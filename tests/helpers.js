/**
 * Shared helpers for the frontend unit suite (issue #26, PR 2).
 *
 * The app is a vanilla-JS SPA (static/app.js) that talks to the Flask API
 * with relative fetch() calls and to the serial world through
 * navigator.serial. In jsdom neither exists, so per test file we:
 *
 *   1. install a fake navigator.serial (recorded requestPort, addEventListener);
 *   2. install a fetch() mock that routes the app's relative API URLs to
 *      canned JSON / byte responses (and records every request);
 *   3. write the real static/index.html into the jsdom document (script tags
 *      stripped — the app module is imported directly as an ES module);
 *   4. import the real static/app.js, whose boot (init) runs against the
 *      DOM + stubs above.
 *
 * The vendored esptool-js bundle is stubbed by the Vite plugin in
 * vitest.config.js (see tests/stubs/esptool-js.bundle.js).
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:5060";

export { BASE };

// ---------------------------------------------------------------------------
// navigator.serial fake
// ---------------------------------------------------------------------------
export function installSerial({
  requestPortError = null,
  portInfo = { usbVendorId: 0x303a, usbProductId: 0x1001, serialNumber: "STUB0001" },
} = {}) {
  const port = { getInfo: () => ({ ...portInfo }) };
  const listeners = { connect: [], disconnect: [] };
  const requestPortCalls = [];
  const serial = {
    port,
    listeners,
    requestPortCalls,
    requestPort: async () => {
      requestPortCalls.push(new Date().toISOString());
      if (requestPortError) throw requestPortError;
      return port;
    },
    addEventListener: (type, cb) => {
      (listeners[type] ||= []).push(cb);
    },
    removeEventListener: () => {},
  };
  Object.defineProperty(navigator, "serial", {
    value: serial,
    configurable: true,
    writable: true,
  });
  return serial;
}

export function removeSerial() {
  Object.defineProperty(navigator, "serial", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// fetch() mock (routes the app's relative API URLs to canned responses)
// ---------------------------------------------------------------------------
export function installFetchMock(routes = {}) {
  const requested = [];
  // `routes` is the LIVE table the handler consults on every call — tests
  // may add, replace or remove entries after the app booted (e.g. a DELETE
  // route for the version under test, issue #36).
  const handler = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const abs = new URL(url, BASE).href;
    requested.push({ url: abs, init });
    const route = routes[abs];
    if (!route) return new Response("not found", { status: 404 });
    if (route.error) throw route.error;
    if (route.bytes != null) {
      return new Response(route.bytes, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (route.json != null) {
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: route.status ?? 200 });
  };
  // The app calls bare fetch(); in the vitest jsdom environment the global
  // fetch is Node's (absolute-URL-only) undici fetch, so override it.
  Object.defineProperty(globalThis, "fetch", {
    value: handler,
    configurable: true,
    writable: true,
  });
  window.fetch = handler;
  return { requested, routes };
}

// ---------------------------------------------------------------------------
// Canned API payloads (mirroring the backend's JSON contract, issue #3 §5)
// ---------------------------------------------------------------------------
export function binBytes(n, seed = 7) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

export const V1_FILES = [
  { name: "bootloader-esp32.bin", address: "0x1000", size: 1024, modified: "2026-01-01T00:00:00Z" },
  { name: "partition-table-esp32.bin", address: "0x8000", size: 2048, modified: "2026-01-01T00:00:00Z" },
  { name: "firmware-esp32.bin", address: "0x10000", size: 4096, label: "Factory app", modified: "2026-01-01T00:00:00Z" },
];

export const V2_FILES = [
  { name: "firmware-esp32.bin", address: "0x10000", size: 512, modified: "2026-01-02T00:00:00Z" },
];

export const V_EMPTY = { version: "empty", files: [] };

export function versionsPayload(versions) {
  return { versions };
}

export function apiRoutes(versions) {
  const routes = { [`${BASE}/api/versions`]: { json: versionsPayload(versions) } };
  for (const v of versions) {
    for (const f of v.files) {
      routes[`${BASE}/api/versions/${encodeURIComponent(v.version)}/files/${encodeURIComponent(f.name)}`] = {
        bytes: binBytes(f.size, f.name.length),
      };
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Page boot (real index.html + real app.js)
// ---------------------------------------------------------------------------
export function writePageDom() {
  // vitest serves test files over its dev server, so import.meta.url is an
  // http: URL — resolve the page from the project root on disk instead.
  const htmlPath = path.resolve(process.cwd(), "static", "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  // The app module is imported directly; strip the <script> tags so jsdom
  // does not try to (re-)load the scripts as external resources.
  html = html.replace(/<script[\s\S]*?<\/script>/g, "");
  document.open();
  document.write(html);
  document.close();
}

export async function waitFor(fn, { timeout = 3000, interval = 10, message = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out: ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function $(id) {
  return document.getElementById(id);
}

export function logText() {
  return $("log").textContent;
}

export function statusInfo() {
  const el = $("status");
  return { text: el.textContent, kind: el.dataset.kind };
}
