function cleanMailBody(text) {
  if (!text) return "";
  return text
    .replace(/=+/g, "")
    .replace(/If you reply to mails received.*?\n/gi, "")
    .replace(/please take care.*?\n/gi, "")
    .replace(/NOT\*\*/gi, "")
    .replace(/To unsubscribe.*?\n/gi, "")
    .replace(/Your subscribed address.*?\n/gi, "")
    .replace(/automated message.*?\n/gi, "")
    .replace(/do not reply.*?\n/gi, "")
    .replace(/PLEASE READ BELOW.*?\n/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


chrome.storage.local.get(['pendingCompose'], (result) => {
  if (result.pendingCompose) {
    const { subject, body, timestamp } = result.pendingCompose;
    if (Date.now() - timestamp < 30000) {
      handleNewComposeInjection(subject, body);
    }
    chrome.storage.local.remove('pendingCompose');
  }
});

function handleNewComposeInjection(subject, body) {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;

    const subjectField = document.getElementById('compose-subject') ||
                         document.querySelector('input[name="_subject"]');

    const bodyIframe = document.getElementById('composebody_ifr') ||
                       document.getElementById('_message_ifr');

    const bodyTextarea = document.getElementById('composebody') ||
                         document.querySelector('textarea[name="_message"]');

    if (subjectField && subject) {
      subjectField.value = subject;
    }

    if (bodyIframe || bodyTextarea) {
      if (bodyIframe) {
        try {
          const doc = bodyIframe.contentDocument || bodyIframe.contentWindow.document;
          if (doc && doc.body) {
             const htmlBody = (body || "").replace(/\n/g, '<br>');

             if (subject === null) {
                doc.body.innerHTML = htmlBody + "<br><br>" + doc.body.innerHTML;
             } else {
                doc.body.innerHTML = htmlBody;
             }

             console.log("IITB Assistant: Fields injected into Iframe.");
             clearInterval(timer);
          }
        } catch (e) {
          console.error("Iframe access blocked", e);
        }
      } else if (bodyTextarea) {
        if (subject === null) {
            bodyTextarea.value = (body || "") + "\n\n" + bodyTextarea.value;
        } else {
            bodyTextarea.value = body || "";
        }
        console.log("IITB Assistant: Fields injected into Textarea.");
        clearInterval(timer);
      }
    }

    if (attempts > 60) {
      clearInterval(timer);
      console.warn("IITB Assistant: Timeout waiting for compose fields.");
    }
  }, 500);
}

async function injectNewCompose(subject, body) {
  const isReply = (subject === null);

  if (isReply) {
    const replyBtn =
        document.querySelector('a.button.reply[title="Reply to sender"]') ||
        document.querySelector('a.button.reply') ||
        document.getElementById('rcmbtn124') ||
        document.querySelector('.toolbar a.reply');

    if (replyBtn) {
        chrome.storage.local.set({
            pendingCompose: { subject: null, body: body, timestamp: Date.now() }
        }, () => {
            replyBtn.click();
        });
    } else {
        handleNewComposeInjection(null, body);
    }
  } else {
    const composeBtn = document.getElementById('rcmbtn107') ||
                        document.querySelector('a.compose[title="Create a new message"]') ||
                        document.querySelector('a.compose');

    if (composeBtn) {
      chrome.storage.local.set({
        pendingCompose: { subject, body, timestamp: Date.now() }
      }, () => {
        composeBtn.click();
      });
    } else {
      console.log("IITB Assistant: No compose button found, checking if fields already exist...");
      handleNewComposeInjection(subject, body);
    }
  }
}

