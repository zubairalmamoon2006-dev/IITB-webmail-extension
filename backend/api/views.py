import email
import imaplib
import json
import re
import ssl
from datetime import date, datetime, timedelta, timezone as dt_timezone
from email.header import decode_header
from email.utils import parseaddr, parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from zoneinfo import ZoneInfo

import requests
from django.conf import settings
from django.core.cache import cache
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt

from .sensitive import SENSITIVE_NOTE, SENSITIVE_SUBJECT, protect_mail

DEFAULT_PROXY_MODEL = "gemini-3.8-flash"
SUPPORTED_PROXY_MODELS = {
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
}

RETIRED_PROXY_MODEL_REPLACEMENTS = {
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
}
PROXY_MODEL_FALLBACKS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"]

class HTMLTextExtractor(HTMLParser):

    BLOCK_TAGS = {
        "br",
        "div",
        "p",
        "li",
        "tr",
        "table",
        "section",
        "article",
        "header",
        "footer",
    }
    SKIP_TAGS = {"script", "style", "head", "title", "meta", "noscript"}

    def __init__(self):
        super().__init__()
        self._parts = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in self.BLOCK_TAGS:
            self._parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0 and data:
            self._parts.append(data)

    def get_text(self):
        return "".join(self._parts)


def decode_mime_header(value):
    if not value:
        return ""

    decoded = []
    for part, encoding in decode_header(value):
        if isinstance(part, bytes):
            try:
                decoded.append(part.decode(encoding or "utf-8", errors="ignore"))
            except LookupError:
                decoded.append(part.decode("utf-8", errors="ignore"))
        else:
            decoded.append(part)
    return "".join(decoded).strip()


def decode_part_payload(part):
    payload = part.get_payload(decode=True)
    if isinstance(payload, bytes):
        charset = part.get_content_charset() or "utf-8"
        try:
            return payload.decode(charset, errors="ignore")
        except LookupError:
            return payload.decode("utf-8", errors="ignore")

    raw_payload = part.get_payload()
    if isinstance(raw_payload, str):
        return raw_payload
    return ""


def clean_extracted_text(text):
    if not text:
        return ""

    text = unescape(text)
    text = text.replace("\xa0", " ").replace("\u200b", "")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def html_to_text(html):
    if not html:
        return ""

    parser = HTMLTextExtractor()
    parser.feed(html)
    parser.close()
    return clean_extracted_text(parser.get_text())


def build_snippet(text, limit=320):
    cleaned = clean_extracted_text(text)
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: max(limit - 3, 0)].rstrip() + "..."


def clamp(value, low, high):
    return max(low, min(high, value))


def extract_best_body(message):
    plain_candidates = []
    html_candidates = []

    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        content_type = part.get_content_type()
        disposition = (part.get("Content-Disposition") or "").lower()

        if part.get_filename() or "attachment" in disposition:
            continue

        payload = decode_part_payload(part)
        if not payload:
            continue

        if content_type == "text/plain":
            plain_candidates.append(clean_extracted_text(payload))
        elif content_type == "text/html":
            html_candidates.append(html_to_text(payload))

    plain_candidates = [candidate for candidate in plain_candidates if candidate]
    if plain_candidates:
        return max(plain_candidates, key=len)

    html_candidates = [candidate for candidate in html_candidates if candidate]
    if html_candidates:
        return max(html_candidates, key=len)

    return ""


def classify_sender(sender_email):
    domain = sender_email.split("@")[-1].lower() if sender_email else ""
    return "internal" if domain.endswith("iitb.ac.in") else "external"


