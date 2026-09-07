# ESP32 Web Flasher — container image (issue #9, spec §7.1 of issue #3)
#
# Multi-stage build:
#   1. vendor  — fetch the pinned esptool-js 0.6.1 browser bundle from the npm
#                registry (pinned version, no moving CDN, no runtime dependency).
#   2. runtime — python:3.12-slim + pinned Flask, non-root user, healthcheck.
#
# The vendored esptool-js bundle is Apache-2.0 licensed; the full license text
# is copied next to the bundle (static/vendor/LICENSE) for attribution (spec §11).
#
# Only pinned versions are referenced: python:3.12-slim and esptool-js@0.6.1.

# --- vendor stage: fetch the pinned esptool-js browser bundle ---------------
FROM python:3.12-slim AS vendor
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs npm ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /vendor
# `npm pack` downloads the exact pinned tarball; extract only the prebuilt
# browser bundle and its Apache-2.0 license (nothing else is needed at runtime).
RUN npm pack esptool-js@0.6.1 \
 && tar -xzf esptool-js-0.6.1.tgz package/bundle.js package/LICENSE \
 && mv package/bundle.js esptool-js.bundle.js \
 && mv package/LICENSE esptool-js.LICENSE \
 && rm -rf package esptool-js-0.6.1.tgz

# --- runtime stage ----------------------------------------------------------
FROM python:3.12-slim
ENV BINARIES_DIR=/srv/binaries \
    PORT=5060 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
# Install the pinned Python dependencies first (keeps that layer cacheable).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Application code + static assets.
COPY app.py .
COPY static/ static/
# Vendored esptool-js 0.6.1 browser bundle + its Apache-2.0 license notice.
COPY --from=vendor /vendor/esptool-js.bundle.js static/vendor/esptool-js.bundle.js
COPY --from=vendor /vendor/esptool-js.LICENSE static/vendor/LICENSE
# Run as an unprivileged user; /srv/binaries is bind-mounted at runtime.
RUN useradd -m appuser \
 && mkdir -p /srv/binaries \
 && chown -R appuser:appuser /srv/binaries /app
USER appuser
EXPOSE 5060
# stdlib-only healthcheck (no curl needed in the slim image).
HEALTHCHECK --interval=30s --timeout=5s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:5060/api/versions')" || exit 1
CMD ["python", "app.py"]
