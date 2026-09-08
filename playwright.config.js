import { defineConfig } from "@playwright/test";

/**
 * Browser integration suite (issue #26, PR 4 / §4.B2) — Playwright +
 * headless Chromium.
 *
 * The suite runs the REAL page (static/index.html + static/app.js) served by
 * the REAL `app.py` server (started per worker by tests/e2e/fixtures.js),
 * with only two stubs injected:
 *   * navigator.serial            — page.addInitScript (fake Web Serial API)
 *   * the vendored esptool-js     — page.route() serves
 *     static/vendor/esptool-js.bundle.js  →  tests/e2e/stubs/esptool-js.bundle.js
 *
 * `baseURL` is injected by the fixtures (WF_BASE_URL) so the same config
 * works locally and in CI.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // one shared app server; tests stay order-independent anyway
  retries: 0, // hermetic suite — a flake is a bug to fix, not to retry
  use: {
    baseURL: process.env.WF_BASE_URL || "http://127.0.0.1:5060",
    headless: true,
  },
});
