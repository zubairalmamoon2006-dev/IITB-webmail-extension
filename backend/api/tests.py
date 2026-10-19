import json
import re
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

import ssl
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase
from django.test.utils import override_settings

from .sensitive import SENSITIVE_SUBJECT, protect_mail
from .views import (
    build_secure_imap_ssl_context,
    build_email_record,
    daily_summary_api,
    extract_best_body,
    extract_pdf_api,
    get_safe_fetch_query,
    is_allowed_extension_request,
    is_gemini_proxy_rate_limited,
    is_pdf_rate_limited,
    mail_window_api,
    parse_requested_summary_date,
    resolve_proxy_request,
    sanitize_proxy_payload,
    should_retry_imap_with_compatibility,
)


class DailySummaryHelpersTests(SimpleTestCase):
    def test_extract_best_body_prefers_plain_text(self):
        message = EmailMessage()
        message["Subject"] = "Assignment reminder"
        message["From"] = "Course Team <course@iitb.ac.in>"
        message.set_content("Submit the assignment by 5 PM tomorrow.")
        message.add_alternative(
            "<html><body><p>HTML version</p></body></html>",
            subtype="html",
        )
        message.add_attachment(
            b"ignore attachment",
            maintype="application",
            subtype="octet-stream",
            filename="notes.bin",
        )

        self.assertEqual(
            extract_best_body(message),
            "Submit the assignment by 5 PM tomorrow.",
        )

    def test_build_email_record_falls_back_to_html_and_marks_external(self):
        message = EmailMessage()
        message["Subject"] = "Interview Invitation"
        message["From"] = "Recruiter <jobs@example.com>"
        message["Date"] = "Thu, 02 Apr 2026 09:15:00 +0530"
        message.set_content(
            "<html><body><p>Your interview is scheduled for Friday.</p></body></html>",
            subtype="html",
        )

        record = build_email_record(message, is_unread=True)

        self.assertEqual(record["source"], "external")
        self.assertEqual(record["status"], "unread")
        self.assertIn("Your interview is scheduled for Friday.", record["snippet"])

    def test_parse_requested_summary_date_accepts_iso_date(self):
        request = type("Request", (), {"GET": QueryDict("date=2026-04-01")})()

        parsed_date, error = parse_requested_summary_date(request)

        self.assertEqual(parsed_date, date(2026, 4, 1))
        self.assertIsNone(error)

    def test_parse_requested_summary_date_rejects_invalid_date(self):
        request = type("Request", (), {"GET": QueryDict("date=04-01-2026")})()

        parsed_date, error = parse_requested_summary_date(request)

        self.assertIsNone(parsed_date)
        self.assertEqual(error, "Invalid date format. Use YYYY-MM-DD.")

    def test_get_safe_fetch_query_uses_body_peek(self):
        self.assertEqual(get_safe_fetch_query(), "(BODY.PEEK[])")

    def test_build_secure_imap_ssl_context_verifies_certificates(self):
        context = build_secure_imap_ssl_context()

        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_build_secure_imap_ssl_context_compatibility_mode_keeps_verification(self):
        context = build_secure_imap_ssl_context(compatibility_mode=True)

        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_should_retry_imap_with_compatibility_for_handshake_failure(self):
        exc = ssl.SSLError("[SSL: SSLV3_ALERT_HANDSHAKE_FAILURE] sslv3 alert handshake failure")

        self.assertTrue(should_retry_imap_with_compatibility(exc))

    def test_should_not_retry_imap_with_compatibility_for_cert_error(self):
        exc = ssl.SSLCertVerificationError("certificate verify failed")

        self.assertFalse(should_retry_imap_with_compatibility(exc))

    def test_resolve_proxy_request_uses_supported_model(self):
        model, payload = resolve_proxy_request(
            {
                "model": "gemini-2.5-pro",
                "payload": {"contents": [{"parts": [{"text": "Hello"}]}]},
            }
        )

        self.assertEqual(model, "gemini-2.5-pro")
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "Hello")

    def test_resolve_proxy_request_falls_back_for_unknown_model(self):
        model, payload = resolve_proxy_request(
            {
                "model": "unknown-model",
                "payload": {"contents": [{"parts": [{"text": "Hello"}]}]},
            }
        )

        self.assertEqual(model, "gemini-3.8-flash")
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "Hello")

    @override_settings(GEMINI_PROXY_MAX_TEXT_CHARS=10, GEMINI_PROXY_MAX_OUTPUT_TOKENS=512)
    def test_sanitize_proxy_payload_trims_text_and_caps_output_tokens(self):
        payload, error, status = sanitize_proxy_payload(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "123456789012345"},
                            {"inline_data": {"mime_type": "image/png"}},
                        ],
                    }
                ],
                "generationConfig": {"maxOutputTokens": 9999},
            }
        )

        self.assertIsNone(error)
        self.assertEqual(status, 200)
        self.assertEqual(payload["contents"][0]["parts"][0]["text"], "1234567890")
        self.assertEqual(payload["generationConfig"]["maxOutputTokens"], 512)

    def test_sanitize_proxy_payload_keeps_json_mode_and_temperature(self):
        payload, error, _ = sanitize_proxy_payload(
            {
                "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                "generationConfig": {
                    "temperature": 0.3,
                    "responseMimeType": "application/json",
                    "tools": ["not allowed"],
                },
            }
        )

        self.assertIsNone(error)
        config = payload["generationConfig"]
        self.assertEqual(config["temperature"], 0.3)
        self.assertEqual(config["responseMimeType"], "application/json")
        self.assertNotIn("tools", config)

    def test_sanitize_proxy_payload_keeps_the_newest_contents(self):
        # The chat sends up to 6 history turns PLUS the current question, so
        # the payload holds 7 contents. Trimming from the front (contents[:6])
        # used to throw away the question the user had just typed; the newest
        # contents must be the ones that survive.
        contents = [
            {
                "role": "user" if index % 2 == 0 else "model",
                "parts": [{"text": f"turn-{index}"}],
            }
            for index in range(6)
        ]
        contents.append({"role": "user", "parts": [{"text": "the question just typed"}]})

        payload, error, _ = sanitize_proxy_payload({"contents": contents})

        self.assertIsNone(error)
        texts = [part["parts"][0]["text"] for part in payload["contents"]]
        self.assertEqual(texts[-1], "the question just typed")
        self.assertEqual(len(texts), 6)
        self.assertNotIn("turn-0", texts)

    def test_sanitize_proxy_payload_passes_small_inline_images(self):
        # An attached image travels as an inline_data part; dropping it silently
        # would make the model answer blind. Only image/* of a sane size passes.
        payload, error, _ = sanitize_proxy_payload(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "What is in this image?"},
                            {"inline_data": {"mime_type": "image/png", "data": "aGVsbG8="}},
                        ],
                    }
                ],
            }
        )

        self.assertIsNone(error)
        parts = payload["contents"][0]["parts"]
        self.assertEqual(parts[0]["text"], "What is in this image?")
        self.assertEqual(parts[1]["inline_data"]["mime_type"], "image/png")
        self.assertEqual(parts[1]["inline_data"]["data"], "aGVsbG8=")

    def test_sanitize_proxy_payload_drops_non_image_inline_data(self):
        payload, error, _ = sanitize_proxy_payload(
            {
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"text": "read this file"},
                            {"inline_data": {"mime_type": "application/pdf", "data": "JVBERi0="}},
                        ],
                    }
                ],
            }
        )

        self.assertIsNone(error)
        parts = payload["contents"][0]["parts"]
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["text"], "read this file")

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_accepts_matching_extension_id(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_X_EXTENSION_ID="test-extension-id",
        )

        self.assertTrue(is_allowed_extension_request(request))

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_rejects_unknown_extension(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_X_EXTENSION_ID="other-extension-id",
        )

        self.assertFalse(is_allowed_extension_request(request))

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_allowed_extension_request_accepts_matching_origin(self):
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            HTTP_ORIGIN="chrome-extension://test-extension-id",
        )

        self.assertTrue(is_allowed_extension_request(request))

    @override_settings(
        GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE=1,
        GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS=60,
    )
    def test_gemini_proxy_rate_limit_blocks_second_request_from_same_ip(self):
        cache.clear()
        request = RequestFactory().post(
            "/api/gemini-proxy/",
            data="{}",
            content_type="application/json",
            REMOTE_ADDR="203.0.113.10",
        )

        self.assertFalse(is_gemini_proxy_rate_limited(request))
        self.assertTrue(is_gemini_proxy_rate_limited(request))