def collect_attachment_names(message, limit=8):
    """Filenames the mail carries — metadata only, never file contents.

    The chat index shows these so a question like "which mails have a png"
    can be answered from the window instead of being guessed at. Inline
    images without a filename count as 'inline.png' for the same reason.
    """
    names = []
    for part in message.walk():
        if part.is_multipart():
            continue
        filename = decode_mime_header(part.get_filename() or "").strip()
        if filename:
            names.append(filename[:120])
            continue

        maintype = (part.get_content_maintype() or "").lower()
        subtype = (part.get_content_subtype() or "file").lower()[:20]
        disposition = (part.get_content_disposition() or "").lower()
        if "pkcs7" in subtype or subtype == "signature":
            continue  # S/MIME bookkeeping, not something the user sent
        if maintype == "image":
            names.append(f"inline.{subtype}")
        elif disposition == "attachment" or maintype == "application":
            names.append(f"attachment.{subtype}")

        if len(names) >= limit:
            break
    return names[:limit]


def format_received_label(raw_value):
    if not raw_value:
        return "Today"

    try:
        dt = parsedate_to_datetime(raw_value)
        return dt.strftime("%d %b %H:%M")
    except Exception:
        return raw_value[:32]


def build_email_record(message, is_unread, uid=None):
    raw_from = decode_mime_header(message.get("From", ""))
    sender_name, sender_email = parseaddr(raw_from)
    sender_name = sender_name.strip() or sender_email or "Unknown sender"
    sender_email = sender_email.strip()

    subject = decode_mime_header(message.get("Subject", "")) or "(No subject)"
    body = extract_best_body(message)

    # OTPs, login codes, reset links and bank alerts never leave the server.
    protected = protect_mail(subject, sender_name, sender_email, body)
    if protected["sensitive"]:
        subject, snippet, excerpt = SENSITIVE_SUBJECT, SENSITIVE_NOTE, SENSITIVE_NOTE
    else:
        subject, body = protected["subject"], protected["body"]
        snippet_source = body or f"Subject: {subject}. From: {sender_name}."
        snippet = build_snippet(snippet_source, 320)
        excerpt = build_snippet(snippet_source, 900)

    return {
        "uid": uid,
        "subject": subject,
        "sender": sender_name,
        "sender_email": sender_email,
        "status": "unread" if is_unread else "read",
        "source": classify_sender(sender_email),
        "received_label": format_received_label(message.get("Date", "")),
        "snippet": snippet,
        "body_excerpt": excerpt,
        "sensitive": protected["sensitive"],
        "_body": body if not protected["sensitive"] else "",
    }


def build_stats(email_records, mailbox_total):
    unread_count = sum(1 for record in email_records if record["status"] == "unread")
    read_count = len(email_records) - unread_count
    internal_records = [record for record in email_records if record["source"] == "internal"]
    external_records = [record for record in email_records if record["source"] == "external"]

    return {
        "mailbox_total": mailbox_total,
        "processed_total": len(email_records),
        "total": len(email_records),
        "unread": unread_count,
        "read": read_count,
        "internal_total": len(internal_records),
        "external_total": len(external_records),
        "internal_unread": sum(1 for record in internal_records if record["status"] == "unread"),
        "external_unread": sum(1 for record in external_records if record["status"] == "unread"),
    }


def parse_requested_summary_date(request):
    raw_value = (request.GET.get("date") or "").strip()
    if not raw_value:
        return date.today(), None

    try:
        return date.fromisoformat(raw_value), None
    except ValueError:
        return None, "Invalid date format. Use YYYY-MM-DD."


def get_safe_fetch_query():
    return "(BODY.PEEK[])"


def resolve_proxy_request(data):
    if not isinstance(data, dict):
        return DEFAULT_PROXY_MODEL, {}

    model = data.get("model")
    if isinstance(model, str):
        model = RETIRED_PROXY_MODEL_REPLACEMENTS.get(model, model)
    if model not in SUPPORTED_PROXY_MODELS:
        model = DEFAULT_PROXY_MODEL

    payload = data.get("payload") if isinstance(data.get("payload"), dict) else data
    return model, payload


def is_model_unavailable_response(response):
    if response.status_code == 404:
        return True

    try:
        body = response.json()
    except ValueError:
        body = {}

    message = ""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        elif isinstance(error, str):
            message = error

    return bool(re.search(r"no longer available|not found|is not found|deprecated", message, re.I))


