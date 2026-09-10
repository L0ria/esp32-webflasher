"""Shared fixtures for the static-checks suite (issue #11, spec §9.5 of #3).

This suite is the **static (no-docker) verification** tier: it maps 1:1 to the
six checks in issue #11 and runs entirely against the repository files — no
server, no network, no Docker.  It complements layers 1–4 in ``docs/TESTING.md``
and is the scripted, repeatable core of spec §9.5.

Fixtures / helpers
------------------
``repo_root``   — the repository root (the directory containing ``app.py``),
                  as a ``pathlib.Path``.  All file reads and subprocess
                  invocations are anchored here so the suite works no matter
                  where ``pytest`` is invoked from.
"""

from __future__ import annotations

from pathlib import Path

import pytest

#: Repository root = the directory two levels above this file
#: (``tests/static/conftest.py`` -> ``tests/static`` -> ``tests`` -> repo root).
_REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def repo_root() -> Path:
    """The repository root (contains ``app.py``, ``Dockerfile``, ``static/``)."""
    return _REPO_ROOT
