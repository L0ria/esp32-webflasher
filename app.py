#!/usr/bin/env python3
"""ESP32 Web Flasher — backend API server.

Stores ESP32 / Espressif firmware binaries under ``BINARIES_DIR``
(default ``/srv/binaries``), one sub-directory per firmware version, and
exposes:

* ``GET  /``                              — frontend (``static/index.html``)
* ``GET  /static/<path>``                 — static assets
* ``GET  /api/versions``                  — list versions + files + addresses
* ``POST /api/upload``                    — multipart upload of 1..N ``.bin`` files and an optional ``meta.json``
* ``GET  /api/versions/<v>/files/<f>``    — serve a binary (``application/octet-stream``)
* ``DELETE /api/versions/<v>``              — remove a whole version bundle (issue #36)

Spec: https://github.com/L0ria/esp32-webflasher/issues/3 (section 5)
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: One sub-directory per firmware version, e.g. ``/srv/binaries/v1.0.0/``.
BINARIES_DIR = os.environ.get("BINARIES_DIR", "/srv/binaries")

#: Hard cap for the total size of an upload request (64 MB).
MAX_CONTENT_LENGTH = 64 * 1024 * 1024

#: Version directory names: 1-64 chars, starting with an alphanumeric, then
#: alnum / dot / underscore / dash.  Rejects ``..``, ``/``, absolute paths,
#: newlines and any other trickery.
VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

#: Name-based flash address convention (spec section 5.4).  Checked in this
#: order, case-insensitive prefix match; first match wins.
ADDRESS_RULES = (
    ("bootloader", "0x1000"),
    ("partition", "0x8000"),
    ("ota_data", "0xe000"),
    ("firmware", "0x10000"),
    ("app", "0x10000"),
    ("factory", "0x10000"),
)
DEFAULT_ADDRESS = "0x10000"

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _setup_logging() -> None:
    """Send all logs — including werkzeug request lines — to stdout.

    werkzeug's logger is left to *propagate* to the root logger (which owns
    the single stdout handler) so request lines are not printed twice.
    """
    root = logging.getLogger()
    if not root.handlers:  # idempotent (e.g. when imported twice in tests)
        root.setLevel(logging.INFO)
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(handler)
    logging.getLogger("werkzeug").setLevel(logging.INFO)


_setup_logging()
log = logging.getLogger("esp32-webflasher")

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


def _ensure_binaries_dir() -> None:
    """Create ``BINARIES_DIR`` at startup if it does not exist yet."""
    try:
        os.makedirs(BINARIES_DIR, exist_ok=True)
    except OSError as exc:
        log.warning("could not create BINARIES_DIR %r: %s", BINARIES_DIR, exc)


_ensure_binaries_dir()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def error(message: str, status: int):
    """Uniform JSON error body: ``{"error": "..."}``."""
    return jsonify({"error": message}), status


def valid_version(version) -> bool:
    """True if *version* is a safe version directory name (spec 5.3)."""
    return isinstance(version, str) and VERSION_RE.fullmatch(version) is not None


def valid_filename(name) -> bool:
    """True if *name* is a safe flat filename (no ``..``, no separators)."""
    if not isinstance(name, str) or not name or len(name) > 255:
        return False
    if ".." in name:
        return False
    return not any(ch in name for ch in ("/", "\\", "\x00"))


def address_for(filename: str) -> str:
    """Flash address for *filename* per the name convention (spec 5.4)."""
    lowered = filename.lower()
    for prefix, address in ADDRESS_RULES:
        if lowered.startswith(prefix):
            return address
    return DEFAULT_ADDRESS


def load_meta(version_dir: str) -> dict:
    """Load the optional ``meta.json`` override from *version_dir*.

    Expected shape::

        {"files": {"firmware-esp32.bin": {"address": "0x10000", "label": "..."}}}

    A missing or broken file is ignored (with a warning) so it can never
    take the API down.
    """
    meta_path = os.path.join(version_dir, "meta.json")
    if not os.path.isfile(meta_path):
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError) as exc:
        log.warning("ignoring broken meta.json in %s: %s", version_dir, exc)
        return {}
    if not isinstance(meta, dict):
        log.warning("ignoring meta.json in %s: top level must be an object", version_dir)
        return {}
    return meta


def build_version_entry(version: str) -> dict:
    """Build the JSON entry for one version directory (spec 5.2)."""
    version_dir = os.path.join(BINARIES_DIR, version)
    meta = load_meta(version_dir)
    meta_files = meta.get("files")
    if not isinstance(meta_files, dict):
        meta_files = {}

    files = []
    try:
        names = sorted(os.listdir(version_dir))
    except OSError as exc:
        log.warning("cannot list %s: %s", version_dir, exc)
        names = []

    for name in names:
        if name == "meta.json":
            continue
        path = os.path.join(version_dir, name)
        if not os.path.isfile(path):
            continue
        try:
            stat = os.stat(path)
        except OSError:
            continue
        entry = {
            "name": name,
            "address": address_for(name),
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        override = meta_files.get(name)
        if isinstance(override, dict):
            if isinstance(override.get("address"), str):
                entry["address"] = override["address"]
            if isinstance(override.get("label"), str):
                entry["label"] = override["label"]
        files.append(entry)

    return {"version": version, "files": files}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/")
def index():
    """Serve the single-page frontend once it exists (issue #8)."""
    if os.path.isfile(os.path.join(app.static_folder, "index.html")):
        return send_from_directory(app.static_folder, "index.html")
    return (
        "ESP32 Web Flasher backend is running.\n"
        "The frontend (static/index.html) is not part of this branch yet — "
        "see https://github.com/L0ria/esp32-webflasher/issues/8\n",
        200,
        {"Content-Type": "text/plain; charset=utf-8"},
    )


@app.get("/api/versions")
def api_versions():
    """List all versions with their files, addresses and metadata."""
    try:
        entries = sorted(os.listdir(BINARIES_DIR))
    except FileNotFoundError:
        entries = []
    versions = [
        build_version_entry(version)
        for version in entries
        if os.path.isdir(os.path.join(BINARIES_DIR, version))
    ]
    return jsonify({"versions": versions})


@app.post("/api/upload")
def api_upload():
    """Save 1..N ``.bin`` files (plus an optional ``meta.json``) into ``BINARIES_DIR/<version>/`` (spec 5.3)."""
    version = request.form.get("version")
    if not valid_version(version):
        return error(
            "missing or invalid 'version' field (expected 1-64 chars: "
            "letters, digits, '.', '_', '-', starting with a letter or digit)",
            400,
        )

    files = request.files.getlist("files")
    if not files:
        return error("missing required 'files' field (1..N .bin files and/or meta.json)", 400)

    for f in files:
        if not valid_filename(f.filename):
            return error(f"invalid filename {f.filename!r}", 400)
        if not (
            f.filename.lower().endswith(".bin") or f.filename == "meta.json"
        ):
            return error(f"file {f.filename!r} is not a .bin file", 400)

    version_dir = os.path.join(BINARIES_DIR, version)
    try:
        os.makedirs(version_dir, exist_ok=True)
        saved = []
        for f in files:
            target = os.path.realpath(os.path.join(version_dir, f.filename))
            if not target.startswith(os.path.realpath(version_dir) + os.sep):
                return error(f"invalid filename {f.filename!r}", 400)
            f.save(target)  # overwrites same-named files, as intended
            saved.append({"name": f.filename, "size": os.path.getsize(target)})
    except OSError as exc:
        log.error("upload failed: %s", exc)
        return error(f"upload failed: {exc}", 500)

    log.info("uploaded %d file(s) to version %r", len(saved), version)
    return jsonify({"version": version, "saved": saved}), 201


@app.get("/api/versions/<version>/files/<filename>")
def api_serve_file(version: str, filename: str):
    """Serve one stored binary (spec 5.5)."""
    if not valid_version(version):
        return error("invalid version", 400)
    if not valid_filename(filename):
        return error("invalid filename", 400)
    path = os.path.join(BINARIES_DIR, version, filename)
    if not os.path.isfile(path):
        return error(f"file {filename!r} not found in version {version!r}", 404)
    return send_from_directory(
        os.path.dirname(path), filename, mimetype="application/octet-stream"
    )


@app.delete("/api/versions/<version>")
def api_delete_version(version: str):
    """Delete a whole version bundle — the directory under ``BINARIES_DIR``
    with all its files (bootloader, partition table, OTA data, firmware,
    ``meta.json``) — in one call (issue #36).

    Contract (issue #36, approved plan):
      * unsafe version name          → ``400 {"error": ...}``
      * version directory not found  → ``404 {"error": ...}``
      * filesystem failure           → ``500 {"error": ...}``
      * success                      → ``200 {"deleted": "<version>"}``
    """
    if not valid_version(version):
        return error("invalid version", 400)
    version_dir = os.path.join(BINARIES_DIR, version)
    if not os.path.isdir(version_dir):
        return error(f"version {version!r} not found", 404)
    # Defense in depth: the directory must resolve back inside BINARIES_DIR
    # (same containment pattern the upload route uses).
    if not os.path.realpath(version_dir).startswith(
        os.path.realpath(BINARIES_DIR) + os.sep
    ):
        return error(f"version {version!r} escapes the binaries directory", 400)
    try:
        file_count = sum(
            1 for name in os.listdir(version_dir) if os.path.isfile(os.path.join(version_dir, name))
        )
        shutil.rmtree(version_dir)
    except OSError as exc:
        log.error("delete failed for %r: %s", version, exc)
        return error(f"delete failed: {exc}", 500)
    log.info("deleted version %r (%d file(s))", version, file_count)
    return jsonify({"deleted": version}), 200


# ---------------------------------------------------------------------------
# Error handlers — always answer with JSON {"error": "..."}
# ---------------------------------------------------------------------------

@app.errorhandler(400)
def _err_400(_exc):
    return error("bad request", 400)


@app.errorhandler(404)
def _err_404(_exc):
    return error("not found", 404)


@app.errorhandler(405)
def _err_405(_exc):
    return error("method not allowed", 405)


@app.errorhandler(413)
def _err_413(_exc):
    return error("upload exceeds the 64 MB limit", 413)


@app.errorhandler(500)
def _err_500(_exc):
    log.exception("internal server error")
    return error("internal server error", 500)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5060"))
    log.info(
        "ESP32 Web Flasher backend starting (BINARIES_DIR=%s, port=%d)",
        BINARIES_DIR,
        port,
    )
    app.run(host="0.0.0.0", port=port)
