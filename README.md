# Mail IITB — Unified (v3.6)

Chrome extension + Django backend for IIT Bombay webmail, by the DAV Team, UGAC.

This repository is **one merged generation built from the best of three** copies of
this product. Everything here has been syntax-checked and is covered by three test
suites (35 backend tests, 24 sensitive-mail samples, the full retrieval suite).

| Source tree | Generation | What it was best at | Taken into this repo |
|---|---|---|---|
| `mail-iitb` (v3.4) | newest | the merge **base**: on-device MiniLM search, sensitive-mail shield, stateless server, dark mode, client-side daily dashboard | the whole tree |
| baseline `extension/` + `backend/` | parallel line | the **standalone chat window** | `chat-window.html/js/css`, the background window manager, the panel's "Open in window" button, `Icons/` (verified byte-identical) |
| nested `webmailExtensionUGAC-main/` | oldest (v3.3) | **reading attachments** | `extractAttachments`/`parsePdfAttachment`/`processAttachment` in the extension + `POST /api/extract-pdf/` on the server |

---

## What is in this repo

### Side panel (`popup.*`, opens as side panel or action popup)

- **Daily Summary dashboard** — one click per date. Fetches that day's raw mails
  (`/api/daily-summary/`), asks Gemini **from the extension** for structured JSON,
  and renders: overview, statistics cards (total/unread/read/external), action-item
  list with priorities, unread/read digests, and a per-mail summary grid with
  click-to-open. 7-day local cache.
- **Chat with my inbox** — question → on-device retrieval → answer with clickable
  `[E12]` citations that open the mail in webmail. Suggestions, history (40 turns
  kept locally), Clear chat, Expand-to-full-panel, **Open in window**. The chat
  also **reads files**: the mail open in webmail joins each question with its body
  and attachments (PDF text, images as real image parts), and any file you already
  read through Summarize/Reply is reused from a small local cache — see below.
- **Summarize this email** (brief/detailed) — now reads the open mail's
  **attachments** too (see below), and can add calendar events from the same reply.
- **AI Reply Generator** — with the mail's attachments available as context.
- **Student Signature** — save your name, roll number and (optionally) programme,
  department, batch, contact and alternate email once. The AI uses it as the
  `[Your Name] / [Roll Number]` block in generated replies and composed mails,
  auto-appends it on inject when the toggle is on, and **Insert Now** adds it to
  the compose/reply box currently open in webmail (plain textarea or TinyMCE).
- **Compose New Mail**, **Add to Calendar** (Google OAuth, the pinned `client_id`),
  **voice input**, **dark mode**, **Expand** for chat and daily.

### Standalone chat window (from the baseline tree)

- `chat-window.html/js/css` — a floating popup window with a splash screen and the
  chat layer. It loads the **same** `attachments.js / store.js / retrieval.js /
  context.js / chat.js` as the panel, so there is only one chat implementation in
  the extension.
- Opened from the panel's **Open in window** button (`OPEN_CHAT_WINDOW` in
  `background.js`; re-focuses instead of spawning a second copy).
- Clicking a citation focuses webmail first, opens the mail through the background
  worker's Roundcube injection, then **minimises itself** so the mail owns the
  foreground. The robot FAB on the webmail page brings the chat back.
- `chat-window.html` loads `sensitive.js` and `retrieval.js` explicitly — the
  baseline copy did not, which would have thrown at first use.

### On-device search (mail-iitb, unchanged)

1. On first open the background worker (`inbox-prep.js`) syncs the last **15 days**
   of mail from the backend into **IndexedDB on the laptop**; later runs only fetch
   new mails.
2. Every mail becomes a **MiniLM vector inside the extension** (`offscreen.js`,
   all-MiniLM-L6-v2 via onnxruntime-web + wasm). Nothing leaves the device for this.
3. A question is parsed for dates, scored with **BM25 + vectors, merged with RRF**,
   plus boosts (date match, prof/TA sender, recency, unread) — `retrieval.js`.
4. `context.js` sends Gemini a one-line index of every mail plus the full text of
   the best matches (300k char budget with your own key, 110k through the proxy).

### Attachments (from the nested tree, re-wired)

