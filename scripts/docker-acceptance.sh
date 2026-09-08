#!/usr/bin/env bash
# =============================================================================
# ESP32 Web Flasher — docker acceptance (issue #26 §4.B3, issue #12 / spec §10)
#
# The repeatable, scriptable core of the §10 acceptance checklist, run against
# a `docker compose up --build` stack (webflasher + Caddy HTTPS proxy):
#
#   1.  fresh start          -> GET /api/versions -> {"versions": []}
#   2.  upload 3 .bin files  -> 201 + files on disk in the `binaries` volume
#   3.  GET /api/versions    -> correct name / size / address per file
#   4.  meta.json upload     -> 201 + address & label overrides in the listing
#   5.  path traversal       -> version=.. and filename with .. -> 400 (JSON)
#   6.  download each file   -> sha256 byte-exact (application/octet-stream)
#   7.  error contract       -> 404 / 405 / 413 all answer {"error": ...}
#   8.  static assets        -> / serves the SPA; /static/* -> 200
#
# The real-hardware flash item of §10 stays manual (needs a physical ESP32).
#
# Usage:
#   scripts/docker-acceptance.sh            # run against the compose stack
#
# Environment (all optional):
#   BASE_URL   API base URL (default: http://127.0.0.1:5060)
#   COMPOSE_PROJ   compose project name (default: esp32-webflasher)
#   SKIP_COMPOSE   set to 1 to skip the compose up/down management (the stack
#                  is already running — e.g. when a CI job owns the lifecycle)
#
# Dependencies: bash, curl, docker (+ compose plugin), python3 (stdlib only).
# No new runtime or test dependencies are introduced.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."   # repository root (docker-compose.yaml lives here)

BASE_URL="${BASE_URL:-http://127.0.0.1:5060}"
COMPOSE_PROJ="${COMPOSE_PROJ:-esp32-webflasher}"
SKIP_COMPOSE="${SKIP_COMPOSE:-0}"
READY_TIMEOUT="${READY_TIMEOUT:-60}"

COMPOSE=(docker compose --project-name "$COMPOSE_PROJ")

