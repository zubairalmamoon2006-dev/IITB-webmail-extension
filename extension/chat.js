const CHAT_HISTORY_KEY = "chatHistory";
const CHAT_HISTORY_LIMIT = 40;
const CHAT_TURN_LIMIT = 1500;
const CHAT_TURNS_SENT = 6;
// Gemini 3 models spend part of this on thinking, so keep it generous or the
// reply gets cut off mid-sentence.
const CHAT_MAX_OUTPUT_TOKENS = 8192;

const CHAT_SUGGESTIONS = [
  "Any deadlines in the next 7 days?",
  "Any quizzes, exams or submissions coming up?",
  "Did anyone ask me to reply or do something?",
];

let chatBusy = false;

function chatStorage(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function escapeChatHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Inline formatting for one escaped line: **bold**, `code`, [E12] chips, and
// any leftover asterisks removed.
function formatChatInline(html, uidById) {
  let out = html;
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/(^|[\s(])\*(?!\s)([^*]+?)\*(?=[\s).,;:!?]|$)/g, "$1$2"); // *italic* -> plain
  out = out.replace(/\*/g, "");
  out = out.replace(/\[(E\d+)\]/g, (match, id) => {
    const uid = uidById[String(Number(id.slice(1)))];
    if (!uid) return match;
    return `<span class="chat-citation" data-uid="${uid}" title="Open this email">${id}</span>`;
  });
  // "[E3][E5]" -> small gap between chips
  out = out.replace(/<\/span><span class="chat-citation"/g, '</span> <span class="chat-citation"');
  return out;
}