When **Summarize** or **Reply** runs on an open mail, the content script now also
returns up to **3 attachments, best-first** (`extractAttachments` in `content.js`,
by fetching Roundcube's download links):

| Kind | What happens |
|---|---|
| **PDF** | base64 → `POST /api/extract-pdf/` (local server first, then the configured backend, 8 s timeout) → Markdown in the prompt |
| **text** (`txt,csv,md,py,…`, ≤5 MB) | read in the page, truncated at 15k chars |
| **image** (`png,jpg,jpeg,webp`, ≤2 MB) | passed to Gemini as a real `inline_data` file part |
| **anything else** | an honest “not directly readable” note — never guessed at |

Every attachment text passes through the **same `protectMail` redaction as a mail
body** before entering a prompt (an OTP in a `.txt` file is blanked like one in the
email). Prompts get an `ATTACHMENTS` block with strict rules: address each file by
name, only use what is actually in it, say plainly when a file cannot be read.

### Chat × attachments (the two reuse paths)

The chat answers from the stored text window, which has no files — but it gets
attachment content in two cheap ways (both reuse work already done, so extra token
cost is only paid when it actually helps):

1. **The open mail joins the question.** When webmail has a mail open, asking the
   chat appends that mail's subject/sender, a short body excerpt (4k chars) and its
   converted attachment text (≤20k chars) to the question, and passes its **images
   as real image parts** (≤2, the proxy's cap — oversized ones are dropped here
   instead of silently server-side). So: open the PDF mail → ask chat about it →
   chat answers from the PDF/PNG itself. Sensitive mails are excluded by the same
   shield as everywhere else.
2. **Summarize/Reply results are cached for chat.** The converted text of a file
   (already redacted) is kept locally per mail — newest **8 mails, 8k chars per
   file** — and rides along with its mail in later chat contexts (≤6k per mail,
   ≤18k per question). The mail index flags those mails with
   “attachment text available”, so chat can even list which mails' files it can
   read. The cache dies with the local mail copy (account switch / logout).

Anything else stays on the Summarize path: chat says so and gives the exact step
(“open the mail → Summarize Mail”), never a flat refusal.

### Sensitive-mail shield (unchanged, both halves)

OTP, login-code, password-reset and bank mails are replaced by a stub on the server
(`backend/api/sensitive.py`) and checked again in the extension
(`extension/sensitive.js`). They are never stored and never sent to Gemini. Both
files use the **same rules** and are tested against the shared fixture
`tests/sensitive_samples.json` — and both were verified byte-identical to the
mail-iitb originals in this merge.

---

## Layout

```
mail-iitb-merged/
├── backend/                  Django 6 server — stateless (reads mail over IMAP, stores nothing)
│   ├── api/views.py          gemini-proxy · daily-summary · mail-window · extract-pdf
│   ├── api/sensitive.py      sensitive-mail rules (mirrors extension/sensitive.js)
│   ├── api/tests.py          35 tests
│   ├── mail_backend/settings.py   all limits are env-tunable
│   └── requirements.txt      + pymupdf, pymupdf4llm (PDF attachments)
├── extension/                Chrome extension (MV3) — load THIS folder unpacked
│   ├── manifest.json         v3.6 - pinned `key` and OAuth `client_id` byte-identical to v3.4
│   ├── popup.html/js/css     the side panel
│   ├── chat-window.html/js/css   standalone chat window (baseline tree)
│   ├── background.js         + chat-window manager (`OPEN_CHAT_WINDOW`)
│   ├── content.js            + attachment extraction
│   ├── attachments.js        PDF/image/text files — shared by panel and chat window
│   ├── chat.js · context.js · retrieval.js · store.js · inbox-prep.js
│   ├── sensitive.js · chat-fab.js · theme.js · offscreen.*
│   ├── models/ · embed/      on-device MiniLM + onnxruntime (23 MB model, no network)
│   └── Icons/
├── tests/                    node tests + shared sensitive fixture
└── README.md                 this file
```

---

## Backend endpoints

| Endpoint | Method | Does | Guards |
|---|---|---|---|
| `/api/gemini-proxy/` | POST | passes a sanitised Gemini request with the server key | extension-ID allowlist, 300 req/min/IP, 8 MB body, 120k chars text, 8192 output tokens, keeps the **newest 6** contents, inline images ≤ 2 × ~2 MB and `image/*` only; preserves `temperature`, `responseMimeType`, `systemInstruction` |
| `/api/daily-summary/?date=` | GET | returns that day's **raw mails** (UIDs + text) — summarising happens in the extension | LDAP credentials headers, no server-side summary |
| `/api/mail-window/?days=N` | GET | incremental mail window for local sync (default 15, max 45) | LDAP headers |
| `/api/extract-pdf/` | POST | PDF → Markdown (`pymupdf4llm`), stateless | allowlist, **20 conversions/min/IP**, 15 MB, first 8 pages / 20k chars |

Hosted: `https://webmailextensionugac-260151192882.asia-south1.run.app` ·
local: `http://127.0.0.1:8000` / `http://localhost:8000` (auto-detected).

> **Hosted deployment status (checked 18 Oct 2026):** the Cloud Run service still
> runs the **old baseline-era backend** — `/api/gemini-proxy/` and
> `/api/daily-summary/` respond, but `/api/mail-window/` and `/api/extract-pdf/`
> return **404** (they were never deployed). Every flow now **prefers the local
> backend when it is running** — mail-window auto-detects it, and PDF conversion
> and the Daily Summary try `127.0.0.1:8000` first and fall back to the saved
> Backend URL — so with `runserver` up everything works. Against the hosted
> server alone, Summarize / Reply / Compose / Calendar / Daily Summary work
> while **Chat sync, auto-research and PDF attachment conversion need a
> redeploy**. To redeploy: `cd backend && gcloud run deploy
> webmailextensionugac-260151192882 --region asia-south1 --source .`
> (dependencies now include `pymupdf`/`pymupdf4llm`).

## Privacy guarantees

- **The server never persists mail content.** `api/models.py` holds no models; the
  migration pair `0001_initial` → `0002_remove_stored_mail` exists only to remove the
  old storage. Daily summary, chat and attachment conversion are stateless reads.
- **Daily summary Gemini runs in the extension** — `google-generativeai` stays out
  of the backend (it was dropped in v3.4 and this merge keeps it dropped).
- **Sensitive mails** never reach Gemini (double filter, shared test fixture).
- **Search runs on your laptop** — vectors never leave the device.
- The manifest `key` (pinned extension ID) and OAuth `client_id` are
  **byte-identical to v3.4** — re-verified by hash during the merge, as are
  `sensitive.js`, `sensitive.py` and the shared fixture.

## Fixed in this merge

1. **The chat's current question was silently dropped when history was full.**
   The proxy trimmed `contents[:6]` while the chat sends 6 history turns **plus**
   the question (7 total) — the just-typed question was the one cut. Now the
   **newest** contents are kept (`contents[-6:]`), with a regression test
   (`test_sanitize_proxy_payload_keeps_the_newest_contents`).
2. **Inline image parts were silently stripped.** The proxy dropped any part
   without a `text` field; images now pass with the caps above. The body limit was
   raised 200 KB → 8 MB (the old nested copy had already hit this at 5 MB) and
   `DATA_UPLOAD_MAX_MEMORY_SIZE` is set — Django's 2.5 MB default would have
   rejected the JSON PDF body over ~1.8 MB, making the documented 15 MB limit a lie.
3. **Standalone chat window wired for v3.4** — script order fixed
   (`sensitive.js`, `retrieval.js`), chat list/note/error CSS added (answers used
   to render as one run-on paragraph), and citations now use the background
   `OPEN_MAIL` path instead of the baseline's removed `pendingOpenUid` mechanism.
4. **Attachment limits aligned end-to-end** (image ≤ 2 MB at the source = the
   server-side inline cap, PDF ≤ 15 MB everywhere).
5. **Rescheduled / cancelled events no longer lose to the stale announcement.**
   A quiz moved to an earlier (already past) date used to be *penalised* by
   retrieval for "only mentioning past dates" while the original announcement
   got the future-date boost — so the chat kept repeating the old date. Now the
   newest mail that revises a topic (rescheduled / postponed / cancelled /
   corrigendum / new date, matched by course code or subject thread) gets an
   `update` boost and skips the past penalty, and the chat prompt tells Gemini
   that the newest mail wins and to state the change
   (regression tests: `rescheduled quiz beats the stale announcement`,
   `update mail is never pushed down as past`).

## Deliberately NOT taken from the older trees

- The baseline's **DB-storing mail-window protocol** (`EmailMessage`, `DayCoverage`,
  `MailboxState`) — the server must not store mail.
