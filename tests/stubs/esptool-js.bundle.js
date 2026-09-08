/**
 * Recording stub for the vendored esptool-js 0.6.1 browser bundle
 * (static/vendor/esptool-js.bundle.js) — frontend unit suite (issue #26, PR 2).
 *
 * Same module shape as the real bundle: named `ESPLoader` + `Transport`
 * exports (verified against the esptool-js 0.6.1 npm tarball). vitest loads
 * this file once per test file (module registry), so the page (app.js) and
 * the test share the SAME instance — the test drives it through `behavior`
 * and inspects it through `calls`.
 *
 *   behavior = {
 *     chip: "ESP32 (stub)",        // returned by loader.main()
 *     mainError: Error,            // main() rejects with this
 *     writeFlashError: Error,      // writeFlash() rejects with this
 *     afterError: Error,           // after() rejects with this
 *     disconnectError: Error,      // transport.disconnect() rejects
 *     progress: [[fileIndex, written, total], ...]  // reportProgress calls
 *   }
 *
 *   calls = [ [name, ...args], ... ]   // every public call, in order
 */
export const behavior = {
  chip: "ESP32 (stub)",
  mainError: null,
  writeFlashError: null,
  afterError: null,
  disconnectError: null,
  progress: [],
};

export const calls = [];

function record(name, ...args) {
  calls.push([name, ...args]);
}

export class Transport {
  constructor(port, tracing) {
    record("Transport", port, tracing);
    this.port = port;
    this.tracing = tracing;
  }

  async disconnect() {
    record("disconnect");
    if (behavior.disconnectError) throw behavior.disconnectError;
  }
}

export class ESPLoader {
  constructor({ transport, baudrate, terminal }) {
    record("ESPLoader", { transport, baudrate, terminal });
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
    if (behavior.mainError) throw behavior.mainError;
    return behavior.chip;
  }

  /** Flash the given files (spec §6.2 step 6). */
  async writeFlash({ fileArray, flashMode, flashFreq, flashSize, eraseAll, compress, reportProgress }) {
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
    for (const [fileIndex, written, total] of behavior.progress) {
      if (typeof reportProgress === "function") {
        reportProgress(fileIndex, written, total);
      }
    }
    if (behavior.writeFlashError) throw behavior.writeFlashError;
  }

  /** Post-flash hook (spec §6.2 step 7). */
  async after(mode) {
    record("after", mode);
    if (behavior.afterError) throw behavior.afterError;
  }
}