// Turns Gemini's markdown-ish reply into clean HTML: paragraphs, bullet and
// numbered lists, bold. Headings become bold lines. No stray asterisks.
function formatChatText(text, uidById = {}) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let list = null; // { type: "ul" | "ol", items: [] }

  const flushList = () => {
    if (!list) return;
    parts.push(`<${list.type} class="chat-list">${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const escaped = escapeChatHtml(line);
    const bullet = escaped.match(/^(?:[-*•‣▪]|–)\s+(.*)$/);
    const numbered = escaped.match(/^(\d{1,2})[.)]\s+(.*)$/);
    const heading = escaped.match(/^#{1,6}\s+(.*)$/);

    if (bullet) {
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(formatChatInline(bullet[1], uidById));
    } else if (numbered) {
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(formatChatInline(numbered[2], uidById));
    } else if (heading) {
      flushList();
      parts.push(`<p class="chat-heading"><strong>${formatChatInline(heading[1].replace(/\*\*/g, ""), uidById)}</strong></p>`);
    } else {
      flushList();
      parts.push(`<p>${formatChatInline(escaped, uidById)}</p>`);
    }
  }
  flushList();
  return parts.join("");
}

// Drops a trailing line that stops mid-sentence (used only if Gemini still
// runs out of room after the shorter retry).
function trimToCompleteLines(text) {
  const lines = String(text || "").trimEnd().split("\n");
  while (lines.length > 1 && !/[.!?)\]]\s*$/.test(lines[lines.length - 1])) lines.pop();
  return lines.join("\n");
}

function collectChatCitations(text, uidById) {
  const found = {};
  const pattern = /\[(E\d+)\]/g;
  let match = pattern.exec(String(text || ""));
  while (match) {
    const key = String(Number(match[1].slice(1)));
    if (uidById[key]) found[key] = uidById[key];
    match = pattern.exec(String(text || ""));
  }
  return found;
}

async function loadChatHistory() {
  const stored = await chatStorage([CHAT_HISTORY_KEY]);
  const history = stored[CHAT_HISTORY_KEY];
  return Array.isArray(history) ? history : [];
}

async function saveChatHistory(history) {
  const trimmed = history.slice(-CHAT_HISTORY_LIMIT);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CHAT_HISTORY_KEY]: trimmed }, resolve);
  });
}

async function clearChatHistory() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CHAT_HISTORY_KEY]: [] }, resolve);
  });
}

function setChatStatus(message) {
  const statusEl = document.getElementById("chat-status");
  if (statusEl) statusEl.textContent = message || "";
}

function renderChatBubble(role, html, options = {}) {
  const container = document.getElementById("chat-messages");
  if (!container) return null;

  const empty = container.querySelector(".chat-empty");
  if (empty) empty.remove();

  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-${role}${options.thinking ? " chat-thinking" : ""}`;
  bubble.innerHTML = html;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function renderChatMessage(entry) {
  const uidById = entry.uids || {};
  if (entry.role === "user") return renderChatBubble("user", escapeChatHtml(entry.text));
  const note = entry.note ? `<p class="chat-note">${escapeChatHtml(entry.note)}</p>` : "";
  const text = typeof stripLatex === "function" ? stripLatex(entry.text) : entry.text;
  return renderChatBubble("assistant", formatChatText(text, uidById) + note);
}

async function renderChatHistory() {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const history = await loadChatHistory();
  if (!history.length) return;

  const needsMap = history.some(
    (entry) => entry.role === "assistant" && (!entry.uids || !Object.keys(entry.uids).length)
  );
  let fallbackMap = null;
  if (needsMap) {
    try {
      const emails = (await getMailWindowEmails()).filter((email) => !email.sensitive);
      fallbackMap = {};
      emails.forEach((email, index) => {
        fallbackMap[index + 1] = email.uid;
      });
    } catch (err) {
      fallbackMap = null;
    }
  }

  container.innerHTML = "";
  history.forEach((entry) => {
    if (
      fallbackMap &&
      entry.role === "assistant" &&
      (!entry.uids || !Object.keys(entry.uids).length)
    ) {
      entry.uids = fallbackMap;
    }
    renderChatMessage(entry);
  });
  container.scrollTop = container.scrollHeight;
}

function renderChatSuggestions() {
  const container = document.getElementById("chat-suggestions");
  if (!container) return;

  container.innerHTML = "";
  CHAT_SUGGESTIONS.forEach((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chat-suggestion";
    chip.textContent = text;
    chip.onclick = () => {
      const input = document.getElementById("chatInput");
      if (input) input.value = text;
      handleChatSend();
    };
    container.appendChild(chip);
  });
}

async function clearActiveChat() {
  await clearChatHistory();
  const messages = document.getElementById("chat-messages");
  if (messages) {
    messages.innerHTML =
      '<div class="chat-bubble chat-assistant"><p>Chat cleared. Ask me anything about your mail.</p></div>';
  }
  setChatStatus("");
}

// Clear chat lives in the panel toolbar and the standalone window header —
// not buried inside the suggestion chips.
function wireChatClearButton() {
  ["chatClearBtn", "cw-clear-btn"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => clearActiveChat();
  });
}

function sendChatPayload(payload, model, uidById) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GEMINI_SUMMARY", payload, model }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || "Extension message failed." });
        return;
      }
      if (response && response.ok) resolve({ ok: true, text: response.text || "", truncated: !!response.truncated, uidById });
      else resolve({ ok: false, error: (response && response.error) || "No response from Gemini." });
    });
  });
}

function requestOpenMail(uid) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_MAIL", uid: Number(uid) }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from the extension." });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}

// Sync new mails and update the local search vectors (runs in the background
// worker; the panel opening, the Sync button and chat questions share one run).
function requestPrepareInbox(force = false, forChat = false) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "PREPARE_INBOX", force, forChat }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response from the extension." });
      });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  });
}

// The question as a MiniLM vector, made on this laptop. null if the model is unavailable.
function requestQueryVector(text) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    try {
      chrome.runtime.sendMessage({ type: "EMBED_QUERY", text }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError || !response || !response.ok) resolve(null);
        else resolve(response.vector);
      });
    } catch (err) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

function formatSyncTime(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "earlier";
  return when.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" });
}

