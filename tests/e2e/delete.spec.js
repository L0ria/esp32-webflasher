/**
 * Delete-version flow (issue #36) — real page, real server, real browser.
 *
 *   * delete the last version → select falls back to the placeholder,
 *     the bundle directory is gone from disk, the log records the delete;
 *   * two versions seeded → delete one → the other remains and is selected.
 *
 * The confirmation dialog is accepted through Playwright's dialog handler.
 */
import fs from "node:fs";
import { test, expect } from "./fixtures.js";
import { logText, statusInfo } from "./fixtures.js";

test.describe("delete version (issue #36)", () => {
  test("delete the last version → placeholder + bundle removed from disk", async ({ page, server, seed }) => {
    const { version } = await seed();
    const versionDir = `${server.binariesDir}/${version}`;
    expect(fs.existsSync(versionDir)).toBe(true);

    page.on("dialog", (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain(version);
      expect(dialog.message()).toContain("cannot be undone");
      return dialog.accept();
    });

    await expect(page.locator("#delete-version")).toBeEnabled();
    await page.click("#delete-version");

    // Success: status line + log entry.
    await expect(page.locator("#status")).toHaveText(`Version ${version} deleted.`);
    const st = await statusInfo(page);
    expect(st.kind).toBe("ok");
    await expect(page.locator("#log")).toContainText(`version ${version} deleted`);

    // The last version is gone → placeholder option + disabled select.
    await expect(page.locator("#version-select")).toBeDisabled();
    const options = await page.locator("#version-select option").allTextContents();
    expect(options).toEqual(["— no versions uploaded yet —"]);
    await expect(page.locator("#delete-version")).toBeDisabled();

    // The whole bundle is gone from disk.
    expect(fs.existsSync(versionDir)).toBe(false);

    // And the API agrees.
    const listing = await (await fetch(`${server.baseUrl}/api/versions`)).json();
    expect(listing.versions).toEqual([]);
  });

  test("delete one of two → the other remains and is selected", async ({ page, seed }) => {
    const first = await seed();
    const second = await seed();

    // Select the FIRST version (the one to delete).
    await page.selectOption("#version-select", first.version);

    page.on("dialog", (dialog) => dialog.accept());
    await page.click("#delete-version");

    await expect(page.locator("#status")).toHaveText(`Version ${first.version} deleted.`);

    // The survivor remains, is the only option, and is selected.
    await expect(page.locator("#version-select")).toBeEnabled();
    await expect(page.locator("#version-select")).toHaveValue(second.version);
    const options = await page.locator("#version-select option").allTextContents();
    expect(options).toEqual([second.version]);

    // The survivor's file table is rendered (UI fully usable).
    const rows = await page.locator("#file-tbody tr").count();
    expect(rows).toBe(3);
    await expect(page.locator("#delete-version")).toBeEnabled();
  });

  test("declined confirmation → nothing is deleted", async ({ page, server, seed }) => {
    const { version } = await seed();
    const versionDir = `${server.binariesDir}/${version}`;

    page.on("dialog", (dialog) => dialog.dismiss());
    await page.click("#delete-version");

    // Give the app a beat to (not) act, then verify the UI is untouched.
    await page.waitForTimeout(300);
    await expect(page.locator("#version-select")).toHaveValue(version);
    await expect(page.locator("#delete-version")).toBeEnabled();
    expect(fs.existsSync(versionDir)).toBe(true);
    await expect(page.locator("#log")).toContainText(`delete of ${version} cancelled`);
    const st = await statusInfo(page);
    expect(st.kind).not.toBe("error");
  });
});
