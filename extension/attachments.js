/* -------------------- Attachments (shared) -------------------- */
// Loaded by the side panel AND the standalone chat window: the chat joins the
// open mail's files to a question exactly the way Summarize does.
// Depends on: store.js (buildBackendUrl), sensitive.js (protectMail).

// The content script hands us the open mail's files, best-first: text files
// already read, PDFs as base64 for the backend to convert, images as base64
// to show the model. Anything that enters a prompt is run through the same
// secret redaction as a mail body, so an OTP pasted into a .txt file is
// blanked exactly like one pasted into the email.
const ATTACHMENT_PDF_TIMEOUT_MS = 8000;
const ATTACHMENT_PROMPT_LIMIT = 20000;
const ATTACHMENT_MAX_IN_PROMPT = 3;

async function parsePdfAttachment(attachment) {
  if (!attachment || !attachment.base64) return null;

  // Local server first (it is faster when it is running), then whatever
  // backend the panel is configured to use.
  const candidates = ["http://127.0.0.1:8000/api/extract-pdf/", await buildBackendUrl("/api/extract-pdf/")];

  for (const backendUrl of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTACHMENT_PDF_TIMEOUT_MS);
      const response = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-Extension-Id": chrome.runtime.id,
          "X-Client-Feature": "iitb-mail-extension",
        },
        body: JSON.stringify({ filename: attachment.filename, base64: attachment.base64 }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) continue;
      const data = await response.json();
      const text = (data && (data.text || data.markdown)) || "";
      if (text) {
        return {
          filename: (data && data.filename) || attachment.filename,
          text,
          truncated: !!(data && data.truncated),
        };
      }
    } catch (err) {
      // server not running, timed out, or rejected it — try the next one
    }
  }

  return null;
}

async function processAttachment(attachment) {
  if (!attachment) return null;

  if (attachment.type === "text" && attachment.text) {
    return { filename: attachment.filename, type: "text", text: attachment.text };
  }

  if (attachment.type === "binary") {
    return {
      filename: attachment.filename,
      type: "binary",
      text: attachment.text || `[Attachment: ${attachment.filename} (binary/archive format — content not directly readable)]`,
    };
  }

  if (attachment.type === "image") {
    const source = attachment.inline
      ? "embedded in the email body"
      : "attached to the email";
    return {
      filename: attachment.filename,
      type: "image",
      text: `[Image ${source}: ${attachment.filename} — passed to the model as a real image.]`,
      file: { mimeType: attachment.mimeType || "image/png", base64: attachment.base64 },
    };
  }

  if (attachment.type === "pdf" || (attachment.filename || "").toLowerCase().endsWith(".pdf")) {
    const parsed = await parsePdfAttachment(attachment);
    if (parsed && parsed.text) {
      return { filename: parsed.filename, type: "pdf", text: parsed.text, truncated: parsed.truncated };
    }
    // Honest fallback: no pretending we read a PDF we could not convert.
    return {
      filename: attachment.filename,
      type: "pdf",
      text: `[Attached PDF: ${attachment.filename} — could not be converted to text (server unreachable). The model has NOT seen its contents.]`,
    };
  }

  return null;
}

async function buildAttachmentContext(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return { text: "", files: [], entries: [] };

  const blocks = [];
  const files = [];
  const entries = [];

  for (const attachment of attachments.slice(0, ATTACHMENT_MAX_IN_PROMPT)) {
    const item = await processAttachment(attachment);
    if (!item) continue;

    let text = String(item.text || "").slice(0, ATTACHMENT_PROMPT_LIMIT);
    const checked = protectMail({ body: text });
    text = (checked && checked.body) || text;

    if (item.file && item.file.base64) files.push(item.file);
    // Images are vision-only: no text worth caching for the chat.
    if (item.type !== "image" && text) entries.push({ filename: item.filename, text });
    blocks.push(`--- ATTACHED FILE: ${item.filename} (${item.type}) ---\n${text || "(no readable text)"}`);
  }

  if (!blocks.length) return { text: "", files: [], entries: [] };

  const imageNote = files.length
    ? "\n- Real image parts are attached below. You MUST describe what is visible in each image (diagram shapes, labels, dimensions, axes, charts, screenshots, handwriting) and connect it to the email text. Never merely mention the image filename without describing its content."
    : "";

  return {
    text:
      "\n\nATTACHMENTS (belong to the same email):\n" +
      blocks.join("\n\n") +
      "\n\nRules for attachments:\n" +
      "- Address each attached file under its own name.\n" +
      "- Use only what is actually in the files. Never invent contents.\n" +
      "- If a file cannot be read, say that plainly instead of guessing." +
      imageNote,
    files,
    entries,
  };
}
