// chat-window.js — standalone chat window controller.
//
// Loaded AFTER store.js / context.js / chat.js. It layers two pages
// (splash ⇄ chat) inside this window and overrides the two panel-only
// hooks that chat.js expects, so the shared chat.js stays untouched:
//
//   1. refreshMailWindowStatus()  — lives in popup.js (not loaded here)
//   2. openWebmailMessage()       — panel version assumes the active tab
//                                   is webmail; from a separate window we
//                                   must find the webmail tab ourselves,
//                                   bring it forward, then drop this
//                                   window behind it (clean layering).

let cwWindowId = null;

/* ------------------------------------------------------------------
   Preview guard — lets this UI be opened outside the extension
   (chrome.* does not exist there). Inside the extension, chrome.storage
   and chrome.runtime.id are present, so this block never runs.
   ------------------------------------------------------------------ */
(function installPreviewFallback() {
  const isExtension =
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.id &&
    chrome.storage &&
    chrome.storage.local;
  if (isExtension) return;

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem("cwPreviewStore") || "{}");
    } catch (err) {
      return {};
    }
  };
  const write = (obj) => {
    try {
      localStorage.setItem("cwPreviewStore", JSON.stringify({ ...read(), ...obj }));
    } catch (err) {
      /* storage unavailable — preview only */
    }
  };

  window.chrome = {
    runtime: {
      id: "preview",
      sendMessage: (msg, callback) => {
        if (callback) {
          callback({
            ok: true,
            text:
              "This is a **UI preview** of the chat window.\n\n" +
              "In the extension I answer from your last *15 days* of mail — " +
              "deadlines, unread work, who replied — and mark sources you can click.",
          });
        }
      },
      lastError: null,
    },
    storage: {
      local: {
        get: (keys, callback) => {
          const all = read();
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            if (key in all) out[key] = all[key];
          });
          if (callback) callback(out);
        },
        set: (obj, callback) => {
          write(obj);
          if (callback) callback();
        },
        remove: (key, callback) => {
          const all = read();
          delete all[key];
          try {
            localStorage.setItem("cwPreviewStore", JSON.stringify(all));
          } catch (err) {
            /* ignore */
          }
          if (callback) callback();
        },
      },
    },
    windows: {
      getCurrent: async () => ({ id: null }),
      update: async () => ({}),
    },
    tabs: {
      query: async () => [],
      update: async () => ({}),
      create: async () => ({}),
    },
  };

  // Pretend the mail window is already synced so the send flow reaches the
  // canned reply above instead of trying to contact a backend.
  Object.defineProperty(window, "runMailWindowSync", {
    configurable: true,
    writable: true,
    value: async () => ({ ok: true, skipped: true, fetched: 0 }),
  });
})();

function cwStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function cwSetLayer(name) {
  document.body.dataset.layer = name;
  if (name === "chat") {
    const input = document.getElementById("chatInput");
    if (input) setTimeout(() => input.focus(), 260);
  }
}

/* ---------------- header sync status ---------------- */

