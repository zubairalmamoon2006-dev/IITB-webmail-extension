from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent


SECRET_KEY = os.environ.get(
    "SECRET_KEY",
    "django-insecure-w#w^)=59xntti+#_vv2_n&$*qp+d-(!n5q$kii5wb%fbn^y6ux",
)

DEBUG = os.environ.get("DJANGO_DEBUG", "False") == "True"

DEFAULT_ALLOWED_HOSTS = (
    "webmailextensionugac-260151192882.asia-south1.run.app,localhost,127.0.0.1"
)
ALLOWED_HOSTS = [
    item.strip()
    for item in os.environ.get("ALLOWED_HOSTS", DEFAULT_ALLOWED_HOSTS).split(",")
    if item.strip()
]


INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "corsheaders",
    "api"
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE = int(
    os.environ.get("GEMINI_PROXY_MAX_REQUESTS_PER_MINUTE", "300")
)
GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS = int(
    os.environ.get("GEMINI_PROXY_RATE_LIMIT_WINDOW_SECONDS", "60")
)
# Room for the chat prompt (120k chars) plus up to two inline images. The
# extension allowlist and the rate limit below still gate every request.
GEMINI_PROXY_MAX_REQUEST_BODY_BYTES = int(
    os.environ.get("GEMINI_PROXY_MAX_REQUEST_BODY_BYTES", "8000000")
)
GEMINI_PROXY_MAX_TEXT_CHARS = int(
    os.environ.get("GEMINI_PROXY_MAX_TEXT_CHARS", "120000")
)
GEMINI_PROXY_MAX_OUTPUT_TOKENS = int(
    os.environ.get("GEMINI_PROXY_MAX_OUTPUT_TOKENS", "8192")
)
# An attached image rides along as an inline_data part. Both caps apply per
# request; base64 of a 2 MB image is ~2.7M chars, so 2 x 2.8M fits the body
# limit above with room to spare.
GEMINI_PROXY_MAX_INLINE_FILES = int(
    os.environ.get("GEMINI_PROXY_MAX_INLINE_FILES", "2")
)
GEMINI_PROXY_MAX_INLINE_B64_CHARS = int(
    os.environ.get("GEMINI_PROXY_MAX_INLINE_B64_CHARS", "2800000")
)
# Django's default (2.5 MB) rejects the JSON {base64} body used by
# /api/extract-pdf/ for anything over ~1.8 MB of PDF. Allow up to 25 MB so the
# documented 15 MB PDF limit actually works.
DATA_UPLOAD_MAX_MEMORY_SIZE = int(
    os.environ.get("DATA_UPLOAD_MAX_MEMORY_SIZE", str(25 * 1024 * 1024))
)
# PDF -> Markdown conversion is much more expensive than a proxy pass, so it
# gets its own tight per-IP budget.
PDF_RATE_LIMIT_PER_MINUTE = int(
    os.environ.get("PDF_RATE_LIMIT_PER_MINUTE", "20")
)
DEFAULT_CHROME_EXTENSION_ID = "ignpnhkdhhneglgihfgppmjdiibjphka"
ALLOWED_EXTENSION_IDS = [
    item.strip()
    for item in os.environ.get(
        "ALLOWED_EXTENSION_IDS",
        DEFAULT_CHROME_EXTENSION_ID,
    ).split(",")
    if item.strip()
]
CORS_ALLOWED_ORIGINS = [
    f"chrome-extension://{extension_id}"
    for extension_id in ALLOWED_EXTENSION_IDS
]
CORS_ALLOW_ALL_ORIGINS = not CORS_ALLOWED_ORIGINS

CORS_ALLOW_HEADERS = [
    "accept",
    "accept-encoding",
    "authorization",
    "content-type",
    "dnt",
    "origin",
    "user-agent",
    "x-csrftoken",
    "x-requested-with",
    "x-extension-id",
    "x-client-feature",
    "x-ldap-user",
    "x-ldap-pass",
]

ROOT_URLCONF = "mail_backend.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "mail_backend.wsgi.application"


DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}


AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]


LANGUAGE_CODE = "en-us"

TIME_ZONE = "UTC"

USE_I18N = True

USE_TZ = True


STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
