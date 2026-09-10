"""Static checks (issue #11, spec §9.5 of #3) — the no-docker verification tier.

Each test maps 1:1 to one of the six checks in
https://github.com/L0ria/esp32-webflasher/issues/11 and runs purely against the
repository files — no server, no network, no Docker.  The Docker tier
(``scripts/docker-acceptance.sh`` / layer 5) still validates the *running*
stack; this suite is the fast, static guard that keeps the checked-in files
syntactically valid and mutually consistent.

Mapping (issue #11 -> test):

  1. ``python3 -m py_compile app.py``            -> :class:`TestAppPyCompiles`
  2. validate ``docker-compose.yaml`` syntax     -> :class:`TestComposeYaml`
  3. validate ``Caddyfile`` syntax               -> :class:`TestCaddyfile`
  4. ``node --check static/app.js``              -> :class:`TestAppJsNodeCheck`
  5. vendored bundle referenced correctly & the  -> :class:`TestVendorBundle`
     ``static/vendor/`` path matches the Dockerfile
  6. no moving CDN URL (pinned ``esptool-js@0.6.1``) -> :class:`TestNoCdnPinned`

Run with ``pytest tests/static`` (see ``docs/TESTING.md`` §1 / §3).
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _run(cmd: list[str], repo_root: Path) -> subprocess.CompletedProcess:
    """Run *cmd* in the repo root, capturing stdout+stderr (for failure output)."""
    return subprocess.run(
        cmd,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
    )


def _iter_static_files(repo_root: Path) -> list[Path]:
    """Every file under ``static/`` (the frontend the browser actually loads)."""
    static_dir = repo_root / "static"
    return sorted(p for p in static_dir.rglob("*") if p.is_file())


# ---------------------------------------------------------------------------
# 1. python3 -m py_compile app.py
# ---------------------------------------------------------------------------

class TestAppPyCompiles:
    """Issue #11 item 1: ``python3 -m py_compile app.py`` must pass."""

    def test_app_py_compiles(self, repo_root: Path):
        app_py = repo_root / "app.py"
        assert app_py.is_file(), f"missing {app_py}"

        proc = _run([sys.executable, "-m", "py_compile", "app.py"], repo_root)
        assert proc.returncode == 0, (
            "python3 -m py_compile app.py failed "
            f"(rc={proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
        )


# ---------------------------------------------------------------------------
# 2. Validate docker-compose.yaml syntax
# ---------------------------------------------------------------------------

class TestComposeYaml:
    """Issue #11 item 2: ``docker-compose.yaml`` must be valid YAML with the
    expected two-service structure (spec §7.2).

    This is the static half of the check: it parses the file and asserts the
    structural contract the rest of the stack relies on.  The *runtime* half
    (does ``docker compose`` actually start it) is layer 5 / the docker tier.
    """

    def test_compose_yaml_valid(self, repo_root: Path):
        yaml = pytest.importorskip("yaml", reason="PyYAML is a dev-only dep (requirements-dev.txt)")
        compose = repo_root / "docker-compose.yaml"
        assert compose.is_file(), f"missing {compose}"

        # A YAML parse error raises; a clean parse is the syntax check.
        data = yaml.safe_load(compose.read_text(encoding="utf-8"))
        assert isinstance(data, dict), "docker-compose.yaml must be a mapping"

        services = data.get("services")
        assert isinstance(services, dict), "docker-compose.yaml must define `services`"
        # spec §7.2: the Flask app + the Caddy HTTPS proxy.
        assert "webflasher" in services, "services.webflasher missing"
        assert "https-proxy" in services, "services.https-proxy missing"

        # Named volume for the uploaded binaries (issue #17 fix).
        volumes = data.get("volumes")
        assert isinstance(volumes, dict), "top-level `volumes` missing"
        assert "binaries" in volumes, "top-level `volumes.binaries` missing"

        # webflasher must expose the app port and use the binaries volume.
        web = services["webflasher"]
        assert any("5060" in str(p) for p in web.get("ports", [])), (
            "services.webflasher.ports must expose 5060"
        )
        assert any("binaries" in str(v) for v in web.get("volumes", [])), (
            "services.webflasher.volumes must mount the `binaries` volume"
        )


# ---------------------------------------------------------------------------
# 3. Validate Caddyfile syntax
# ---------------------------------------------------------------------------