function tryExtractMailBody() {
  let body = "";

  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const f of iframes) {
    try {
      const doc = f.contentDocument;
      if (!doc || !doc.body) continue;

      // Attachment chrome ("Download attachment", sizes, view links) would
      // otherwise be read out as if it were part of the letter.
      doc.querySelectorAll(
        "#attachment-list, .attachmentslist, #messageattachments, .message-attachments, ul.attachments"
      ).forEach((n) => n.remove());

      const text = doc.body.innerText?.trim() || "";
      if (text.length > body.length) body = text;
    } catch {}
  }

  if (!body) {
    const bodyEl = document.querySelector(
      "#message-content, .message-body, .preview-pane, .mail-body, article"
    );
    if (bodyEl) {
      const clone = bodyEl.cloneNode(true);
      clone
        .querySelectorAll(
          "script, style, iframe, #attachment-list, .attachmentslist, #messageattachments, .message-attachments, ul.attachments"
        )
        .forEach((n) => n.remove());
      body = clone.innerText.trim();
    }
  }

  if (body) {
    body = cleanMailBody(body)
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !/^(download|view)\s+(the\s+)?attachment\b/i.test(t) && !/^attachment\s*:\s*\S/i.test(t);
      })
      .join("\n")
      .trim();
  }

  return body || null;
}


/* -------------------- Attachments -------------------- */

// The open mail's files, so Summarize and Reply can read them too.
//   pdf   -> sent to the backend (/api/extract-pdf/) and returned as text
//   text  -> read right here in the page
//   image -> passed through as a real image the model can see
//   other -> honestly labelled unreadable; never guessed at
const MAX_ATTACHMENTS = 3;
const ATTACHMENT_TEXT_LIMIT = 15000;
const ATTACHMENT_MAX_BYTES = { text: 5 * 1024 * 1024, pdf: 15 * 1024 * 1024, image: 2 * 1024 * 1024 };

function classifyAttachment(filename = "") {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const textExtensions = new Set([
    "txt", "csv", "tsv", "md", "json", "py", "c", "cpp", "h", "hpp",
    "java", "html", "htm", "xml", "tex", "yaml", "yml", "log", "sql", "sh", "ini", "env"
  ]);
  const imageExtensions = new Set(["png", "jpg", "jpeg", "webp"]);

  if (ext === "pdf") return "pdf";
  if (textExtensions.has(ext)) return "text";
  if (imageExtensions.has(ext)) return "image";
  return "binary";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? result.split(",")[1] : "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Inline images: pasted/embedded <img> tags in the mail body (diagrams,
// screenshots, figures) — NOT listed in the attachment bar. The old trees
// never read these, so a professor's pasted figure was invisible to Summarize.
const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // matches ATTACHMENT_MAX_BYTES.image
const INLINE_IMAGE_MIN_BYTES = 2048; // skip tracking pixels / tiny icons
const MAX_INLINE_IMAGES = 2; // proxy allows ≤ 2 image parts per request

function messageBodyRoots() {
  const roots = [];
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      if (frame.contentDocument && frame.contentDocument.body) {
        roots.push(frame.contentDocument);
      }
    } catch (err) {
      // cross-origin frame — skip
    }
  }
  const bodyEl = document.querySelector(
    "#message-content, .message-body, .preview-pane, .mail-body, article, #rcmmessagecontent"
  );
  if (bodyEl) roots.push(bodyEl);
  if (!roots.length) roots.push(document);
  return roots;
}

function isLikelyContentImage(img) {
  const w = Number(img.getAttribute("width") || img.width || 0);
  const h = Number(img.getAttribute("height") || img.height || 0);
  if (w && h && w <= 64 && h <= 64) return false;

  const src = img.getAttribute("src") || "";
  if (!src) return false;
  if (src.startsWith("cid:")) return false; // Roundcube usually rewrites these; raw cid: is unfetchable
  if (src.startsWith("data:image/svg+xml")) return false; // icons / spacers

  const cls = `${img.className || ""} ${img.id || ""}`;
  if (/logo|icon|avatar|spacer|pixel|badge|smime|emoji|tracking/i.test(cls)) return false;

  return true;
}

function dataUrlToBlob(src) {
  const match = src.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!match) return null;
  const mime = match[1] || "image/png";
  if (!mime.startsWith("image/")) return null;
  if (match[2]) {
    const bin = atob(match[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(match[3])], { type: mime });
}