def build_secure_imap_ssl_context(compatibility_mode=False):
    context = ssl.create_default_context()

    if compatibility_mode:
        try:
            context.set_ciphers("DEFAULT:@SECLEVEL=1")
        except ssl.SSLError:
            pass

        tls_version = getattr(ssl, "TLSVersion", None)
        if tls_version is not None and hasattr(tls_version, "TLSv1"):
            try:
                context.minimum_version = tls_version.TLSv1
            except ValueError:
                pass

    return context


def should_retry_imap_with_compatibility(exc):
    message = str(exc).lower()
    retry_markers = (
        "handshake failure",
        "no shared cipher",
        "wrong version number",
        "version too low",
        "tlsv1 alert protocol version",
    )
    return any(marker in message for marker in retry_markers)


def connect_to_iitb_imap():
    strict_context = build_secure_imap_ssl_context()

    try:
        return imaplib.IMAP4_SSL(
            host="imap.iitb.ac.in",
            port=993,
            ssl_context=strict_context,
        )
    except ssl.SSLCertVerificationError:
        raise
    except ssl.SSLError as exc:
        if not should_retry_imap_with_compatibility(exc):
            raise

        compatibility_context = build_secure_imap_ssl_context(compatibility_mode=True)
        return imaplib.IMAP4_SSL(
            host="imap.iitb.ac.in",
            port=993,
            ssl_context=compatibility_context,
        )


def get_client_ip(request):
    forwarded_for = (request.META.get("HTTP_X_FORWARDED_FOR") or "").strip()
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return (request.META.get("REMOTE_ADDR") or "unknown").strip() or "unknown"


def is_allowed_extension_request(request):
    allowed_ids = getattr(settings, "ALLOWED_EXTENSION_IDS", []) or []
    if not allowed_ids:
        return True

    header_extension_id = (request.headers.get("X-Extension-Id") or "").strip()
    origin = (request.headers.get("Origin") or "").strip()
    allowed_origins = {f"chrome-extension://{extension_id}" for extension_id in allowed_ids}
    return header_extension_id in allowed_ids or origin in allowed_origins


def is_gemini_proxy_rate_limited(request):
    limit = max(int(getattr(settings, "GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE", 60)), 1)
    window_seconds = max(
        int(getattr(settings, "GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS", 60)),
        1,
    )
    client_ip = get_client_ip(request)
    cache_key = f"gemini-proxy-rate:{client_ip}"

    if cache.add(cache_key, 1, timeout=window_seconds):
        return False

    try:
        current_count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, timeout=window_seconds)
        return False

    return current_count > limit


