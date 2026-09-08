"""Shared pytest fixtures for the API integration suite (issue #26, PR 3 / #24).

Unlike the unit suite (Flask test client), these tests start the **real**
``python app.py`` server as a subprocess — real WSGI stack, real filesystem,
real HTTP over loopback — so the suite is the scripted, repeatable core of the
spec §10 acceptance checklist.

Fixtures / helpers
------------------
``server``      — session-scoped: a ready ``requests.Session`` bound to a
                  real ``app.py`` subprocess + its temp ``BINARIES_DIR``
                  (``pathlib.Path``).  One server for the whole suite; every
                  test uses its own version directory so tests stay
                  order-independent.
``payloads``    — deterministic, seeded pseudo-random firmware payloads with
                  distinct sha256 digests (byte-exactness checks are
                  meaningful).
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path

import pytest
import requests

_REPO_ROOT = Path(__file__).resolve().parents[2]

#: Bounded readiness budget (seconds) for the server to answer.
READY_TIMEOUT = 10.0

#: How long we give the server to shut down before escalating to a kill.
SHUTDOWN_TIMEOUT = 5.0


def _free_port() -> int:
    """Pick a free TCP port on loopback.

    Binds ``127.0.0.1:0``, lets the OS assign a port, and reuses the number
    after releasing it.  (Standard trade-off: a tiny race window exists, but
    on CI / local machines it is not a practical concern.)
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def server_log_path() -> Path:
    """Where the server subprocess's stdout/stderr are captured."""
    return Path(tempfile.mkdtemp(prefix="wf-integration-")) / "server.log"


@pytest.fixture(scope="session")
def server(server_log_path: Path) -> types.SimpleNamespace:
    """Start the real ``app.py`` server and yield a bound session.

    Yields a ``SimpleNamespace`` with:
      * ``session``   — ``requests.Session`` bound to ``http://127.0.0.1:<port>``
      * ``base_url``  — the base URL string
      * ``binaries_dir`` — the temp storage dir (``pathlib.Path``)
      * ``log_path``  — server stdout/stderr (for failure triage)
    """
    port = _free_port()
    binaries_dir = Path(tempfile.mkdtemp(prefix="wf-integration-binaries-"))
    server_log_path.parent.mkdir(parents=True, exist_ok=True)

    env = dict(os.environ)
    env["PORT"] = str(port)
    env["BINARIES_DIR"] = str(binaries_dir)
    # Keep the server quiet-ish but capture everything for triage.
    env.pop("WERKZEUG_RUN_MAIN", None)

    log_fh = open(server_log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, str(_REPO_ROOT / "app.py")],
        cwd=str(_REPO_ROOT),
        env=env,
        stdout=log_fh,
        stderr=subprocess.STDOUT,
    )

    base_url = f"http://127.0.0.1:{port}"
    session = requests.Session()
    ready = False
    deadline = time.monotonic() + READY_TIMEOUT
    try:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"server exited early (rc={proc.returncode}); log:\n"
                    f"{server_log_path.read_text(errors='replace')}"
                )
            try:
                resp = session.get(f"{base_url}/api/versions", timeout=1.0)
                if resp.status_code == 200:
                    ready = True
                    break
            except requests.RequestException:
                pass  # not up yet
            time.sleep(0.1)
        if not ready:
            raise RuntimeError(
                f"server did not become ready within {READY_TIMEOUT:.0f}s; "
                f"log:\n{server_log_path.read_text(errors='replace')}"
            )

        yield types.SimpleNamespace(
            session=session,
            base_url=base_url,
            binaries_dir=binaries_dir,
            log_path=server_log_path,
        )
    finally:
        session.close()
        proc.terminate()
        try:
            proc.wait(timeout=SHUTDOWN_TIMEOUT)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=SHUTDOWN_TIMEOUT)
        log_fh.close()


# ---------------------------------------------------------------------------
# Deterministic payloads
# ---------------------------------------------------------------------------


def _seeded_payload(seed: int, size: int) -> bytes:
    """Deterministic pseudo-random payload (distinct per seed)."""
    import hashlib

    out = bytearray()
    counter = 0
    while len(out) < size:
        out.extend(hashlib.sha256(f"{seed}:{counter}".encode()).digest())
        counter += 1
    return bytes(out[:size])


@pytest.fixture(scope="session")
def payloads() -> dict[str, bytes]:
    """Three distinct firmware payloads with known, distinct sha256 digests.

    Sizes are small (a few KiB) so the suite stays fast, but large enough
    that a truncated/corrupted serve would be caught by the sha256 check.
    """
    return {
        "bootloader-esp32.bin": _seeded_payload(1, 4096),
        "partition-table-esp32.bin": _seeded_payload(2, 8192),
        "firmware-esp32.bin": _seeded_payload(3, 16384),
    }


@pytest.fixture(scope="session")
def payload_hashes(payloads: dict[str, bytes]) -> dict[str, str]:
    """sha256 hex digest per payload (for byte-exact serve checks)."""
    import hashlib

    return {name: hashlib.sha256(data).hexdigest() for name, data in payloads.items()}