async function extractInlineBodyImages(seenKeys) {
  const results = [];
  const seenSrc = new Set();

  for (const root of messageBodyRoots()) {
    const imgs = Array.from(root.querySelectorAll("img"));
    for (const img of imgs) {
      if (results.length >= MAX_INLINE_IMAGES) break;
      if (!isLikelyContentImage(img)) continue;

      const src = img.getAttribute("src") || img.src || "";
      if (!src || seenSrc.has(src)) continue;
      seenSrc.add(src);

      try {
        let blob = null;
        let mimeType = "";

        if (src.startsWith("data:")) {
          blob = dataUrlToBlob(src);
          if (!blob) continue;
          mimeType = blob.type || "image/png";
        } else {
          const res = await fetch(src, { credentials: "include" });
          if (!res.ok) continue;
          blob = await res.blob();
          mimeType = blob.type || "";
          if (mimeType && !mimeType.startsWith("image/")) continue;
          if (!mimeType) {
            const path = src.split("?")[0];
            const ext = (path.split(".").pop() || "png").toLowerCase();
            const known = ["png", "jpeg", "webp", "gif", "bmp"];
            mimeType = `image/${ext === "jpg" ? "jpeg" : known.includes(ext) ? ext : "png"}`;
          }
        }

        if (!blob || !blob.size) continue;
        if (blob.size > INLINE_IMAGE_MAX_BYTES || blob.size < INLINE_IMAGE_MIN_BYTES) continue;

        const base64 = await blobToBase64(blob);
        if (!base64) continue;

        const ext = (mimeType.split("/")[1] || "png").replace("jpeg", "jpg");
        const filename = `inline-image-${results.length + 1}.${ext}`;
        const normKey = filename.toLowerCase();
        if (seenKeys && seenKeys.has(normKey)) continue;
        if (seenKeys) seenKeys.add(normKey);

        results.push({
          filename,
          type: "image",
          base64,
          mimeType,
          sizeBytes: blob.size,
          inline: true,
        });
      } catch (err) {
        console.warn("IITB Assistant: could not extract inline image", err);
      }
    }
    if (results.length >= MAX_INLINE_IMAGES) break;
  }

  return results;
}

