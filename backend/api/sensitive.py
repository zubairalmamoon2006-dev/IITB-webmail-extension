"""Keeps OTPs, login codes, password-reset links and bank alerts out of every
feature. A sensitive mail is replaced by a stub (sender + time only) before it
leaves the server, so it is never stored in the extension or sent to Gemini.
Normal mails pass through, with only clear secrets blanked (a typed password,
a card number, an Aadhaar number).

The same rules live in extension/sensitive.js. Both are checked against
tests/sensitive_samples.json, so change them together.
"""
import re

SENSITIVE_SUBJECT = "Sensitive mail hidden"
SENSITIVE_NOTE = (
    "This mail looks like an OTP, login code, password reset or bank alert, "
    "so its content is hidden and never sent to Gemini."
)

# Keywords that only count when a code-like number is close by.
PROXIMITY_KEYWORD_RE = re.compile(
    r"\b(?:otp"
    r"|one[\s-]?time[\s-]?(?:password|passcode|pin|code)"
    r"|(?:verification|security|login|log[\s-]?in|sign[\s-]?in|authentication|auth"
    r"|confirmation|access|single[\s-]?use|2fa|apple\s+id|account)\s+code"
    r"|two[\s-]?(?:factor|step)\s+(?:authentication|verification|code))\b",
    re.IGNORECASE,
)
# "code is 552901", "your PIN: 4821": the number has to follow right away.
DIRECT_CODE_RE = re.compile(
    r"\b(?:code|your\s+pin|your\s+passcode)\s*(?:is\s*:?|:)\s*(\d{4,8}|\d{3}[\s-]\d{3})(?![\w])",
    re.IGNORECASE,
)
# Runs of digit groups ("482913", "459-321", "022 2576 4022", "14-10-26").
DIGIT_RUN_RE = re.compile(r"(?<![\w/:.])\d+(?:[ -]\d+)*(?![\w/:])(?!\.\d)")
MONTH_RE = re.compile(
    r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s*$"
    r"|(?:batch|class|year|spring|autumn|fall|summer|winter|of|in|since)\s*$",
    re.IGNORECASE,
)
ADDRESS_BEFORE_RE = re.compile(
    r"(?:mumbai|powai|maharashtra|india|pin\s*code|pincode|pin)\W{0,3}$", re.IGNORECASE
)
# "1500 students", "2359 hrs", "Rs 5000": counts and amounts, not codes.
UNIT_AFTER_RE = re.compile(
    r"^\s*(?:hrs?|hours?|mins?|minutes?|students?|people|participants?|marks?|seats?|rs\.?|inr"
    r"|rupees|km|am|pm|registrations?|teams?|members?|days?)\b",
    re.IGNORECASE,
)
MONEY_BEFORE_RE = re.compile(r"(?:rs\.?|inr|₹)\s*$", re.IGNORECASE)
PROXIMITY_CHARS = 120

RESET_RE = re.compile(
    r"\b(?:(?:reset|recover|change)\s+(?:your\s+)?(?:\w+\s+)?password|password\s+reset"
    r"|forgot(?:ten)?\s+(?:your\s+)?password)\b",
    re.IGNORECASE,
)
MAGIC_LINK_RE = re.compile(
    r"\b(?:magic|login|log[\s-]?in|sign[\s-]?in)\s+link\b|\blink\s+(?:below\s+)?to\s+(?:sign|log)\s*in\b",
    re.IGNORECASE,
)
TOKEN_URL_RE = re.compile(
    r"https?://\S*?(?:[?&](?:token|code|key|otp|auth|reset|t|state|sig|signature)=[\w%-]{8,}"
    r"|/[A-Za-z0-9_-]{24,})",
    re.IGNORECASE,
)

