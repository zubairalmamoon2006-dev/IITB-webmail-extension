const MAIL_WINDOW_DAYS = 15;
const MAIL_WINDOW_DB = "mail-window-db";
const MAIL_WINDOW_DB_VERSION = 1;
const MAIL_WINDOW_EMAILS = "emails";
const MAIL_WINDOW_META = "meta";
const MAIL_WINDOW_META_KEY = "window";
const MAIL_WINDOW_SYNC_GAP_MS = 5 * 60 * 1000;
const MAIL_WINDOW_BACKEND_BASE = "https://webmailextensionugac-260151192882.asia-south1.run.app";
const MAIL_WINDOW_LOCAL_CANDIDATES = ["http://127.0.0.1:8000", "http://localhost:8000"];

// Gemini sometimes answers with LaTeX even when told not to. Convert the
// common math bits to plain readable text before showing anything to the user.
// Shared by popup.js (summary/reply) and chat.js (answers).
function stripLatex(text) {
  let s = String(text == null ? "" : text);
  s = s.replace(/\\text\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\mathrm\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\mathbf\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  s = s.replace(/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  s = s.replace(/\\times/g, "×");
  s = s.replace(/\\cdot/g, "·");
  s = s.replace(/\\pm/g, "±");
  s = s.replace(/\\leq?/g, "≤");
  s = s.replace(/\\geq?/g, "≥");
  s = s.replace(/\\neq/g, "≠");
  s = s.replace(/\\approx/g, "≈");
  s = s.replace(/\\left|\\right|\\,|\\;|\\!|\\ /g, "");
  s = s.replace(/\^\{([^{}]*)\}/g, "^$1");
  s = s.replace(/_\{([^{}]*)\}/g, "$1");
  s = s.replace(/\$([^$]*)\$/g, "$1");
  s = s.replace(/\\[a-zA-Z]+/g, "");
  return s;
}

let mailWindowDbPromise = null;

function mailWindowBackendBase(value) {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  return trimmed || MAIL_WINDOW_BACKEND_BASE;
}

// Backend base URL + path for panel pages (side panel and the standalone chat
// window). background.js keeps its own copy for the service worker.
async function buildBackendUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const stored = await mailWindowStorageGet(["backendBaseUrl"]);
  return `${mailWindowBackendBase(stored.backendBaseUrl)}${normalizedPath}`;
}

function mailWindowStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

function openMailWindowDb() {
  if (mailWindowDbPromise) return mailWindowDbPromise;

  mailWindowDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MAIL_WINDOW_DB, MAIL_WINDOW_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MAIL_WINDOW_EMAILS)) {
        const emails = db.createObjectStore(MAIL_WINDOW_EMAILS, { keyPath: "uid" });
        emails.createIndex("receivedAt", "receivedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(MAIL_WINDOW_META)) {
        db.createObjectStore(MAIL_WINDOW_META, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return mailWindowDbPromise;
}

function normalizeWindowEmail(row) {
  const receivedAt = new Date(row.received_at);
  const base = {
    uid: Number(row.uid),
    messageId: row.message_id || "",
    receivedAt: Number.isNaN(receivedAt.getTime()) ? "" : receivedAt.toISOString(),
    receivedLabel: row.received_label || "",
    senderName: row.sender_name || "",
    senderEmail: row.sender_email || "",
    isRead: !!row.is_read,
    source: row.source || "internal",
  };

  // The server already hides OTP / login / bank mails; check again so nothing
  // sensitive is ever stored here, even from an older server.
  const checked = protectMail({
    subject: row.subject || "",
    senderName: base.senderName,
    senderEmail: base.senderEmail,
    body: [row.body, row.snippet, row.excerpt].filter(Boolean).join("\n"),
  });
  const reason = row.sensitive || checked.sensitive;
  if (reason) {
    return { ...base, sensitive: reason, subject: SENSITIVE_SUBJECT, body: "", snippet: SENSITIVE_NOTE, excerpt: SENSITIVE_NOTE, attachments: [] };
  }
  return {
    ...base,
    sensitive: null,
    subject: redactSecrets(row.subject || ""),
    body: redactSecrets(row.body || ""),
    snippet: redactSecrets(row.snippet || ""),
    excerpt: redactSecrets(row.excerpt || ""),
    // Attachment names only (metadata), so the chat index can answer
    // "which mails have a pdf/png". Contents never live in the window.
    attachments: (Array.isArray(row.attachments) ? row.attachments : [])
      .map((name) => String(name).slice(0, 120))
      .slice(0, 8),
  };
}

async function detectMailWindowBackend(stored) {
  const explicit = (stored.backendBaseUrl || "").trim().replace(/\/+$/, "");
  if (explicit) return { base: explicit, source: "custom" };

  for (const candidate of MAIL_WINDOW_LOCAL_CANDIDATES) {
    try {
      const options = { method: "GET", headers: { Accept: "application/json" } };
      if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
        options.signal = AbortSignal.timeout(2000);
      }
      const probe = await fetch(`${candidate}/api/mail-window/?days=1`, options);
      const body = await probe.json();
      if (body && typeof body.status === "string") {
        return { base: candidate, source: "local" };
      }
    } catch (err) {
    }
  }

  return { base: MAIL_WINDOW_BACKEND_BASE, source: "hosted" };
}

// The server keeps nothing: it reports every UID currently in the window, which
// of them are unread, and sends full details only for mails newer than ours.
async function applyMailWindowSync(payload, metaExtra = {}) {
  const db = await openMailWindowDb();
  const tx = db.transaction([MAIL_WINDOW_EMAILS, MAIL_WINDOW_META], "readwrite");
  const emailsStore = tx.objectStore(MAIL_WINDOW_EMAILS);
  const metaStore = tx.objectStore(MAIL_WINDOW_META);

  const inWindow = new Set((payload.window_uids || []).map(Number));
  const unseen = new Set((payload.unseen_uids || []).map(Number));

  if (payload.full) emailsStore.clear();

  // Drop mails that left the window (older than 15 days, deleted or moved),
  // and refresh read/unread for the ones we keep.
  const cursorRequest = emailsStore.openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    const row = cursor.value;
    if (!inWindow.has(Number(row.uid))) {
      cursor.delete();
    } else {
      const isRead = !unseen.has(Number(row.uid));
      if (row.isRead !== isRead) cursor.update({ ...row, isRead });
    }
    cursor.continue();
  };

  for (const raw of payload.emails || []) {
    const emailRow = normalizeWindowEmail(raw);
    if (emailRow.receivedAt) emailsStore.put(emailRow);
  }

  const uids = [...inWindow];
  metaStore.put({
    key: MAIL_WINDOW_META_KEY,
    windowStart: payload.window_start,
    windowEnd: payload.window_end,
    syncedAt: payload.synced_at,
    count: payload.total_in_window,
    full: !!payload.full,
    uidValidity: payload.uid_validity || "",
    maxUid: uids.length ? Math.max(...uids) : 0,
    ...metaExtra,
  });

  await idbTxDone(tx);
}

