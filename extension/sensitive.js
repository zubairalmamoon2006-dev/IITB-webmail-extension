// Keeps OTPs, login codes, password-reset links and bank alerts away from
// Gemini and out of the local mail copy. Same rules as backend/api/sensitive.py;
// both are checked against tests/sensitive_samples.json, so change them together.
// Works in the side panel, the background worker and Node (for tests).

const SENSITIVE_SUBJECT = "Sensitive mail hidden";
const SENSITIVE_NOTE =
  "This mail looks like an OTP, login code, password reset or bank alert, " +
  "so its content is hidden and never sent to Gemini.";

const SENS_PROXIMITY_KEYWORD_RE = new RegExp(
  "\\b(?:otp" +
    "|one[\\s-]?time[\\s-]?(?:password|passcode|pin|code)" +
    "|(?:verification|security|login|log[\\s-]?in|sign[\\s-]?in|authentication|auth" +
    "|confirmation|access|single[\\s-]?use|2fa|apple\\s+id|account)\\s+code" +
    "|two[\\s-]?(?:factor|step)\\s+(?:authentication|verification|code))\\b",
  "gi"
);
const SENS_DIRECT_CODE_RE =
  /\b(?:code|your\s+pin|your\s+passcode)\s*(?:is\s*:?|:)\s*(\d{4,8}|\d{3}[\s-]\d{3})(?![\w])/i;
const SENS_DIGIT_RUN_RE = /(?<![\w/:.])\d+(?:[ -]\d+)*(?![\w/:])(?!\.\d)/g;
const SENS_MONTH_RE = new RegExp(
  "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s*$" +
    "|(?:batch|class|year|spring|autumn|fall|summer|winter|of|in|since)\\s*$",
  "i"
);
const SENS_ADDRESS_BEFORE_RE = /(?:mumbai|powai|maharashtra|india|pin\s*code|pincode|pin)\W{0,3}$/i;
const SENS_UNIT_AFTER_RE = new RegExp(
  "^\\s*(?:hrs?|hours?|mins?|minutes?|students?|people|participants?|marks?|seats?|rs\\.?|inr" +
    "|rupees|km|am|pm|registrations?|teams?|members?|days?)\\b",
  "i"
);
const SENS_MONEY_BEFORE_RE = /(?:rs\.?|inr|₹)\s*$/i;
const SENS_PROXIMITY_CHARS = 120;

const SENS_RESET_RE = new RegExp(
  "\\b(?:(?:reset|recover|change)\\s+(?:your\\s+)?(?:\\w+\\s+)?password|password\\s+reset" +
    "|forgot(?:ten)?\\s+(?:your\\s+)?password)\\b",
  "i"
);
const SENS_MAGIC_LINK_RE =
  /\b(?:magic|login|log[\s-]?in|sign[\s-]?in)\s+link\b|\blink\s+(?:below\s+)?to\s+(?:sign|log)\s*in\b/i;
const SENS_TOKEN_URL_RE =
  /https?:\/\/\S*?(?:[?&](?:token|code|key|otp|auth|reset|t|state|sig|signature)=[\w%-]{8,}|\/[A-Za-z0-9_-]{24,})/i;

const SENS_BANK_SENDER_RE = new RegExp(
  "(?:hdfcbank|icicibank|sbi\\.co\\.in|onlinesbi|axisbank|kotak|yesbank|idfcfirst|indusind" +
    "|paytm|phonepe|bankofbaroda|pnb|canarabank|unionbank|federalbank|aubank|rblbank)",
  "i"
);
const SENS_BANK_CONTENT_RE = /\b(?:debited|credited|transaction|a\/c|account|balance|card|upi|otp)\b/i;

