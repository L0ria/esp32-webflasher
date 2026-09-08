"""Integration: the error contract — every failure answers JSON ``{"error"}``.

Spec: issue #3 §5 / §10, issue #26 §4.B1 steps 5 and 7.  Runs against the
**real** ``app.py`` server over HTTP.
"""

from __future__ import annotations

import io


def _assert_error(resp, expected_status: int):
    """Every error must be the uniform ``{"error": "..."}`` JSON shape."""
    assert resp.status_code == expected_status, (
        f"expected {expected_status}, got {resp.status_code}: {resp.text!r}"
    )
    body = resp.json()
    assert isinstance(body, dict) and "error" in body and isinstance(body["error"], str)
    return body


class TestApiErrors:
    def test_path_traversal_version_rejected(self, server):
        """B1 step 5: ``version=..`` → 400 (JSON)."""
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": ".."},
            files=[("files", ("a.bin", b"x"))],
        )
        _assert_error(resp, 400)

    def test_path_traversal_filename_rejected(self, server):
        """B1 step 5: a filename containing ``..`` → 400 (JSON)."""
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": "v-int-err"},
            files=[("files", ("../escape.bin", b"x"))],
        )
        _assert_error(resp, 400)

    def test_unknown_route_404_json(self, server):
        """B1 step 7: unknown route → 404 (JSON)."""
        resp = server.session.get(f"{server.base_url}/api/nope")
        _assert_error(resp, 404)

    def test_wrong_method_405_json(self, server):
        """B1 step 7: wrong method on a known route → 405 (JSON)."""
        resp = server.session.delete(f"{server.base_url}/api/versions")
        _assert_error(resp, 405)

    def test_oversized_upload_413_json(self, server):
        """B1 step 7: an upload > 64 MiB → 413 (JSON).

        The payload is a 65 MiB ``BytesIO`` (just over the 64 MiB cap); the
        server must reject it with 413 and save nothing.
        """
        big = io.BytesIO(b"\x00" * (65 * 1024 * 1024))
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": "v-int-err"},
            files=[("files", ("big.bin", big))],
            timeout=60,
        )
        _assert_error(resp, 413)

    def test_missing_version_400_json(self, server):
        """B1 step 7: missing ``version`` field → 400 (JSON)."""
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            files=[("files", ("a.bin", b"x"))],
        )
        _assert_error(resp, 400)

    def test_missing_files_400_json(self, server):
        """B1 step 7: missing ``files`` field → 400 (JSON)."""
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": "v-int-err"},
        )
        _assert_error(resp, 400)

    def test_non_bin_rejected_400_json(self, server):
        """B1 step 7: a non-``.bin`` / non-``meta.json`` file → 400 (JSON)."""
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": "v-int-err"},
            files=[("files", ("notes.txt", b"hello"))],
        )
        _assert_error(resp, 400)