def sanitize_proxy_payload(payload):
    if not isinstance(payload, dict):
        return None, "Invalid payload", 400

    contents = payload.get("contents")
    if not isinstance(contents, list) or not contents:
        return None, "Payload must include contents", 400

    max_total_chars = max(int(getattr(settings, "GEMINI_PROXY_MAX_TEXT_CHARS", 25000)), 1)
    remaining_chars = max_total_chars
    sanitized_contents = []

    # The chat sends the last few turns PLUS the current question. Trimming
    # from the front would throw away the question the user just typed, so
    # keep the NEWEST contents and let the oldest fall off.
    max_inline_files = max(int(getattr(settings, "GEMINI_PROXY_MAX_INLINE_FILES", 3)), 0)
    max_inline_b64_chars = max(int(getattr(settings, "GEMINI_PROXY_MAX_INLINE_B64_CHARS", 5500000)), 0)
    inline_files_left = max_inline_files

    for content in contents[-6:]:
        if not isinstance(content, dict):
            continue

        role = str(content.get("role") or "user").strip() or "user"
        raw_parts = content.get("parts")
        if not isinstance(raw_parts, list):
            continue

        sanitized_parts = []
        for part in raw_parts[:8]:
            if not isinstance(part, dict):
                continue

            text = part.get("text")
            if not isinstance(text, str):
                # A real file part (an attached image) rides along as
                # inline_data instead of being dropped on the floor.
                inline = part.get("inline_data") or part.get("inlineData")
                if isinstance(inline, dict) and inline_files_left > 0:
                    mime = str(inline.get("mime_type") or inline.get("mimeType") or "").strip()
                    data = inline.get("data")
                    if (
                        mime.startswith("image/")
                        and isinstance(data, str)
                        and 0 < len(data) <= max_inline_b64_chars
                    ):
                        sanitized_parts.append({"inline_data": {"mime_type": mime, "data": data}})
                        inline_files_left -= 1
                continue

            cleaned_text = text.strip()
            if not cleaned_text:
                continue

            if remaining_chars <= 0:
                break

            if len(cleaned_text) > remaining_chars:
                cleaned_text = cleaned_text[:remaining_chars]

            sanitized_parts.append({"text": cleaned_text})
            remaining_chars -= len(cleaned_text)

        if sanitized_parts:
            sanitized_contents.append({"role": role, "parts": sanitized_parts})

        if remaining_chars <= 0:
            break

    if not sanitized_contents:
        return None, "Payload does not contain supported text parts", 400

    sanitized_payload = {"contents": sanitized_contents}

    system_instruction = payload.get("systemInstruction")
    if isinstance(system_instruction, dict):
        sanitized_instruction, _, _ = sanitize_proxy_payload({"contents": [system_instruction]})
        if sanitized_instruction and sanitized_instruction.get("contents"):
            sanitized_payload["systemInstruction"] = sanitized_instruction["contents"][0]

    requested_generation_config = payload.get("generationConfig")
    requested_max_tokens = None
    if isinstance(requested_generation_config, dict):
        candidate_tokens = requested_generation_config.get("maxOutputTokens")
        if isinstance(candidate_tokens, int):
            requested_max_tokens = candidate_tokens

    max_output_tokens = max(int(getattr(settings, "GEMINI_PROXY_MAX_OUTPUT_TOKENS", 1536)), 256)
    generation_config = {
        "maxOutputTokens": min(requested_max_tokens or max_output_tokens, max_output_tokens)
    }

    if isinstance(requested_generation_config, dict):
        temperature = requested_generation_config.get("temperature")
        if isinstance(temperature, (int, float)) and not isinstance(temperature, bool):
            generation_config["temperature"] = min(max(float(temperature), 0.0), 2.0)

        mime_type = requested_generation_config.get("responseMimeType")
        if mime_type in ("application/json", "text/plain"):
            generation_config["responseMimeType"] = mime_type

    sanitized_payload["generationConfig"] = generation_config

    return sanitized_payload, None, 200


