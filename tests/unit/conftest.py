"""Shared pytest fixtures for the backend unit suite (issue #26, PR 1 / #23).

``app.py`` reads ``BINARIES_DIR`` at *import* time and creates the directory,
so the environment variable must point at a temp dir **before** the first
``import app``.  This conftest is imported by pytest before any test module,
so it performs that setup exactly once.

Fixtures / helpers
------------------
``wf``            — namespace with ``app``, ``client`` and a fresh, empty
                    ``binaries_dir`` (``pathlib.Path``) per test.
``write_version`` — create ``<binaries_dir>/<version>/`` with files + optional
                    ``meta.json``.
``upload``        — POST a multipart upload via the Flask test client.
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

# Make the repository root (the directory containing ``app.py``) importable
# regardless of where pytest is invoked from.
_REPO_ROOT = str(Path(__file__).resolve().parents[2])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# Point the storage dir at a temp dir BEFORE ``app`` is imported (see above),
# so the import-time ``os.makedirs(BINARIES_DIR)`` never touches real paths.
os.environ.setdefault(
    "BINARIES_DIR", tempfile.mkdtemp(prefix="esp32-webflasher-tests-")
)


@pytest.fixture()
def wf():
    """Flask app + test client + a fresh, empty ``binaries_dir`` per test.

    The directory is created empty; tests populate it (or use ``write_version``)
    so every test is hermetic and order-independent.
    """
    binaries_dir = Path(tempfile.mkdtemp(prefix="wf-binaries-"))
    import app as wf_app  # imported once; cached by ``sys.modules`` afterwards

    # ``app.py`` reads the module-global ``BINARIES_DIR`` (in the routes and in
    # ``build_version_entry``), so point it at this test's fresh directory.
    wf_app.BINARIES_DIR = str(binaries_dir)

    ns = types.SimpleNamespace(
        app=wf_app.app,
        client=wf_app.app.test_client(),
        binaries_dir=binaries_dir,
    )
    yield ns


def write_version(
    binaries_dir: Path,
    version: str,
    files: dict[str, bytes],
    meta: str | None = None,
) -> Path:
    """Create ``binaries_dir/<version>/`` with *files* and optional *meta* JSON.

    Returns the version directory.
    """
    version_dir = binaries_dir / version
    version_dir.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        (version_dir / name).write_bytes(payload)
    if meta is not None:
        (version_dir / "meta.json").write_text(meta, encoding="utf-8")
    return version_dir


def upload(client, version: str, files: list[tuple[str, bytes]]):
    """POST a multipart upload (field ``version`` + 1..N ``files``) and return
    the response.  *files* is a list of ``(filename, payload)`` pairs."""
    data: dict = {"version": version}
    if len(files) == 1:
        data["files"] = (io.BytesIO(files[0][1]), files[0][0])
    else:
        data["files"] = [(io.BytesIO(payload), name) for name, payload in files]
    return client.post(
        "/api/upload", data=data, content_type="multipart/form-data"
    )


def now_utc_iso() -> str:
    """The ``modified`` timestamp format used by ``build_version_entry``."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
