"""Unit tests for ``GET /api/versions``.

Spec: issue #3 §5.2.  Part of issue #26 (PR 1) / #23.
"""

from __future__ import annotations

import pytest

import app as wf_app
from conftest import write_version


class TestApiVersions:
    def test_empty_dir_returns_empty_versions(self, wf):
        resp = wf.client.get("/api/versions")
        assert resp.status_code == 200
        assert resp.get_json() == {"versions": []}

    def test_populated_dir_returns_correct_entries(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {
                "bootloader-esp32.bin": b"B" * 19456,
                "partition-table-esp32.bin": b"P" * 2232,
                "firmware-esp32.bin": b"F" * 1234567,
            },
        )
        resp = wf.client.get("/api/versions")
        assert resp.status_code == 200
        body = resp.get_json()

        assert len(body["versions"]) == 1
        v = body["versions"][0]
        assert v["version"] == "v1.0.0"
        assert len(v["files"]) == 3

        by_name = {f["name"]: f for f in v["files"]}
        assert by_name["bootloader-esp32.bin"]["address"] == "0x1000"
        assert by_name["bootloader-esp32.bin"]["size"] == 19456
        assert by_name["partition-table-esp32.bin"]["address"] == "0x8000"
        assert by_name["partition-table-esp32.bin"]["size"] == 2232
        assert by_name["firmware-esp32.bin"]["address"] == "0x10000"
        assert by_name["firmware-esp32.bin"]["size"] == 1234567

    def test_versions_are_sorted(self, wf):
        write_version(wf.binaries_dir, "v2.0.0", {"a.bin": b"1"})
        write_version(wf.binaries_dir, "v1.0.0", {"a.bin": b"2"})
        resp = wf.client.get("/api/versions")
        body = resp.get_json()
        assert [v["version"] for v in body["versions"]] == ["v1.0.0", "v2.0.0"]

    def test_non_directories_are_ignored(self, wf):
        # A plain file directly under BINARIES_DIR is not a version.
        (wf.binaries_dir / "stray-file.bin").write_bytes(b"not a version")
        write_version(wf.binaries_dir, "v1.0.0", {"firmware.bin": b"F"})
        resp = wf.client.get("/api/versions")
        body = resp.get_json()
        assert [v["version"] for v in body["versions"]] == ["v1.0.0"]

    def test_meta_json_overrides_reflected_in_listing(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {"firmware-esp32.bin": {"address": "0x20000", "label": "Factory app"}}}',
        )
        resp = wf.client.get("/api/versions")
        v = resp.get_json()["versions"][0]
        f = v["files"][0]
        assert f["address"] == "0x20000"
        assert f["label"] == "Factory app"
        # meta.json itself is not listed
        assert all(x["name"] != "meta.json" for x in v["files"])

    def test_broken_meta_json_does_not_break_listing(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta="{ broken json",
        )
        resp = wf.client.get("/api/versions")
        assert resp.status_code == 200
        v = resp.get_json()["versions"][0]
        assert v["files"][0]["name"] == "firmware-esp32.bin"
        assert v["files"][0]["address"] == "0x10000"  # default kept
