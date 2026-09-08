/**
 * Page boot with Web Serial available (issue #26 §A2(b): versions load →
 * select populated, first selected; file table rows; button enabled).
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  BASE,
  V1_FILES,
  apiRoutes,
  installFetchMock,
  installSerial,
  waitFor,
  writePageDom,
  $,
} from "./helpers.js";
import { ESPLoader, Transport } from "./stubs/esptool-js.bundle.js";

let serial;
let fetchMock;

beforeAll(async () => {
  serial = installSerial();
  fetchMock = installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
  writePageDom();
  await import("../static/app.js");
  await waitFor(() => $("version-select").options.length === 1 && !$("version-select").disabled, {
    message: "version select populated",
  });
  await waitFor(() => !$("flash-button").disabled, { message: "flash button enabled" });
});

describe("boot (spec §6.1)", () => {
  it("logs that Web Serial is available and hides the banner", () => {
    expect($("log").textContent).toContain("[ui] Web Serial API is available.");
    expect($("browser-support").hidden).toBe(true);
  });

  it("populates the version select and selects the first version", () => {
    const select = $("version-select");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["v1.0.0"]);
    expect(select.value).toBe("v1.0.0");
    expect(select.disabled).toBe(false);
  });

  it("renders one file-table row per file with name/size/address", () => {
    expect($("file-table").hidden).toBe(false);
    const rows = $("file-tbody").querySelectorAll("tr");
    expect(rows.length).toBe(3);
    const first = rows[0];
    expect(first.children[1].textContent).toBe("bootloader-esp32.bin");
    expect(first.children[2].textContent).toBe("1.0 KiB");
    expect(first.children[2].title).toBe("1024 bytes");
    expect(first.children[3].textContent).toBe("0x1000");
  });

  it("shows the meta.json label in the name cell title", () => {
    const rows = $("file-tbody").querySelectorAll("tr");
    const firmware = rows[2];
    expect(firmware.children[1].title).toBe("firmware-esp32.bin (Factory app)");
  });

  it("enables Connect & Flash once bundle + version + files are ready", () => {
    expect($("flash-button").disabled).toBe(false);
    expect($("status").textContent).toBe("Ready.");
  });

  it("fetched the version list from the API with the Accept header", () => {
    const req = fetchMock.requested.find((r) => r.url === `${BASE}/api/versions`);
    expect(req).toBeTruthy();
    expect(req.init.headers.Accept).toBe("application/json");
  });

  it("loaded the (stubbed) esptool bundle: ESPLoader + Transport available", () => {
    expect(typeof ESPLoader).toBe("function");
    expect(typeof Transport).toBe("function");
  });
});
