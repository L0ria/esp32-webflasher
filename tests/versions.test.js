/**
 * Version list behavior (issue #26 §A2(b)):
 *   * versions load → select populated, first selected;
 *   * previous selection preserved on refresh;
 *   * switching versions re-renders the file table;
 *   * empty version → "no files" hint;
 *   * API failure → error status + log, UI stays usable.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  V1_FILES,
  V2_FILES,
  apiRoutes,
  installFetchMock,
  installSerial,
  waitFor,
  writePageDom,
  $,
} from "./helpers.js";

const VERSIONS = [
  { version: "v1.0.0", files: V1_FILES },
  { version: "v2.0.0", files: V2_FILES },
  { version: "empty", files: [] },
];

let fetchMock;

function changeVersion(value) {
  $("version-select").value = value;
  $("version-select").dispatchEvent(new window.Event("change", { bubbles: true }));
}

beforeAll(async () => {
  installSerial();
  fetchMock = installFetchMock(apiRoutes(VERSIONS));
  writePageDom();
  await import("../static/app.js");
  await waitFor(() => $("version-select").options.length === 3, {
    message: "all versions loaded",
  });
});

beforeEach(() => {
  // Reset to a known selection between tests.
  changeVersion("v1.0.0");
});

describe("version list (spec §6.1)", () => {
  it("populates the select in API order and selects the first version", () => {
    const select = $("version-select");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["v1.0.0", "v2.0.0", "empty"]);
    expect(select.value).toBe("v1.0.0");
  });

  it("switching versions re-renders the file table", () => {
    changeVersion("v2.0.0");
    const rows = $("file-tbody").querySelectorAll("tr");
    expect(rows.length).toBe(1);
    expect(rows[0].children[1].textContent).toBe("firmware-esp32.bin");
    expect(rows[0].children[2].textContent).toBe("512 B");
    expect(rows[0].children[3].textContent).toBe("0x10000");
  });

  it("shows the 'no files' hint for an empty version", () => {
    changeVersion("empty");
    expect($("file-table").hidden).toBe(true);
    expect($("no-files").hidden).toBe(false);
    expect($("no-files").textContent).toBe("The selected version has no files.");
  });

  it("preserves the previous selection on refresh", async () => {
    changeVersion("v2.0.0");
    $("refresh-versions").click();
    await waitFor(() => $("log").textContent.includes("version list refreshed"), {
      message: "refresh completed",
    });
    expect($("version-select").value).toBe("v2.0.0");
    expect($("file-tbody").querySelectorAll("tr").length).toBe(1);
  });

  it("falls back to the first version when the previous one disappeared", async () => {
    changeVersion("v2.0.0");
    // Re-route the API to a list without v2.0.0 (re-install the fetch mock).
    installFetchMock({
      "http://localhost:5060/api/versions": {
        json: { versions: [{ version: "v1.0.0", files: V1_FILES }] },
      },
    });
    $("refresh-versions").click();
    await waitFor(() => $("version-select").options.length === 1, {
      message: "reduced version list",
    });
    expect($("version-select").value).toBe("v1.0.0");
    // restore the full mock for later tests
    fetchMock = installFetchMock(apiRoutes(VERSIONS));
  });
});
