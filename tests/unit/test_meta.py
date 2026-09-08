"""Unit tests for ``load_meta`` and ``build_version_entry``.

Spec: issue #3 §5.2 (listing shape) and the optional ``meta.json`` override
(§5.4).  Part of issue #26 (PR 1) / #23.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import app as wf_app
from conftest import write_version

MODIFIED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


# ---------------------------------------------------------------------------
# load_meta
# ---------------------------------------------------------------------------

class TestLoadMeta:
    def test_missing_meta_returns_empty_dict(self, tmp_path):
        assert wf_app.load_meta(str(tmp_path)) == {}

    def test_broken_json_returns_empty_dict(self, tmp_path, caplog):
        (tmp_path / "meta.json").write_text("{ not valid json", encoding="utf-8")
        with caplog.at_level("WARNING"):
            assert wf_app.load_meta(str(tmp_path)) == {}
        assert any("meta.json" in r.message for r in caplog.records)

    def test_non_dict_top_level_returns_empty_dict(self, tmp_path, caplog):
        (tmp_path / "meta.json").write_text('[1, 2, 3]', encoding="utf-8")
        with caplog.at_level("WARNING"):
            assert wf_app.load_meta(str(tmp_path)) == {}

    @pytest.mark.parametrize("top", ['"string"', "42", "null", "true"])
    def test_non_dict_top_level_variants(self, tmp_path, top):
        (tmp_path / "meta.json").write_text(top, encoding="utf-8")
        assert wf_app.load_meta(str(tmp_path)) == {}

    def test_valid_meta_is_returned(self, tmp_path):
        meta = {"files": {"firmware-esp32.bin": {"address": "0x20000", "label": "Factory app"}}}
        (tmp_path / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        assert wf_app.load_meta(str(tmp_path)) == meta

    def test_meta_json_that_is_a_directory_is_ignored(self, tmp_path):
        (tmp_path / "meta.json").mkdir()
        assert wf_app.load_meta(str(tmp_path)) == {}


# ---------------------------------------------------------------------------
# build_version_entry
# ---------------------------------------------------------------------------

class TestBuildVersionEntry:
    def test_listing_shape(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {
                "bootloader-esp32.bin": b"B" * 16,
                "partition-table-esp32.bin": b"P" * 8,
                "firmware-esp32.bin": b"F" * 32,
            },
        )
        entry = wf_app.build_version_entry("v1.0.0")

        assert entry["version"] == "v1.0.0"
        assert len(entry["files"]) == 3
        for f in entry["files"]:
            assert set(f) == {"name", "address", "size", "modified"}
            assert MODIFIED_RE.match(f["modified"])

        by_name = {f["name"]: f for f in entry["files"]}
        assert by_name["bootloader-esp32.bin"]["address"] == "0x1000"
        assert by_name["bootloader-esp32.bin"]["size"] == 16
        assert by_name["partition-table-esp32.bin"]["address"] == "0x8000"
        assert by_name["firmware-esp32.bin"]["address"] == "0x10000"

    def test_files_are_sorted(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"zeta.bin": b"1", "alpha.bin": b"2", "mid.bin": b"3"},
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert [f["name"] for f in entry["files"]] == ["alpha.bin", "mid.bin", "zeta.bin"]

    def test_meta_json_is_excluded_from_listing(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {}}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert [f["name"] for f in entry["files"]] == ["firmware-esp32.bin"]
        assert all("meta.json" != f["name"] for f in entry["files"])

    def test_subdirectories_are_skipped(self, wf):
        version_dir = write_version(
            wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": b"F" * 4}
        )
        (version_dir / "subdir").mkdir()
        (version_dir / "subdir" / "inner.bin").write_bytes(b"X")
        entry = wf_app.build_version_entry("v1.0.0")
        assert [f["name"] for f in entry["files"]] == ["firmware-esp32.bin"]

    def test_address_override_applied(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {"firmware-esp32.bin": {"address": "0x20000"}}}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert entry["files"][0]["address"] == "0x20000"

    def test_label_override_applied(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {"firmware-esp32.bin": {"label": "Factory app"}}}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert entry["files"][0]["label"] == "Factory app"

    def test_address_and_label_overrides_together(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {"firmware-esp32.bin": {"address": "0x30000", "label": "Custom"}}}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert entry["files"][0]["address"] == "0x30000"
        assert entry["files"][0]["label"] == "Custom"

    @pytest.mark.parametrize(
        "override",
        [
            {"address": 0x30000},            # address must be a string
            {"address": None},
            {"label": 42},                   # label must be a string
            {"label": None},
            {"bogus_key": "ignored"},
        ],
    )
    def test_malformed_overrides_are_ignored(self, wf, override):
        import json as _json

        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta=_json.dumps({"files": {"firmware-esp32.bin": override}}),
        )
        entry = wf_app.build_version_entry("v1.0.0")
        f = entry["files"][0]
        # Default address kept, no label key added.
        assert f["address"] == "0x10000"
        assert "label" not in f

    def test_override_for_unknown_file_is_harmless(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": {"does-not-exist.bin": {"address": "0x99999", "label": "x"}}}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert entry["files"][0]["address"] == "0x10000"
        assert "label" not in entry["files"][0]

    def test_non_dict_files_section_is_ignored(self, wf):
        write_version(
            wf.binaries_dir,
            "v1.0.0",
            {"firmware-esp32.bin": b"F" * 4},
            meta='{"files": ["not", "a", "dict"]}',
        )
        entry = wf_app.build_version_entry("v1.0.0")
        assert entry["files"][0]["address"] == "0x10000"
        assert "label" not in entry["files"][0]

    def test_missing_version_dir_yields_empty_files(self, wf):
        entry = wf_app.build_version_entry("does-not-exist")
        assert entry == {"version": "does-not-exist", "files": []}
