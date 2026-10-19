// Mail filter, local mail store and the inbox prep job (sync + local search
// vectors) are shared with the side panel.
importScripts("sensitive.js", "store.js", "inbox-prep.js");

const DEFAULT_BACKEND_BASE = "https://webmailextensionugac-260151192882.asia-south1.run.app";
const sidePanelStateByTab = new Map();

function normalizeBackendBase(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_BACKEND_BASE;
}

async function resolveBackendBase() {
  try {
    const data = await chrome.storage.local.get(["backendBaseUrl"]);
    return normalizeBackendBase(data.backendBaseUrl);
  } catch (err) {
    return DEFAULT_BACKEND_BASE;
  }
}

async function buildBackendUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const base = await resolveBackendBase();
  return `${base}${normalizedPath}`;
}

// The service worker is stopped after ~30s idle and its memory is wiped. The
// per-tab panel state is mirrored to chrome.storage.session so a page reload
// after a restart does not close an open panel.
const SIDE_PANEL_STATE_KEY = "sidePanelStateByTab";

const sidePanelStateLoaded = chrome.storage.session
  .get([SIDE_PANEL_STATE_KEY])
  .then((data) => {
    const saved = (data && data[SIDE_PANEL_STATE_KEY]) || {};
    for (const [tabId, state] of Object.entries(saved)) {
      if (!sidePanelStateByTab.has(Number(tabId))) {
        sidePanelStateByTab.set(Number(tabId), state);
      }
    }
  })
  .catch(() => {});

function persistSidePanelState() {
  const plain = Object.fromEntries(sidePanelStateByTab);
  chrome.storage.session.set({ [SIDE_PANEL_STATE_KEY]: plain }).catch(() => {});
}

function getSidePanelState(tabId) {
  return sidePanelStateByTab.get(tabId) || { autoOpened: false, opened: false, manuallyClosed: false };
}

function setSidePanelState(tabId, nextState) {
  sidePanelStateByTab.set(tabId, nextState);
  persistSidePanelState();
}

function clearSidePanelState(tabId) {
  sidePanelStateByTab.delete(tabId);
  persistSidePanelState();
}

function isWebmailUrl(url = "") {
  return typeof url === "string" && url.includes("webmail.iitb.ac.in");
}

function applySidePanelOptions(tabId, enabled) {
  return chrome.sidePanel.setOptions({
    tabId,
    path: "popup.html",
    enabled,
  });
}

function disableDefaultSidePanel() {
  return chrome.sidePanel.setOptions({
    enabled: false,
  });
}

function markTabState(tabId, updates) {
  const current = getSidePanelState(tabId);
  setSidePanelState(tabId, {
    ...current,
    ...updates,
  });
}

async function syncTabSidePanel(tabId, url = "") {
  await sidePanelStateLoaded;
  // Unknown tab: leave the panel alone instead of closing it.
  if (!sidePanelStateByTab.has(tabId)) return;
  const state = getSidePanelState(tabId);
  await applySidePanelOptions(tabId, state.opened === true);
}

disableDefaultSidePanel().catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  disableDefaultSidePanel().catch((error) => console.error(error));
});

chrome.runtime.onStartup.addListener(() => {
  disableDefaultSidePanel().catch((error) => console.error(error));
});

let isAuthPending = false;
let cachedToken = null;



/* -------------------- Open a mail inside webmail (no page reload) -------------------- */

const WEBMAIL_INBOX_URL = "https://webmail.iitb.ac.in/?_task=mail&_mbox=INBOX";