- The **server-side Gemini daily summary** (`google-generativeai`) — summarising is
  client-side now.
- The nested copy's own `popup.js`/`content.js`/`background.js` wholesale — only the
  attachment pipeline was lifted out of it.
- The baseline's `pendingOpenUid` / `OPEN_MESSAGE` citation flow — superseded by
  mail-iitb's Roundcube injection, which works from the standalone window too.

---

## Run locally

Backend (Python 3.10+):

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt      # Django, cors, requests, pymupdf, pymupdf4llm
python manage.py migrate
DJANGO_DEBUG=True python manage.py runserver
```

Extension:

```bash
bash extension/models/get-model.sh   # only if models/all-MiniLM-L6-v2/onnx is missing
```

Then `chrome://extensions` → Developer mode → **Load unpacked** → pick the
`extension` folder. In the panel set the Backend URL to `http://localhost:8000`,
save your Gemini API key and your LDAP ID + access token.

## Tests

```bash
node tests/sensitive.test.js     # 24/24 samples — server and extension rules agree
node tests/retrieval.test.js     # BM25/vector/date/sensitive ranking
node tests/attachment-cache.test.js  # chat attachment cache: caps, eviction, redaction keys
cd backend && python manage.py test api    # 35 tests: proxy sanitising, newest-contents
                                            # fix, inline images, PDF conversion,
                                            # rate limits, mail-window, daily summary
```