class TestCaddyfile:
    """Issue #11 item 3: ``Caddyfile`` must be structurally valid.

    ``caddy validate`` needs the Caddy binary (Docker tier).  This encodes the
    "manual review" half of the check as assertions on the Caddyfile contract:
    exactly one site block, addressed by a hostname, serving TLS via the
    internal CA and proxying to the ``webflasher`` upstream (spec §7.3).
    """

    @staticmethod
    def _strip_comments(text: str) -> str:
        """Drop full-line ``#`` comments (Caddyfile comment syntax)."""
        lines = []
        for line in text.splitlines():
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue
            lines.append(line)
        return "\n".join(lines)

    def test_caddyfile_structure(self, repo_root: Path):
        caddyfile = repo_root / "Caddyfile"
        assert caddyfile.is_file(), f"missing {caddyfile}"
        text = caddyfile.read_text(encoding="utf-8")
        body = self._strip_comments(text)

        # Exactly one site block: a top-level ``{`` that is not nested inside
        # another block.  Counting braces in the comment-stripped body gives a
        # well-formed single site block (one open, one matching close).
        assert body.count("{") == 1, (
            f"expected exactly one site block, found {body.count('{')} opening braces"
        )
        assert body.count("}") == 1, (
            f"expected exactly one closing brace, found {body.count('}')}"
        )

        # A site address (hostname) must precede the block — not a bare port.
        site_address = re.search(r"^\s*([A-Za-z0-9._-]+)\s*\{", body, re.MULTILINE)
        assert site_address, "expected a site address (hostname) before the `{`"
        assert not site_address.group(1).startswith(":"), (
            "site address must be a hostname, not a bare port (see issue #17)"
        )

        # TLS via the internal CA (self-signed acceptable — Q1 in spec §7.3).
        assert re.search(r"^\s*tls\s+internal\s*$", body, re.MULTILINE), (
            "expected a `tls internal` directive"
        )

        # Proxy to the webflasher upstream on port 5060.
        assert re.search(
            r"^\s*reverse_proxy\s+webflasher:5060\s*$", body, re.MULTILINE
        ), "expected `reverse_proxy webflasher:5060`"


# ---------------------------------------------------------------------------
# 4. node --check static/app.js
# ---------------------------------------------------------------------------

class TestAppJsNodeCheck:
    """Issue #11 item 4: ``node --check static/app.js`` must pass (if node is
    available).  This is the explicit syntax assertion that the vitest/Playwright
    tiers only cover implicitly (a syntax error would fail the import/load)."""

    def test_app_js_node_check(self, repo_root: Path):
        node = shutil.which("node")
        if node is None:
            pytest.skip("node is not installed (issue #11 item 4 is conditional)")

        app_js = repo_root / "static" / "app.js"
        assert app_js.is_file(), f"missing {app_js}"

        proc = _run([node, "--check", "static/app.js"], repo_root)
        assert proc.returncode == 0, (
            "node --check static/app.js failed "
            f"(rc={proc.returncode}):\n{proc.stdout}\n{proc.stderr}"
        )


# ---------------------------------------------------------------------------
# 5. Vendored bundle referenced correctly & path matches the Dockerfile
# ---------------------------------------------------------------------------