@csrf_exempt
def gemini_proxy(request):
    if request.method != "POST":
        return JsonResponse({"error": "Only POST allowed"}, status=405)

    try:
        max_body_bytes = max(
            int(getattr(settings, "GEMINI_PROXY_MAX_REQUEST_BODY_BYTES", 50000)),
            1024,
        )
        if len(request.body or b"") > max_body_bytes:
            return JsonResponse({"error": "Request body too large"}, status=413)

        if not request.body:
            return JsonResponse({"error": "Empty request body"}, status=400)

        if not is_allowed_extension_request(request):
            return JsonResponse({"error": "Unauthorized extension client"}, status=403)

        if is_gemini_proxy_rate_limited(request):
            return JsonResponse({"error": "Rate limit exceeded. Please try again shortly."}, status=429)

        data = json.loads(request.body)
        model, payload = resolve_proxy_request(data)
        sanitized_payload, payload_error, payload_status = sanitize_proxy_payload(payload)
        if payload_error:
            return JsonResponse({"error": payload_error}, status=payload_status)

        api_key = getattr(settings, "GEMINI_API_KEY", None)

        candidates = [model]
        for fallback in PROXY_MODEL_FALLBACKS:
            if fallback not in candidates:
                candidates.append(fallback)

        response = None
        for candidate in candidates:
            url = (
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{candidate}:generateContent?key={api_key}"
            )
            response = requests.post(url, json=sanitized_payload, timeout=60)
            if response.status_code == 200:
                model = candidate
                break
            if not is_model_unavailable_response(response):
                break

        if response.status_code != 200:
            return JsonResponse(
                {
                    "error": "Google API Error",
                    "details": response.text,
                },
                status=response.status_code,
            )

        gemini_response = response.json()

        text_content = ""
        if "candidates" in gemini_response and gemini_response["candidates"]:
            candidate = gemini_response["candidates"][0]
            if "content" in candidate and "parts" in candidate["content"]:
                for part in candidate["content"]["parts"]:
                    if "text" in part:
                        text_content += part["text"]

        return JsonResponse(
            {
                "ok": True,
                "text": text_content,
                "summary": text_content,
                "raw": gemini_response,
            }
        )

    except json.JSONDecodeError:
        return JsonResponse({"error": f"Invalid JSON: {request.body.decode()}"}, status=400)
    except Exception as exc:
        return JsonResponse({"error": str(exc)}, status=500)


def imap_search_uids(mail, start_day, end_day=None, unseen_only=False):
    """UIDs of inbox mails received on start_day..end_day (end_day inclusive, open if None)."""
    criteria = f'(SINCE "{start_day.strftime("%d-%b-%Y")}"'
    if end_day is not None:
        criteria += f' BEFORE "{(end_day + timedelta(days=1)).strftime("%d-%b-%Y")}"'
    if unseen_only:
        criteria += " UNSEEN"
    criteria += ")"

    status, data = mail.uid("search", None, criteria)
    if status != "OK" or not data or not data[0]:
        return []
    return [int(uid) for uid in data[0].split()]


def parse_fetched_messages(items):
    messages = {}
    for item in items or []:
        if not isinstance(item, tuple) or len(item) < 2:
            continue

        header, payload = item[0], item[1]
        if not isinstance(payload, (bytes, bytearray)) or not payload:
            continue

        header_bytes = (
            header
            if isinstance(header, bytes)
            else str(header).encode("utf-8", errors="ignore")
        )
        match = re.search(rb"UID\s+(\d+)", header_bytes)
        if not match:
            continue

        messages[int(match.group(1))] = email.message_from_bytes(payload)
    return messages


IMAP_FETCH_CHUNK_SIZE = 25


def fetch_messages_by_uid(mail, uids):
    """Fetch full messages by UID in chunks, without marking them as read."""
    messages = {}
    for start in range(0, len(uids), IMAP_FETCH_CHUNK_SIZE):
        chunk = uids[start : start + IMAP_FETCH_CHUNK_SIZE]
        id_list = ",".join(str(uid) for uid in chunk)

        try:
            status, items = mail.uid("fetch", id_list, get_safe_fetch_query())
        except Exception:
            status, items = "NO", []

        if status == "OK":
            messages.update(parse_fetched_messages(items))

        for uid in chunk:
            if uid in messages:
                continue
            try:
                single_status, single_items = mail.uid("fetch", str(uid), get_safe_fetch_query())
            except Exception:
                continue
            if single_status == "OK":
                messages.update(parse_fetched_messages(single_items))

    return messages


def read_uid_validity(mail):
    try:
        code, data = mail.response("UIDVALIDITY")
    except Exception:
        return ""

    if not code or not data:
        return ""

    first = data[0] if isinstance(data, (list, tuple)) and data else data
    if isinstance(first, bytes):
        return first.decode("ascii", errors="ignore").strip()
    return str(first or "").strip()


