"""Integration: ``DELETE /api/versions/<version>`` (issue #36).

Same contract as the unit suite, verified end-to-end against the **real**
``app.py`` server over HTTP: 200 + ``{"deleted": ...}`` + bundle gone from
disk and listing, 404 for a missing version, 400 for an unsafe name, and a
404 JSON from the serve route after the delete.
"""

from __future__ import annotations

import json


def _upload(session, base_url: str, version: str, files: list[tuple[str, bytes]]):
    return session.post(
        f"{base_url}/api/upload",
        data={"version": version},
        files=[("files", (name, payload)) for name, payload in files],
    )


def _assert_error(resp, expected_status: int):
    """Every error must be the uniform ``{"error": "..."}`` JSON shape."""
    assert resp.status_code == expected_status, (
        f"expected {expected_status}, got {resp.status_code}: {resp.text!r}"
    )
    body = resp.json()
    assert isinstance(body, dict) and "error" in body and isinstance(body["error"], str)
    return body


class TestApiDelete:
    def test_delete_removes_bundle_end_to_end(self, server):
        """200 + ``{"deleted": ...}`` + the whole bundle (incl. meta.json) gone."""
        version = "v-int-del-1"
        meta = {"files": {"firmware-esp32.bin": {"label": "Factory app"}}}
        resp = _upload(
            server.session,
            server.base_url,
            version,
            [
                ("bootloader-esp32.bin", b"BOOT"),
                ("partition-table-esp32.bin", b"PART"),
                ("firmware-esp32.bin", b"FIRM"),
                ("meta.json", json.dumps(meta).encode("utf-8")),
            ],
        )
        assert resp.status_code == 201, resp.text
        version_dir = server.binaries_dir / version
        assert (version_dir / "meta.json").is_file()

        resp = server.session.delete(f"{server.base_url}/api/versions/{version}")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"deleted": version}
        assert not version_dir.exists()

        listing = server.session.get(f"{server.base_url}/api/versions").json()["versions"]
        assert all(v["version"] != version for v in listing)

        # The serve route now answers 404 JSON for any file of the bundle.
        serve = server.session.get(
            f"{server.base_url}/api/versions/{version}/files/firmware-esp32.bin"
        )
        _assert_error(serve, 404)

    def test_delete_one_of_two_keeps_the_other(self, server):
        first = "v-int-del-a"
        second = "v-int-del-b"
        for v in (first, second):
            resp = _upload(
                server.session,
                server.base_url,
                v,
                [("firmware-esp32.bin", b"X")],
            )
            assert resp.status_code == 201, resp.text

        resp = server.session.delete(f"{server.base_url}/api/versions/{first}")
        assert resp.status_code == 200
        assert resp.json() == {"deleted": first}

        assert not (server.binaries_dir / first).exists()
        assert (server.binaries_dir / second / "firmware-esp32.bin").is_file()

        listing = server.session.get(f"{server.base_url}/api/versions").json()["versions"]
        assert [v["version"] for v in listing] == [second]

        # Clean up the survivor: the suite shares one server + storage dir,
        # and test_api_flow.py's "fresh start" test expects an empty listing.
        resp = server.session.delete(f"{server.base_url}/api/versions/{second}")
        assert resp.status_code == 200

    def test_delete_missing_version_404_json(self, server):
        resp = server.session.delete(f"{server.base_url}/api/versions/v-int-missing")
        _assert_error(resp, 404)

    def test_delete_invalid_version_400_json(self, server):
        # ``.hidden`` fails ``valid_version`` (leading dot) → 400, no FS access.
        resp = server.session.delete(f"{server.base_url}/api/versions/.hidden")
        _assert_error(resp, 400)

    def test_delete_twice_404_second_time(self, server):
        version = "v-int-del-2"
        resp = _upload(
            server.session,
            server.base_url,
            version,
            [("firmware-esp32.bin", b"X")],
        )
        assert resp.status_code == 201
        assert server.session.delete(f"{server.base_url}/api/versions/{version}").status_code == 200
        _assert_error(
            server.session.delete(f"{server.base_url}/api/versions/{version}"),
            404,
        )