class FakeImapConnection:
    """Stand-in for imaplib.IMAP4_SSL that only accepts UID commands."""

    def __init__(self, messages, unseen, uid_validity=b"777"):
        # messages: {uid: (received date, raw bytes)}
        self.messages = messages
        self.unseen = set(unseen)
        self.uid_validity = uid_validity
        self.selected = None
        self.fetched = []

    def login(self, user, password):
        return "OK", [b"logged in"]

    def select(self, mailbox, readonly=False):
        self.selected = (mailbox, readonly)
        return "OK", [str(len(self.messages)).encode()]

    def response(self, code):
        return code, [self.uid_validity]

    def uid(self, command, *args):
        if command == "search":
            criteria = args[-1]
            since = re.search(r'SINCE "([^"]+)"', criteria).group(1)
            since = datetime.strptime(since, "%d-%b-%Y").date()
            before = re.search(r'BEFORE "([^"]+)"', criteria)
            before = datetime.strptime(before.group(1), "%d-%b-%Y").date() if before else None
            uids = [
                uid for uid, (day, _raw) in self.messages.items()
                if day >= since and (before is None or day < before)
                and ("UNSEEN" not in criteria or uid in self.unseen)
            ]
            return "OK", [b" ".join(str(uid).encode() for uid in sorted(uids))]
        if command == "fetch":
            id_list, query = args
            items = []
            for uid in str(id_list).split(","):
                self.fetched.append((int(uid), query))
                raw = self.messages[int(uid)][1]
                items += [(f"1 (UID {uid} BODY[] {{{len(raw)}}}".encode(), raw), b")"]
            return "OK", items
        raise AssertionError(f"Unexpected UID command {command}")

    def search(self, *args):
        raise AssertionError("Sequence-number SEARCH must not be used")

    def fetch(self, *args):
        raise AssertionError("Sequence-number FETCH must not be used")

    def logout(self):
        return "BYE", [b""]


