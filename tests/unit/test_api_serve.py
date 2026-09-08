"""Unit tests for ``GET /api/versions/<version>/files/<filename>``.

Spec: issue #3 §5.5 (serve a stored binary as ``application/octet-stream``).
Part of issue #26 (PR 1) / #23.
"""

from __future__ import annotations

import pytest

import app as wf_app
from conftest import write_version


class TestApiServe:
    def test_serves_exact_bytes_with_octet_stream(self, wf):
        payload = b"\x00\x01\x02PAYLOAD\xff"
        write_version(wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": payload})
        resp = wf.client.get("/api/versions/v1.0.0/files/firmware-esp32.bin")
        assert resp.status_code == 200
        assert resp.data == payload
        assert resp.headers["Content-Type"].startswith("application/octet-stream")
        assert int(resp.headers["Content-Length"]) == len(payload)

    def test_unknown_file_returns_404(self, wf):
        write_version(wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": b"F"})
        resp = wf.client.get("/api/versions/v1.0.0/files/missing.bin")
        assert resp.status_code == 404
        assert "error" in resp.get_json()

    def test_invalid_version_returns_400(self, wf):
        # A version that fails ``valid_version`` (leading dot) must be rejected
        # before any filesystem access.
        resp = wf.client.get("/api/versions/.hidden/files/firmware.bin")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_path_traversal_in_filename_is_not_served(self, wf):
        # A filename that tries to escape the version dir (``..%2F``) must not
        # be served.  Werkzeug normalizes the decoded path, so the request
        # fails to match the route and returns a 404 JSON error — it is never
        # read from outside the version directory.
        resp = wf.client.get("/api/versions/v1.0.0/files/..%2Fevil.bin")
        assert resp.status_code == 404
        assert "error" in resp.get_json()
        assert b"evil" not in resp.data

    def test_meta_json_is_also_servable(self, wf):
        # meta.json is a valid stored file and can be downloaded like any other.
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F"},
            meta='{"files": {}}',
        )
        resp = wf.client.get("/api/versions/v1.0.0/files/meta.json")
        assert resp.status_code == 200
        # Served as application/octet-stream, so compare the exact bytes.
        assert resp.data == b'{"files": {}}'