// Runs inside the webmail page itself (MAIN world), where Roundcube's own
// `rcmail` object lives. Must be self-contained.
function roundcubeOpenInPreview(uid, mbox) {
  const rc = window.rcmail;
  if (!rc || !rc.env) return { ok: false, reason: "no-roundcube" };
  if (rc.env.task !== "mail") return { ok: false, reason: "not-mail-task" };

  const key = String(uid);
  const list = rc.message_list;

  // 1. The mail is in the list on screen: select it like a normal click.
  try {
    if (list && list.rows && list.rows[key] && (rc.env.mailbox || "INBOX") === mbox) {
      list.select(key);
      if (typeof list.scrollto === "function") list.scrollto(key);
      return { ok: true, method: "select" };
    }
  } catch (err) {
    // fall through to the preview pane
  }

  // 2. Not on this page: load it straight into the preview pane.
  try {
    const frameName = rc.env.contentframe;
    const frameWindow = frameName && rc.get_frame_window(frameName);
    if (!frameWindow) return { ok: false, reason: "no-preview-pane" };

    if (list && typeof list.clear_selection === "function") list.clear_selection();

    const query = { _uid: key, _mbox: mbox, _framed: 1 };
    if (typeof rc.browser_capabilities === "function") query._caps = rc.browser_capabilities();

    rc.preview_id = key;
    rc.location_href(rc.url("preview", query), frameWindow, true);
    if (typeof rc.show_contentframe === "function") rc.show_contentframe(true);
    return { ok: true, method: "preview" };
  } catch (err) {
    return { ok: false, reason: `preview-failed: ${err && err.message ? err.message : err}` };
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") done(true);
    }).catch(() => done(false));
  });
}

async function findWebmailTab() {
  const tabs = await chrome.tabs.query({ url: "*://webmail.iitb.ac.in/*" });
  if (!tabs.length) return null;

  let focusedWindowId = null;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    focusedWindowId = win && win.id;
  } catch (err) {
    // ignore
  }

  return (
    tabs.find((tab) => tab.active && tab.windowId === focusedWindowId) ||
    tabs.find((tab) => tab.active) ||
    tabs[0]
  );
}

async function runRoundcubeOpen(tabId, uid, mbox) {
  // Roundcube finishes setting itself up shortly after the page loads.
  for (let attempt = 0; attempt < 20; attempt++) {
    let result = null;
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "MAIN",
        func: roundcubeOpenInPreview,
        args: [uid, mbox],
      });
      result = injection && injection.result;
    } catch (err) {
      result = { ok: false, reason: `inject-failed: ${err && err.message ? err.message : err}` };
    }

    if (result && (result.ok || result.reason !== "no-roundcube")) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, reason: "no-roundcube" };
}

async function openMailInWebmail(uid, mbox = "INBOX") {
  const cleanUid = Number(uid);
  if (!Number.isInteger(cleanUid) || cleanUid <= 0) {
    return { ok: false, error: "This item has no mail link." };
  }

  let tab = await findWebmailTab();

  if (!tab) {
    tab = await chrome.tabs.create({ url: WEBMAIL_INBOX_URL, active: true });
    await waitForTabComplete(tab.id);
  } else {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  let result = await runRoundcubeOpen(tab.id, cleanUid, mbox);

  // Webmail is showing something other than the mail list (compose, settings,
  // a full-screen message): go to the inbox once, then open it in the preview.
  if (!result.ok) {
    await chrome.tabs.update(tab.id, { url: WEBMAIL_INBOX_URL });
    await waitForTabComplete(tab.id);
    result = await runRoundcubeOpen(tab.id, cleanUid, mbox);
  }

  if (!result.ok) {
    return { ok: false, error: `Could not open the mail in webmail (${result.reason}).` };
  }
  return { ok: true, method: result.method };
}


/* -------------------- Standalone chat window -------------------- */

// The side panel is the primary chat surface; this is the optional floating
// window for people who want the chat parked beside another app. It loads the
// SAME store.js / retrieval.js / context.js / chat.js as the panel, so there
// is only one chat implementation in the extension.
const CHAT_WINDOW_URL = "chat-window.html";
let chatWindowId = null;

function chatWindowMetrics() {
  const width = Math.min(470, Math.max(380, Math.round((screen.width || 1440) * 0.3)));
  const height = Math.min(860, Math.max(540, Math.round((screen.height || 900) * 0.86)));
  return { width, height };
}

async function openChatWindow() {
  // Already open: focus it rather than spawning a second copy.
  if (chatWindowId !== null) {
    try {
      const existing = await chrome.windows.get(chatWindowId);
      if (existing && existing.id !== undefined) {
        await chrome.windows.update(existing.id, { focused: true });
        return { ok: true, created: false, windowId: existing.id };
      }
    } catch (err) {
      chatWindowId = null; // closed while this worker was asleep
    }
  }

  const { width, height } = chatWindowMetrics();
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(CHAT_WINDOW_URL),
    type: "popup",
    width,
    height,
  });
  chatWindowId = created && created.id;
  return { ok: true, created: true, windowId: chatWindowId };
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === chatWindowId) chatWindowId = null;
});


chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req || req.target === "offscreen") return; // handled by offscreen.js

  if (req.type === "PREPARE_INBOX") {
    (req.forChat ? prepareInboxForChat() : prepareInbox({ force: !!req.force }))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (req.type === "EMBED_QUERY") {
    embedQuery(req.text)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (req.type === "OPEN_MAIL") {
    openMailInWebmail(req.uid, req.mbox || "INBOX")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  // The robot button on webmail opens the side panel with the chat expanded.
  if (req.type === "OPEN_CHAT_PANEL" && sender.tab) {
    const tabId = sender.tab.id;
    markTabState(tabId, { opened: true, manuallyClosed: false });
    chrome.storage.session.set({ focusChatAt: Date.now() }).catch(() => {});
    applySidePanelOptions(tabId, true).catch((e) => console.error(e));
    chrome.sidePanel
      .open({ tabId })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  // The panel's "open in a window" button. Works from the panel or the
  // standalone window — no sender tab required.
  if (req.type === "OPEN_CHAT_WINDOW") {
    openChatWindow()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
    return true;
  }

  if (req.type === "OPEN_SIDEBAR" && sender.tab) {
    const state = getSidePanelState(sender.tab.id);
    if (state.autoOpened || state.manuallyClosed) {
      return;
    }

    markTabState(sender.tab.id, {
      autoOpened: true,
      opened: true,
      manuallyClosed: false,
    });

    applySidePanelOptions(sender.tab.id, true).catch((e) => console.error(e));
    chrome.sidePanel.open({ tabId: sender.tab.id })
      .catch((e) => console.error(e));
    return;
  }

  if (req.type === "GEMINI_SUMMARY") {
    handleGeminiProxy(req, sendResponse);
    return true;
  }

  if (req.type === "ADD_CALENDAR_EVENT") {
    handleCalendarFlow(req.eventData, req.cardId);
  }

  if (req.type === "UPDATE_CALENDAR_EVENT") {
    handleCalendarFlow(req.eventData, req.cardId, req.eventId);
  }

  if (req.type === "SWITCH_GOOGLE_ACCOUNT") {
    cachedToken = null;
    chrome.storage.local.remove('sessionToken', () => {
      handleCalendarFlow({}, null, null, true);
    });
  }

});

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) {
    return;
  }

  markTabState(tab.id, {
    opened: true,
    manuallyClosed: false,
  });

  applySidePanelOptions(tab.id, true).catch((e) => console.error(e));
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error(e));
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url) {
    return;
  }

  await syncTabSidePanel(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await syncTabSidePanel(tabId, tab.url);
  } catch (error) {
    console.error(error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSidePanelState(tabId);
});

if (chrome.sidePanel.onOpened) {
  chrome.sidePanel.onOpened.addListener((info) => {
    if (Number.isInteger(info.tabId)) {
      markTabState(info.tabId, { opened: true });
    }
  });
}

if (chrome.sidePanel.onClosed) {
  chrome.sidePanel.onClosed.addListener((info) => {
    if (Number.isInteger(info.tabId)) {
      markTabState(info.tabId, {
        opened: false,
        manuallyClosed: true,
      });
      applySidePanelOptions(info.tabId, false).catch((error) => console.error(error));
    }
  });
}


const RETIRED_GEMINI_MODELS = {
  "gemini-2.5-flash": "gemini-3.8-flash",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
};
const FALLBACK_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

function resolveGeminiModel(model) {
  const chosen = model || DEFAULT_GEMINI_MODEL;
  return RETIRED_GEMINI_MODELS[chosen] || chosen;
}