async function extractAttachments() {
  const roots = [document];
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try {
      if (frame.contentDocument) roots.push(frame.contentDocument);
    } catch (err) {
      // cross-origin frame — skip
    }
  }

  const candidates = [];
  const seenFilenames = new Set();
  const LIST_SELECTOR =
    '#attachment-list li, .attachmentslist li, #messageattachments li, .message-attachments li, ul.attachments > li';
  const LINK_SELECTOR =
    '#attachment-list a, .attachmentslist a, #messageattachments a, .message-attachments a, a[href*="_action=get"], a[href*="_action=preview"], a.attachment-link, a[download]';

  for (const root of roots) {
    const listItems = Array.from(root.querySelectorAll(LIST_SELECTOR));
    const links = listItems.length
      ? listItems
          .map((li) =>
            li.querySelector('a[href*="_action=get"]') ||
            li.querySelector("a[download]") ||
            li.querySelector('a[href*="_action=preview"]') ||
            li.querySelector("a")
          )
          .filter(Boolean)
      : Array.from(root.querySelectorAll(LINK_SELECTOR));

    for (const link of links) {
      if (!link || !link.href) continue;
      const text = `${link.innerText || ""} ${link.title || ""} ${(link.closest("li") || {}).innerText || ""}`.trim();
      const match = text.match(/([a-zA-Z0-9_\-\.\s\(\)]+\.[a-zA-Z0-9]{2,5})/i);
      const filename = (match ? match[1] : link.title || link.innerText || "attachment").trim();
      const normKey = filename.toLowerCase();
      if (filename && !seenFilenames.has(normKey)) {
        seenFilenames.add(normKey);
        candidates.push({ filename, href: link.href });
      }
    }
  }

  // Readable first: PDF, then text, then images, then whatever we cannot read.
  const rank = { pdf: 0, text: 1, image: 2, binary: 3 };
  candidates.sort(
    (a, b) => (rank[classifyAttachment(a.filename)] ?? 3) - (rank[classifyAttachment(b.filename)] ?? 3)
  );

  const results = [];
  for (const item of candidates.slice(0, MAX_ATTACHMENTS)) {
    const type = classifyAttachment(item.filename);

    if (type === "binary") {
      results.push({
        filename: item.filename,
        type: "binary",
        text: `[Attachment: ${item.filename} (binary/archive format — content not directly readable)]`,
      });
      continue;
    }

    try {
      const res = await fetch(item.href, { credentials: "include" });
      if (!res.ok) continue;
      const blob = await res.blob();
      const limit = ATTACHMENT_MAX_BYTES[type];
      if (limit && blob.size > limit) continue;

      if (type === "text") {
        let text = await blob.text();
        if (text.length > ATTACHMENT_TEXT_LIMIT) {
          text = `${text.slice(0, ATTACHMENT_TEXT_LIMIT)}\n\n*(Truncated: text file exceeded ${ATTACHMENT_TEXT_LIMIT.toLocaleString()} characters)*`;
        }
        results.push({ filename: item.filename, type: "text", text, sizeBytes: blob.size });
      } else if (type === "pdf") {
        const base64 = await blobToBase64(blob);
        if (base64) {
          results.push({ filename: item.filename, type: "pdf", base64, mimeType: "application/pdf", sizeBytes: blob.size });
        }
      } else if (type === "image") {
        const base64 = await blobToBase64(blob);
        if (base64) {
          const ext = (item.filename.split(".").pop() || "png").toLowerCase();
          results.push({
            filename: item.filename,
            type: "image",
            base64,
            mimeType: `image/${ext === "jpg" ? "jpeg" : ext}`,
            sizeBytes: blob.size,
          });
        }
      }
    } catch (err) {
      console.warn("IITB Assistant: could not extract attachment", err);
    }
  }

  // Inline body images (pasted/embedded figures) fill any remaining slots.
  // File attachments stay first — they are what the user explicitly attached.
  try {
    if (results.length < MAX_ATTACHMENTS) {
      const inlineImages = await extractInlineBodyImages(seenFilenames);
      for (const img of inlineImages) {
        if (results.length >= MAX_ATTACHMENTS) break;
        results.push(img);
      }
    }
  } catch (err) {
    console.warn("IITB Assistant: inline image extraction failed", err);
  }

  return results;
}


function waitForMailBody(maxAttempts = 10, interval = 300) {
  return new Promise(resolve => {
    let attempts = 0;

    const timer = setInterval(() => {
      const body = tryExtractMailBody();
      attempts++;

      if (body) {
        clearInterval(timer);
        resolve(body);
      } else if (attempts >= maxAttempts) {
        clearInterval(timer);
        resolve(null);
      }
    }, interval);
  });
}


function findReplyButton(root = document) {
  return root.querySelector(
    'a.reply[title="Reply to sender"], a.reply#rcmbtn124'
  );
}

function findReplyEditor(root = document) {
  return (
    root.querySelector('textarea#composebody') ||
    root.querySelector('textarea[name="_message"]') ||
    root.querySelector('textarea[name="body"]') ||
    root.querySelector('textarea')
  );
}

function fillReplyEditor(replyText) {
  const replyBtn =
    document.querySelector('a.button.reply[title="Reply to sender"]') ||
    document.querySelector('a.button.reply') ||
    document.getElementById('rcmbtn124') ||
    document.querySelector('.toolbar a.reply');

  if (!replyBtn) {
    console.error("IITB Assistant: Reply button not found.");
    return;
  }

  replyBtn.click();

  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    const editor = document.querySelector('textarea#composebody') ||
                   document.querySelector('textarea[name="_message"]');

    if (editor) {
      editor.value = replyText + "\n\n" + editor.value;
      clearInterval(timer);
    }
    if (attempts >= 20) clearInterval(timer);
  }, 500);
}


/* -------------------- Signature Insertion -------------------- */