## Limits & tuning (all env-tunable in `backend/mail_backend/settings.py`)

| Thing | Limit | Where |
|---|---|---|
| Mail window | 15 days (server max 45) | `store.js`, `/api/mail-window/` |
| Chat history kept / sent | 40 turns kept; last 6 sent + question | `chat.js` |
| Chat output tokens | 8192 (Gemini spends part on *thinking* — lower `CHAT_MAX_OUTPUT_TOKENS` in `chat.js` only if replies are consistently short) | `chat.js` |
| Daily prompt | 90k chars | `popup.js` |
| Attachments per prompt | 3, best-first | `content.js` |
| Attachment-text cache (chat) | 8 newest mails · 8k chars/file | `store.js` |
| Chat attachment injection | 6k chars/mail · 18k chars/question; open mail: 4k body + 20k files, ≤2 images | `context.js`, `chat.js` |
| PDF conversion | 15 MB · 8 pages · 20k chars · 20/min/IP | `views.py` |
| Inline images | 2/request · `image/*` · ≤2.8M base64 chars | `settings.py` |
| Proxy text/output | 120k chars / 8192 tokens per request | `settings.py` |

## Manual test checklist

1. **Load** the extension → no service-worker errors; panel opens from webmail;
   Sync fills the header with “N mails · dates”.
2. **Chat**: ask “Any deadlines in the next 7 days?” → answer with `[E#]` chips →
   clicking a chip opens that mail in webmail.
3. **Regression (fixed bug #1)**: ask **7 questions in one session** — the 7th must
   still be answered correctly; it used to be the one dropped.
4. **Open in window** button → floating chat with the same history → click a
   citation → window minimises, webmail focused → the robot FAB restores it.
5. **PDF attachment**: open a mail with a PDF → Summarize → “Reading mail &
   attachments…” → the summary reflects the PDF's content (needs a running backend).
6. **Reply** on the same mail → the draft is consistent with the attachment.
7. **Image attachment**: Summarize → model describes what it sees (own API key
   always; proxy path needs this backend deployed).
8. **Daily Summary** → generate → stats cards, action items, digests, per-mail grid.
9. **OTP mail** → Summarize → “sensitive” message; the mail never appears in chat.
10. **Dark mode** and **Expand** in both chat and daily sections.
11. **Student Signature**: fill name + roll → preview updates → Save → generate a
    Reply and a Compose → the draft ends with your real name/roll (with the
    auto-add toggle on). With a compose box open in webmail, **Insert Now** →
    “Signature inserted!”.
12. **Model dropdown** (after saving a custom API key): only
    `gemini-3.8-flash` and `gemini-3.5-flash-lite` are listed; an old saved
    model (e.g. `gemini-2.5-flash`) auto-upgrades to `gemini-3.8-flash` on open.
13. **Chat + open mail**: open a mail with a PDF → without closing it, ask the
    chat a question about the file → the status line ends with “used the open
    mail + its files” and the answer uses the PDF's content (needs a running
    backend for PDF conversion).
14. **Chat + cache**: after step 13 (or a Summarize on that mail), close the
    mail and ask the same question again → the mail's index line now shows
    “attachment text available” and the answer still uses the file's content,
    with no second download.
15. Run all four test suites above.

## Before deploying

- Remove the localhost auto-detect entries in `extension/store.js` and
  `extension/attachments.js` (the `/api/extract-pdf/` candidate) and the localhost
  host permissions in `extension/manifest.json` if the extension should only talk
  to the hosted backend.
- The hosted `/api/mail-window/` and `/api/extract-pdf/` URLs are now in
  `host_permissions` (v3.4 shipped without them, so hosted sync and attachment
  summaries only worked against localhost) — no manual step needed for those.
- Deploy the backend with `requirements.txt` (the `pymupdf` entries are new) and
  confirm `/api/extract-pdf/` answers before testing attachment summaries against
  the hosted URL.
