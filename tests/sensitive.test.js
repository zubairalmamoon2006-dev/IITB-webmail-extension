// Run: node tests/sensitive.test.js
const assert = require("assert");
const path = require("path");
const { protectMail } = require(path.join(__dirname, "..", "extension", "sensitive.js"));
const { samples } = require(path.join(__dirname, "sensitive_samples.json"));

let failures = 0;
for (const s of samples) {
  try {
    const r = protectMail({ subject: s.subject, senderName: s.sender_name, senderEmail: s.sender_email, body: s.body });
    assert.strictEqual(r.sensitive !== null, s.expect === "hidden", `expected ${s.expect}, got ${r.sensitive}`);
    const text = `${r.subject} ${r.body}`;
    for (const k of s.must_keep || []) assert.ok(text.includes(k), `lost "${k}"`);
    for (const k of s.must_remove || []) assert.ok(!text.includes(k), `kept "${k}"`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${s.name}: ${err.message}`);
  }
}
console.log(`${samples.length - failures}/${samples.length} sensitive samples pass`);
process.exit(failures ? 1 : 0);