def imap_error_response(exc):
    if isinstance(exc, ssl.SSLCertVerificationError):
        message = (
            "Secure connection to IITB IMAP failed certificate verification. "
            f"Details: {exc}"
        )
        return JsonResponse({"status": "error", "message": message}, status=502)
    if isinstance(exc, ssl.SSLError):
        return JsonResponse(
            {"status": "error", "message": f"Secure IMAP connection failed: {exc}"},
            status=502,
        )
    if isinstance(exc, imaplib.IMAP4.error) and "auth" in str(exc).lower():
        return JsonResponse(
            {"status": "error", "message": "IITB mail login failed. Check your LDAP ID and access token."},
            status=401,
        )
    return JsonResponse({"status": "error", "message": str(exc)}, status=500)


def safe_logout(mail):
    if mail is None:
        return
    try:
        mail.logout()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Daily Summary: returns the day's mails. The extension writes the summary.
# --------------------------------------------------------------------------

def daily_summary_api(request):
    requested_date, date_error = parse_requested_summary_date(request)
    if date_error:
        return JsonResponse({"status": "error", "message": date_error}, status=400)

    user = request.headers.get("X-LDAP-User")
    password = request.headers.get("X-LDAP-Pass")
    if not user or not password:
        return JsonResponse({"status": "error", "message": "LDAP credentials missing"}, status=401)

    print(f"[API] daily_summary_api called for {requested_date.isoformat()}")

    mail = None
    try:
        mail = connect_to_iitb_imap()
        mail.login(user, password)
        mail.select("inbox", readonly=True)

        # UIDs (not sequence numbers) so each mail can be opened in webmail later.
        all_uids = sorted(imap_search_uids(mail, requested_date, requested_date), reverse=True)
        unread_uids = set(imap_search_uids(mail, requested_date, requested_date, unseen_only=True))
        messages = fetch_messages_by_uid(mail, all_uids)

        emails = []
        for uid in all_uids:
            message_obj = messages.get(uid)
            if message_obj is None:
                continue
            record = build_email_record(message_obj, uid in unread_uids, uid=uid)
            record.pop("_body", None)
            emails.append(record)

        return JsonResponse(
            {
                "status": "success",
                "generated_for": requested_date.isoformat(),
                "stats": build_stats(emails, len(all_uids)),
                "emails": emails,
            }
        )
    except Exception as exc:
        return imap_error_response(exc)
    finally:
        safe_logout(mail)


# --------------------------------------------------------------------------
# Chat mail window: stateless. The extension keeps the copy and tells us the
# highest UID it already has; we only fetch newer mails. Nothing is stored.
# --------------------------------------------------------------------------

MAIL_WINDOW_DEFAULT_DAYS = 15
MAIL_WINDOW_MAX_DAYS = 45
MAIL_WINDOW_BODY_LIMIT = 6000
MAIL_WINDOW_MAX_FETCH = 800
IST_TIMEZONE = ZoneInfo("Asia/Kolkata")


def current_ist_date():
    return datetime.now(IST_TIMEZONE).date()


def parse_message_datetime(raw_date):
    if not raw_date:
        return None

    try:
        parsed = parsedate_to_datetime(raw_date)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None

    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt_timezone.utc)
    return parsed.astimezone(dt_timezone.utc)


def build_window_record(message_obj, uid, is_unread):
    record = build_email_record(message_obj, is_unread, uid=uid)
    body = clean_extracted_text(record.pop("_body", ""))[:MAIL_WINDOW_BODY_LIMIT]
    received_at = (
        parse_message_datetime(message_obj.get("Date", ""))
        or datetime.now(dt_timezone.utc)
    )
    message_id = (message_obj.get("Message-ID") or "").strip()[:255] or f"uid:{uid}"

    return {
        "uid": uid,
        "message_id": message_id,
        "received_at": received_at.isoformat(),
        "received_label": received_at.astimezone(IST_TIMEZONE).strftime("%d %b %H:%M"),
        "sender_name": record["sender"][:255],
        "sender_email": record["sender_email"][:255],
        "subject": record["subject"][:1000],
        "body": body,
        "snippet": record["snippet"][:400],
        "excerpt": record["body_excerpt"][:1000],
        "is_read": not is_unread,
        "source": record["source"],
        "sensitive": record["sensitive"],
        # File names only — a sensitive mail does not even leak its filenames.
        "attachments": [] if record["sensitive"] else collect_attachment_names(message_obj),
    }


