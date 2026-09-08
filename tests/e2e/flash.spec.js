/**
 * Connect & Flash end-to-end (issue #26 §4.B2 + spec §6.2) — the E2E core:
 *
 *   requestPort → Transport → ESPLoader → main() → per-file fetch (real API)
 *   → writeFlash (fileArray with the REAL API's addresses) → after("hard_reset")
 *   → transport.disconnect() in finally.
 *
 * Plus the failure paths with UI recovery: mid-flash writeFlash failure,
 * API 500 on a file download, and a missing bundle.
 */
import { test, expect } from "./fixtures.js";
import {
  logText,
  statusInfo,
  progressRows,
  requestPortCount,
  setBehavior,
  stubCalls,
} from "./fixtures.js";

const BOOTLOADER = "bootloader-esp32.bin";
const PARTITION = "partition-table-esp32.bin";
const FIRMWARE = "firmware-esp32.bin";

/** Wait until the status line says the flash finished (success or failure). */
async function waitForFlashOutcome(page) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById("status").textContent;
      return s.startsWith("Done") || s.startsWith("Flash failed");
    },
    { timeout: 10_000 }
  );
}

/** The stub's writeFlash call (or undefined). */
function writeFlashCall(calls) {
  return calls.find((c) => c[0] === "writeFlash");
}

test.describe("Connect & Flash (spec §6.2)", () => {
  test("happy path: full flow with correct addresses, progress, reset, release", async ({ page, seed }) => {
    const { version } = await seed();
    const sizes = { [BOOTLOADER]: 4096, [PARTITION]: 8192, [FIRMWARE]: 16384 };

    // The stub reports per-file progress (the app renders the progress rows).
    await setBehavior(page, {
      progress: [
        [0, Math.floor(sizes[BOOTLOADER] / 2), sizes[BOOTLOADER]],
        [0, sizes[BOOTLOADER], sizes[BOOTLOADER]],
        [1, sizes[PARTITION], sizes[PARTITION]],
        [2, sizes[FIRMWARE], sizes[FIRMWARE]],
      ],
    });

    await page.click("#flash-button");
    await waitForFlashOutcome(page);

    // --- Outcome: success -------------------------------------------------
    const status = await statusInfo(page);
    expect(status.text).toBe("Done — device reset. Check the log for details.");
    expect(status.kind).toBe("ok");

    // --- Serial: exactly one requestPort, inside the gesture chain --------
    expect(await requestPortCount(page)).toBe(1);

    // --- Stub call order + arguments (spec §6.2 steps 1–8) ---------------
    const calls = await stubCalls(page);
    expect(calls.map((c) => c[0])).toEqual([
      "Transport",
      "ESPLoader",
      "main",
      "writeFlash",
      "after",
      "disconnect",
    ]);

    // Transport(port, tracing=true) with the stub port's info.
    expect(calls[0][1].tracing).toBe(true);
    expect(calls[0][1].portInfo).toMatchObject({ usbVendorId: 0x303a, serialNumber: "STUB0001" });

    // ESPLoader({transport, baudrate, terminal}).
    expect(calls[1][1].baudrate).toBe(115200);
    expect(calls[1][1].hasTerminal).toBe(true);

    // main() connected and the chip made it into the log.
    expect((await logText(page))).toContain("connected: ESP32 (stub)");

    // writeFlash: the REAL API's fileArray — addresses 0x1000/0x8000/0x10000
    // and the real byte lengths — with keep×3, no erase, compression on.
    const wf = writeFlashCall(calls);
    // The app flashes in the API's order (sorted by filename).
    const flashed = [...wf[1].fileArray].sort(
      (a, b) => Object.keys(sizes).find((n) => sizes[n] === a.bytes).localeCompare(
        Object.keys(sizes).find((n) => sizes[n] === b.bytes))
    );
    expect(flashed).toEqual([
      { address: 0x1000, bytes: sizes[BOOTLOADER] },
      { address: 0x10000, bytes: sizes[FIRMWARE] },
      { address: 0x8000, bytes: sizes[PARTITION] },
    ]);
    expect(wf[1].flashMode).toBe("keep");
    expect(wf[1].flashFreq).toBe("keep");
    expect(wf[1].flashSize).toBe("keep");
    expect(wf[1].eraseAll).toBe(false);
    expect(wf[1].compress).toBe(true);

    // after("hard_reset") + port released in finally.
    expect(calls[4][1]).toBe("hard_reset");
    expect(calls[5][0]).toBe("disconnect");

    // --- UI: progress rows reached 100 %, log panel populated -------------
    const rows = await progressRows(page);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name).sort()).toEqual([BOOTLOADER, FIRMWARE, PARTITION]);
    expect(rows.map((r) => r.pct)).toEqual(["100%", "100%", "100%"]);
    // CSSOM serializes the width ("100.0%" → "100%").
    expect(rows.map((r) => r.width)).toEqual(["100%", "100%", "100%"]);

    const log = await logText(page);
    expect(log).toContain("serial port selected:");
    expect(log).toContain("flash sequence finished successfully");
    expect(log).not.toContain("[error]");

    // UI re-enabled after the flow.
    await expect(page.locator("#version-select")).toBeEnabled();
    await expect(page.locator("#flash-button")).toBeEnabled();
  });

  test("baud rate + erase-all pass through to the loader", async ({ page, seed }) => {
    await seed();
    await setBehavior(page, { progress: [[2, 16384, 16384]] });

    await page.selectOption("#baud-select", "921600");
    await page.locator("#erase-all").check();
    await page.click("#flash-button");
    await waitForFlashOutcome(page);

    const calls = await stubCalls(page);
    expect(calls.find((c) => c[0] === "ESPLoader")[1].baudrate).toBe(921600);
    const wf = writeFlashCall(calls);
    expect(wf[1].eraseAll).toBe(true);
    expect(wf[1].compress).toBe(true);
  });

  test("flashing only the checked files (partial selection)", async ({ page, seed }) => {
    await seed();
    await setBehavior(page, { progress: [[0, 16384, 16384]] });

    // Uncheck bootloader + partition → only the firmware is flashed.
    await page.locator(`#file-tbody input[data-name="${BOOTLOADER}"]`).uncheck();
    await page.locator(`#file-tbody input[data-name="${PARTITION}"]`).uncheck();
    await page.click("#flash-button");
    await waitForFlashOutcome(page);

    const wf = writeFlashCall(await stubCalls(page));
    expect(wf[1].fileArray).toEqual([{ address: 0x10000, bytes: 16384 }]);
  });
});

