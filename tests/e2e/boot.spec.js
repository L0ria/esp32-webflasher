/**
 * Page boot (issue #26 §4.B2 scenario "page boot" + spec §6.1).
 *
 * Real page served by the real server; the bundle stub is installed, so the
 * app boots exactly as it would against a vendored bundle.
 */
import { test, expect } from "./fixtures.js";
import { logText, statusInfo, requestPortCount } from "./fixtures.js";

test.describe("page boot (spec §6.1)", () => {
  test("serves the real SPA and reports Web Serial availability", async ({ page }) => {
    await expect(page).toHaveTitle("ESP32 Web Flasher");
    await expect(page.locator("h1")).toHaveText("ESP32 Web Flasher");

    // The app booted against the stubbed serial + bundle (no errors).
    const log = await logText(page);
    expect(log).toContain("Web Serial API is available.");
    expect(log).not.toContain("[error]");

    // Idle state: ready status, no banner, flash disabled (no versions yet).
    // (data-kind is only set after the first status change — see app.js.)
    expect(await page.locator("#status").textContent()).toBe("Ready.");
    await expect(page.locator("#browser-support")).toBeHidden();
    await expect(page.locator("#flash-button")).toBeDisabled();
  });

  test("no-serial context: banner visible + flash button disabled (spec §6.1)", async ({ browser, server }) => {
    // A context WITHOUT Web Serial (Firefox/Safari shape).  Headless Chrome
    // ships a native navigator.serial, so remove it explicitly before the
    // app boots.
    const context = await browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "serial", { value: undefined, configurable: true });
    });
    const page = await context.newPage();
    await page.goto(server.baseUrl); // absolute: server runs on a random port
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("#browser-support")).toBeVisible();
    await expect(page.locator("#browser-support")).toContainText("Requires Chrome/Edge 89+");
    await expect(page.locator("#flash-button")).toBeDisabled();

    const log = await page.locator("#log").textContent();
    expect(log).toContain("navigator.serial is undefined");

    // Clicking the (disabled) button must not touch serial at all.
    expect(await requestPortCount(page)).toBe(-1); // no serial stub installed
    await context.close();
  });
});