// Saves MiniLM vectors next to their mails. Rows that disappeared meanwhile
// (left the window) are skipped.
async function saveMailVectors(items, model) {
  const db = await openMailWindowDb();
  const tx = db.transaction(MAIL_WINDOW_EMAILS, "readwrite");
  const store = tx.objectStore(MAIL_WINDOW_EMAILS);
  for (const { uid, vector } of items) {
    const request = store.get(Number(uid));
    request.onsuccess = () => {
      const row = request.result;
      if (row && vector) store.put({ ...row, vec: Float32Array.from(vector), vecModel: model });
    };
  }
  await idbTxDone(tx);
}

async function getMailWindowMeta() {
  try {
    const db = await openMailWindowDb();
    const store = db.transaction(MAIL_WINDOW_META, "readonly").objectStore(MAIL_WINDOW_META);
    const row = await idbRequest(store.get(MAIL_WINDOW_META_KEY));
    return row || null;
  } catch (err) {
    return null;
  }
}

async function getMailWindowEmails() {
  const db = await openMailWindowDb();
  const store = db.transaction(MAIL_WINDOW_EMAILS, "readonly").objectStore(MAIL_WINDOW_EMAILS);
  const rows = await idbRequest(store.getAll());
  return (rows || []).sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
}

async function clearMailWindow() {
  try {
    const db = await openMailWindowDb();
    const tx = db.transaction([MAIL_WINDOW_EMAILS, MAIL_WINDOW_META], "readwrite");
    tx.objectStore(MAIL_WINDOW_EMAILS).clear();
    tx.objectStore(MAIL_WINDOW_META).clear();
    await idbTxDone(tx);
  } catch (err) {
  }
  // Cached attachment text is mail content too — it belongs to this login.
  try {
    await clearAttachmentTextCache();
  } catch (err) {
  }
}

