/**
 * ESP32 Web Flasher — pure frontend helpers (issue #26, PR 2).
 *
 * Extracted from app.js as a tiny testability refactor (issue #26 open
 * question Q2, approved in the issue thread): these helpers are pure and
 * now live in their own ES module so the frontend unit suite
 * (vitest + jsdom) can import and test them directly.
 *
 * Loaded in index.html as `<script type="module" src="static/lib.js">`
 * BEFORE the classic app.js script. ES module scripts are deferred, so
 * they always execute before the classic script that follows them —
 * which is exactly the order app.js needs.
 *
 * app.js consumes the same module instance (same resolved URL), so the
 * behavior of the page is unchanged.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function parseAddress(raw, fallback = 0x10000) {
  const value = parseInt(String(raw), 16);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