BANK_SENDER_RE = re.compile(
    r"(?:hdfcbank|icicibank|sbi\.co\.in|onlinesbi|axisbank|kotak|yesbank|idfcfirst|indusind"
    r"|paytm|phonepe|bankofbaroda|pnb|canarabank|unionbank|federalbank|aubank|rblbank)",
    re.IGNORECASE,
)
BANK_CONTENT_RE = re.compile(
    r"\b(?:debited|credited|transaction|a/c|account|balance|card|upi|otp)\b", re.IGNORECASE
)

MEETING_RE = re.compile(r"zoom\.us|meet\.google|webex|teams\.microsoft|\bmeeting\s+id\b", re.IGNORECASE)
PASSWORD_VALUE_RE = re.compile(r"\b(password|passwd|pwd)(\s*(?:is\s*:?|:|=)\s*)(\S+)", re.IGNORECASE)
CARD_RE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
AADHAAR_SPACED_RE = re.compile(r"(?<!\d)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?!\d)")
AADHAAR_LABELLED_RE = re.compile(r"(\b(?:aadhaa?r|uid)\D{0,20})([2-9]\d{11})(?!\d)", re.IGNORECASE)


def _is_code_run(run):
    groups = re.split(r"[ -]", run)
    if len(groups) == 1:
        return 4 <= len(groups[0]) <= 8
    return len(groups) == 2 and len(groups[0]) == 3 and len(groups[1]) == 3


def _code_positions(text):
    positions = []
    for match in DIGIT_RUN_RE.finditer(text):
        run = match.group(0)
        if not _is_code_run(run):
            continue
        before = text[max(0, match.start() - 16):match.start()]
        if len(run) == 4 and 1950 <= int(run) <= 2099 and MONTH_RE.search(before):
            continue  # a year: "Oct 2026", "Batch of 2027"
        if ADDRESS_BEFORE_RE.search(before):
            continue  # a pincode: "Mumbai 400076"
        if MONEY_BEFORE_RE.search(before) or UNIT_AFTER_RE.search(text[match.end():match.end() + 16]):
            continue
        positions.append((match.start(), match.end()))
    return positions


def _has_code_near_keyword(text):
    codes = _code_positions(text)
    if not codes:
        return False
    for keyword in PROXIMITY_KEYWORD_RE.finditer(text):
        for start, end in codes:
            if start >= keyword.start() - PROXIMITY_CHARS and end <= keyword.end() + PROXIMITY_CHARS:
                return True
    return False


def sensitive_reason(subject="", sender_name="", sender_email="", body=""):
    """Returns why a mail is sensitive ("otp", "password_reset", "bank") or None."""
    text = f"{subject or ''}\n{body or ''}"
    sender = f"{sender_name or ''} {sender_email or ''}"

    if DIRECT_CODE_RE.search(text) or _has_code_near_keyword(text):
        return "otp"
    if (RESET_RE.search(text) or MAGIC_LINK_RE.search(text)) and TOKEN_URL_RE.search(text):
        return "password_reset"
    if BANK_SENDER_RE.search(sender) and BANK_CONTENT_RE.search(text):
        return "bank"
    return None


def _luhn_ok(digits):
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def redact_secrets(text):
    """Blanks clear secrets inside an otherwise normal mail."""
    if not text:
        return text or ""

    if not MEETING_RE.search(text):
        text = PASSWORD_VALUE_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}[hidden]", text)

    def card(match):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and _luhn_ok(digits):
            return "[card number hidden]"
        return match.group(0)

    text = CARD_RE.sub(card, text)
    text = AADHAAR_LABELLED_RE.sub(lambda m: f"{m.group(1)}[ID number hidden]", text)
    text = AADHAAR_SPACED_RE.sub("[ID number hidden]", text)
    return text


def protect_mail(subject="", sender_name="", sender_email="", body=""):
    """Returns {"sensitive": reason or None, "subject": ..., "body": ...}."""
    reason = sensitive_reason(subject, sender_name, sender_email, body)
    if reason:
        return {"sensitive": reason, "subject": SENSITIVE_SUBJECT, "body": ""}
    return {
        "sensitive": None,
        "subject": redact_secrets(subject or ""),
        "body": redact_secrets(body or ""),
    }
