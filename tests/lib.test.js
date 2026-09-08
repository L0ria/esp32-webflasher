/**
 * Unit tests for the pure frontend helpers in static/lib.js
 * (issue #26, PR 2 — §A2(a): formatBytes + parseAddress).
 */
import { describe, it, expect } from "vitest";
import { formatBytes, parseAddress } from "../static/lib.js";

describe("formatBytes (spec §6.1 table rendering)", () => {
  it("formats byte values below 1 KiB as plain bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats KiB / MiB / GiB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GiB");
  });

  it("caps at GiB (no TiB unit) and keeps the value finite", () => {
    const value = 5 * 1024 * 1024 * 1024 * 1024; // 5 TiB
    expect(formatBytes(value)).toBe("5120.0 GiB");
  });

  it("returns the em-dash placeholder for negative and non-finite input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(-1024)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
    expect(formatBytes(Infinity)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(null)).toBe("—");
  });
});

describe("parseAddress (spec §6.2 — hex flash addresses from the API)", () => {
  it("parses 0x-prefixed hex addresses", () => {
    expect(parseAddress("0x0")).toBe(0x0);
    expect(parseAddress("0x1000")).toBe(0x1000);
    expect(parseAddress("0x8000")).toBe(0x8000);
    expect(parseAddress("0xe000")).toBe(0xe000);
    expect(parseAddress("0x10000")).toBe(0x10000);
  });

  it("is case-insensitive and accepts plain hex strings", () => {
    expect(parseAddress("0X10000")).toBe(0x10000);
    expect(parseAddress("10000")).toBe(0x10000);
  });

  it("falls back to 0x10000 for unparseable input (spec default address)", () => {
    expect(parseAddress("garbage")).toBe(0x10000);
    expect(parseAddress("")).toBe(0x10000);
    expect(parseAddress(null)).toBe(0x10000);
    expect(parseAddress(undefined)).toBe(0x10000);
    expect(parseAddress({})).toBe(0x10000);
  });

  it("uses the caller-supplied fallback when given", () => {
    expect(parseAddress("nope", 0x1234)).toBe(0x1234);
    expect(parseAddress("0x8000", 0)).toBe(0x8000);
  });
});
