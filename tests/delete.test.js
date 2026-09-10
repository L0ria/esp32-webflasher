/**
 * Delete-version behavior (issue #36):
 *   * button enabled with a selected version, disabled with none;
 *   * confirm → DELETE issued to the right URL → success → status/log +
 *     the version disappears from the select (placeholder when it was last);
 *   * confirm declined → no DELETE request, UI unchanged;
 *   * DELETE 404 → error status + log, UI stays usable.
 *
 * Real static/app.js + real index.html DOM; fetch and navigator.serial are
 * mocked (tests/helpers.js), the esptool-js bundle is stubbed by vitest.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  V1_FILES,
  V2_FILES,
  apiRoutes,
  installFetchMock,
  installSerial,
  waitFor,
  writePageDom,
  $,
  logText,
  statusInfo,
} from "./helpers.js";

const VERSIONS = [
  { version: "v1.0.0", files: V1_FILES },
  { version: "v2.0.0", files: V2_FILES },
];

const DELETE_URL = (v) => `http://localhost:5060/api/versions/${encodeURIComponent(v)}`;

let fetchMock;

/** Re-install the fetch mock with the given version list (shared handler). */
function setVersions(versions) {
  fetchMock = installFetchMock(apiRoutes(versions));
  return fetchMock;
}

function deleteRequests() {
  return fetchMock.requested.filter((r) => r.init && r.init.method === "DELETE");
}

beforeAll(async () => {
  installSerial();
  setVersions(VERSIONS);
  writePageDom();
  await import("../static/app.js");
  await waitFor(() => $("version-select").options.length === 2, {
    message: "all versions loaded",
  });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  // A previous test may have left the app with a reduced version list (or
  // the "no versions" placeholder).  If v1.0.0 is not selectable, restore
  // the full list through the app's own refresh so `selectedVersion()`
  // resolves again.
  const hasV1 = Array.from($("version-select").options).some((o) => o.value === "v1.0.0");
  if (!hasV1) {
    setVersions(VERSIONS);
    $("refresh-versions").click();
    await waitFor(
      () =>
        Array.from($("version-select").options).some((o) => o.value === "v1.0.0"),
      { message: "version list restored" }
    );
  }
  $("version-select").value = "v1.0.0";
  $("version-select").dispatchEvent(new window.Event("change", { bubbles: true }));
});

describe("delete button state (issue #36)", () => {
  it("is enabled when a version is selected", () => {
    expect($("delete-version").disabled).toBe(false);
  });

  it("is disabled when no version is selected", async () => {
    setVersions([]);
    $("refresh-versions").click();
    await waitFor(() => $("version-select").options.length === 1, {
      message: "empty version list",
    });
    expect($("version-select").value).toBe("");
    expect($("delete-version").disabled).toBe(true);
    setVersions(VERSIONS);
  });
});

describe("delete flow (issue #36)", () => {
  it("confirm → DELETE to the right URL → success → select falls back to placeholder", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mock = setVersions([{ version: "v1.0.0", files: V1_FILES }]);
    mock.routes[DELETE_URL("v1.0.0")] = { json: { deleted: "v1.0.0" } };
    mock.routes["http://localhost:5060/api/versions"] = {
      json: { versions: [] },
    };

    $("delete-version").click();

    await waitFor(() => logText().includes("version v1.0.0 deleted"), {
      message: "delete completed",
    });

    const reqs = deleteRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].url).toBe(DELETE_URL("v1.0.0"));
    expect(reqs[0].init.method).toBe("DELETE");

    const st = statusInfo();
    expect(st.text).toBe("Version v1.0.0 deleted.");
    expect(st.kind).toBe("ok");
    expect(logText()).toContain("deleting version v1.0.0");

    // The last version is gone → placeholder + disabled select.
    await waitFor(() => $("version-select").options.length === 1, {
      message: "empty version list after delete",
    });
    expect($("version-select").value).toBe("");
    expect($("version-select").disabled).toBe(true);
    expect($("delete-version").disabled).toBe(true);
  });

  it("deletes one of two versions and keeps the other selected", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mock = setVersions(VERSIONS);
    mock.routes[DELETE_URL("v1.0.0")] = { json: { deleted: "v1.0.0" } };
    mock.routes["http://localhost:5060/api/versions"] = {
      json: { versions: [{ version: "v2.0.0", files: V2_FILES }] },
    };

    $("delete-version").click();

    await waitFor(() => $("version-select").options.length === 1, {
      message: "reduced version list",
    });
    expect($("version-select").value).toBe("v2.0.0");
    expect($("delete-version").disabled).toBe(false);
    expect(statusInfo().text).toBe("Version v1.0.0 deleted.");
  });

  it("confirm declined → no DELETE request, UI unchanged", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const mock = setVersions(VERSIONS);

    $("delete-version").click();

    await waitFor(() => logText().includes("delete of v1.0.0 cancelled"), {
      message: "cancel logged",
    });
    expect(deleteRequests()).toHaveLength(0);
    expect($("version-select").value).toBe("v1.0.0");
    expect($("version-select").options.length).toBe(2);
    expect(statusInfo().kind).not.toBe("error");
  });

  it("DELETE 404 → error status + log, UI stays usable", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const mock = setVersions(VERSIONS);
    mock.routes[DELETE_URL("v1.0.0")] = {
      json: { error: "version 'v1.0.0' not found" },
      status: 404,
    };

    $("delete-version").click();

    await waitFor(() => logText().includes("delete of v1.0.0 failed"), {
      message: "delete failure logged",
    });
    expect(deleteRequests()).toHaveLength(1);

    const st = statusInfo();
    expect(st.kind).toBe("error");
    expect(st.text).toContain("version 'v1.0.0' not found");
    expect(logText()).toContain("[ui][error]");

    // UI stays usable: selection intact, button enabled, no crash.
    expect($("version-select").value).toBe("v1.0.0");
    expect($("delete-version").disabled).toBe(false);
  });
});