// Appends the saved signature to whichever compose/reply editor is open.
// Works for both the TinyMCE iframe (HTML mode) and the plain textarea.
function insertSignature(signatureText) {
  if (!signatureText) return false;

  let inserted = false;

  // 1. TinyMCE Iframe (HTML mode) — ID 'composebody_ifr'
  const bodyIframe = document.getElementById('composebody_ifr') ||
                     document.getElementById('_message_ifr');
  if (bodyIframe) {
    try {
      const doc = bodyIframe.contentDocument || bodyIframe.contentWindow.document;
      if (doc && doc.body) {
        // Convert newlines to <br> and avoid duplicating the signature
        const htmlSig = signatureText.replace(/\n/g, '<br>');
        if (!doc.body.innerHTML.includes(htmlSig)) {
          const sep = doc.body.innerHTML.trim() && doc.body.innerHTML.trim() !== "<br>" ? "<br><br>" : "";
          doc.body.innerHTML = doc.body.innerHTML + sep + htmlSig;
        }
        inserted = true;
      }
    } catch (e) {
      console.error("Iframe access blocked", e);
    }
  }

  // 2. Standard Textarea (Plain text mode) — ID 'composebody' / name '_message'
  if (!inserted) {
    const bodyTextarea = document.getElementById('composebody') ||
                         document.querySelector('textarea[name="_message"]');
    if (bodyTextarea) {
      if (!bodyTextarea.value.includes(signatureText)) {
        const sep = bodyTextarea.value.trim() ? "\n\n" : "";
        bodyTextarea.value = bodyTextarea.value + sep + signatureText;
      }
      inserted = true;
    }
  }

  return inserted;
}


// Best-effort identity of the open mail. Roundcube keeps the uid in the URL
// and the sender/subject in the message header; the panel uses them to key
// its local attachment-text cache. Anything not found stays empty — never
// guessed.
function openedMailUid() {
  try {
    const uid = Number(new URLSearchParams(window.location.search).get("_uid"));
    return Number.isFinite(uid) && uid > 0 ? uid : null;
  } catch (err) {
    return null;
  }
}

function openedMailHeaderPart(part) {
  const el = document.querySelector(
    `#rcmmessageheader .${part}, .message-header .${part}, .messagecontent .${part}`
  );
  return el ? String(el.textContent || "").trim().slice(0, 300) : "";
}


chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req?.type === "GET_OPENED_MAIL") {
    waitForMailBody().then(async (body) => {
      if (!body) {
        sendResponse({ ok: false, error: "No opened mail detected" });
        return;
      }

      let attachments = [];
      try {
        attachments = await extractAttachments();
      } catch (err) {
        console.warn("IITB Assistant: attachment extraction failed", err);
      }

      sendResponse({
        ok: true,
        mail: {
          uid: openedMailUid(),
          subject: openedMailHeaderPart("subject"),
          from: openedMailHeaderPart("from"),
          body,
          attachments,
        },
      });
    });

    return true;
  }

  if (req?.type === "FILL_REPLY") {
    fillReplyEditor(req.replyText);
    sendResponse({ ok: true });
  }

  if (req?.type === "COMPOSE_NEW_MAIL") {
    injectNewCompose(req.subject, req.body);
    sendResponse({ ok: true });
  }

  /* ---------- Insert saved signature into open compose/reply box ---------- */
  if (req?.type === "INSERT_SIGNATURE") {
    // Only the top frame owns the compose box.
    if (window !== window.top) return;
    const ok = insertSignature(req.signature);
    sendResponse({ ok: ok });
  }

  return true;
});


function teammate_tryExtractMailBody() {
  let body = "";
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const f of iframes) {
    try {
      const doc = f.contentDocument;
      if (!doc || !doc.body) continue;
      const text = doc.body.innerText?.trim() || "";
      if (text.length > body.length) body = text;
    } catch {}
  }
  return body;
}


let hasOpenedOnce = false;

document.addEventListener('click', (e) => {
    if (hasOpenedOnce) return;

    const isMailItem = e.target.closest('tr[id^="rcmrow"]') ||
                        e.target.closest('.message-list-item') ||
                        e.target.closest('.messagelist tr');

    if (isMailItem) {
        console.log("IITB Assistant: First mail detected. Opening Side Panel...");
        hasOpenedOnce = true;
        chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" });
    }
});
