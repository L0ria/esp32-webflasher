/**
 * UI state + boot-failure paths (issue #26 §A2(b)):
 *   * checkboxes checked by default; unchecking all disables the button;
 *   * checkbox / baud / erase-all changes drive syncUiState;
 *   * API failure → error status + log, UI stays usable;
 *   * bundle load failure → error status + log, button stays disabled.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  V1_FILES,
  apiRoutes,
  installFetchMock,
  installSerial,
  waitFor,
  writePageDom,
  $,
} from "./helpers.js";

function setBaud(value) {
  $("baud-select").value = value;
  $("baud-select").dispatchEvent(new window.Event("change", { bubbles: true }));
}

function setEraseAll(checked) {
  $("erase-all").checked = checked;
  $("erase-all").dispatchEvent(new window.Event("change", { bubbles: true }));
}

function setChecked(name, checked) {
  const box = $("file-tbody").querySelector(`input[data-name="${name}"]`);
  box.checked = checked;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
}

describe("UI state (spec §6.1 syncUiState)", () => {
  beforeAll(async () => {
    installSerial();
    installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
    writePageDom();
    await import("../static/app.js");
    await waitFor(() => !$("flash-button").disabled, { message: "button enabled" });
  });

  it("renders all checkboxes checked by default", () => {
    const boxes = $("file-tbody").querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(3);
    for (const box of boxes) expect(box.checked).toBe(true);
  });

  it("unchecking a single file keeps the button enabled (others remain)", () => {
    setChecked("bootloader-esp32.bin", false);
    expect($("flash-button").disabled).toBe(false);
    setChecked("bootloader-esp32.bin", true);
  });

  it("unchecking every file disables Connect & Flash", () => {
    for (const name of ["bootloader-esp32.bin", "partition-table-esp32.bin", "firmware-esp32.bin"]) {
      setChecked(name, false);
    }
    expect($("flash-button").disabled).toBe(true);
    // ...and re-checking one re-enables it
    setChecked("firmware-esp32.bin", true);
    expect($("flash-button").disabled).toBe(false);
  });

  it("baud-rate changes keep the button enabled (valid baud values)", () => {
    setBaud("921600");
    expect($("flash-button").disabled).toBe(false);
    setBaud("57600");
    expect($("flash-button").disabled).toBe(false);
    setBaud("115200");
  });

  it("erase-all toggling keeps the button enabled (it only changes flash options)", () => {
    setEraseAll(true);
    expect($("flash-button").disabled).toBe(false);
    setEraseAll(false);
    expect($("flash-button").disabled).toBe(false);
  });
});

describe("boot failure paths (spec §6.2)", () => {
  it("API failure → error status + log, select stays disabled, button disabled", async () => {
    // Re-import the app module fresh so init() runs against this scenario.
    vi.resetModules();
    installSerial();
    installFetchMock({
      "http://localhost:5060/api/versions": { error: new Error("network down") },
    });
    writePageDom();
    await import("../static/app.js");
    await waitFor(() => $("status").textContent.includes("Failed to load versions"), {
      message: "error status set",
    });
    expect($("status").dataset.kind).toBe("error");
    expect($("log").textContent).toContain("[ui][error] could not load versions: network down");
    expect($("version-select").disabled).toBe(true);
    expect($("flash-button").disabled).toBe(true);
    expect($("log").textContent).toContain("[ui] Web Serial API is available.");
  });

  it("bundle load failure → error status + log, button stays disabled", async () => {
    globalThis.__ESPTOOL_BUNDLE_MODE = "missing";
    vi.resetModules();
    try {
      installSerial();
      installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
      writePageDom();
      await import("../static/app.js");
      await waitFor(() => $("status").textContent.includes("bundle not found"), {
        message: "bundle error status set",
      });
      expect($("status").dataset.kind).toBe("error");
      expect($("log").textContent).toContain("esptool-js bundle not found");
      expect($("log").textContent).toContain("bundle load failed (test)");
      expect($("flash-button").disabled).toBe(true);
    } finally {
      delete globalThis.__ESPTOOL_BUNDLE_MODE;
    }
  });

  it("bundle with missing exports → invalid-bundle error, button stays disabled", async () => {
    globalThis.__ESPTOOL_BUNDLE_MODE = "invalid";
    vi.resetModules();
    try {
      installSerial();
      installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
      writePageDom();
      await import("../static/app.js");
      await waitFor(() => $("status").textContent.includes("bundle is invalid"), {
        message: "invalid bundle status set",
      });
      expect($("status").dataset.kind).toBe("error");
      expect($("log").textContent).toContain("missing the ESPLoader/Transport exports");
      expect($("flash-button").disabled).toBe(true);
    } finally {
      delete globalThis.__ESPTOOL_BUNDLE_MODE;
    }
  });
});
