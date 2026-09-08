"""Unit tests for ``address_for`` — the name-based flash-address convention.

Spec: issue #3 §5.4.  Current rules (as of PR #27, issue #22):

==================  =========
prefix (lowercased) address
==================  =========
``bootloader``      ``0x1000``
``partition``       ``0x8000``
``ota_data``        ``0xe000``
``firmware``        ``0x10000``
``app``             ``0x10000``
``factory``         ``0x10000``
anything else       ``0x10000`` (default)
==================  =========

Rules are checked in order, case-insensitive, first match wins.  Part of
issue #26 (PR 1) / #23.
"""

from __future__ import annotations

import pytest

import app as wf_app


class TestAddressFor:
    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("bootloader-esp32.bin", "0x1000"),
            ("bootloader.bin", "0x1000"),
            ("partition-table-esp32.bin", "0x8000"),
            ("partition.bin", "0x8000"),
            ("ota_data_initial.bin", "0xe000"),
            ("ota_data.bin", "0xe000"),
            ("firmware-esp32.bin", "0x10000"),
            ("firmware.bin", "0x10000"),
            ("app-esp32.bin", "0x10000"),
            ("app.bin", "0x10000"),
            ("factory-esp32.bin", "0x10000"),
            ("factory.bin", "0x10000"),
        ],
    )
    def test_each_rule(self, filename, expected):
        assert wf_app.address_for(filename) == expected

    @pytest.mark.parametrize(
        ("filename", "expected"),
        [
            ("BOOTLOADER-ESP32.BIN", "0x1000"),
            ("Bootloader.bin", "0x1000"),
            ("PARTITION-TABLE.BIN", "0x8000"),
            ("OTA_DATA_INITIAL.BIN", "0xe000"),
            ("FIRMWARE.BIN", "0x10000"),
            ("APP.BIN", "0x10000"),
            ("FACTORY.BIN", "0x10000"),
        ],
    )
    def test_case_insensitive(self, filename, expected):
        assert wf_app.address_for(filename) == expected

    def test_unknown_name_falls_back_to_default(self):
        assert wf_app.address_for("custom-image.bin") == wf_app.DEFAULT_ADDRESS
        assert wf_app.address_for("random.bin") == "0x10000"

    def test_default_address_is_0x10000(self):
        assert wf_app.DEFAULT_ADDRESS == "0x10000"

    def test_first_match_wins(self):
        # A name that starts with an earlier rule's prefix must resolve to
        # that rule even if a later rule's prefix also appears in the name.
        # "bootloader" is checked before "partition", so a file named
        # "bootloader_partition.bin" must take the bootloader address.
        assert wf_app.address_for("bootloader_partition.bin") == "0x1000"

    def test_prefix_is_a_prefix_not_a_substring(self):
        # The match is on the *start* of the name; "notbootloader" must not
        # match the "bootloader" rule.
        assert wf_app.address_for("notbootloader.bin") == wf_app.DEFAULT_ADDRESS
        # "xpartition" does not start with "partition".
        assert wf_app.address_for("xpartition.bin") == wf_app.DEFAULT_ADDRESS