const SENS_MEETING_RE = /zoom\.us|meet\.google|webex|teams\.microsoft|\bmeeting\s+id\b/i;
const SENS_PASSWORD_VALUE_RE = /\b(password|passwd|pwd)(\s*(?:is\s*:?|:|=)\s*)(\S+)/gi;
const SENS_CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const SENS_AADHAAR_SPACED_RE = /(?<!\d)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?!\d)/g;
const SENS_AADHAAR_LABELLED_RE = /(\b(?:aadhaa?r|uid)\D{0,20})([2-9]\d{11})(?!\d)/gi;

function sensIsCodeRun(run) {
  const groups = run.split(/[ -]/);
  if (groups.length === 1) return groups[0].length >= 4 && groups[0].length <= 8;
  return groups.length === 2 && groups[0].length === 3 && groups[1].length === 3;
}

function sensCodePositions(text) {
  const positions = [];
  for (const match of text.matchAll(SENS_DIGIT_RUN_RE)) {
    const run = match[0];
    if (!sensIsCodeRun(run)) continue;
    const start = match.index;
    const end = start + run.length;
    const before = text.slice(Math.max(0, start - 16), start);
    const value = Number(run);
    if (run.length === 4 && value >= 1950 && value <= 2099 && SENS_MONTH_RE.test(before)) continue;
    if (SENS_ADDRESS_BEFORE_RE.test(before)) continue;
    if (SENS_MONEY_BEFORE_RE.test(before) || SENS_UNIT_AFTER_RE.test(text.slice(end, end + 16))) continue;
    positions.push([start, end]);
  }
  return positions;
}

function sensHasCodeNearKeyword(text) {
  const codes = sensCodePositions(text);
  if (!codes.length) return false;
  for (const keyword of text.matchAll(SENS_PROXIMITY_KEYWORD_RE)) {
    const kStart = keyword.index;
    const kEnd = kStart + keyword[0].length;
    for (const [start, end] of codes) {
      if (start >= kStart - SENS_PROXIMITY_CHARS && end <= kEnd + SENS_PROXIMITY_CHARS) return true;
    }
  }
  return false;
}

// Returns why a mail is sensitive ("otp", "password_reset", "bank") or null.
function sensitiveReason({ subject = "", senderName = "", senderEmail = "", body = "" } = {}) {
  const text = `${subject || ""}\n${body || ""}`;
  const sender = `${senderName || ""} ${senderEmail || ""}`;

  if (SENS_DIRECT_CODE_RE.test(text) || sensHasCodeNearKeyword(text)) return "otp";
  if ((SENS_RESET_RE.test(text) || SENS_MAGIC_LINK_RE.test(text)) && SENS_TOKEN_URL_RE.test(text)) {
    return "password_reset";
  }
  if (SENS_BANK_SENDER_RE.test(sender) && SENS_BANK_CONTENT_RE.test(text)) return "bank";
  return null;
}

function sensLuhnOk(digits) {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let value = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    total += value;
  }
  return total % 10 === 0;
}

// Blanks clear secrets inside an otherwise normal mail.
function redactSecrets(text) {
  if (!text) return text || "";
  let out = String(text);

  if (!SENS_MEETING_RE.test(out)) {
    out = out.replace(SENS_PASSWORD_VALUE_RE, (m, word, sep) => `${word}${sep}[hidden]`);
  }
  out = out.replace(SENS_CARD_RE, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && sensLuhnOk(digits) ? "[card number hidden]" : m;
  });
  out = out.replace(SENS_AADHAAR_LABELLED_RE, (m, label) => `${label}[ID number hidden]`);
  out = out.replace(SENS_AADHAAR_SPACED_RE, "[ID number hidden]");
  return out;
}

// Returns { sensitive: reason|null, subject, body }.
function protectMail(mail = {}) {
  const reason = sensitiveReason(mail);
  if (reason) return { sensitive: reason, subject: SENSITIVE_SUBJECT, body: "" };
  return {
    sensitive: null,
    subject: redactSecrets(mail.subject || ""),
    body: redactSecrets(mail.body || ""),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { protectMail, sensitiveReason, redactSecrets, SENSITIVE_SUBJECT, SENSITIVE_NOTE };
}