class TestVendorBundle:
    """Issue #11 item 5: the vendored esptool-js bundle is referenced correctly
    by the frontend **and** the ``static/vendor/`` path matches what the
    Dockerfile copies.

    The frontend resolves the bundle relative to itself
    (``new URL("vendor/esptool-js.bundle.js", import.meta.url)``), which —
    because ``static/app.js`` lives at the repo's ``static/`` dir — is the
    absolute path ``static/vendor/esptool-js.bundle.js``.  The Dockerfile must
    place the vendored bundle at that exact target.
    """

    #: The bundle filename, as referenced by the frontend (a sibling ``vendor/``
    #: of ``static/app.js``) and as copied by the Dockerfile.
    BUNDLE_FILENAME = "esptool-js.bundle.js"

    def _frontend_bundle_path(self, repo_root: Path) -> str:
        """The absolute (repo-relative) path the frontend resolves the bundle to.

        ``static/app.js`` does ``new URL("vendor/<bundle>", import.meta.url)``;
        relative to ``static/`` that is ``static/vendor/<bundle>``.
        """
        app_js = (repo_root / "static" / "app.js").read_text(encoding="utf-8")
        match = re.search(
            r'new\s+URL\(\s*["\']vendor/' + re.escape(self.BUNDLE_FILENAME) + r'["\']',
            app_js,
        )
        assert match, (
            "static/app.js must reference the bundle via "
            f'`new URL("vendor/{self.BUNDLE_FILENAME}", import.meta.url)`'
        )
        # app.js is at static/app.js, so "vendor/<bundle>" resolves to:
        return f"static/vendor/{self.BUNDLE_FILENAME}"

    def test_vendor_path_matches_dockerfile(self, repo_root: Path):
        dockerfile = repo_root / "Dockerfile"
        assert dockerfile.is_file(), f"missing {dockerfile}"
        df = dockerfile.read_text(encoding="utf-8")

        frontend_path = self._frontend_bundle_path(repo_root)

        # The Dockerfile must COPY the vendored bundle to exactly the path the
        # frontend expects.  Match a COPY whose destination ends in the bundle
        # path (allowing the `--from=vendor` flag and absolute source).
        copy_re = re.compile(
            r"^\s*COPY\b[^\n]*\s(static/vendor/" + re.escape(self.BUNDLE_FILENAME) + r")\s*$",
            re.MULTILINE,
        )
        match = copy_re.search(df)
        assert match, (
            "Dockerfile must `COPY` the vendored bundle to "
            f"`{frontend_path}` (the path the frontend resolves)"
        )
        assert match.group(1) == frontend_path, (
            f"Dockerfile COPY target `{match.group(1)}` != frontend path `{frontend_path}`"
        )


# ---------------------------------------------------------------------------
# 6. No moving CDN URL (pinned esptool-js@0.6.1 only)
# ---------------------------------------------------------------------------

class TestNoCdnPinned:
    """Issue #11 item 6: no moving CDN URL is used anywhere; the only
    esptool-js reference is the pinned ``esptool-js@0.6.1``.

    "Moving CDN" = a remote *resource load* (a ``src=``/``href=``/``import()``/
    ``fetch()``/CSS ``url()`` pointing at an ``http(s)://`` origin).  Plain
    hyperlinks in the UI (docs, the upstream repo) are not resource loads and
    are allowed.
    """

    #: Patterns that would *load* a remote resource at runtime.
    _RESOURCE_LOAD = re.compile(
        r"""
        (?:
            \bsrc\s*=\s*["\']https?://          # <script src= / <link href= / <img src=>
          | <link\b[^>]*\bhref\s*=\s*["\']https?://
          | \bimport\s*\(\s*["\']https?://      # dynamic import of a URL
          | \bfetch\s*\(\s*["\']https?://       # fetch of an absolute URL
          | \bnew\s+URL\s*\(\s*["\']https?://   # new URL("http...")
          | \burl\s*\(\s*["\']?https?://        # CSS url(http...)
        )
        """,
        re.IGNORECASE | re.VERBOSE,
    )

    def test_no_remote_resource_loads(self, repo_root: Path):
        offenders = []
        for path in _iter_static_files(repo_root):
            text = path.read_text(encoding="utf-8", errors="replace")
            for lineno, line in enumerate(text.splitlines(), start=1):
                if self._RESOURCE_LOAD.search(line):
                    rel = path.relative_to(repo_root)
                    offenders.append(f"{rel}:{lineno}: {line.strip()}")
        assert not offenders, (
            "remote (CDN) resource load(s) found in static/ — the app must be "
            "fully self-contained:\n" + "\n".join(offenders)
        )

    def test_dockerfile_pins_esptool_js(self, repo_root: Path):
        dockerfile = repo_root / "Dockerfile"
        assert dockerfile.is_file(), f"missing {dockerfile}"
        df = dockerfile.read_text(encoding="utf-8")

        # The vendor stage must fetch the exact pinned tarball via `npm pack`.
        assert re.search(r"npm\s+pack\s+esptool-js@0\.6\.1\b", df), (
            "Dockerfile must pin `esptool-js@0.6.1` (npm pack)"
        )
        # And extract the bundle from that exact pinned tarball.
        assert re.search(r"esptool-js-0\.6\.1\.tgz", df), (
            "Dockerfile must extract the bundle from `esptool-js-0.6.1.tgz`"
        )
        # No *other* esptool-js version may be referenced (no moving version).
        versions = set(re.findall(r"esptool-js@(\d+\.\d+\.\d+)", df))
        assert versions == {"0.6.1"}, (
            f"expected only esptool-js@0.6.1 in the Dockerfile, found {sorted(versions)}"
        )
