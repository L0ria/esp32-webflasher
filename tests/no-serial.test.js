/**
 * Boot without Web Serial (issue #26 §A2(b), spec §6.1):
 * navigator.serial undefined → banner visible, flash button disabled.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  V1_FILES,
  apiRoutes,
  installFetchMock,
  removeSerial,
  waitFor,
  writePageDom,
  $,
} from "./helpers.js";

beforeAll(async () => {
  removeSerial(); // navigator.serial stays undefined (Firefox/Safari case)
  installFetchMock(apiRoutes([{ version: "v1.0.0", files: V1_FILES }]));
  writePageDom();
  await import("../static/app.js");
  await waitFor(() => $("version-select").options.length === 1, {
    message: "version select populated",
  });
});

describe("no Web Serial (spec §6.1)", () => {
  it("shows the browser-support banner", () => {
    const banner = $("browser-support");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("Requires Chrome/Edge 89+ (Web Serial)");
  });

  it("keeps Connect & Flash disabled even with a version and files selected", () => {
    expect($("flash-button").disabled).toBe(true);
  });

  it("logs the missing Web Serial API as an error", () => {
    expect($("log").textContent).toContain("[ui][error] navigator.serial is undefined");
  });

  it("still renders the version list and file table (read-only state)", () => {
    expect($("version-select").value).toBe("v1.0.0");
    expect($("file-tbody").querySelectorAll("tr").length).toBe(3);
  });

  it("clicking Connect & Flash reports Web Serial unavailable (no crash)", async () => {
    // jsdom does not fire click events on disabled buttons — dispatch directly.
    $("flash-button").dispatchEvent(new window.Event("click"));
    await waitFor(() => $("status").textContent.includes("Web Serial is not available"), {
      message: "status reports missing Web Serial",
    });
    expect($("status").dataset.kind).toBe("error");
  });
});
