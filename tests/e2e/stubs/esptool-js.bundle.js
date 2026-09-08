/**
 * Recording stub for the vendored esptool-js 0.6.1 browser bundle
 * (static/vendor/esptool-js.bundle.js) — browser integration suite
 * (issue #26, PR 4 / §4.B2).
 *
 * This file is served INSTEAD OF the real bundle by a page.route()
 * interception (see tests/e2e/fixtures.js), so it must be a SELF-CONTAINED
 * ES module with the exact shape of the real 0.6.1 bundle: named
 * `ESPLoader` + `Transport` exports (no default export, no globals required).
 *
 * Unlike the vitest stub (tests/stubs/esptool-js.bundle.js, shared with the
 * test process via the module registry), the page and the test live in
 * different realms — so the stub publishes its state on
 * `window.__ESPTOOL_STUB__`:
 *
 *   behavior = {                       // set by tests via page.evaluate
 *     chip: "ESP32 (stub)",            // returned by loader.main()
 *     mainError: Error|null,           // main() rejects with this
 *     writeFlashError: Error|null,     // writeFlash() rejects with this
 *     afterError: Error|null,          // after() rejects with this
 *     disconnectError: Error|null,     // transport.disconnect() rejects
 *     progress: [[fileIndex, written, total], ...]  // reportProgress calls
 *   }
 *
 *   calls = [ [name, ...args], ... ]   // every public call, in order
 *
 * The same `behavior` / `calls` vocabulary as the vitest stub keeps the two
 * suites comparable.
 */

const state = {
  behavior: {
    chip: "ESP32 (stub)",
    mainError: null,
    writeFlashError: null,
    afterError: null,
    disconnectError: null,
    progress: [],
  },
  calls: [],
};

// Cross-realm handle for the test (assertions + per-test behavior switching).
window.__ESPTOOL_STUB__ = state;

function record(name, ...args) {
  state.calls.push([name, ...args]);
}

export class Transport {
  constructor(port, tracing) {
    record("Transport", {
      tracing,
      portInfo: port && port.getInfo ? port.getInfo() : null,
    });
    this.port = port;
    this.tracing = tracing;
  }

  /** 0.6.1 method name; the app's `finally` block calls this to release the port. */
  async disconnect() {
    record("disconnect");
    if (state.behavior.disconnectError) throw state.behavior.disconnectError;
  }
}

export class ESPLoader {
  constructor({ transport, baudrate, terminal }) {
    record("ESPLoader", { baudrate, hasTerminal: !!terminal });
    this.transport = transport;
    this.baudrate = baudrate;
    this.terminal = terminal;
  }

  /** Connect + detect the chip (spec §6.2 step 4). */
  async main() {
    record("main");
    if (this.terminal && typeof this.terminal.writeLine === "function") {
      this.terminal.writeLine(`[stub] connecting @ ${this.baudrate} baud`);
    }
    if (state.behavior.mainError) throw state.behavior.mainError;
    return state.behavior.chip;
  }

  /** Flash the given files (spec §6.2 step 6). */
  async writeFlash({
    fileArray,
    flashMode,
    flashFreq,
    flashSize,
    eraseAll,
    compress,
    reportProgress,
  }) {
    record("writeFlash", {
      fileArray: fileArray.map((f) => ({
        address: f.address,
        bytes: f.data && f.data.length,
      })),
      flashMode,
      flashFreq,
      flashSize,
      eraseAll,
      compress,
    });
    for (const [fileIndex, written, total] of state.behavior.progress) {
      if (typeof reportProgress === "function") {
        reportProgress(fileIndex, written, total);
      }
    }
    if (state.behavior.writeFlashError) throw state.behavior.writeFlashError;
  }

  /** Post-flash hook (spec §6.2 step 7). */
  async after(mode) {
    record("after", mode);
    if (state.behavior.afterError) throw state.behavior.afterError;
  }
}
