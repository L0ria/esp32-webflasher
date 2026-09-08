"""Integration: static assets (spec §10).

``/`` must serve the SPA (``static/index.html``) and the static assets must
be reachable with the expected content types.  Runs against the **real**
``app.py`` server over HTTP.
"""

from __future__ import annotations


class TestStatic:
    def test_root_serves_index_html(self, server):
        """§10: ``GET /`` → the SPA (HTML, containing the app title)."""
        resp = server.session.get(f"{server.base_url}/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["Content-Type"]
        assert "ESP32 Web Flasher" in resp.text
        assert "<!DOCTYPE html>" in resp.text

    def test_static_assets_served(self, server):
        """§10: ``/static/*`` assets → 200 with the expected content types."""
        expected = {
            "app.js": "text/javascript",
            "lib.js": "text/javascript",
            "style.css": "text/css",
        }
        for name, content_type in expected.items():
            resp = server.session.get(f"{server.base_url}/static/{name}")
            assert resp.status_code == 200, name
            assert resp.headers["Content-Type"].startswith(content_type), (
                f"{name}: expected {content_type}, got {resp.headers['Content-Type']}"
            )
            assert len(resp.content) > 0