def parse_non_negative_int(raw_value, default=0):
    raw_value = (raw_value or "").strip()
    if not raw_value:
        return default, None
    try:
        value = int(raw_value)
    except ValueError:
        return None, "must be an integer"
    if value < 0:
        return None, "must not be negative"
    return value, None


@csrf_exempt
def mail_window_api(request):
    if request.method not in ("GET", "POST"):
        return JsonResponse({"status": "error", "message": "Only GET or POST allowed"}, status=405)

    days, days_error = parse_non_negative_int(request.GET.get("days"), MAIL_WINDOW_DEFAULT_DAYS)
    if days_error:
        return JsonResponse({"status": "error", "message": f"days {days_error}"}, status=400)
    days = max(1, min(days, MAIL_WINDOW_MAX_DAYS))

    known_max_uid, uid_error = parse_non_negative_int(request.GET.get("max_uid"), 0)
    if uid_error:
        return JsonResponse({"status": "error", "message": f"max_uid {uid_error}"}, status=400)
    client_uid_validity = (request.GET.get("uidvalidity") or "").strip()

    user = request.headers.get("X-LDAP-User")
    password = request.headers.get("X-LDAP-Pass")
    if not user or not password:
        return JsonResponse({"status": "error", "message": "LDAP credentials missing"}, status=401)

    mail = None
    try:
        today = current_ist_date()
        window_start_day = today - timedelta(days=days - 1)

        mail = connect_to_iitb_imap()
        mail.login(user, password)
        mail.select("inbox", readonly=True)

        uid_validity = read_uid_validity(mail)
        # A full resend when the extension has nothing yet, or the mailbox's UIDs were reset.
        full = (
            known_max_uid == 0
            or not client_uid_validity
            or (uid_validity and client_uid_validity != uid_validity)
        )

        window_uids = sorted(imap_search_uids(mail, window_start_day), reverse=True)
        unseen_uids = set(imap_search_uids(mail, window_start_day, unseen_only=True))

        wanted = window_uids if full else [uid for uid in window_uids if uid > known_max_uid]
        wanted = wanted[:MAIL_WINDOW_MAX_FETCH]
        messages = fetch_messages_by_uid(mail, wanted)

        emails = []
        for uid in wanted:
            message_obj = messages.get(uid)
            if message_obj is None:
                continue
            emails.append(build_window_record(message_obj, uid, uid in unseen_uids))

        print(
            f"[API] mail_window_api days={days} full={bool(full)} "
            f"in_window={len(window_uids)} fetched={len(emails)}"
        )

        return JsonResponse(
            {
                "status": "success",
                "full": bool(full),
                "days": days,
                "window_start": window_start_day.isoformat(),
                "window_end": today.isoformat(),
                "uid_validity": uid_validity,
                "synced_at": datetime.now(dt_timezone.utc).isoformat(),
                "window_uids": window_uids,
                "unseen_uids": sorted(unseen_uids, reverse=True),
                "total_in_window": len(window_uids),
                "count": len(emails),
                "emails": emails,
            }
        )
    except Exception as exc:
        return imap_error_response(exc)
    finally:
        safe_logout(mail)


# --------------------------------------------------------------------------
# Attachments: PDF -> Markdown. Stateless: the file is read, converted and
# forgotten. Nothing about it is stored anywhere on this server.
# --------------------------------------------------------------------------

MAX_PDF_PAGES = 8
MAX_PDF_CHARS = 20000
MAX_PDF_UPLOAD_BYTES = 15 * 1024 * 1024
PDF_RATE_LIMIT_PER_MINUTE = 20


