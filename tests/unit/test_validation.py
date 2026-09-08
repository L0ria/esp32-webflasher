"""Unit tests for the input-validation helpers in ``app.py``.

Spec: issue #3 §5.3 (version / filename rules).  Part of issue #26 (PR 1) / #23.

``valid_version``  — 1-64 chars, leading alnum, then ``.``/``_``/``-``.
``valid_filename`` — non-empty, <=255 chars, no ``..``, no ``/``/``\\``/NUL.
"""

from __future__ import annotations

import pytest

import app as wf_app


# ---------------------------------------------------------------------------
# valid_version
# ---------------------------------------------------------------------------

class TestValidVersion:
    @pytest.mark.parametrize(
        "version",
        [
            "a",
            "1",
            "v1.0.0",
            "V2.3.4-beta",
            "release_2026-09-07",
            "abc.def-ghi_123",
            "0",
            "Z",
        ],
    )
    def test_accepts_valid_names(self, version):
        assert wf_app.valid_version(version) is True

    def test_accepts_max_length_64(self):
        name = "a" * 64
        assert wf_app.valid_version(name) is True

    @pytest.mark.parametrize(
        "version",
        [
            "",                       # empty
            "a" * 65,                 # too long (> 64)
            "..",                     # parent-dir traversal
            "...",                    # still a traversal pattern
            "a/b",                    # forward separator
            "a\\b",                   # backslash separator
            "/abs",                   # absolute path
            ".hidden",                # leading dot
            "-dash",                  # leading dash
            "_under",                 # leading underscore
            "a b",                    # space
            "a\x00b",                 # NUL byte
            "a\nb",                   # newline
            "a:b",                    # colon
            "a*b",                    # glob char
            "a?b",                    # glob char
            "a[b]",                   # bracket
            "a'b",                    # quote
            "a\"b",                   # quote
            "a|b",                    # pipe
            "a&b",                    # ampersand
            "a;b",                    # semicolon
            "a=b",                    # equals
            "a+b",                    # plus
            "a~b",                    # tilde
            "a#b",                    # hash
            "a%b",                    # percent
        ],
    )
    def test_rejects_invalid_names(self, version):
        assert wf_app.valid_version(version) is False

    @pytest.mark.parametrize("bad", [None, 1, 1.5, ["v1"], {"v": 1}, b"v1", True])
    def test_rejects_non_string(self, bad):
        assert wf_app.valid_version(bad) is False


# ---------------------------------------------------------------------------
# valid_filename
# ---------------------------------------------------------------------------

class TestValidFilename:
    @pytest.mark.parametrize(
        "name",
        [
            "firmware.bin",
            "bootloader-esp32.bin",
            "a.bin",
            "meta.json",
            "with space.bin",
            "UPPER.BIN",
            "a.b.c.bin",
            "a_b-c.bin",
            "a" * 255,               # exactly 255 chars is allowed
        ],
    )
    def test_accepts_valid_names(self, name):
        assert wf_app.valid_filename(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            "",                       # empty
            "a" * 256,                # too long (> 255)
            "..",                     # parent-dir traversal
            "../evil.bin",            # traversal
            "a/../b.bin",             # traversal in the middle
            "a/b.bin",                # forward separator
            "a\\b.bin",               # backslash separator
            "a\x00b.bin",             # NUL byte
            "/abs.bin",               # absolute path
        ],
    )
    def test_rejects_invalid_names(self, name):
        assert wf_app.valid_filename(name) is False

    @pytest.mark.parametrize("bad", [None, 1, 1.5, ["a.bin"], {"a": 1}, b"a.bin"])
    def test_rejects_non_string(self, bad):
        assert wf_app.valid_filename(bad) is False