/* -------------------- Attachment text cache (chat reuse) -------------------- */
// Summarize and Reply already convert the open mail's files into text. Keep a
// small copy — already run through the same secret redaction as mail bodies —
// so the chat can answer questions about those files again without
// re-downloading or re-converting anything. Keyed by mail uid, capped at the
// newest few mails, and cleared with the local mail copy (account switch).
const ATTACHMENT_CACHE_KEY = "attachmentTextCache";
const ATTACHMENT_CACHE_MAX_MAILS = 8;
const ATTACHMENT_CACHE_MAX_CHARS = 8000;

async function getAttachmentTextCache() {
  const stored = await mailWindowStorageGet([ATTACHMENT_CACHE_KEY]);
  const cache = stored[ATTACHMENT_CACHE_KEY];
  return cache && typeof cache === "object" ? cache : {};
}

async function saveAttachmentTextCache(mail, entries) {
  const uid = mail && Number(mail.uid);
  if (!Number.isFinite(uid) || uid <= 0) return;

  const blocks = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.text)
    .map((entry) => {
      const text = String(entry.text);
      return {
        filename: String(entry.filename || "attachment").slice(0, 120),
        text:
          text.length > ATTACHMENT_CACHE_MAX_CHARS
            ? `${text.slice(0, ATTACHMENT_CACHE_MAX_CHARS)}\n\n*(cached text truncated)*`
            : text,
      };
    });
  if (!blocks.length) return;

  const cache = await getAttachmentTextCache();
  cache[String(uid)] = { blocks, savedAt: new Date().toISOString() };

  // Keep only the newest few mails so the cache never grows without bound.
  // Same-millisecond saves tie-break on the uid (a higher IMAP uid is newer).
  Object.keys(cache)
    .sort((a, b) => {
      const right = Date.parse(cache[b].savedAt) || 0;
      const left = Date.parse(cache[a].savedAt) || 0;
      if (right !== left) return right - left;
      return (Number(b) || 0) - (Number(a) || 0);
    })
    .slice(ATTACHMENT_CACHE_MAX_MAILS)
    .forEach((key) => {
      delete cache[key];
    });

  await new Promise((resolve) => {
    chrome.storage.local.set({ [ATTACHMENT_CACHE_KEY]: cache }, resolve);
  });
}

function clearAttachmentTextCache() {
  return new Promise((resolve) => {
    chrome.storage.local.remove([ATTACHMENT_CACHE_KEY], resolve);
  });
}

async function syncMailWindow(options = {}) {
  const force = options.force !== false;
  const days = options.days || MAIL_WINDOW_DAYS;

  const stored = await mailWindowStorageGet(["ldap_user", "ldap_pass", "backendBaseUrl"]);
  if (!stored.ldap_user || !stored.ldap_pass) {
    return {
      ok: false,
      error: "Save your LDAP ID and access token in the LDAP Credentials section first.",
    };
  }

  const meta = await getMailWindowMeta();
  const lastSyncMs = meta && meta.syncedAt ? Date.parse(meta.syncedAt) : 0;

  if (!force && lastSyncMs && Date.now() - lastSyncMs < MAIL_WINDOW_SYNC_GAP_MS) {
    return { ok: true, skipped: true, meta };
  }

  const target = await detectMailWindowBackend(stored);
  const base = target.base;
  const params = new URLSearchParams({ days: String(days) });
  const localCount = (await getMailWindowEmails().catch(() => [])).length;
  if (meta && meta.uidValidity && meta.maxUid && localCount) {
    params.set("uidvalidity", meta.uidValidity);
    params.set("max_uid", String(meta.maxUid));
  }

  let response;
  try {
    response = await fetch(`${base}/api/mail-window/?${params.toString()}`, {
      method: "GET",
      headers: {
        "X-LDAP-User": stored.ldap_user,
        "X-LDAP-Pass": stored.ldap_pass,
        "X-Client-Feature": "iitb-mail-extension",
        "X-Extension-Id": chrome.runtime.id,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Backend unreachable at ${base}. Is the local server running?`,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    payload = null;
  }

  if (!response.ok || !payload || payload.status !== "success") {
    const message = (payload && (payload.message || payload.error)) ||
      `Window sync failed (HTTP ${response.status}) at ${base}.` +
        (response.status === 404 ? " The server does not have the mail-window route." : "");
    return { ok: false, error: message };
  }

  await applyMailWindowSync(payload, {
    backendUsed: base,
    backendSource: target.source,
  });
  const nextMeta = await getMailWindowMeta();

  return {
    ok: true,
    skipped: false,
    full: !!payload.full,
    fetched: payload.count,
    stats: payload.stats || {},
    backend: { base, source: target.source },
    meta: nextMeta,
  };
}
