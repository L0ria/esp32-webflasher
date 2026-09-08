"""Unit tests for ``POST /api/upload``.

Spec: issue #3 §5.3.  Includes the ``meta.json`` acceptance regression
(issues #20 / #25).  Part of issue #26 (PR 1) / #23.
"""

from __future__ import annotations

import io

import pytest

import app as wf_app
from conftest import upload


class TestApiUpload:
    def test_single_bin_returns_201_and_saves(self, wf):
        resp = upload(wf.client, "v1.0.0", [("firmware-esp32.bin", b"12345")])
        assert resp.status_code == 201
        body = resp.get_json()
        assert body["version"] == "v1.0.0"
        assert body["saved"] == [{"name": "firmware-esp32.bin", "size": 5}]
        assert (wf.binaries_dir / "v1.0.0" / "firmware-esp32.bin").read_bytes() == b"12345"

    def test_multi_bin_returns_201_with_all_sizes(self, wf):
        resp = upload(
            wf.client,
            "v1.0.0",
            [
                ("bootloader-esp32.bin", b"BB"),
                ("partition-table-esp32.bin", b"PPPP"),
                ("firmware-esp32.bin", b"FFFFFFF"),
            ],
        )
        assert resp.status_code == 201
        body = resp.get_json()
        assert body["version"] == "v1.0.0"
        saved = {s["name"]: s["size"] for s in body["saved"]}
        assert saved == {
            "bootloader-esp32.bin": 2,
            "partition-table-esp32.bin": 4,
            "firmware-esp32.bin": 7,
        }

    def test_overwrite_same_name(self, wf):
        upload(wf.client, "v1.0.0", [("firmware.bin", b"12345")])
        resp = upload(wf.client, "v1.0.0", [("firmware.bin", b"OVERWRITE")])
        assert resp.status_code == 201
        assert resp.get_json()["saved"][0]["size"] == 9
        assert (wf.binaries_dir / "v1.0.0" / "firmware.bin").read_bytes() == b"OVERWRITE"

    def test_missing_version_returns_400(self, wf):
        # No ``version`` form field at all.
        resp = wf.client.post(
            "/api/upload",
            data={"files": (io.BytesIO(b"x"), "a.bin")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    @pytest.mark.parametrize("bad_version", ["", "..", "a/b", "a\\b", "a\x00b", "a" * 65])
    def test_invalid_version_returns_400(self, wf, bad_version):
        resp = upload(wf.client, bad_version, [("a.bin", b"x")])
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_missing_files_returns_400(self, wf):
        resp = wf.client.post(
            "/api/upload",
            data={"version": "v1.0.0"},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_non_bin_file_returns_400(self, wf):
        resp = upload(wf.client, "v1.0.0", [("notes.txt", b"x")])
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_dotdot_filename_returns_400(self, wf):
        resp = upload(wf.client, "v1.0.0", [("../evil.bin", b"x")])
        assert resp.status_code == 400
        assert "error" in resp.get_json()

    def test_meta_json_accepted_regression_20_25(self, wf):
        # Regression: meta.json must be accepted by /api/upload (issue #20, fixed in #25).
        resp = upload(
            wf.client,
            "v1.0.0",
            [
                ("firmware-esp32.bin", b"fw"),
                ("meta.json", b'{"files": {}}'),
            ],
        )
        assert resp.status_code == 201
        body = resp.get_json()
        saved = {s["name"]: s["size"] for s in body["saved"]}
        assert saved == {"firmware-esp32.bin": 2, "meta.json": 13}
        assert (wf.binaries_dir / "v1.0.0" / "meta.json").is_file()

    def test_meta_json_alone_accepted(self, wf):
        resp = upload(wf.client, "v1.0.0", [("meta.json", b'{"files": {}}')])
        assert resp.status_code == 201
        assert (wf.binaries_dir / "v1.0.0" / "meta.json").is_file()

    def test_oversized_upload_returns_413(self, wf):
        # Shrink the limit for the test, then restore it.
        original = wf.app.config["MAX_CONTENT_LENGTH"]
        try:
            wf.app.config["MAX_CONTENT_LENGTH"] = 10
            resp = upload(wf.client, "v1.0.0", [("a.bin", b"A" * 100)])
            assert resp.status_code == 413
            assert "error" in resp.get_json()
        finally:
            wf.app.config["MAX_CONTENT_LENGTH"] = original

    def test_oserror_returns_500(self, wf):
        # Make the version path a *file* so ``os.makedirs`` raises
        # ``FileExistsError`` (an ``OSError``) inside the handler.
        (wf.binaries_dir / "v1.0.0").write_bytes(b"blocker")
        resp = upload(wf.client, "v1.0.0", [("a.bin", b"x")])
        assert resp.status_code == 500
        assert "error" in resp.get_json()
