FROM python:3.13-slim AS builder

WORKDIR /build

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.13-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV DJANGO_DEBUG=False

COPY --from=builder /install /usr/local

COPY . .

RUN mkdir -p /app/staticfiles

RUN python manage.py migrate --noinput || true
RUN python manage.py collectstatic --noinput || true

EXPOSE 8080

CMD exec gunicorn mail_backend.wsgi:application --bind 0.0.0.0:${PORT:-8080} --workers 4 --timeout 0
