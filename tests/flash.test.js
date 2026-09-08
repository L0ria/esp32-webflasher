/**
 * Full Connect & Flash flow (issue #26 §A2(b), spec §6.2):
 *   requestPort → Transport → ESPLoader → main() → per-file fetch (URL +
 *   byte-length check) → writeFlash (fileArray addresses, eraseAll, compress,
 *   reportProgress) → after("hard_reset") → transport.disconnect() in finally.
 * Plus the failure paths: requestPort / main / fetch / writeFlash / after /
 * disconnect errors → error status + log + UI re-enabled + port released.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  V1_FILES,
  apiRoutes,
  binBytes,
  installFetchMock,
  installSerial,
  waitFor,
  writePageDom,
  $,
} from "./helpers.js";
import { behavior, calls, Transport } from "./stubs/esptool-js.bundle.js";

const VERSION = "v1.0.0";
const [BOOTLOADER, PARTITION, FIRMWARE] = V1_FILES;

let serial;
let fetchMock;

function resetStub() {
  calls.length = 0;
  behavior.chip = "ESP32 (stub)";
  behavior.mainError = null;
  behavior.writeFlashError = null;
  behavior.afterError = null;
  behavior.disconnectError = null;
  behavior.progress = [];
}

function clickFlash() {
  $("flash-button").dispatchEvent(new window.Event("click"));
}

function clearStatus() {
  $("status").textContent = "";
}

function statusChanged(expectPrefix) {
  return $("status").textContent.startsWith(expectPrefix);
}

async function waitForDone() {
  const before = $("status").textContent;
  await waitFor(() => $("status").textContent !== before && $("status").textContent.startsWith("Done"), {
    message: "flash flow finished",
  });
}

async function waitForFailure() {
  const before = $("status").textContent;
  await waitFor(() => $("status").textContent !== before && $("status").textContent.startsWith("Flash failed"), {
    message: "flash flow failed",
  });
}

beforeAll(async () => {
  serial = installSerial();
  fetchMock = installFetchMock(apiRoutes([{ version: VERSION, files: V1_FILES }]));
  writePageDom();
  await import("../static/app.js");
  await waitFor(() => !$("flash-button").disabled, { message: "button enabled" });
});

beforeEach(() => {
  resetStub();
  $("status").textContent = "";
  $("log").textContent = "";
});

describe("full flash flow (spec §6.2)", () => {
  it("runs requestPort → main → fetch → writeFlash → after → disconnect, end to end", async () => {
    behavior.progress = [
      [0, 512, BOOTLOADER.size],
      [0, BOOTLOADER.size, BOOTLOADER.size],
      [1, PARTITION.size, PARTITION.size],
      [2, FIRMWARE.size, FIRMWARE.size],
    ];
    clickFlash();
    await waitForDone();

    // 1. requestPort was called (inside the user-gesture chain).
    expect(serial.requestPortCalls.length).toBe(1);

    // 2. Transport created with the port + tracing=true.
    expect(calls[0][0]).toBe("Transport");
    expect(calls[0][1]).toBe(serial.port);
    expect(calls[0][2]).toBe(true);

    // 3. ESPLoader created with transport, baud 115200, and a terminal.
    expect(calls[1][0]).toBe("ESPLoader");
    expect(calls[1][1].transport).toBeInstanceOf(Transport); // the stub Transport
    expect(calls[1][1].baudrate).toBe(115200);
    expect(typeof calls[1][1].terminal.writeLine).toBe("function");

    // 4. main() connected and reported the chip into the log.
    expect(calls[2][0]).toBe("main");
    expect($("log").textContent).toContain("connected: ESP32 (stub)");

    // 5. Each selected file was fetched from the API (exact URLs).
    const fileFetches = fetchMock.requested.filter((r) =>
      r.url.startsWith(`http://localhost:5060/api/versions/${VERSION}/files/`)
    );
    expect(fileFetches.map((r) => r.url)).toEqual([
      `http://localhost:5060/api/versions/${VERSION}/files/${BOOTLOADER.name}`,
      `http://localhost:5060/api/versions/${VERSION}/files/${PARTITION.name}`,
      `http://localhost:5060/api/versions/${VERSION}/files/${FIRMWARE.name}`,
    ]);
    for (const req of fileFetches) {
      expect(req.init.headers.Accept).toBe("application/octet-stream");
    }

    // 6. writeFlash received the parsed addresses + byte-exact data.
    const wf = calls.find((c) => c[0] === "writeFlash");
    expect(wf[1].fileArray).toEqual([
      { address: 0x1000, bytes: BOOTLOADER.size },
      { address: 0x8000, bytes: PARTITION.size },
      { address: 0x10000, bytes: FIRMWARE.size },
    ]);
    expect(wf[1].flashMode).toBe("keep");
    expect(wf[1].flashFreq).toBe("keep");
    expect(wf[1].flashSize).toBe("keep");
    expect(wf[1].eraseAll).toBe(false);
    expect(wf[1].compress).toBe(true);

    // 7. Progress rows were built (one per file) and driven to 100 %.
    const rows = $("progress-rows").querySelectorAll(".progress-row");
    expect(rows.length).toBe(3);
    expect(rows[0].dataset.name).toBe(BOOTLOADER.name);
    expect(rows[0].querySelector(".progress-name").textContent).toBe(`${BOOTLOADER.name} @ 0x1000`);
    for (const row of rows) {
      expect(row.querySelector(".progress-fill").style.width).toBe("100%"); // jsdom normalizes "100.0%"
      expect(row.querySelector(".progress-pct").textContent).toBe("100%");
    }

    // 8. after("hard_reset") + port released.
    expect(calls.find((c) => c[0] === "after")[1]).toBe("hard_reset");
    expect(calls[calls.length - 1][0]).toBe("disconnect");

    // 9. Final state: success status + log + UI re-enabled.
    expect($("status").textContent).toBe("Done — device reset. Check the log for details.");
    expect($("status").dataset.kind).toBe("ok");
    expect($("log").textContent).toContain("flash sequence finished successfully");
    expect($("flash-button").disabled).toBe(false);
    expect($("version-select").disabled).toBe(false);
    expect($("refresh-versions").disabled).toBe(false);
  });

  it("passes the selected baud rate and erase-all option through to the loader", async () => {
    $("baud-select").value = "921600";
    $("baud-select").dispatchEvent(new window.Event("change", { bubbles: true }));
    $("erase-all").checked = true;
    $("erase-all").dispatchEvent(new window.Event("change", { bubbles: true }));
    clickFlash();
    await waitForDone();
    expect(calls.find((c) => c[0] === "ESPLoader")[1].baudrate).toBe(921600);
    expect(calls.find((c) => c[0] === "writeFlash")[1].eraseAll).toBe(true);
    expect($("log").textContent).toContain("[stub] connecting @ 921600 baud");
    $("baud-select").value = "115200";
    $("erase-all").checked = false;
  });

  it("flashes only the checked files (unchecked files are not fetched or written)", async () => {
    const before = fetchMock.requested.length; // current mock instance
    const uncheck = (name) => {
      const box = $("file-tbody").querySelector(`input[data-name="${name}"]`);
      box.checked = false;
      box.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    uncheck(BOOTLOADER.name);
    uncheck(PARTITION.name);
    clickFlash();
    await waitForDone();
    const fileFetches = fetchMock.requested.slice(before).filter((r) => r.url.includes("/files/"));
    expect(fileFetches.map((r) => r.url)).toEqual([
      `http://localhost:5060/api/versions/${VERSION}/files/${FIRMWARE.name}`,
    ]);
    expect(calls.find((c) => c[0] === "writeFlash")[1].fileArray).toEqual([
      { address: 0x10000, bytes: FIRMWARE.size },
    ]);
    const rows = $("progress-rows").querySelectorAll(".progress-row");
    expect(rows.length).toBe(1);
    // restore
    for (const name of [BOOTLOADER.name, PARTITION.name]) {
      const box = $("file-tbody").querySelector(`input[data-name="${name}"]`);
      box.checked = true;
      box.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
  });
});

describe("flash failure paths (spec §6.2 — UI recovery + port release)", () => {
  it("requestPort rejection → error status + log, no transport created, UI re-enabled", async () => {
    const badSerial = installSerial({ requestPortError: new Error("port denied") });
    try {
      clickFlash();
      await waitForFailure();
      expect($("status").textContent).toBe("Flash failed: port denied");
      expect($("status").dataset.kind).toBe("error");
      expect($("log").textContent).toContain("[ui][error] port denied");
      expect(calls.length).toBe(0); // nothing reached the bundle
      expect(badSerial.requestPortCalls.length).toBe(1);
      expect($("flash-button").disabled).toBe(false);
    } finally {
      serial = installSerial(); // restore the good port for later tests
    }
  });

  it("main() failure → error status + log, transport still disconnected", async () => {
    behavior.mainError = new Error("timed out waiting for packet header");
    clickFlash();
    await waitForFailure();
    expect($("status").textContent).toContain("Flash failed: timed out waiting for packet header");
    expect($("log").textContent).toContain("timed out waiting for packet header");
    expect(calls.find((c) => c[0] === "main")).toBeTruthy();
    expect(calls.find((c) => c[0] === "writeFlash")).toBeUndefined();
    expect(calls.find((c) => c[0] === "after")).toBeUndefined();
    expect(calls[calls.length - 1][0]).toBe("disconnect"); // released in finally
    expect($("flash-button").disabled).toBe(false);
  });

  it("binary download failure (HTTP 404) → error status + log, port released", async () => {
    // Re-route the API: the bootloader 404s, the rest serve fine.
    installFetchMock({
      "http://localhost:5060/api/versions": {
        json: { versions: [{ version: VERSION, files: V1_FILES }] },
      },
      "http://localhost:5060/api/versions/v1.0.0/files/bootloader-esp32.bin": {
        status: 404,
      },
      "http://localhost:5060/api/versions/v1.0.0/files/partition-table-esp32.bin": {
        bytes: binBytes(PARTITION.size, 3),
      },
      "http://localhost:5060/api/versions/v1.0.0/files/firmware-esp32.bin": {
        bytes: binBytes(FIRMWARE.size, 4),
      },
    });
    clickFlash();
    await waitForFailure();
    expect($("status").textContent).toContain("Flash failed: GET binary bootloader-esp32.bin → HTTP 404");
    expect(calls.find((c) => c[0] === "writeFlash")).toBeUndefined();
    expect(calls[calls.length - 1][0]).toBe("disconnect");
    expect($("flash-button").disabled).toBe(false);
    // restore the full mock (and keep the shared reference in sync)
    fetchMock = installFetchMock(apiRoutes([{ version: VERSION, files: V1_FILES }]));
  });

  it("writeFlash failure → error status + log, after() skipped, port released", async () => {
    behavior.writeFlashError = new Error("write failed at 0x10000");
    clickFlash();
    await waitForFailure();
    expect($("status").textContent).toContain("Flash failed: write failed at 0x10000");
    expect($("log").textContent).toContain("write failed at 0x10000");
    expect(calls.find((c) => c[0] === "writeFlash")).toBeTruthy();
    expect(calls.find((c) => c[0] === "after")).toBeUndefined();
    expect(calls[calls.length - 1][0]).toBe("disconnect");
    expect($("flash-button").disabled).toBe(false);
  });

  it("after() failure → error status + log, port released", async () => {
    behavior.afterError = new Error("reset failed");
    clickFlash();
    await waitForFailure();
    expect($("status").textContent).toContain("Flash failed: reset failed");
    expect(calls.find((c) => c[0] === "after")).toBeTruthy();
    expect(calls[calls.length - 1][0]).toBe("disconnect");
    expect($("flash-button").disabled).toBe(false);
  });

  it("disconnect() failure is swallowed — the flash is still reported as done", async () => {
    behavior.disconnectError = new Error("port vanished");
    clickFlash();
    await waitForDone();
    expect($("status").textContent).toBe("Done — device reset. Check the log for details.");
    expect($("status").dataset.kind).toBe("ok");
    expect(calls.find((c) => c[0] === "disconnect")).toBeTruthy();
    expect($("flash-button").disabled).toBe(false);
  });
});