test.describe("failure paths (UI recovery + port release)", () => {
  test("mid-flash writeFlash failure → error status, log, UI re-enabled, port released", async ({ page, seed }) => {
    await seed();
    await setBehavior(page, {
      writeFlashError: "stub: flash write failed (simulated)",
    });

    await page.click("#flash-button");
    await waitForFlashOutcome(page);

    const status = await statusInfo(page);
    expect(status.text).toBe("Flash failed: stub: flash write failed (simulated)");
    expect(status.kind).toBe("error");

    const log = await logText(page);
    expect(log).toContain("[ui][error] stub: flash write failed (simulated)");

    // The port was STILL released (finally block) — and the flow ran far
    // enough to connect, but never reset the device.
    const calls = await stubCalls(page);
    expect(calls.map((c) => c[0])).toEqual(["Transport", "ESPLoader", "main", "writeFlash", "disconnect"]);
    expect(calls.find((c) => c[0] === "after")).toBeUndefined();

    await expect(page.locator("#version-select")).toBeEnabled();
    await expect(page.locator("#refresh-versions")).toBeEnabled();
    await expect(page.locator("#flash-button")).toBeEnabled();
  });

  test("API 500 on a file download → error status, log, no writeFlash, port released", async ({ page, seed }) => {
    const { version } = await seed();

    // Fail the firmware download (the third fetch) with a JSON 500.
    await page.route(`**/api/versions/${version}/files/${FIRMWARE}`, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "internal server error" }),
      })
    );

    await page.click("#flash-button");
    await waitForFlashOutcome(page);

    const status = await statusInfo(page);
    expect(status.text).toContain("Flash failed:");
    expect(status.text).toContain(`GET binary ${FIRMWARE} → HTTP 500`);
    expect(status.kind).toBe("error");

    const log = await logText(page);
    expect(log).toContain(`[ui][error] GET binary ${FIRMWARE} → HTTP 500`);

    // Connected, but never wrote anything — and the port was released.
    const calls = await stubCalls(page);
    expect(calls.map((c) => c[0])).toEqual(["Transport", "ESPLoader", "main", "disconnect"]);
    expect(writeFlashCall(calls)).toBeUndefined();

    await expect(page.locator("#version-select")).toBeEnabled();
    await expect(page.locator("#flash-button")).toBeEnabled();
  });

  test("bundle missing at boot → error surfaced, flash stays disabled, no serial use", async ({ browser, server }) => {
    // Context WITHOUT the bundle route: the app's dynamic import() of the
    // (absent) vendored bundle fails, exactly like a pre-Docker-build state.
    const context = await browser.newContext();
    await context.addInitScript((portInfo) => {
      const port = { getInfo: () => ({ ...portInfo }) };
      const requestPortCalls = [];
      window.__SERIAL_STUB__ = {
        requestPortCalls,
        requestPort: async () => requestPortCalls.push(1) || port,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
      Object.defineProperty(navigator, "serial", { value: window.__SERIAL_STUB__, configurable: true });
    }, { usbVendorId: 0x303a, usbProductId: 0x1001, serialNumber: "STUB0001" });

    const page = await context.newPage();
    await page.goto(server.baseUrl);
    await page.waitForLoadState("domcontentloaded");

    // Boot surfaced the bundle error (status + log), no crash.
    await page.waitForFunction(
      () => document.getElementById("status").textContent.includes("bundle"),
      { timeout: 10_000 }
    );
    const status = await statusInfo(page);
    expect(status.text).toBe("esptool-js bundle not found — build with Docker.");
    expect(status.kind).toBe("error");
    expect(await logText(page)).toContain("esptool-js bundle not found");

    // Flashing is impossible: the button stays disabled and no serial call
    // can happen (requestPort is only ever called from the flash flow).
    await expect(page.locator("#flash-button")).toBeDisabled();
    expect(await page.evaluate(() => window.__SERIAL_STUB__.requestPortCalls.length)).toBe(0);
    await context.close();
  });
});