window.refreshMailWindowStatus = async function refreshMailWindowStatus() {
  const el = document.getElementById("cw-sync-status");
  if (!el) return;

  try {
    const meta = await getMailWindowMeta();
    if (!meta || !meta.syncedAt) {
      el.textContent = "Not synced yet";
      return;
    }

    const start = String(meta.windowStart || "").slice(0, 10);
    const end = String(meta.windowEnd || "").slice(0, 10);
    const via = (meta.backendUsed || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
    const range = start && end ? ` · ${start} → ${end}` : "";
    const backend = via ? ` · ${via}` : "";
    el.textContent = `${meta.count || 0} mails${range}${backend}`;
    el.title = el.textContent;
  } catch (err) {
    el.textContent = "Not synced yet";
  }
};

/* ---------------- citation → mail, with layering ---------------- */

const CW_WEBMAIL_MATCH = "https://webmail.iitb.ac.in/*";

// Drop this window to the taskbar so the opened mail owns the foreground.
// The floating robot button on the webmail page brings the chat back.
function cwMinimiseSelf() {
  if (!cwWindowId) return;
  try {
    const updating = chrome.windows.update(cwWindowId, { state: "minimized" });
    if (updating && typeof updating.catch === "function") updating.catch(() => {});
  } catch (err) {
    /* window already gone — ignore */
  }
}

// The panel's chat.js already knows how to open a mail: it asks the background
// worker, which finds (or opens) the webmail tab and drives Roundcube's own
// rcmail object in the page — no reload, no content-script row clicking. From
// this separate window the same message works unchanged, so we only add the
// window-specific part: bring webmail forward, then send this window behind it.
window.openWebmailMessage = async function openWebmailMessage(uid) {
  const numUid = Number(uid);

  if (!numUid || Number.isNaN(numUid)) {
    setChatStatus("That citation has no mail link (older chat message) — ask the question again to get clickable ones.");
    setTimeout(() => setChatStatus(""), 6000);
    return;
  }

  setChatStatus(`Opening mail #${numUid}…`);

  try {
    // Put the webmail window in front FIRST so the opened mail lands on top
    // of this popup instead of underneath it.
    const tabs = await chrome.tabs.query({ url: CW_WEBMAIL_MATCH });
    const webmailTab =
      tabs.find((tab) => tab.active && !tab.hidden) || tabs.find((tab) => !tab.hidden) || tabs[0];

    if (webmailTab) {
      try {
        await chrome.windows.update(webmailTab.windowId, { focused: true });
      } catch (err) {
        /* window may be gone */
      }
    }

    const result = await requestOpenMail(numUid);

    if (result && result.ok) {
      setChatStatus("");
      setTimeout(cwMinimiseSelf, 250);
    } else {
      setChatStatus((result && result.error) || "Could not open that mail — is webmail still open?");
      setTimeout(() => setChatStatus(""), 6000);
    }
  } catch (err) {
    console.error("[IITB Citation] window open failed:", err);
    setChatStatus("Could not open that mail — is the webmail tab still open?");
    setTimeout(() => setChatStatus(""), 6000);
  }
};

/* ---------------- runMailWindowSync (panel version lives in popup.js) ---- */

// chat.js's send flow calls runMailWindowSync(), but popup.js is not loaded
// in this standalone window — without this, every send dies with a silent
// ReferenceError right after the user bubble. syncMailWindow() comes from
// store.js, which is loaded here.
if (typeof window.runMailWindowSync !== "function") {
  window.runMailWindowSync = async function runMailWindowSync(options = {}) {
    const force = options.force !== false;
    const result = await syncMailWindow({ force });
    if (result && result.ok && !result.skipped) refreshMailWindowStatus();
    return result;
  };
}

/* ---------------- header controls ---------------- */

async function cwRunSync() {
  const btn = document.getElementById("cw-sync-btn");
  const el = document.getElementById("cw-sync-status");
  if (btn) btn.disabled = true;
  if (el) el.textContent = "Syncing 15 days…";

  try {
    const result = await runMailWindowSync({ force: true });
    if (result && result.ok) {
      await refreshMailWindowStatus();
    } else {
      const message = (result && result.error) || "Sync failed.";
      if (el) {
        el.textContent = message;
        el.title = message;
      }
    }
  } catch (err) {
    if (el) el.textContent = `Sync failed: ${err && err.message ? err.message : err}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------- boot ---------------- */

async function initChatWindow() {
  // own window id — used to minimise after a citation jump
  try {
    const win = await chrome.windows.getCurrent();
    cwWindowId = win && win.id;
  } catch (err) {
    cwWindowId = null;
  }

  // which layer to show on open
  const stored = await cwStorage(["chatWindowSeen"]);
  cwSetLayer(stored.chatWindowSeen ? "chat" : "splash");

  document.getElementById("cw-get-started").addEventListener("click", () => {
    chrome.storage.local.set({ chatWindowSeen: true });
    cwSetLayer("chat");
  });

  // header mascot → back to the launcher layer
  document.getElementById("cw-avatar-btn").addEventListener("click", () => {
    cwSetLayer("splash");
  });

  document.getElementById("cw-sync-btn").addEventListener("click", cwRunSync);

  document.getElementById("cw-minimize-btn").addEventListener("click", cwMinimiseSelf);

  document.getElementById("cw-close-btn").addEventListener("click", () => window.close());

  // shared chat behaviour (history, suggestions, send, citation chips)
  if (typeof initChat === "function") initChat();

  refreshMailWindowStatus();
}

document.addEventListener("DOMContentLoaded", initChatWindow);
