/**
 * Fixtures + helpers for the browser integration suite (issue #26, PR 4 / §4.B2).
 *
 * Layering (what is real, what is stubbed):
 *   REAL   — the app.py server (subprocess), the served page (index.html +
 *            app.js + lib.js), the API (upload / list / serve), the browser
 *            (headless Chromium).
 *   STUB   — navigator.serial (context.addInitScript) and the vendored
 *            esptool-js bundle (context.route → tests/e2e/stubs/esptool-js.bundle.js).
 *
 * The `server` fixture mirrors tests/integration/conftest.py (PR 3): free
 * port, temp BINARIES_DIR, real `python app.py` subprocess, bounded
 * readiness poll, terminate → kill escalation.  It is TEST-scoped so every
 * test starts from a clean server (order-independent, and the "fresh server"
 * state is testable).  Seeded payloads use the SAME deterministic algorithm
 * as the pytest suite, so the bytes (and sha256s) match across languages.
 *
 * NOTE: `use()` MUST be awaited — it resolves when the test (and its whole
 * fixture chain) finishes; code after it is teardown.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Real app.py server (one per test)
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, "127.0.0.1", () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
    sock.on("error", reject);
  });
}

/**
 * Pick the Python interpreter for the app server.
 *
 * `PYTHON` (env) wins — set it to the interpreter that has the runtime deps
 * (e.g. `PYTHON=/path/to/venv/bin/python npx playwright test`).  When a
 * venv-style interpreter is used, its site-packages are exported via
 * PYTHONPATH so the server sees the same environment as the test runner.
 */
function pythonEnv() {
  const exe = process.env.PYTHON || (fs.existsSync("/usr/bin/python3") ? "python3" : "python");
  const env = { ...process.env };
  if (process.env.PYTHON) {
    try {
      const sitePackages = execFileSync(exe, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
        encoding: "utf8",
      }).trim();
      if (sitePackages) {
        env.PYTHONPATH = [sitePackages, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      }
    } catch {
      /* non-venv interpreter — nothing to add */
    }
  }
  return { exe, env };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, { timeoutMs = READY_TIMEOUT_MS, intervalMs = 100, message = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${message}`);
    await sleep(intervalMs);
  }
}

async function stopServer(proc) {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  const result = await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout")]);
  if (result === "timeout") {
    proc.kill("SIGKILL");
    await Promise.race([exited, sleep(SHUTDOWN_TIMEOUT_MS)]);
  }
}

async function startServer() {
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "wf-e2e-"));
  const binariesDir = path.join(scratch, "binaries");
  const logPath = path.join(scratch, "server.log");
  fs.mkdirSync(binariesDir, { recursive: true });
  const logFd = fs.openSync(logPath, "w");

  const { exe, env: baseEnv } = pythonEnv();
  const env = { ...baseEnv, PORT: String(port), BINARIES_DIR: binariesDir };
  delete env.WERKZEUG_RUN_MAIN;
  const proc = spawn(exe, [path.join(REPO_ROOT, "app.py")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "");

  try {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early (rc=${proc.exitCode}) — server log:\n${serverLog()}`);
    }
    await waitFor(
      async () => {
        try {
          const res = await fetch(`${baseUrl}/api/versions`, { signal: AbortSignal.timeout(1000) });
          return res.status === 200;
        } catch {
          return false;
        }
      },
      { message: "server readiness" }
    );
  } catch (err) {
    await stopServer(proc);
    if (!err.message.includes("server log:")) {
      throw new Error(`${err.message} — server log:\n${serverLog()}`);
    }
    throw err;
  }

  return { baseUrl, binariesDir, logPath, proc };
}

// ---------------------------------------------------------------------------
// Deterministic payloads (same algorithm as tests/integration/conftest.py)
// ---------------------------------------------------------------------------

function seededPayload(seed, size) {
  const out = Buffer.alloc(size);
  let counter = 0;
  let offset = 0;
  while (offset < size) {
    crypto.createHash("sha256").update(`${seed}:${counter}`).digest().copy(out, offset);
    offset += 32;
    counter += 1;
  }
  return out;
}

const SEED_FILES = [
  { name: "bootloader-esp32.bin", seed: 1, size: 4096 },
  { name: "partition-table-esp32.bin", seed: 2, size: 8192 },
  { name: "firmware-esp32.bin", seed: 3, size: 16384 },
];

// ---------------------------------------------------------------------------
// Stub installation (the only two fakes in the suite)
// ---------------------------------------------------------------------------

const STUB_SOURCE = fs.readFileSync(
  fileURLToPath(new URL("./stubs/esptool-js.bundle.js", import.meta.url)),
  "utf8"
);

const PORT_INFO = { usbVendorId: 0x303a, usbProductId: 0x1001, serialNumber: "STUB0001" };

/**
 * Create a browser context with the stubs installed:
 *   * `serial: true`  (default) — fake navigator.serial via addInitScript;
 *   * `bundle: true`  (default) — context.route() serves the recording
 *     bundle stub for the vendored URL (the real file is not in git —
 *     it is vendored at Docker build time — so the route always wins).
 */
