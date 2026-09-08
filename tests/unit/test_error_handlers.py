"""Unit tests for the JSON error handlers (400/404/405/413/500).

Spec: issue #3 §5.3 (errors are always JSON ``{"error": "..."}``).
Part of issue #26 (PR 1) / #23.

The handlers are registered with ``@app.errorhandler(<code>)``.  Flask freezes
the URL map after the first request, so instead of adding throwaway routes we
call the registered handler functions directly (each returns
``(jsonify({"error": ...}), <code>)``) and assert on the tuple.  The natural
404 / 405 paths are still exercised through the real request cycle.
"""

from __future__ import annotations

import pytest

import app as wf_app

# code -> module-level handler function registered via ``@app.errorhandler``.
HANDLERS = {
    400: wf_app._err_400,
    404: wf_app._err_404,
    405: wf_app._err_405,
    413: wf_app._err_413,
    500: wf_app._err_500,
}


class TestErrorHandlers:
    @pytest.mark.parametrize("code", [400, 404, 405, 413, 500])
    def test_handler_is_registered(self, wf, code):
        # The handler must be wired into the app's error-handler spec.
        spec = wf.app.error_handler_spec.get(None, {})
        assert code in spec, f"no error handler registered for {code}"

    @pytest.mark.parametrize("code", [400, 404, 405, 413, 500])
    def test_handler_returns_json_error_tuple(self, wf, code):
        handler = HANDLERS[code]
        with wf.app.app_context():
            response, status = handler(RuntimeError("boom"))
        assert status == code
        body = response.get_json()
        assert isinstance(body, dict)
        assert isinstance(body.get("error"), str)
        assert body["error"]

    def test_404_unknown_route(self, wf):
        resp = wf.client.get("/does-not-exist")
        assert resp.status_code == 404
        assert resp.get_json() == {"error": "not found"}

    def test_405_method_not_allowed(self, wf):
        resp = wf.client.delete("/api/versions")
        assert resp.status_code == 405
        assert resp.get_json() == {"error": "method not allowed"}
