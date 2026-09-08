"""Unit tests for ``GET /`` (the index route).

Spec: issue #3 §5.1 (serve ``static/index.html``).  Part of issue #26 (PR 1) / #23.
"""

from __future__ import annotations

from pathlib import Path

import pytest

import app as wf_app


class TestIndex:
    def test_serves_index_html_when_present(self, wf):
        resp = wf.client.get("/")
        assert resp.status_code == 200
        assert resp.headers["Content-Type"].startswith("text/html")
        # The real frontend title is present.
        assert b"ESP32 Web Flasher" in resp.data

    def test_fallback_text_when_index_missing(self, wf):
        # Point the static folder at an empty directory so ``index.html`` is
        # not found, then the handler must return the plain-text fallback.
        empty = Path(__file__).resolve().parent / "_empty_static"
        empty.mkdir(exist_ok=True)
        original = wf.app.static_folder
        try:
            wf.app.static_folder = str(empty)
            resp = wf.client.get("/")
            assert resp.status_code == 200
            assert resp.headers["Content-Type"].startswith("text/plain")
            body = resp.get_data(as_text=True)
            assert "ESP32 Web Flasher backend is running" in body
        finally:
            wf.app.static_folder = original
