/**
 * Version list + file table (issue #26 §4.B2 scenarios "version population +
 * refresh + switch", "file table + labels"; spec §5.2/§6.1).
 *
 * Everything goes through the REAL API: seeding uploads real bytes to the
 * real server; the page lists and renders them.
 */
import { test, expect } from "./fixtures.js";
import { fileRows, statusInfo } from "./fixtures.js";

const BOOTLOADER = "bootloader-esp32.bin";
const PARTITION = "partition-table-esp32.bin";
const FIRMWARE = "firmware-esp32.bin";

test.describe("versions + files (spec §5.2/§6.1)", () => {
  test("fresh server: placeholder option, disabled select, empty table", async ({ page }) => {
    await expect(page.locator("#version-select")).toBeDisabled();
    const options = await page.locator("#version-select option").allTextContents();
    expect(options).toEqual(["— no versions uploaded yet —"]);
    await expect(page.locator("#file-table")).toBeHidden();
    await expect(page.locator("#no-files")).toBeHidden();
  });

  test("after upload: select populated, first selected, file table rendered", async ({ page, seed }) => {
    const { version } = await seed();

    // Select is enabled and holds the seeded version (only one exists).
    await expect(page.locator("#version-select")).toBeEnabled();
    await expect(page.locator("#version-select")).toHaveValue(version);

    // File table: one row per file, name/size/address per the API contract.
    const rows = (await fileRows(page)).sort((a, b) => a.name.localeCompare(b.name));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual([BOOTLOADER, FIRMWARE, PARTITION]); // API sorts by name
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName[BOOTLOADER].address).toBe("0x1000"); // post-#27 convention
    expect(byName[PARTITION].address).toBe("0x8000");
    expect(byName[FIRMWARE].address).toBe("0x10000");
    expect(rows.every((r) => r.checked)).toBe(true); // all checked by default

    // Sizes are human-formatted by the app (real bytes from the real API).
    expect(byName[BOOTLOADER].size).toBe("4.0 KiB");
    expect(byName[PARTITION].size).toBe("8.0 KiB");
    expect(byName[FIRMWARE].size).toBe("16.0 KiB");

    // With serial + bundle + a selected version, flashing is possible.
    await expect(page.locator("#flash-button")).toBeEnabled();
  });

  test("meta.json: label rendered in the file table (regression #20/#25)", async ({ page, seed }) => {
    await seed({
      meta: { files: { [FIRMWARE]: { label: "Factory app", address: "0x10000" } } },
    });

    const rows = await fileRows(page);
    const firmware = rows.find((r) => r.name === FIRMWARE);
    expect(firmware.title).toBe(`${FIRMWARE} (Factory app)`);
    expect(firmware.address).toBe("0x10000"); // override honored
  });

  test("refresh re-fetches the list and preserves the selection", async ({ page, seed }) => {
    const first = await seed();
    const second = await seed();

    // Select the first version, then refresh: the list re-populates and the
    // previous selection survives (spec §6.1 behavior).
    await page.selectOption("#version-select", first.version);
    await page.click("#refresh-versions");
    // The list must re-populate with BOTH versions and keep the selection.
    await page.waitForFunction(
      ([a, b]) => {
        const sel = document.getElementById("version-select");
        const opts = Array.from(sel.options).map((o) => o.value);
        return opts.includes(a) && opts.includes(b) && sel.value === a;
      },
      [first.version, second.version],
      { timeout: 10_000 }
    );

    const options = await page.locator("#version-select option").allTextContents();
    expect(options).toContain(first.version);
    expect(options).toContain(second.version);
    await expect(page.locator("#version-select")).toHaveValue(first.version);
    expect(await page.locator("#log").textContent()).toContain("version list refreshed");
  });

  test("switching versions re-renders the file table", async ({ page, seed }) => {
    const first = await seed();
    const second = await seed({
      meta: { files: { [FIRMWARE]: { label: "Second build" } } },
    });

    await page.selectOption("#version-select", second.version);
    const rows = await fileRows(page);
    expect(rows.find((r) => r.name === FIRMWARE).title).toBe(`${FIRMWARE} (Second build)`);

    await page.selectOption("#version-select", first.version);
    const back = await fileRows(page);
    expect(back.find((r) => r.name === FIRMWARE).title).toBe(FIRMWARE); // no label
  });

  test("unchecking all files disables the flash button (syncUiState)", async ({ page, seed }) => {
    await seed();
    await expect(page.locator("#flash-button")).toBeEnabled();

    for (const name of [BOOTLOADER, PARTITION, FIRMWARE]) {
      await page.locator(`#file-tbody input[data-name="${name}"]`).uncheck();
    }
    await expect(page.locator("#flash-button")).toBeDisabled();

    await page.locator(`#file-tbody input[data-name="${FIRMWARE}"]`).check();
    await expect(page.locator("#flash-button")).toBeEnabled();
  });
});