log()  { printf '\033[1;34m[acceptance]\033[0m %s\n' "$*"; }
pass() { printf '\033[1;32m  PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  FAIL\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Bring the stack up (unless the caller already owns it)
# ---------------------------------------------------------------------------
if [ "$SKIP_COMPOSE" != "1" ]; then
  log "docker compose up --build (this builds the images on first run) ..."
  "${COMPOSE[@]}" up --build -d
  trap 'log "docker compose down ..."; "${COMPOSE[@]}" down -v --remove-orphans >/dev/null || true' EXIT
fi

# ---------------------------------------------------------------------------
# 1. Readiness: the API must answer before any check runs
# ---------------------------------------------------------------------------
log "waiting for $BASE_URL/api/versions (timeout ${READY_TIMEOUT}s) ..."
deadline=$(( $(date +%s) + READY_TIMEOUT ))
ready=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -fsS --max-time 2 "$BASE_URL/api/versions" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail "server not ready within ${READY_TIMEOUT}s (is the compose stack up?)"
pass "server ready at $BASE_URL"

# ---------------------------------------------------------------------------
# 2. All HTTP checks — python3 stdlib only (urllib + json + hashlib)
# ---------------------------------------------------------------------------
log "running the §10 acceptance checks ..."
BASE_URL="$BASE_URL" python3 - <<'PY'
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ["BASE_URL"].rstrip("/")
CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


def http(method, path, data=None, headers=None, timeout=30):
    """One HTTP request; returns (status, body_bytes, response_headers)."""
    req = urllib.request.Request(
        BASE + path, data=data, method=method, headers=headers or {}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def multipart(fields, files):
    """Minimal multipart/form-data encoder (stdlib only).

    fields: list of (name, value); files: list of (name, filename, content).
    """
    boundary = "----wf-acceptance-boundary"
    chunks = []
    for name, value in fields:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, filename, content in files:
        chunks.append(
            (
                f'--{boundary}\r\nContent-Disposition: form-data; '
                f'name="{name}"; filename="{filename}"\r\n'
                f'Content-Type: application/octet-stream\r\n\r\n'
            ).encode()
            + content
            + b"\r\n"
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    return body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def upload(version, files):
    """POST a multipart upload (field ``version`` + 1..N ``files``)."""
    parts = [("files", name, data) for name, data in files]
    body, headers = multipart([("version", version)], parts)
    return http("POST", "/api/upload", data=body, headers=headers)


def seeded(seed, size):
    """Deterministic payload (same algorithm as tests/integration/conftest.py)."""
    out = bytearray()
    counter = 0
    while len(out) < size:
        out.extend(hashlib.sha256(f"{seed}:{counter}".encode()).digest())
        counter += 1
    return bytes(out[:size])


def expect_json(resp_body):
    try:
        return json.loads(resp_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise AssertionError(f"response is not JSON: {resp_body[:200]!r}")


def assert_error(status, body, expected):
    if status != expected:
        raise AssertionError(f"expected HTTP {expected}, got {status}: {body[:200]!r}")
    body = expect_json(body)
    if not (isinstance(body, dict) and isinstance(body.get("error"), str)):
        raise AssertionError(f"error body must be {{'error': str}}: {body!r}")
    return body


# -- deterministic payloads (same as the pytest integration suite) -----------
PAYLOADS = {
    "bootloader-esp32.bin": seeded(1, 4096),
    "partition-table-esp32.bin": seeded(2, 8192),
    "firmware-esp32.bin": seeded(3, 16384),
}
HASHES = {name: hashlib.sha256(data).hexdigest() for name, data in PAYLOADS.items()}
EXPECTED_ADDRESS = {
    "bootloader-esp32.bin": "0x1000",
    "partition-table-esp32.bin": "0x8000",
    "firmware-esp32.bin": "0x10000",
}
VERSION = "v-acceptance"


@check("1. fresh start -> GET /api/versions -> {\"versions\": []}")
def c1_fresh_listing():
    status, body, _ = http("GET", "/api/versions")
    if status != 200:
        raise AssertionError(f"expected 200, got {status}: {body[:200]!r}")
    listing = expect_json(body)
    if listing != {"versions": []}:
        raise AssertionError(f"expected empty listing, got: {listing!r}")


@check("2. upload 3 .bin files -> 201 + saved sizes match")
def c2_upload():
    status, body, _ = upload(VERSION, [(n, data) for n, data in PAYLOADS.items()])
    if status != 201:
        raise AssertionError(f"expected 201, got {status}: {body[:200]!r}")
    saved = {s["name"]: s["size"] for s in expect_json(body)["saved"]}
    if saved != {name: len(data) for name, data in PAYLOADS.items()}:
        raise AssertionError(f"saved sizes mismatch: {saved!r}")


@check("3. GET /api/versions -> correct name / size / address per file")
def c3_listing_shape():
    status, body, _ = http("GET", "/api/versions")
    if status != 200:
        raise AssertionError(f"expected 200, got {status}")
    versions = expect_json(body)["versions"]
    entry = next((v for v in versions if v["version"] == VERSION), None)
    if entry is None:
        raise AssertionError(f"version {VERSION!r} missing from listing: {versions!r}")
    for name in PAYLOADS:
        f = next((x for x in entry["files"] if x["name"] == name), None)
        if f is None:
            raise AssertionError(f"{name!r} missing from listing")
        if f["size"] != len(PAYLOADS[name]):
            raise AssertionError(f"{name}: size {f['size']} != {len(PAYLOADS[name])}")
        if f["address"] != EXPECTED_ADDRESS[name]:
            raise AssertionError(f"{name}: address {f['address']} != {EXPECTED_ADDRESS[name]}")
        if "modified" not in f:
            raise AssertionError(f"{name}: missing 'modified' timestamp")


@check("4. meta.json upload -> 201 + address & label overrides in listing")
def c4_meta_overrides():
    meta = {"files": {"firmware-esp32.bin": {"address": "0x20000", "label": "Custom firmware"}}}
    status, body, _ = upload(VERSION, [("meta.json", json.dumps(meta).encode())])
    if status != 201:
        raise AssertionError(f"expected 201, got {status}: {body[:200]!r}")
    status, body, _ = http("GET", "/api/versions")
    versions = expect_json(body)["versions"]
    entry = next(v for v in versions if v["version"] == VERSION)
    f = next(x for x in entry["files"] if x["name"] == "firmware-esp32.bin")
    if f["address"] != "0x20000":
        raise AssertionError(f"address override not applied: {f!r}")
    if f.get("label") != "Custom firmware":
        raise AssertionError(f"label override not applied: {f!r}")
    if "meta.json" in [x["name"] for x in entry["files"]]:
        raise AssertionError("meta.json must be excluded from the listing")


@check("5a. path traversal: version=.. -> 400 (JSON)")
def c5a_traversal_version():
    status, body, _ = upload("..", [("a.bin", b"x")])
    assert_error(status, body, 400)


@check("5b. path traversal: filename with .. -> 400 (JSON)")
def c5b_traversal_filename():
    status, body, _ = upload("v-acceptance-err", [("../escape.bin", b"x")])
    assert_error(status, body, 400)


@check("6. download each file -> sha256 byte-exact + octet-stream")
def c6_byte_exact():
    for name, data in PAYLOADS.items():
        status, body, headers = http(
            "GET", f"/api/versions/{VERSION}/files/{name}"
        )
        if status != 200:
            raise AssertionError(f"{name}: expected 200, got {status}")
        if not headers.get("Content-Type", "").startswith("application/octet-stream"):
            raise AssertionError(f"{name}: bad Content-Type: {headers.get('Content-Type')!r}")
        if hashlib.sha256(body).hexdigest() != HASHES[name]:
            raise AssertionError(f"{name}: sha256 mismatch (not byte-exact)")
        if body != data:
            raise AssertionError(f"{name}: bytes differ")


@check("7a. unknown route -> 404 (JSON)")
def c7a_404():
    status, body, _ = http("GET", "/api/nope")
    assert_error(status, body, 404)


@check("7b. wrong method -> 405 (JSON)")
def c7b_405():
    status, body, _ = http("DELETE", "/api/versions")
    assert_error(status, body, 405)


@check("7c. oversized upload (> 64 MiB) -> 413 (JSON)")
def c7c_413():
    status, body, _ = upload("v-acceptance-err", [("big.bin", b"\x00" * (65 * 1024 * 1024))])
    assert_error(status, body, 413)


@check("8a. GET / -> the SPA (index.html)")
def c8a_index():
    status, body, headers = http("GET", "/")
    if status != 200:
        raise AssertionError(f"expected 200, got {status}")
    if "text/html" not in headers.get("Content-Type", ""):
        raise AssertionError(f"bad Content-Type: {headers.get('Content-Type')!r}")
    text = body.decode("utf-8")
    if "ESP32 Web Flasher" not in text or "<!DOCTYPE html>" not in text:
        raise AssertionError("index.html does not look like the SPA")


@check("8b. /static/* assets -> 200 with expected content types")
def c8b_static():
    for name, prefix in (
        ("app.js", "text/javascript"),
        ("lib.js", "text/javascript"),
        ("style.css", "text/css"),
    ):
        status, body, headers = http("GET", f"/static/{name}")
        if status != 200:
            raise AssertionError(f"/static/{name}: expected 200, got {status}")
        if not headers.get("Content-Type", "").startswith(prefix):
            raise AssertionError(f"/static/{name}: bad Content-Type: {headers.get('Content-Type')!r}")
        if not body:
            raise AssertionError(f"/static/{name}: empty body")


for name, fn in CHECKS:
    try:
        fn()
    except AssertionError as exc:
        print(f"  FAIL {name}\n       {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"  PASS {name}")
print(f"  {len(CHECKS)}/{len(CHECKS)} acceptance checks passed")
PY

# ---------------------------------------------------------------------------
# 3. On-disk check: the uploaded files must live in the `binaries` volume
#    (spec §10: "file appears under /srv/binaries/v1.0.0/")
# ---------------------------------------------------------------------------
if [ "$SKIP_COMPOSE" != "1" ]; then
  log "verifying the uploaded files on disk (binaries volume) ..."
  listing="$(docker compose --project-name "$COMPOSE_PROJ" exec -T webflasher python3 - <<'PY'
import json, os
root = os.environ.get("BINARIES_DIR", "/srv/binaries")
version = "v-acceptance"
names = sorted(os.listdir(os.path.join(root, version)))
print(json.dumps(names))
PY
)"
  expected='["bootloader-esp32.bin", "firmware-esp32.bin", "meta.json", "partition-table-esp32.bin"]'
  if [ "$listing" != "$expected" ]; then
    fail "on-disk files mismatch: got $listing, expected $expected"
  fi
  pass "on-disk: $listing"
fi

log "ALL ACCEPTANCE CHECKS PASSED"
