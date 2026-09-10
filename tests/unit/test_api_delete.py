"""Unit tests for ``DELETE /api/versions/<version>`` (issue #36).

The route removes a whole version bundle — the directory under
``BINARIES_DIR`` with all its files (bootloader, partition table, OTA
data, firmware, ``meta.json``) — in one call.

Contract (issue #36, approved plan):
  * unsafe version name        → ``400 {"error": ...}``
  * version directory missing  → ``404 {"error": ...}``
  * success                    → ``200 {"deleted": "<version>"}`` + dir gone
"""

from __future__ import annotations

import pytest

import app as wf_app
from conftest import write_version


class TestApiDelete:
    def test_delete_existing_version_removes_bundle(self, wf):
        """200 + the directory is gone from disk and from the listing."""
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {
                "bootloader-esp32.bin": b"B" * 100,
                "partition-table-esp32.bin": b"P" * 50,
                "ota_data_initial.bin": b"O" * 20,
                "firmware-esp32.bin": b"F" * 1000,
            },
            meta='{"files": {}}',
        )
        version_dir = wf.binaries_dir / "v1.0.0"
        assert version_dir.is_dir()

        resp = wf.client.delete("/api/versions/v1.0.0")
        assert resp.status_code == 200
        assert resp.get_json() == {"deleted": "v1.0.0"}

        assert not version_dir.exists()
        body = wf.client.get("/api/versions").get_json()
        assert body == {"versions": []}

    def test_delete_removes_meta_json_too(self, wf):
        """The whole bundle goes — including ``meta.json``."""
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F"},
            meta='{"files": {"firmware-esp32.bin": {"label": "Factory app"}}}',
        )
        resp = wf.client.delete("/api/versions/v1.0.0")
        assert resp.status_code == 200
        assert not (wf.binaries_dir / "v1.0.0").exists()
        assert not (wf.binaries_dir / "v1.0.0" / "meta.json").exists()

    def test_other_versions_untouched(self, wf):
        write_version(wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": b"ONE"})
        write_version(wf.binaries_dir, "v2.0.0", {"firmware-esp32.bin": b"TWO"})

        resp = wf.client.delete("/api/versions/v1.0.0")
        assert resp.status_code == 200

        assert not (wf.binaries_dir / "v1.0.0").exists()
        assert (wf.binaries_dir / "v2.0.0" / "firmware-esp32.bin").read_bytes() == b"TWO"

        body = wf.client.get("/api/versions").get_json()
        assert [v["version"] for v in body["versions"]] == ["v2.0.0"]
        assert body["versions"][0]["files"][0]["name"] == "firmware-esp32.bin"

    def test_delete_nonexistent_version_returns_404(self, wf):
        resp = wf.client.delete("/api/versions/nope")
        assert resp.status_code == 404
        body = resp.get_json()
        assert isinstance(body, dict) and "error" in body and isinstance(body["error"], str)

    def test_delete_invalid_version_returns_400(self, wf):
        # A version that fails ``valid_version`` (leading dot) must be
        # rejected before any filesystem access.
        resp = wf.client.delete("/api/versions/.hidden")
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_delete_is_not_idempotent(self, wf):
        """A second delete of the same version is a 404 (it is gone)."""
        write_version(wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": b"F"})
        assert wf.client.delete("/api/versions/v1.0.0").status_code == 200
        assert wf.client.delete("/api/versions/v1.0.0").status_code == 404

    def test_delete_empty_version_dir(self, wf):
        """Even a version with no files is a valid bundle to delete."""
        (wf.binaries_dir / "v-empty").mkdir()
        resp = wf.client.delete("/api/versions/v-empty")
        assert resp.status_code == 200
        assert resp.get_json() == {"deleted": "v-empty"}
        assert not (wf.binaries_dir / "v-empty").exists()
