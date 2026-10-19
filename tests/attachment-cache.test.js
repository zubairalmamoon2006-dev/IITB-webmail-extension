// Attachment-text cache (store.js) and its chat-side trimming (context.js):
// newest mails kept, per-mail char cap, per-question budget, uid keying.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Minimal chrome.storage.local stub shared by both scripts.
const backing = {};
global.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (k in backing) out[k] = JSON.parse(JSON.stringify(backing[k]));
        });
        cb(out);
      },
      set(values, cb) {
        Object.keys(values).forEach((k) => {
          backing[k] = JSON.parse(JSON.stringify(values[k]));
        });
        if (cb) cb();
      },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete backing[k]);
        if (cb) cb();
      },
    },
  },
};

// One eval = one lexical scope, mirroring how the browser shares top-level
// const/function declarations across the page's classic scripts.
// eslint-disable-next-line no-eval
eval(
  ["sensitive.js", "store.js", "context.js"]
    .map((file) => fs.readFileSync(path.join(__dirname, "..", "extension", file), "utf8"))
    .join("\n;\n")
);

async function run() {
  // No uid -> nothing cached (chat could never look it up).
  await saveAttachmentTextCache({ subject: "x" }, [{ filename: "a.pdf", text: "hello" }]);
  assert.strictEqual(Object.keys(await getAttachmentTextCache()).length, 0, "no uid must not cache");

  // Image-style empty entries are skipped; text entries stored under the uid.
  await saveAttachmentTextCache({ uid: 42 }, [
    { filename: "marks.pdf", text: "Quiz 2: 10 marks" },
    { filename: "pic.png", text: "" },
  ]);
  let cache = await getAttachmentTextCache();
  assert.ok(cache["42"], "cached under uid key");
  assert.strictEqual(cache["42"].blocks.length, 1, "empty-text entries skipped");
  assert.strictEqual(cache["42"].blocks[0].filename, "marks.pdf");

  // Per-mail char cap: an 9k-char file is stored cut to 8000 + note.
  await saveAttachmentTextCache({ uid: 43 }, [{ filename: "big.pdf", text: "x".repeat(9000) }]);
  cache = await getAttachmentTextCache();
  assert.ok(cache["43"].blocks[0].text.length < 8200, "per-mail cache cap applied");

  // Only the newest 8 mails survive.
  for (let uid = 100; uid < 110; uid += 1) {
    await saveAttachmentTextCache({ uid }, [{ filename: "f.txt", text: `mail ${uid}` }]);
  }
  cache = await getAttachmentTextCache();
  assert.strictEqual(Object.keys(cache).length, 8, "cache capped at 8 mails");
  assert.ok(cache["109"] && !cache["100"], "newest kept, oldest evicted");

  // chatAttachmentText: per-mail trim and hard budget stop.
  const entry = { blocks: [{ filename: "big.pdf", text: "y".repeat(20000) }] };
  const out = chatAttachmentText(entry, 18000);
  assert.ok(out.includes("[Attachment text — big.pdf]"), "block labelled with filename");
  assert.ok(out.includes("[...attachment truncated...]"), "over-long file trimmed");
  assert.ok(out.length <= 18000, "never exceeds the budget");
  assert.strictEqual(chatAttachmentText(entry, 100), "", "no room -> no block");
  assert.strictEqual(chatAttachmentText(null, 18000), "", "no entry -> no block");

  // Window rows keep attachment names (metadata), sensitive rows leak none.
  const row = normalizeWindowEmail({
    uid: 7,
    received_at: new Date().toISOString(),
    subject: "Lab manual",
    body: "Manual attached.",
    attachments: ["manual.pdf", "inline.png"],
  });
  assert.deepStrictEqual(row.attachments, ["manual.pdf", "inline.png"], "file names kept in the window row");
  const otpRow = normalizeWindowEmail({
    uid: 8,
    received_at: new Date().toISOString(),
    subject: "Your OTP is 445566",
    body: "Use OTP 445566 to log in.",
    attachments: ["bank-statement.pdf"],
  });
  assert.ok(otpRow.sensitive, "OTP mail marked sensitive");
  assert.deepStrictEqual(otpRow.attachments, [], "sensitive row leaks no filenames");

  // clearAttachmentTextCache wipes it (account switch / local-copy clear).
  await clearAttachmentTextCache();
  assert.strictEqual(Object.keys(await getAttachmentTextCache()).length, 0, "cleared");

  console.log("attachment-cache tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