// The chat also runs in its own floating window, so webmail is searched for
// across all tabs instead of only the current one.
function findWebmailTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) {
          resolve(null);
          return;
        }
        const webmailTabs = tabs.filter((tab) => tab.url && tab.url.includes("webmail.iitb.ac.in"));
        resolve(webmailTabs.find((tab) => tab.active) || webmailTabs[0] || null);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

// The mail the user is looking at right now, with the same secret redaction
// the popup uses. null when webmail has no mail open (or it is sensitive).
async function fetchOpenMailForChat() {
  const tab = await findWebmailTab();
  if (!tab) return null;

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: "GET_OPENED_MAIL" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok || !response.mail) {
        resolve(null);
        return;
      }
      const checked = protectMail({ body: response.mail.body || "" });
      if (checked.sensitive) {
        resolve(null);
        return;
      }
      resolve({ ...response.mail, body: checked.body });
    });
  });
}

async function openWebmailMessage(uid) {
  const numUid = Number(uid);
  if (!numUid || Number.isNaN(numUid)) {
    setChatStatus("That citation has no mail link (older chat message). Ask again to get clickable ones.");
    setTimeout(() => setChatStatus(""), 6000);
    return;
  }

  setChatStatus("Opening mail…");
  const result = await requestOpenMail(numUid);
  setChatStatus(result.ok ? "" : result.error);
  if (!result.ok) setTimeout(() => setChatStatus(""), 6000);
}