def make_raw_email(subject, sender, when, body=None):
    message = EmailMessage()
    message["From"] = sender
    message["Subject"] = subject
    message["Date"] = when.strftime("%a, %d %b %Y %H:%M:%S +0530")
    message["Message-ID"] = f"<{subject.replace(' ', '-')}@test>"
    message.set_content(body if body is not None else f"Body of {subject}")
    return message.as_bytes()


class MailEndpointsTests(SimpleTestCase):
    headers = {"X-LDAP-User": "24b0000", "X-LDAP-Pass": "token"}

    def make_mailbox(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        day = lambda n: now - timedelta(days=n)
        return FakeImapConnection(
            messages={
                205: (day(0).date(), make_raw_email("Newest", "HR <hr@example.com>", day(0))),
                150: (day(3).date(), make_raw_email("Three days", "Prof <p@iitb.ac.in>", day(3))),
                40: (day(30).date(), make_raw_email("Too old", "Old <o@iitb.ac.in>", day(30))),
            },
            unseen=[205],
        )

    def call_window(self, mailbox, **params):
        request = RequestFactory().get("/api/mail-window/", params, headers=self.headers)
        with patch("api.views.connect_to_iitb_imap", return_value=mailbox):
            response = mail_window_api(request)
        return response.status_code, json.loads(response.content)

    def test_daily_summary_returns_mails_with_uids_and_no_server_summary(self):
        mailbox = self.make_mailbox()
        today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
        request = RequestFactory().get("/api/daily-summary/", {"date": today}, headers=self.headers)

        with patch("api.views.connect_to_iitb_imap", return_value=mailbox):
            response = daily_summary_api(request)

        self.assertEqual(response.status_code, 200)
        payload = json.loads(response.content)
        self.assertEqual([item["uid"] for item in payload["emails"]], [205])
        self.assertEqual(payload["emails"][0]["status"], "unread")
        self.assertEqual(payload["stats"]["total"], 1)
        self.assertNotIn("overview", payload)
        self.assertEqual(mailbox.selected, ("inbox", True))
        self.assertTrue(all(query == "(BODY.PEEK[])" for _uid, query in mailbox.fetched))

    def test_mail_window_first_sync_sends_whole_window_newest_first(self):
        status, payload = self.call_window(self.make_mailbox(), days="15")

        self.assertEqual(status, 200)
        self.assertTrue(payload["full"])
        self.assertEqual([item["uid"] for item in payload["emails"]], [205, 150])
        self.assertEqual(payload["window_uids"], [205, 150])
        self.assertEqual(payload["unseen_uids"], [205])
        self.assertEqual(payload["uid_validity"], "777")
        self.assertFalse(payload["emails"][0]["is_read"])

    def test_mail_window_incremental_sync_fetches_only_newer_mails(self):
        mailbox = self.make_mailbox()
        status, payload = self.call_window(mailbox, days="15", max_uid="150", uidvalidity="777")

        self.assertEqual(status, 200)
        self.assertFalse(payload["full"])
        self.assertEqual([item["uid"] for item in payload["emails"]], [205])
        self.assertEqual(payload["window_uids"], [205, 150])
        self.assertEqual([uid for uid, _query in mailbox.fetched], [205])

    def test_mail_window_resends_everything_when_uidvalidity_changes(self):
        status, payload = self.call_window(
            self.make_mailbox(), days="15", max_uid="205", uidvalidity="111"
        )

        self.assertEqual(status, 200)
        self.assertTrue(payload["full"])
        self.assertEqual(len(payload["emails"]), 2)

    def test_mail_window_lists_attachment_names_as_metadata(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        message = EmailMessage()
        message["From"] = "Prof <p@iitb.ac.in>"
        message["Subject"] = "Lab manual"
        message["Date"] = now.strftime("%a, %d %b %Y %H:%M:%S +0530")
        message.set_content("Manual attached.")
        message.add_attachment(
            b"%PDF", maintype="application", subtype="pdf", filename="manual.pdf"
        )
        message.add_attachment(b"PNG", maintype="image", subtype="png")
        mailbox = FakeImapConnection(
            messages={7: (now.date(), message.as_bytes())}, unseen=[]
        )

        status, payload = self.call_window(mailbox, days="15")

        self.assertEqual(status, 200)
        # Names only — so the chat can answer "which mails have a pdf/png".
        self.assertEqual(payload["emails"][0]["attachments"], ["manual.pdf", "inline.png"])

    def test_mail_window_sensitive_mails_leak_no_filenames(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        message = EmailMessage()
        message["From"] = "Bank <alerts@bank.example.com>"
        message["Subject"] = "Your OTP for login is 445566"
        message["Date"] = now.strftime("%a, %d %b %Y %H:%M:%S +0530")
        message.set_content("Use OTP 445566 to log in.")
        message.add_attachment(
            b"stmt", maintype="application", subtype="octet-stream", filename="bank-statement.pdf"
        )
        mailbox = FakeImapConnection(
            messages={9: (now.date(), message.as_bytes())}, unseen=[]
        )

        status, payload = self.call_window(mailbox, days="15")

        self.assertEqual(status, 200)
        self.assertTrue(payload["emails"][0]["sensitive"])
        self.assertEqual(payload["emails"][0]["attachments"], [])

    def test_mail_window_requires_credentials(self):
        request = RequestFactory().get("/api/mail-window/", {"days": "15"})
        response = mail_window_api(request)
        self.assertEqual(response.status_code, 401)

    def test_mail_window_rejects_bad_max_uid(self):
        request = RequestFactory().get(
            "/api/mail-window/", {"max_uid": "abc"}, headers=self.headers
        )
        response = mail_window_api(request)
        self.assertEqual(response.status_code, 400)


SAMPLES_PATH = Path(__file__).resolve().parents[2] / "tests" / "sensitive_samples.json"


class SensitiveMailTests(SimpleTestCase):
    """Runs the shared sample set (also used by the extension's JS tests)."""

    def test_shared_samples(self):
        samples = json.loads(SAMPLES_PATH.read_text(encoding="utf-8"))["samples"]
        for sample in samples:
            with self.subTest(sample["name"]):
                result = protect_mail(
                    sample["subject"], sample["sender_name"], sample["sender_email"], sample["body"]
                )
                self.assertEqual(result["sensitive"] is not None, sample["expect"] == "hidden")
                text = f"{result['subject']} {result['body']}"
                for kept in sample.get("must_keep", []):
                    self.assertIn(kept, text)
                for removed in sample.get("must_remove", []):
                    self.assertNotIn(removed, text)

    def mailbox_with_otp(self):
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        return FakeImapConnection(
            messages={
                301: (now.date(), make_raw_email(
                    "OTP for ASC login", "ASC <asc@iitb.ac.in>", now,
                    body="Your OTP for ASC login is 482913. Valid for 10 minutes.")),
                300: (now.date(), make_raw_email(
                    "Quiz 2 on Friday", "Prof <p@iitb.ac.in>", now,
                    body="Quiz 2 on 17 Oct at 8:30 AM in LH 101.")),
            },
            unseen=[301],
        )

    def test_daily_summary_never_returns_otp_text(self):
        today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
        request = RequestFactory().get(
            "/api/daily-summary/", {"date": today}, headers=MailEndpointsTests.headers
        )
        with patch("api.views.connect_to_iitb_imap", return_value=self.mailbox_with_otp()):
            response = daily_summary_api(request)

        raw = response.content.decode()
        self.assertNotIn("482913", raw)
        self.assertNotIn("_body", raw)
        emails = {item["uid"]: item for item in json.loads(raw)["emails"]}
        self.assertEqual(emails[301]["sensitive"], "otp")
        self.assertEqual(emails[301]["subject"], SENSITIVE_SUBJECT)
        self.assertIsNone(emails[300]["sensitive"])
        self.assertIn("LH 101", emails[300]["snippet"])

    def test_mail_window_never_returns_otp_text(self):
        request = RequestFactory().get(
            "/api/mail-window/", {"days": "15"}, headers=MailEndpointsTests.headers
        )
        with patch("api.views.connect_to_iitb_imap", return_value=self.mailbox_with_otp()):
            response = mail_window_api(request)

        raw = response.content.decode()
        self.assertNotIn("482913", raw)
        emails = {item["uid"]: item for item in json.loads(raw)["emails"]}
        self.assertEqual(emails[301]["sensitive"], "otp")
        self.assertEqual(emails[301]["body"], "")
        self.assertIn("LH 101", emails[300]["body"])


class ExtractPdfApiTests(SimpleTestCase):
    """Attachments: POST a PDF, get Markdown back. Stateless, allowlisted,
    rate-limited, and nothing about the file is ever stored."""

    extension_headers = {"X-Extension-Id": "ignpnhkdhhneglgihfgppmjdiibjphka"}

    def setUp(self):
        cache.clear()  # the endpoint counts calls per IP in the cache

    def post_pdf(self, payload, headers=None):
        request = RequestFactory().post(
            "/api/extract-pdf/",
            data=json.dumps(payload),
            content_type="application/json",
            headers=headers or self.extension_headers,
        )
        return extract_pdf_api(request)

    def test_extract_pdf_requires_post(self):
        request = RequestFactory().get("/api/extract-pdf/")
        response = extract_pdf_api(request)
        self.assertEqual(response.status_code, 405)

    @override_settings(ALLOWED_EXTENSION_IDS=["test-extension-id"])
    def test_extract_pdf_rejects_unknown_extension(self):
        response = self.post_pdf(
            {"filename": "a.pdf", "base64": "JVBERi0="},
            headers={"X-Extension-Id": "other-extension-id"},
        )
        self.assertEqual(response.status_code, 403)

    def test_extract_pdf_reports_missing_payload(self):
        response = self.post_pdf({"filename": "notice.pdf"})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(json.loads(response.content)["ok"])

    def test_extract_pdf_converts_a_generated_pdf(self):
        import base64

        import pymupdf

        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Hello from an IITB attachment")
        pdf_bytes = doc.tobytes()
        doc.close()

        response = self.post_pdf(
            {
                "filename": "notice.pdf",
                "base64": base64.b64encode(pdf_bytes).decode("ascii"),
            }
        )

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.content)
        self.assertTrue(body["ok"])
        self.assertEqual(body["filename"], "notice.pdf")
        self.assertEqual(body["total_pages"], 1)
        self.assertFalse(body["truncated"])
        self.assertIn("Hello from an IITB attachment", body["text"])

    @override_settings(PDF_RATE_LIMIT_PER_MINUTE=1)
    def test_extract_pdf_rate_limits_repeated_calls(self):
        first = self.post_pdf({"filename": "a.pdf"})
        second = self.post_pdf({"filename": "a.pdf"})
        self.assertNotEqual(first.status_code, 429)
        self.assertEqual(second.status_code, 429)

    def test_is_pdf_rate_limited_counts_calls_per_ip(self):
        request = RequestFactory().post(
            "/api/extract-pdf/", data="{}", content_type="application/json"
        )
        self.assertFalse(is_pdf_rate_limited(request))
        for _ in range(19):
            is_pdf_rate_limited(request)
        self.assertTrue(is_pdf_rate_limited(request))
