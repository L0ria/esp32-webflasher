# Testing — esp32-webflasher

The single source of truth for **running** and **adding tests** in this
repository. This is the deliverable required by issue #23 and issue #24
("instructions for humans and agents on how to add new tests") and ships in
PR 5 of the unified testing strategy ([issue #26](https://github.com/L0ria/esp32-webflasher/issues/26)).

Guiding principles (issue #26 §2):

1. **Deterministic & hermetic** — unit tests never touch the network, real
   serial, or the real filesystem outside a temp dir.
2. **No new runtime deps** — test tooling is dev-only (`requirements-dev.txt`,
   `package.json`); the Docker app image stays slim and unchanged.
3. **Fast** — the four automated layers target < 2 min on CI.
4. **Spec-mapped** — each test references the spec section
   ([#3 §5/§6](https://github.com/L0ria/esp32-webflasher/issues/3)) or the
   issue it protects, so regressions (e.g. the `meta.json` upload bug fixed
   in #25) are explicitly covered.

---

## 1. The four layers

| # | Layer | Runner | What is **real** | What is **stubbed** | Suite |
|---|-------|--------|------------------|---------------------|-------|
| 1 | Backend unit | `pytest` + Flask test client | `app.py` routes & helpers, in-process | nothing (no server, no network) | `tests/unit/` |
| 2 | Frontend unit | `vitest` + jsdom | `static/app.js`, `static/lib.js`, `static/index.html` DOM | `navigator.serial`, `fetch()`, the esptool-js bundle | `tests/*.test.js` |
| 3 | API integration | `pytest` + `requests` | the real `python app.py` server over loopback HTTP | nothing | `tests/integration/` |
| 4 | Browser integration | Playwright + headless Chromium | the real page + real `app.py` server + real API | `navigator.serial`, the esptool-js bundle | `tests/e2e/` |
| 5 | Docker acceptance (manual/CI tier) | `scripts/docker-acceptance.sh` | the full `docker compose` stack (webflasher + Caddy) | nothing | `scripts/` |

Layering rule of thumb: **the higher the layer, the more of the real system
runs**. A bug that survives layers 1–4 is almost certainly in the Docker
packaging — layer 5 covers that.

The only fake hardware anywhere is the esptool-js bundle stub and the
`navigator.serial` fake. The real-hardware flash item of spec §10 stays
manual (it needs a physical ESP32).

---

## 2. Prerequisites

- **Python 3.12** (CI version; 3.14 works locally)
- **Node 20** (matches CI)
- **Docker** with the **compose** plugin (layer 5 only)

Install the dev-only test dependencies (runtime deps stay in
`requirements.txt` and are *not* added to the dev file):

```bash
pip install -r requirements.txt -r requirements-dev.txt   # flask, pytest, requests
npm ci                                                     # vitest, jsdom, @playwright/test
npx playwright install --with-deps chromium                # headless Chromium
```

> Tip: a venv keeps the system interpreter clean —
> `python3 -m venv .venv && . .venv/bin/activate` first.

---

## 3. Run the whole suite

From the repository root:

```bash
pytest tests/unit          # layer 1 — backend unit
npx vitest run             # layer 2 — frontend unit
pytest tests/integration   # layer 3 — API integration (real server)
npx playwright test        # layer 4 — browser integration (real page + server)
```

Expected green output (as of PR 5, `main` @ `96de60c`):

```
156 passed in ~0.1s        # tests/unit
42 passed (6 files)        # vitest
15 passed in ~0.2s         # tests/integration
14 passed (3 specs)        # playwright
```

Notes:

- Bare `pytest` (no path) runs the **unit** suite — `pytest.ini` sets
  `testpaths = tests/unit`. The integration suite is always invoked by its
  explicit path.
- The Playwright fixtures spawn the app server with the interpreter named by
  `$PYTHON` (or `python3`). If your deps live in a venv, point it there:
  `PYTHON=/path/to/venv/bin/python npx playwright test`.
- Layer 5 (Docker acceptance) is the **manual / CI tier**:

  ```bash
  scripts/docker-acceptance.sh
  ```

  It runs `docker compose up --build`, waits for readiness, executes the
  scriptable core of spec §10 (12 HTTP checks + the on-disk volume check),
  then `docker compose down -v`. See §8.

---

## 4. Run a single test (debugging)

**pytest** — node-id form (exact) or `-k` (substring):

```bash
pytest "tests/unit/test_validation.py::TestValidVersion::test_accepts_max_length_64"
pytest tests/unit -k "accepts_max_length_64"
pytest tests/integration/test_api_flow.py -k meta_json -v
```

Drop into a debugger at the first failure:

```bash
pytest tests/unit -k "meta_json_accepted" --pdb
```

**vitest** — by file and/or test-name substring:

```bash
npx vitest run tests/lib.test.js
npx vitest run tests/flash.test.js -t "writeFlash failure"
```

**Playwright** — by file and/or test-title grep:

```bash
npx playwright test tests/e2e/boot.spec.js
npx playwright test -g "no-serial"
npx playwright test --ui        # interactive UI mode
npx playwright test --debug     # step-through debugger
```

Traces/screenshots from failed runs land in `test-results/` (git-ignored);
open `npx playwright show-report` for the HTML report when enabled.

---

## 5. How to add a unit test

### 5.1 Backend (`tests/unit/`)

New file `tests/unit/test_<topic>.py`, one class per unit under test, one
behavior per test method. Use the shared fixtures from
`tests/unit/conftest.py`:

```python
"""Unit: <topic> (spec §x / issue #y)."""
import pytest
from conftest import write_version, upload   # or: from tests.unit.conftest import ...


class TestMyThing:
    def test_happy_path(self, wf):
        # wf.app / wf.client / wf.binaries_dir  (fresh, empty dir per test)
        write_version(wf.binaries_dir, "v1.0.0", {"firmware-esp32.bin": b"abc"})
        resp = wf.client.get("/api/versions")
        assert resp.status_code == 200
        assert resp.get_json() == {
            "versions": [{
                "version": "v1.0.0",
                "files": [{
                    "name": "firmware-esp32.bin",
                    "address": "0x10000",
                    "size": 3,
                    "modified": "<ISO-8601 UTC>",
                }],
            }]
        }

    def test_upload_single(self, wf):
        resp = upload(wf.client, "v1.0.0", [("firmware-esp32.bin", b"abc")])
        assert resp.status_code == 201
```

Fixture contract (see `tests/unit/conftest.py` for the full reference):

- `wf` — namespace with `app` (the Flask app), `client` (the test client),
  and `binaries_dir` (a **fresh, empty** `pathlib.Path` per test).
- `write_version(binaries_dir, version, files, meta=None)` — create
  `<binaries_dir>/<version>/` with `files` (dict of name → bytes) and an
  optional `meta.json`.
- `upload(client, version, files)` — POST a multipart upload; `files` is a
  list of `(filename, payload)` pairs.

⚠️ **Import-time contract:** `app.py` reads `BINARIES_DIR` at *import* time
and creates the directory. The conftest sets the env var **before** the first
`import app` — keep new test files importing `app` only through the `wf`
fixture (or after the conftest has run); never call `os.makedirs` on real
paths.

Pure helpers (`valid_version`, `address_for`, `load_meta`,
`build_version_entry`) can be imported directly and tested without the
client — see `tests/unit/test_validation.py`, `test_address.py`, `test_meta.py`.

### 5.2 Frontend (`tests/*.test.js`)

Two patterns:

**(a) Pure helpers** — import `static/lib.js` directly (see
`tests/lib.test.js`):

```js
import { describe, it, expect } from "vitest";
import { formatBytes } from "../static/lib.js";

describe("formatBytes", () => {
  it("formats KiB with one decimal", () => {
    expect(formatBytes(1536)).toBe("1.5 KiB");
  });
});
```

**(b) Full-page DOM** — boot the real page in jsdom with stubs (see
`tests/flash.test.js`). The shared helpers live in `tests/helpers.js`:

```js
import { describe, it, expect, beforeAll } from "vitest";
import {
  V1_FILES, apiRoutes, installFetchMock, installSerial, writePageDom, $,
} from "./helpers.js";
import { behavior, calls } from "./stubs/esptool-js.bundle.js";

beforeAll(async () => {
  installSerial();                                   // fake navigator.serial
  installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
  writePageDom();                                    // real index.html DOM
  await import("../static/app.js");                  // real app boots
});

it("enables the flash button once ready", async () => {
  expect($("flash-button").disabled).toBe(false);
});
```

- `installFetchMock(routes)` routes the app's relative API URLs to canned
  `{ json }` / `{ bytes }` / `{ status }` / `{ error }` responses and records
  every request (`requested`).
- The vendored esptool-js bundle is stubbed by the Vite plugin in
  `vitest.config.js`, which serves `tests/stubs/esptool-js.bundle.js` for the
  bundle URL. The stub and the test share the same module instance, so drive
  it via `behavior` and assert via `calls` (see §7).
- Bundle failure modes switch on a global set **before** the page loads:
  `globalThis.__ESPTOOL_BUNDLE_MODE = "missing"` (import throws) or
  `"invalid"` (exports absent) — see `tests/ui-state.test.js`.

---

## 6. How to add an integration test

### 6.1 API integration (`tests/integration/`)

New file `tests/integration/test_<topic>.py`. Use the session-scoped
fixtures from `tests/integration/conftest.py`:

```python
"""Integration: <topic> (spec §10 / issue #26 §4.B1)."""


class TestMyFlow:
    def test_my_check(self, server, payloads):
        # server.session    — requests.Session bound to a REAL app.py server
        # server.base_url   — http://127.0.0.1:<free port>
        # server.binaries_dir — temp storage dir (pathlib.Path)
        # server.log_path   — server stdout/stderr (failure triage)
        # payloads          — 3 deterministic .bin payloads (distinct sha256)
        version = "v-int-mytest"          # one version dir per test
        resp = server.session.post(
            f"{server.base_url}/api/upload",
            data={"version": version},
            files=[("files", ("firmware-esp32.bin", b"abc"))],
        )
        assert resp.status_code == 201
```

Conventions (mirror the existing modules):

- **One version directory per test** (`v-int-<topic>`) so tests stay
  order-independent — the server fixture is session-scoped and shared.
- Error-contract tests assert the uniform `{"error": "..."}` JSON shape
  (see `test_api_errors.py::_assert_error`).
- Byte-exactness checks use the `payloads` / `payload_hashes` fixtures
  (deterministic seeded payloads — the same algorithm as the JS suites).

### 6.2 Browser integration (`tests/e2e/`)

New file `tests/e2e/<topic>.spec.js`. The fixtures from
`tests/e2e/fixtures.js` give you a **fresh real server per test**, a page on
the real served app with both stubs installed, and a `seed` helper that
uploads a version through the real API and selects it in the UI:

```js
import { test, expect } from "./fixtures.js";
import { logText, statusInfo, setBehavior, stubCalls } from "./fixtures.js";

test.describe("my flow (spec §6.2)", () => {
  test("happy path", async ({ page, seed }) => {
    const { version, files } = await seed();   // upload + select via real API
    await page.selectOption("#baud-select", "115200");
    await page.click("#flash-button");
    await expect(page.locator("#status")).toContainText("Done");
    const calls = await stubCalls(page);       // recorded bundle calls
    expect(calls.map((c) => c[0])).toContain("writeFlash");
  });

  test("writeFlash failure", async ({ page, seed }) => {
    await seed();
    await setBehavior(page, { writeFlashError: new Error("boom") });
    await page.click("#flash-button");
    expect((await statusInfo(page)).text).toContain("Flash failed");
  });
});
```

- `setBehavior(page, patch)` patches the stub's `behavior` (chip /
  `mainError` / `writeFlashError` / `afterError` / `disconnectError` /
  `progress`) after the app has loaded the stub.
- `stubCalls(page)` reads the stub's recorded `calls` (in order) from the
  page; `requestPortCount(page)` counts `navigator.serial.requestPort()`
  calls; `logText`, `statusInfo`, `progressRows`, `fileRows` read the UI.
- A context **without** Web Serial (banner state) is built by hand with
  `browser.newContext()` + `addInitScript` — see
  `tests/e2e/boot.spec.js`.

---

## 7. Where the stubs live & how to extend them

| Stub file | Serves | Mechanism |
|-----------|--------|-----------|
| `tests/stubs/esptool-js.bundle.js` | frontend unit suite | Vite plugin in `vitest.config.js` intercepts the bundle URL; same module instance as the tests |
| `tests/e2e/stubs/esptool-js.bundle.js` | browser suite | `page.route()` in `tests/e2e/fixtures.js` serves it instead of the vendored bundle; state published on `window.__ESPTOOL_STUB__` |
| `tests/helpers.js` | frontend unit suite | `installSerial` (fake `navigator.serial`), `installFetchMock` (canned API), `writePageDom` (real `index.html` DOM) |
| `tests/e2e/fixtures.js` | browser suite | fake `navigator.serial` via `context.addInitScript`; `server` / `page` / `seed` fixtures |

**The `behavior` / `calls` vocabulary** (shared by both bundle stubs so the
suites stay comparable):

```
behavior = {
  chip: "ESP32 (stub)",        // returned by loader.main()
  mainError: Error|null,       // main() rejects with this
  writeFlashError: Error|null, // writeFlash() rejects with this
  afterError: Error|null,      // after() rejects with this
  disconnectError: Error|null, // transport.disconnect() rejects
  progress: [[fileIndex, written, total], ...],  // reportProgress calls
}

calls = [ [name, ...args], ... ]   // every public call, in order
```

**Adding a new failure mode:** set the corresponding `behavior.*Error`
before triggering the flow (directly in unit tests, via `setBehavior(page, …)`
in the browser suite). If a new stub method is needed, add it to **both**
stub files (they are intentionally near-identical) and record it in `calls`.

---

## 8. Docker acceptance (layer 5)

`scripts/docker-acceptance.sh` is the repeatable core of spec §10
(issue #12): `docker compose up --build` → readiness poll → 12 HTTP checks
(empty listing · upload 201 + sizes · listing shape · `meta.json` overrides ·
traversal 400 · byte-exact sha256 · 404/405/413 JSON error contract · static
assets) → the on-disk `binaries`-volume check → `docker compose down -v`.
Stdlib `python3` + `curl` only — no new dependencies.

```bash
scripts/docker-acceptance.sh                          # full run (owns compose)
BASE_URL=http://172.19.0.3:5060 SKIP_COMPOSE=1 \
  scripts/docker-acceptance.sh                        # against an existing stack
```

Environment: `BASE_URL` (default `http://127.0.0.1:5060`), `COMPOSE_PROJ`
(default `esp32-webflasher`), `SKIP_COMPOSE` (default `0`), `READY_TIMEOUT`
(default `60`s).

In CI the `docker-acceptance` job in `.github/workflows/tests.yml` runs the
same script on `ubuntu-latest` (native Docker daemon) — triggered by PRs,
pushes to `main`, and `workflow_dispatch` (the "manual tier" decision from
issue #26).

---

## 9. Conventions

- **Name tests after the spec section / issue they protect** (e.g.
  `test_meta_json_accepted_regression_20_25`, `"meta.json: label rendered in
  the file table (regression #20/#25)"`).
- **One behavior per test**; describe blocks/classes group by unit.
- **No network or hardware in unit tests** (layers 1–2); the integration
  layers (3–5) are where real servers and real HTTP live.
- **The stubs are the only fake hardware.** Anything not stubbed is real —
  that is the point of the layering.
- **Hermetic & order-independent:** fresh temp dirs per test (unit), one
  version dir per test (integration), fresh server per test (browser).
- **Pinned versions only** (`requirements*.txt`, `package.json` + committed
  `package-lock.json`); test deps are dev-only — never add runtime deps to
  `requirements-dev.txt` / `devDependencies`.
- Keep the acceptance script and `tests/integration` in lock-step: a new
  API behavior gets a check in both.

---

## 10. Agent notes — copy-pasteable quick reference

```bash
# setup (once)
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
npm ci && npx playwright install --with-deps chromium

# run everything (expected: 156 / 42 / 15 / 14 passed)
pytest tests/unit && npx vitest run && pytest tests/integration \
  && PYTHON=$PWD/.venv/bin/python npx playwright test

# run one test
pytest "tests/unit/test_meta.py::TestLoadMeta::test_broken_json_returns_empty_dict"
npx vitest run tests/lib.test.js -t "em-dash"
npx playwright test tests/e2e/boot.spec.js -g "no-serial"

# docker acceptance (needs docker)
scripts/docker-acceptance.sh
```

**Failure triage cheat sheet:**

| Symptom | First look |
|---------|-----------|
| `pytest tests/unit` collection error | `tests/unit/conftest.py` import-time `BINARIES_DIR` contract — the env var must be set before `import app` |
| Integration: `server did not become ready` | the fixture already prints the server log — or read `server.log_path` (`/tmp/wf-integration-*/server.log`); usually a missing `flask` in the interpreter |
| Playwright: `ModuleNotFoundError: No module named 'flask'` | the e2e fixture spawns `python3` — point it at your venv: `PYTHON=/path/to/venv/bin/python npx playwright test` |
| Playwright: `bundle stub not loaded` | the `page.route()` in `tests/e2e/fixtures.js` must match the bundle URL (`**/static/vendor/esptool-js.bundle.js`) |
| vitest: bundle behavior differs from the real app | compare against `tests/stubs/esptool-js.bundle.js` — the stub is a recording fake, not the real 0.6.1 bundle (see the B2b follow-up issue) |
| Acceptance: `server not ready within 60s` | `docker compose ps` + `docker compose logs webflasher`; check `BASE_URL` / port mapping |
| Acceptance: on-disk check fails | `docker compose exec webflasher ls -la /srv/binaries/<version>` |

**Useful files:** `app.py` (API contract) · `tests/unit/conftest.py` ·
`tests/integration/conftest.py` · `tests/helpers.js` ·
`tests/e2e/fixtures.js` · `vitest.config.js` · `playwright.config.js` ·
`pytest.ini` · `scripts/docker-acceptance.sh` · `.github/workflows/tests.yml`