def is_pdf_rate_limited(request):
    """PDF conversion is far more expensive than a proxy pass, so it gets a
    much tighter per-IP budget than the Gemini proxy."""
    limit = max(int(getattr(settings, "PDF_RATE_LIMIT_PER_MINUTE", PDF_RATE_LIMIT_PER_MINUTE)), 1)
    client_ip = get_client_ip(request)
    cache_key = f"extract-pdf-rate:{client_ip}"

    if cache.add(cache_key, 1, timeout=60):
        return False

    try:
        current_count = cache.incr(cache_key)
    except ValueError:
        cache.set(cache_key, 1, timeout=60)
        return False

    return current_count > limit


@csrf_exempt
def extract_pdf_api(request):
    """Turns an attached PDF into Markdown so Summarize and Reply can read it.

    Accepts either a multipart upload ("file") or JSON {"filename": ..., "base64": ...}.
    pymupdf is imported inside the function so the rest of the API never pays
    for loading the native library.
    """
    if request.method != "POST":
        return JsonResponse({"ok": False, "error": "Only POST is allowed"}, status=405)

    if not is_allowed_extension_request(request):
        return JsonResponse({"ok": False, "error": "Request not allowed"}, status=403)

    if is_pdf_rate_limited(request):
        return JsonResponse({"ok": False, "error": "Too many PDF conversions - try again in a minute."}, status=429)

    pdf_bytes = None
    filename = "document.pdf"

    try:
        if request.FILES.get("file"):
            uploaded = request.FILES["file"]
            filename = uploaded.name or filename
            if uploaded.size > MAX_PDF_UPLOAD_BYTES:
                return JsonResponse(
                    {"ok": False, "error": "PDF exceeds the 15MB limit"}, status=400
                )
            pdf_bytes = uploaded.read()
        elif request.body:
            data = json.loads(request.body)
            b64_content = data.get("base64", "")
            filename = data.get("filename") or filename
            if b64_content:
                import base64 as base64_module

                if len(b64_content) > (MAX_PDF_UPLOAD_BYTES // 3) * 4 + 4096:
                    return JsonResponse(
                        {"ok": False, "error": "PDF exceeds the 15MB limit"}, status=400
                    )
                pdf_bytes = base64_module.b64decode(b64_content)
    except (ValueError, TypeError) as exc:
        return JsonResponse({"ok": False, "error": f"Invalid payload: {exc}"}, status=400)

    if not pdf_bytes:
        return JsonResponse({"ok": False, "error": "No PDF data provided"}, status=400)

    try:
        import pymupdf
        import pymupdf4llm
    except ImportError:
        return JsonResponse(
            {"ok": False, "error": "PDF support is not installed on this server"}, status=503
        )

    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        total_pages = len(doc)
        if total_pages == 0:
            return JsonResponse({"ok": False, "error": "PDF has no pages"}, status=400)

        pages_to_extract = list(range(min(total_pages, MAX_PDF_PAGES)))
        md_text = pymupdf4llm.to_markdown(doc, pages=pages_to_extract)

        truncated = False
        if len(md_text) > MAX_PDF_CHARS:
            md_text = (
                md_text[:MAX_PDF_CHARS]
                + f"\n\n*(Truncated: PDF text exceeded {MAX_PDF_CHARS:,} characters)*"
            )
            truncated = True
        elif total_pages > MAX_PDF_PAGES:
            md_text += (
                f"\n\n*(Note: only the first {MAX_PDF_PAGES} of {total_pages} pages were read)*"
            )
            truncated = True

        return JsonResponse(
            {
                "ok": True,
                "filename": filename,
                "pages_extracted": len(pages_to_extract),
                "total_pages": total_pages,
                "truncated": truncated,
                "text": md_text,
            }
        )
    except Exception as exc:  # a corrupt PDF must not take the server down
        return JsonResponse({"ok": False, "error": f"Could not read that PDF: {exc}"}, status=422)