function buildGeminiModelCandidates(model) {
  const candidates = [resolveGeminiModel(model)];
  for (const fallback of FALLBACK_GEMINI_MODELS) {
    const resolved = resolveGeminiModel(fallback);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  return candidates;
}

function isModelUnavailableError(message = "") {
  return /no longer available|not found|is not found|deprecated|does not have permission/i.test(message);
}

function isModelBusyError(message = "", status = 0) {
  return status === 503 || status === 500 || /high demand|overloaded|UNAVAILABLE|try again later/i.test(message);
}

function extractGeminiErrorMessage(json, status) {
  const err = json && json.error;
  if (err && typeof err === "object" && err.message) return String(err.message);
  if (typeof err === "string") {
    const details = json.details ? ` — ${String(json.details).slice(0, 300)}` : "";
    return `${err}${details}`;
  }
  if (json && json.message) return String(json.message);
  return `Error ${status}`;
}

async function fetchGemini(model, payload, data, hasCustomKey) {
  if (hasCustomKey) {
    console.log("[DEBUG] Using Custom User API Key, model:", model);
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${data.customApiKey}`;
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  console.log("[DEBUG] Routing to Django Backend Proxy, model:", model);
  const backendProxyUrl = await buildBackendUrl('/api/gemini-proxy/');
  return fetch(backendProxyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Extension-Id": chrome.runtime.id,
      "X-Client-Feature": "iitb-mail-extension",
    },
    body: JSON.stringify({ model, payload }),
  });
}

async function handleGeminiProxy(req, sendResponse) {
  chrome.storage.local.get(['customApiKey', 'selectedModel'], async (data) => {
    const hasCustomKey = !!data.customApiKey;

    // popup.js sends { prompt, files } where files are { mimeType, base64 }.
    // Gemini (and the proxy) expect real parts: { inlineData: { mimeType, data } }.
    // The nested tree used to build this correctly; the merge spread the raw
    // objects instead, so image attachments never reached the model.
    let payload = req.payload;
    if (!payload) {
      const parts = [{ text: req.prompt }];
      const mediaFiles = Array.isArray(req.files) ? req.files : [];
      for (const item of mediaFiles) {
        if (item && item.base64 && item.mimeType) {
          parts.push({
            inlineData: {
              mimeType: item.mimeType,
              data: item.base64,
            },
          });
        } else if (item && (item.inlineData || item.inline_data || typeof item.text === "string")) {
          // Already a Gemini-shaped part (chat payload builder).
          parts.push(item);
        }
      }
      payload = { contents: [{ parts }] };
    }

    try {
      const candidates = buildGeminiModelCandidates(req.model || data.selectedModel);
      let res = null;
      let lastError = "";

      outer:
      for (const model of candidates) {
        // Google sometimes answers "high demand" (503). Retry the same model
        // once after a short pause, then move on to the next model.
        for (let attempt = 0; attempt < 2; attempt++) {
          res = await fetchGemini(model, payload, data, hasCustomKey);
          if (res.ok) break outer;

          const status = res.status;
          const errJson = await res.json().catch(() => ({}));
          lastError = extractGeminiErrorMessage(errJson, status);
          res = null;

          if (isModelBusyError(lastError, status)) {
            if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          if (isModelUnavailableError(lastError)) continue outer;
          break outer;
        }
      }

      if (!res) {
        sendResponse({
          ok: false,
          error: hasCustomKey ? `Custom Key Error: ${lastError}` : `Backend Error: ${lastError}`,
        });
        return;
      }

      const json = await res.json();

      const text = json.summary ||
                   json.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
                   "No response generated.";

      // "MAX_TOKENS" means Gemini stopped mid-answer (thinking tokens count too).
      const finishReason = (json.raw || json).candidates?.[0]?.finishReason || "";
      sendResponse({ ok: true, text, truncated: finishReason === "MAX_TOKENS" });

    } catch (err) {
      console.error("[DEBUG] Proxy Error:", err);
      sendResponse({ ok: false, error: "Network error. Please check your connection and try again." });
    }
  });
}

async function handleCalendarFlow(eventData, cardId, eventId = null, forceSelect = false) {
  const data = await chrome.storage.local.get(['sessionToken']);
  let token = cachedToken || data.sessionToken;

  if (token && !forceSelect) {
    executeCalendarInsert(token, eventData, cardId, eventId);
    return;
  }

  if (isAuthPending) {
    console.log("Auth already in progress. Queueing request for:", cardId);
    const checkInterval = setInterval(() => {
        if (cachedToken || !isAuthPending) {
            clearInterval(checkInterval);
            if (cachedToken) executeCalendarInsert(cachedToken, eventData, cardId, eventId);
        }
    }, 500);
    return;
  }

  const clientId = "204923188074-lev69m2gnnock5k9btjvqmle7pono50r.apps.googleusercontent.com";
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const scopes = encodeURIComponent("https://www.googleapis.com/auth/calendar.events");

  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth` +
    `?client_id=${clientId}` +
    `&response_type=token` +
    `&redirect_uri=${redirectUri}` +
    `&scope=${scopes}&prompt=select_account`;

  isAuthPending = true;

  chrome.identity.launchWebAuthFlow(
    { url: authUrl, interactive: true },
    async (redirectUrl) => {
      isAuthPending = false;

      if (chrome.runtime.lastError || !redirectUrl) {
        if (forceSelect && !(eventData && eventData.title)) {
          chrome.runtime.sendMessage({
            type: "GOOGLE_ACCOUNT_SWITCH_RESULT",
            status: "error",
            message: "Google account switch failed."
          });
        } else {
          chrome.runtime.sendMessage({
            type: "CALENDAR_RESULT",
            status: "error",
            message: "Google login failed.",
            cardId: cardId
          });
        }
        return;
      }

      const params = new URLSearchParams(new URL(redirectUrl).hash.substring(1));
      const newToken = params.get("access_token");
      if (newToken) {
        cachedToken = newToken;
        await chrome.storage.local.set({ sessionToken: newToken });

        setTimeout(() => {
            cachedToken = null;
            chrome.storage.local.remove('sessionToken');
        }, 3600000);

        if (eventData && eventData.title) {
          executeCalendarInsert(newToken, eventData, cardId, eventId);
        } else if (forceSelect) {
          chrome.runtime.sendMessage({
            type: "GOOGLE_ACCOUNT_SWITCH_RESULT",
            status: "success",
            message: "Google account switched successfully."
          });
        }
      }
    }
  );
}

async function executeCalendarInsert(token, data, cardId, eventId = null) {
  const startTimeVal = data.startTime || data.time;

  const event = {
    summary: data.title,
    description: data.description || "Added via IITB Mail Assistant",
  };

  if (startTimeVal && startTimeVal.trim() !== "") {
    const startDateTime = `${data.date}T${startTimeVal}:00`;
    let endDateTime;

    if (data.endTime && /^\d{2}:\d{2}$/.test(data.endTime)) {
      endDateTime = `${data.date}T${data.endTime}:00`;
    } else {
      const [hours, minutes] = startTimeVal.split(':').map(Number);
      let endHours = hours + 1;
      let endDate = data.date;

      if (endHours >= 24) {
          endHours = 0;
      }
      const pad = (n) => n.toString().padStart(2, '0');
      endDateTime = `${endDate}T${pad(endHours)}:${pad(minutes)}:00`;
    }

    event.start = { dateTime: startDateTime, timeZone: "Asia/Kolkata" };
    event.end = { dateTime: endDateTime, timeZone: "Asia/Kolkata" };
  } else {
    event.start = { date: data.date };
    event.end = { date: data.date };
  }

  const url = eventId
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`
    : "https://www.googleapis.com/calendar/v3/calendars/primary/events";

  const method = eventId ? "PATCH" : "POST";

  try {
    const res = await fetch(url, {
        method: method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(event)
      }
    );

    if (res.status === 401) {
      cachedToken = null;
      await chrome.storage.local.remove('sessionToken');
      handleCalendarFlow(data, cardId, eventId);
      return;
    }

    if (res.ok) {
      const savedEvent = await res.json();
      chrome.runtime.sendMessage({
        type: "CALENDAR_RESULT",
        status: "success",
        cardId: cardId,
        eventId: savedEvent.id
      });

      chrome.notifications.create({
        type: "basic",
        iconUrl: "Icons/icon_128.png",
        title: eventId ? "Event Updated" : "Event Scheduled",
        message: startTimeVal ? `Scheduled for ${startTimeVal} (IST)` : `Scheduled as All Day Event`,
        priority: 2
      });
    } else {
      const errorInfo = await res.json();
      chrome.runtime.sendMessage({ type: "CALENDAR_RESULT", status: "error", message: errorInfo.error?.message, cardId: cardId });
    }
  } catch (err) {
    chrome.runtime.sendMessage({ type: "CALENDAR_RESULT", status: "error", message: "Network error.", cardId: cardId });
  }

}
