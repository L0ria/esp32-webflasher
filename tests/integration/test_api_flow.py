"""Integration: the happy path — upload → list → meta overrides → serve.

Spec: issue #3 §5 (API contract) / §10 (acceptance checklist), issue #26 §4.B1
steps 1–4 and 6.  Runs against the **real** ``app.py`` server over HTTP.
"""

from __future__ import annotations

import hashlib
import json

import pytest


def _upload(session, base_url: str, version: str, files: list[tuple[str, bytes]]):
    """POST a multipart upload (field ``version`` + 1..N ``files``)."""
    return session.post(
        f"{base_url}/api/upload",
        data={"version": version},
        files=[("files", (name, payload)) for name, payload in files],
    )


def _entry(version_body: dict, name: str) -> dict:
    for entry in version_body["files"]:
        if entry["name"] == name:
            return entry
    raise AssertionError(f"{name!r} not in version listing: {version_body!r}")


class TestApiFlow:
    def test_fresh_start_lists_no_versions(self, server):
        """B1 step 1: a fresh server answers an empty (but valid) listing."""
        resp = server.session.get(f"{server.base_url}/api/versions")
        assert resp.status_code == 200
        assert resp.json() == {"versions": []}

    def test_upload_three_binaries_201_and_on_disk(self, server, payloads):
        """B1 step 2: upload 3 known binaries → 201 + files on disk."""
        version = "v-int-flow"
        resp = _upload(server.session, server.base_url, version, list(payloads.items()))
        assert resp.status_code == 201
        body = resp.json()
        assert body["version"] == version
        saved = {s["name"]: s["size"] for s in body["saved"]}
        assert saved == {name: len(payload) for name, payload in payloads.items()}

        for name, payload in payloads.items():
            on_disk = server.binaries_dir / version / name
            assert on_disk.is_file(), f"{name} missing on disk"
            assert on_disk.read_bytes() == payload

    def test_listing_shape_name_size_address(self, server, payloads):
        """B1 step 3: listing reports correct name / size / address per file."""
        version = "v-int-flow"
        resp = server.session.get(f"{server.base_url}/api/versions")
        assert resp.status_code == 200
        versions = resp.json()["versions"]
        assert any(v["version"] == version for v in versions)
        body = next(v for v in versions if v["version"] == version)

        expected_addresses = {
            "bootloader-esp32.bin": "0x1000",
            "partition-table-esp32.bin": "0x8000",
            "firmware-esp32.bin": "0x10000",
        }
        for name, payload in payloads.items():
            entry = _entry(body, name)
            assert entry["size"] == len(payload)
            assert entry["address"] == expected_addresses[name]
            assert "modified" in entry  # ISO-8601 UTC timestamp present

    def test_meta_json_upload_and_overrides(self, server):
        """B1 step 4: ``meta.json`` → 201; address + label overrides apply.

        Regression guard for issues #20 / #25 (``meta.json`` must be an
        accepted upload, and its overrides must be honored in the listing).
        """
        version = "v-int-meta"
        meta = {
            "files": {
                "firmware-esp32.bin": {
                    "address": "0x20000",
                    "label": "Custom firmware",
                }
            }
        }
        resp = _upload(
            server.session,
            server.base_url,
            version,
            [
                ("firmware-esp32.bin", b"firmware-bytes"),
                ("meta.json", json.dumps(meta).encode("utf-8")),
            ],
        )
        assert resp.status_code == 201, resp.text
        assert (server.binaries_dir / version / "meta.json").is_file()

        listing = server.session.get(
            f"{server.base_url}/api/versions"
        ).json()["versions"]
        body = next(v for v in listing if v["version"] == version)
        entry = _entry(body, "firmware-esp32.bin")
        assert entry["address"] == "0x20000"  # override applied
        assert entry["label"] == "Custom firmware"  # override applied
        assert "meta.json" not in [f["name"] for f in body["files"]]  # excluded

    def test_download_is_byte_exact(self, server, payloads, payload_hashes):
        """B1 step 6: every download is sha256 byte-exact + octet-stream."""
        version = "v-int-flow"
        for name, payload in payloads.items():
            resp = server.session.get(
                f"{server.base_url}/api/versions/{version}/files/{name}"
            )
            assert resp.status_code == 200
            assert resp.headers["Content-Type"].startswith(
                "application/octet-stream"
            )
            assert hashlib.sha256(resp.content).hexdigest() == payload_hashes[name]
            assert resp.content == payload
