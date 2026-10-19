// Runs in the background worker. Keeps the local 15-day mail copy fresh and
// searchable: sync new mails from the server, then turn each new mail into a
// MiniLM vector (in the offscreen page) and save it next to the mail.
// The side panel follows progress through chrome.storage.session.

const INBOX_PREP_STATE_KEY = "inboxPrepState";
const EMBED_MODEL_ID = "all-MiniLM-L6-v2-q8";
const EMBED_BATCH_SIZE = 8;
const OFFSCREEN_PATH = "offscreen.html";

const CHAT_WAIT_MAX_PENDING = 24;

let inboxPrepPromise = null;
let inboxSyncedPromise = null; // resolves when the current run has finished syncing
let offscreenCreating = null;
let inboxPrepState = {};

function writeInboxPrepState(patch) {
  inboxPrepState = { ...inboxPrepState, ...patch, updatedAt: Date.now() };
  return chrome.storage.session.set({ [INBOX_PREP_STATE_KEY]: inboxPrepState }).catch(() => {});
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Runs the local mail search model so mail text never leaves the laptop.",
      })
      .catch((err) => {
        if (!/single offscreen|already exists/i.test(String(err && err.message))) throw err;
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function askOffscreen(message) {
  await ensureOffscreenDocument();
  // The page may still be loading its scripts right after it is created.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
      if (response) return response;
    } catch (err) {
      if (!/Receiving end does not exist|message port closed/i.test(String(err && err.message))) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("The local search model did not start.");
}

async function embedTexts(texts) {
  const response = await askOffscreen({ type: "EMBED", texts });
  if (!response.ok) throw new Error(response.error || "The local search model failed.");
  return response.vectors;
}

function mailEmbedText(row) {
  const sender = row.senderName || row.senderEmail || "";
  const body = (row.body || row.excerpt || row.snippet || "").slice(0, 1500);
  return `${row.subject || ""}\nFrom: ${sender}\n${body}`;
}

async function embedPendingMails(onProgress) {
  const emails = await getMailWindowEmails(); // newest first
  const pending = emails.filter((row) => !row.sensitive && row.vecModel !== EMBED_MODEL_ID);
  let done = 0;
  if (onProgress) await onProgress(done, pending.length);

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(batch.map(mailEmbedText));
    // Saved batch by batch, so closing the panel midway loses nothing.
    await saveMailVectors(
      batch.map((row, index) => ({ uid: row.uid, vector: vectors[index] })),
      EMBED_MODEL_ID
    );
    done += batch.length;
    if (onProgress) await onProgress(done, pending.length);
  }
  return { ok: true, embedded: done };
}

async function countPendingVectors() {
  const emails = await getMailWindowEmails();
  return emails.filter((row) => !row.sensitive && row.vecModel !== EMBED_MODEL_ID).length;
}

async function runInboxPrep(force, onSynced) {
  await writeInboxPrepState({ phase: "syncing", error: "", embedError: "", done: 0, total: 0 });

  let sync;
  try {
    sync = await syncMailWindow({ force });
  } catch (err) {
    sync = { ok: false, error: (err && err.message) || String(err) };
  }

  onSynced(sync);

  if (!sync.ok) {
    const meta = await getMailWindowMeta();
    await writeInboxPrepState({
      phase: "error",
      error: sync.error,
      syncedAt: (meta && meta.syncedAt) || "",
      count: meta ? meta.count : 0,
    });
    return { ok: false, error: sync.error, hasCopy: !!(meta && meta.syncedAt), syncedAt: (meta && meta.syncedAt) || "" };
  }

  let embed;
  try {
    embed = await embedPendingMails((done, total) =>
      total ? writeInboxPrepState({ phase: "embedding", done, total }) : null
    );
  } catch (err) {
    // Search still works without vectors (keyword search only).
    embed = { ok: false, error: (err && err.message) || String(err) };
  }

  const meta = (await getMailWindowMeta()) || {};
  await writeInboxPrepState({
    phase: "ready",
    error: "",
    embedError: embed.ok ? "" : embed.error,
    syncedAt: meta.syncedAt || "",
    count: meta.count || 0,
    windowStart: meta.windowStart || "",
    windowEnd: meta.windowEnd || "",
    backendUsed: meta.backendUsed || "",
    backendSource: meta.backendSource || "",
    skipped: !!sync.skipped,
  });

  return {
    ok: true,
    skipped: !!sync.skipped,
    full: !!sync.full,
    fetched: sync.fetched || 0,
    syncedAt: meta.syncedAt || "",
    count: meta.count || 0,
    embedded: embed.ok ? embed.embedded : 0,
    embedError: embed.ok ? "" : embed.error,
  };
}

// One run at a time: the panel opening, the Sync button and a chat question
// can all ask for it, and they share the same run.
function prepareInbox({ force = false } = {}) {
  if (inboxPrepPromise && force) {
    // A forced refresh (Sync button) waits for the current run, then syncs again.
    return inboxPrepPromise.catch(() => {}).then(() => prepareInbox({ force: true }));
  }
  if (!inboxPrepPromise) {
    let markSynced;
    inboxSyncedPromise = new Promise((resolve) => {
      markSynced = resolve;
    });
    inboxPrepPromise = runInboxPrep(force, markSynced).finally(() => {
      markSynced({ ok: false, error: "Sync stopped." }); // no-op if already resolved
      inboxPrepPromise = null;
    });
  }
  return inboxPrepPromise;
}

// For a chat question: wait until new mail is synced. Also wait for the search
// vectors if only a few mails need them (normal case); on the very first run,
// when hundreds of mails are still being prepared, answer right away with
// whatever is ready (keyword search covers the rest).
async function prepareInboxForChat() {
  const run = prepareInbox({ force: false });
  const synced = await inboxSyncedPromise;
  if (!synced || !synced.ok) return run;
  if ((await countPendingVectors()) <= CHAT_WAIT_MAX_PENDING) return run;
  const meta = (await getMailWindowMeta()) || {};
  return { ok: true, partial: true, syncedAt: meta.syncedAt || "", count: meta.count || 0 };
}

async function embedQuery(text) {
  const vectors = await embedTexts([String(text || "").slice(0, 1000)]);
  return { ok: true, vector: vectors[0], model: EMBED_MODEL_ID };
}