async function handleChatSend() {
  const input = document.getElementById("chatInput");
  const sendBtn = document.getElementById("chatSendBtn");
  const question = ((input && input.value) || "").trim().slice(0, 2000);

  if (!question || chatBusy) return;
  if (input) input.value = "";

  chatBusy = true;
  if (sendBtn) sendBtn.disabled = true;

  renderChatBubble("user", escapeChatHtml(question));

  let thinking = null;
  try {
    const history = await loadChatHistory();
    history.push({ role: "user", text: question });
    await saveChatHistory(history);

    // Fetch new mails first (only if the last sync is over 5 minutes old), so
    // the answer includes mail that just arrived.
    thinking = renderChatBubble("assistant", "<p>Checking for new mail…</p>", { thinking: true });
    const prep = await requestPrepareInbox(false, true);
    let note = "";
    if (!prep.ok) {
      const meta = await getMailWindowMeta();
      if (!meta || !meta.syncedAt) {
        if (thinking) thinking.remove();
        renderChatBubble("assistant", `<p>${escapeChatHtml(prep.error || "Could not sync your inbox.")}</p>`);
        return;
      }
      note = `Couldn't refresh, using mails synced at ${formatSyncTime(meta.syncedAt)}.`;
    }

    if (thinking) thinking.innerHTML = "<p>Thinking…</p>";

    const queryVector = await requestQueryVector(question);
    const context = await buildMailContext(question, { queryVector });
    const model = (await chatStorage(["selectedModel"])).selectedModel || "gemini-3.8-flash";

    // The mail open in webmail right now joins the question: a short body
    // plus its files — PDF text through the backend, images as real image
    // parts (the shared proxy allows at most two, so cap them here instead
    // of letting the server drop them silently).
    let openMailNote = "";
    let openMailImages = [];
    const openMail = await fetchOpenMailForChat();
    if (openMail && (openMail.body || (openMail.attachments && openMail.attachments.length))) {
      if (thinking) thinking.innerHTML = "<p>Reading the open mail's files…</p>";
      const openCtx = await buildAttachmentContext(openMail.attachments || []);
      const attachText = String(openCtx.text || "").slice(0, 20000);
      openMailNote = [
        "",
        "",
        "[MAIL CURRENTLY OPEN IN WEBMAIL — the user is looking at this mail right now; it may not be in the window above]",
        openMail.subject ? `Subject: ${openMail.subject}` : "",
        openMail.from ? `From: ${openMail.from}` : "",
        "Body:",
        String(openMail.body || "").slice(0, 4000),
        attachText ? `\nIts attachments:\n${attachText}` : "",
      ].filter(Boolean).join("\n");
      openMailImages = (openCtx.files || [])
        .filter((file) => file && file.base64 && file.base64.length <= 2800000)
        .slice(0, 2);
    }

    const priorTurns = history.slice(0, -1).slice(-CHAT_TURNS_SENT);
    const contents = priorTurns.map((entry) => ({
      role: entry.role === "user" ? "user" : "model",
      parts: [{ text: String(entry.text).slice(0, CHAT_TURN_LIMIT) }],
    }));
    const questionParts = [{ text: openMailNote ? `${question}\n${openMailNote}` : question }];
    openMailImages.forEach((file) => {
      questionParts.push({ inlineData: { mimeType: file.mimeType || "image/png", data: file.base64 } });
    });
    contents.push({ role: "user", parts: questionParts });

    const payload = {
      systemInstruction: { parts: [{ text: context.systemText }] },
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS },
    };

    let answer = await sendChatPayload(payload, model, context.uidById || {});

    // Gemini ran out of room mid-answer: ask once more for a shorter, complete
    // answer instead of showing a half one.
    if (answer.ok && answer.truncated) {
      if (thinking) thinking.innerHTML = "<p>Making the answer shorter…</p>";
      const shorter = {
        ...payload,
        systemInstruction: {
          parts: [{
            text: `${context.systemText}\n\nIMPORTANT: your previous attempt was too long and got cut off. ` +
              "Answer again in at most 5 lines starting with \"- \", each at most 15 words, most urgent first. " +
              "Keep the [E12] citations. Finish every sentence.",
          }],
        },
      };
      const retry = await sendChatPayload(shorter, model, context.uidById || {});
      if (retry.ok) answer = retry;
    }
    // Last resort: never show a half sentence.
    if (answer.ok && answer.truncated) answer.text = trimToCompleteLines(answer.text);

    if (thinking) thinking.remove();
    thinking = null;

    if (!answer.ok) {
      const hint = typeof geminiErrorHint === "function" ? geminiErrorHint(answer.error) : answer.error;
      renderChatBubble("assistant", `<p class="chat-error">${escapeChatHtml(hint)}</p>`);
      setChatStatus("");
      return;
    }

    if (typeof stripLatex === "function") answer.text = stripLatex(answer.text);
    const uids = collectChatCitations(answer.text, answer.uidById || {});
    const entry = { role: "assistant", text: answer.text, uids, note };
    renderChatMessage({ ...entry, uids: answer.uidById || {} });

    history.push(entry);
    await saveChatHistory(history);

    const stats = context.stats || {};
    const searchNote = !stats.usedVectors
      ? " (keyword search only)"
      : prep.partial
        ? " (still preparing older mails for search)"
        : "";
    const attachNote = stats.attachMails
      ? `, attachment text of ${stats.attachMails} mail${stats.attachMails === 1 ? "" : "s"}`
      : "";
    const openNote = openMailNote ? " · used the open mail + its files" : "";
    setChatStatus(`Searched ${stats.total || 0} mails${searchNote}, read ${stats.included || 0} in full${attachNote}${openNote}`);
  } catch (err) {
    if (thinking) thinking.remove();
    renderChatBubble("assistant", `<p class="chat-error">${escapeChatHtml(err && err.message ? err.message : err)}</p>`);
    setChatStatus("");
  } finally {
    chatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

function initChat() {
  renderChatSuggestions();
  renderChatHistory();
  wireChatClearButton();

  const sendBtn = document.getElementById("chatSendBtn");
  const input = document.getElementById("chatInput");

  if (sendBtn) sendBtn.onclick = () => handleChatSend();
  if (input) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleChatSend();
      }
    });
  }

  const messages = document.getElementById("chat-messages");
  if (messages) {
    messages.addEventListener("click", (event) => {
      const chip = event.target.closest(".chat-citation");
      if (!chip) return;
      openWebmailMessage(Number(chip.dataset.uid));
    });
  }
}
