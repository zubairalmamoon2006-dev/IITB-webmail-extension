# Merge Report — how three old repos became `mail-iitb-merged` (v3.6)

## 1. Goal

- One repo that is strictly better than all three of its parents, on two axes:
  **minimise API token usage** and **maximise answer accuracy**.
- Hard constraints kept throughout: pinned manifest `key` and OAuth `client_id`
  **byte-identical** to `mail-iitb` v3.4 (same extension ID, no re-auth),
  `sensitive.js` / `backend/api/sensitive.py` rule-identical (shared fixture),
  and the **server never persists mail content** (daily summary stays client-side).

## 2. The three source repos

| Repo | Generation | What it was best at | What it lacked |
|---|---|---|---|
| `webmailExtensionUGAC-main/` (nested) | v3.3, oldest (friend's) | **Reading attachments**: PDF → Markdown via `/api/extract-pdf/` (pymupdf4llm), PNG/JPG to Gemini as real image parts — own-key only | No chat at all; server-side Gemini daily summary (`google-generativeai`); 5 MB proxy body |
| `mail-iitb/` | v3.4, newest | The **base**: 15-day on-device mail window (IndexedDB), MiniLM vectors in the extension, BM25+vector retrieval, chat with `[E#]` citations, sensitive-mail shield, client-side daily summary | Could not read attachments; chat blind to files; 200 KB proxy body |
| root `extension/` + `backend/` | parallel line | **Standalone chat window** (`chat-window.html/js/css`, `OPEN_CHAT_WINDOW`, webmail FAB) and the **Student Signature** template | Older chat layer, no mail window |

## 3. Merge method

- Base = **mail-iitb v3.4**; the other two were mined for their best parts and
  ported in. Originals were never edited.
- Old repos' **storage protocols were NOT merged**: the nested/baseline DB
  mail-window protocol, the server-side Gemini daily summary and the
  `pendingOpenUid` flow were all discarded — one storage design (mail-iitb's),
  one summary path (client-side), one chat.
- Verified byte-identity after the merge: manifest `key`, OAuth `client_id`,
  `sensitive.js`, `backend/api/sensitive.py` (hash-compared against v3.4).

## 4. Feature-by-feature provenance

### From the nested repo (v3.3, attachment readers)
- `classifyAttachment` + `extractAttachments` in `content.js` — 3 files,
  best-first, Roundcube download-link discovery → ported as-is.
- `parsePdfAttachment` — POST base64 to `localhost:8000` then the configured
  backend → ported **+ improved** (8 s AbortController timeout, accepts the
  server's `markdown` key too).
- `processAttachment` — text/PDF/image/binary dispatch → ported, **minus** its
  raw-PDF-to-Gemini fallback (replaced by an honest "model has NOT seen this"
  stub: through the proxy that fallback never worked anyway, and pretending
  otherwise is worse than saying no).
- Backend `/api/extract-pdf/` — pymupdf4llm, first **8 pages / 20k chars /
  15 MB** → ported identical, **+ added**: extension-ID allowlist, 20/min/IP
  rate limit, 405/403/400 handling, and 7 tests (the old repo had **zero**).
- Proxy inline **images** (`image/*` pass-through) → ported **+ capped**
  (≤2 files, ≤2.8M base64 chars, 8 MB body — old repo: unbounded, 5 MB).
- `requirements.txt`: `pymupdf`, `pymupdf4llm` → ported; `google-generativeai`
  and `google-genai` deliberately **not** (privacy rule: no server-side Gemini).
- Old summarize prompt's per-file attachment rules were **re-designed**, not
  copied: mail-iitb's single-paragraph format kept for plain mails, strict
  per-file rules grafted on via the `ATTACHMENTS` block + honesty rules.

### From mail-iitb v3.4 (the base — kept whole)
- Manifest (pinned `key`, `client_id`), side panel, background proxy with the
  own-key direct path, model list plumbing.
- 15-day mail window: server `/api/mail-window/` (IMAP, stateless) → IndexedDB
  locally; incremental sync by `max_uid` + `uidvalidity`.
- On-device search: MiniLM embeddings in the extension (`offscreen.js`,
  `inbox-prep.js`, 23 MB model, no network), `retrieval.js` BM25+vector+RRF
  with date/sender/recency boosts.
- Chat: `chat.js`/`context.js` (index + top-K full texts, `[E#]` citations),
  40-turn history, last 6 turns sent.
- Sensitive-mail shield (both halves, shared fixture), client-side Daily
  Summary with 7-day cache, calendar flow.

### From the baseline root tree (parallel line)
- **Standalone chat window**: `chat-window.html/js/css` + `OPEN_CHAT_WINDOW`
  in `background.js` + webmail FAB → ported, **+ fixed** (script order — the
  baseline copy omitted `sensitive.js`/`retrieval.js` and would throw at first
  use; chat list/note/error CSS added).
- **Student Signature** template: popup section, `popup.js` signature module
  (save/load/build/auto-append/Insert-Now), `content.js` `insertSignature` +
  `INSERT_SIGNATURE` handler (top-frame guard) → ported and wired into the
  async Reply/Compose flows.

## 5. Bugs found and fixed during/after the merge

1. **Chat dropped the 7th question** — proxy trimmed `contents[:6]` while chat
   sends 6 history turns + the question; the trim now keeps the newest 6 and
   the live question.
2. **Attachment limits misaligned** — client allowed 4 MB images the proxy
   silently stripped; client caps now equal the server caps (2 MB ≈ 2.8M b64).
3. **Standalone chat window crashed at first use** — missing script includes
   (see above).
4. **Rescheduled/stale info** ("latest mail wins") — added `RET_UPDATE_PATTERN`
   + `retTopicKeys()`: the newest update mail per topic gets an `update` boost
   and skips the past penalty; chat prompt gained a conflict-resolution rule
   (rescheduled quiz from 21 Oct → 15 Oct now answered correctly).
5. **Chat refused attachment questions flatly** — prompt now redirects to the
   Summarize flow with the exact steps instead of "I can't".
6. **Model dropdown** trimmed to `gemini-3.8-flash` (default) +
   `gemini-3.5-flash-lite`; retired models in saved settings auto-upgrade.
7. **Hosted server 404s** — the Cloud Run deployment predates
   `/api/mail-window/` and `/api/extract-pdf/`; diagnosed, local backend
   documented as the stopgap, redeploy command in the README.
8. **Cache eviction tie-break** (found by the new test): same-millisecond cache
   saves evicted the newest mail; now tie-breaks on the IMAP uid.

## 6. New work on top of the merge (v3.5 → v3.6)

- **Chat × attachments, path 1 — the open mail joins the question**:
  `fetchOpenMailForChat()` (works from panel and floating window), body
  excerpt + converted attachment text (≤20k) + images as real parts (≤2, the
  proxy cap). Status line: "used the open mail + its files".
- **Chat × attachments, path 2 — Summarize/Reply results are cached**:
  converted, redacted file text kept per mail uid (newest 8 mails, 8k/file,
  `store.js`), injected into later chat contexts (≤6k/mail, ≤18k/question),
  cleared with the local mail copy on logout. Index flags
  "attachment text available".
- **Shared `attachments.js`** — the attachment pipeline was extracted out of
  `popup.js` so the standalone chat window can use the same code
  (one implementation, both pages); `buildBackendUrl` moved to `store.js`.
- **Attachment names as metadata** — the server now sends file names per mail
  (`collect_attachment_names`; sensitive mails leak none), the window stores
  them, and the chat index shows `files: manual.pdf, inline.png`, so "which
  mails have a png" is answered as a lookup with citations.
- **Anti-hallucination rules** — "stay on the exact question asked; if the
  context cannot answer, say so and point to Summarize; never switch topics".

## 7. Verification evidence

- 14 extension JS files: `node --check` clean.
- Django backend: **37/37** tests (proxy sanitising, newest-contents fix,
  inline images, PDF e2e conversion, rate limits, mail-window incl. the two
  new attachment-metadata tests, sensitive no-filename-leak).
- Extension rules: **24/24** sensitive samples (shared fixture with server).
- Retrieval: **13/13** checks incl. 2 reschedule regressions.
- Attachment cache/window rows: dedicated node suite (caps, eviction,
  keying, redaction, sensitive stripping).
- Live smoke test: `POST /api/extract-pdf/` with a generated PDF → HTTP 200,
  correct Markdown text out; chat sync verified against the local backend.

## 8. Still pending

- Redeploy the Cloud Run backend so hosted mode gets `/api/mail-window/` and
  `/api/extract-pdf/` (`cd backend && gcloud run deploy webmailextensionugac-260151192882 --region asia-south1 --source .`).
- Nothing has been committed anywhere (no git repo yet) — commit when ready.