async function newContext(browser, { serial = true, bundle = true } = {}) {
  const context = await browser.newContext();
  if (serial) {
    await context.addInitScript((portInfo) => {
      const port = { getInfo: () => ({ ...portInfo }) };
      const listeners = { connect: [], disconnect: [] };
      const requestPortCalls = [];
      window.__SERIAL_STUB__ = {
        requestPortCalls,
        listeners,
        requestPort: async () => {
          requestPortCalls.push(new Date().toISOString());
          return port;
        },
        addEventListener: (type, cb) => (listeners[type] ||= []).push(cb),
        removeEventListener: () => {},
      };
      Object.defineProperty(navigator, "serial", { value: window.__SERIAL_STUB__, configurable: true });
    }, PORT_INFO);
  }
  if (bundle) {
    await context.route("**/static/vendor/esptool-js.bundle.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript", body: STUB_SOURCE })
    );
  }
  return context;
}

// ---------------------------------------------------------------------------
// Page-side helpers (cross-realm reads of the stubs)
// ---------------------------------------------------------------------------

/** Read the bundle stub's recorded calls (in order) from the page. */
export async function stubCalls(page) {
  return page.evaluate(() => (window.__ESPTOOL_STUB__ ? window.__ESPTOOL_STUB__.calls : null));
}

/** Number of navigator.serial.requestPort() calls recorded by the serial stub. */
export async function requestPortCount(page) {
  return page.evaluate(() => (window.__SERIAL_STUB__ ? window.__SERIAL_STUB__.requestPortCalls.length : -1));
}

/**
 * Patch the bundle stub's per-test behavior (chip / errors / progress).
 * Waits until the app has loaded the stub (its `loadBundle()` at boot).
 */
export async function setBehavior(page, patch) {
  await page.waitForFunction(
    () => !!window.__ESPTOOL_STUB__,
    { timeout: 10_000 },
    { message: "bundle stub not loaded" }
  );
  await page.evaluate((p) => {
    Object.assign(window.__ESPTOOL_STUB__.behavior, p);
  }, patch);
}

export async function logText(page) {
  return page.locator("#log").textContent();
}

export async function statusInfo(page) {
  return {
    text: await page.locator("#status").textContent(),
    kind: await page.locator("#status").getAttribute("data-kind"),
  };
}

export async function progressRows(page) {
  return page
    .locator("#progress-rows .progress-row")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        name: row.dataset.name,
        pct: row.querySelector(".progress-pct").textContent,
        width: row.querySelector(".progress-fill").style.width,
      }))
    );
}

export async function fileRows(page) {
  return page
    .locator("#file-tbody tr")
    .evaluateAll((rows) =>
      rows.map((tr) => {
        const tds = tr.querySelectorAll("td");
        const box = tr.querySelector('input[type="checkbox"]');
        return {
          name: tds[1] ? tds[1].textContent.trim() : "",
          size: tds[2] ? tds[2].textContent.trim() : "",
          address: tds[3] ? tds[3].textContent.trim() : "",
          title: tds[1] ? tds[1].getAttribute("title") || "" : "",
          checked: box ? box.checked : false,
        };
      })
    );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const test = base.extend({
  /**
   * One real `app.py` server per test (fresh storage → order-independent
   * tests, and the "fresh server" state is testable).
   */
  server: async ({}, use) => {
    const server = await startServer();
    await use({ baseUrl: server.baseUrl, binariesDir: server.binariesDir, logPath: server.logPath });
    await stopServer(server.proc);
  },

  /** A page on the REAL served page with both stubs installed. */
  page: async ({ browser, server }, use) => {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.goto(server.baseUrl); // absolute: server runs on a random port
    await page.waitForLoadState("domcontentloaded");
    await use(page);
    await context.close();
  },

  /**
   * Seed a fresh version dir (unique per test → order-independent) with the
   * three deterministic binaries, through the REAL API, then refresh the
   * page's version list and select the new version.  Returns
   * `{ version, files }` where `files` is the API listing (name/size/address
   * in the API's order — sorted by filename).
   */
  seed: async ({ server, page }, use) => {
    await use(async ({ meta } = {}) => {
      const version = `v-e2e-${crypto.randomUUID().slice(0, 8)}`;
      const form = new FormData();
      form.append("version", version);
      for (const f of SEED_FILES) {
        form.append("files", new Blob([seededPayload(f.seed, f.size)]), f.name);
      }
      if (meta) {
        form.append("files", new Blob([JSON.stringify(meta)], { type: "application/json" }), "meta.json");
      }
      const res = await fetch(`${server.baseUrl}/api/upload`, { method: "POST", body: form });
      if (res.status !== 201) throw new Error(`seed upload failed: HTTP ${res.status}`);

      const listing = await (await fetch(`${server.baseUrl}/api/versions`)).json();
      const entry = listing.versions.find((v) => v.version === version);
      if (!entry) throw new Error(`seeded version ${version} missing from listing`);

      // The page booted before our upload — trigger the app's own refresh
      // (its refresh button re-fetches /api/versions), wait for the fresh
      // option, then select it.
      await page.click("#refresh-versions");
      await page.waitForFunction(
        (v) =>
          Array.from(document.getElementById("version-select").options).some(
            (o) => o.value === v
          ),
        version,
        { timeout: 10_000 }
      );
      await page.selectOption("#version-select", version);
      return { version, files: entry.files };
    });
  },
});

export { expect } from "@playwright/test";
export { SEED_FILES, PORT_INFO };
