import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// ---------------------------------------------------------------------------
// Frontend unit suite (issue #26, PR 2) — vitest + jsdom.
//
// The app is vanilla JS with no build step. Two pieces of test infrastructure
// live here:
//
//   1. jsdom environment with a real (http) origin so the page's relative
//      fetch("/api/...") calls and module resolution behave like the browser.
//
//   2. A Vite plugin that stubs the vendored esptool-js 0.6.1 bundle
//      (static/vendor/esptool-js.bundle.js) with tests/stubs/esptool-js.bundle.js.
//      The real app.js resolves the bundle relative to import.meta.url and
//      loads it with a dynamic import(); the plugin intercepts that URL and
//      serves the stub instead — so the full flash flow (requestPort → main →
//      fetch → writeFlash → after → disconnect) runs against a recording stub,
//      exactly as issue #26 §A2(b) describes.
//
// The stub is a plain ES module (same shape as the real bundle: named
// ESPLoader + Transport exports) and is cached by the module registry, so a
// test imports the same instance the app uses and drives it via
// `behavior` / reads it via `calls`.
// ---------------------------------------------------------------------------

const stubPath = fileURLToPath(new URL("./tests/stubs/esptool-js.bundle.js", import.meta.url));

function esptoolBundleStub() {
  return {
    name: "test:stub-esptool-bundle",
    enforce: "pre",
    resolveId(id) {
      // Match the app's bundle URL (resolved against the jsdom origin, or the
      // relative specifier) — but NOT the stub file itself
      // (tests/stubs/esptool-js.bundle.js), which must load as a real file.
      if (
        typeof id === "string" &&
        (id.endsWith("static/vendor/esptool-js.bundle.js") ||
          id === "vendor/esptool-js.bundle.js")
      ) {
        return "\0stub:esptool-bundle";
      }
    },
    load(id) {
      if (id === "\0stub:esptool-bundle") {
        return [
          `import * as stub from ${JSON.stringify(stubPath)};`,
          // Test switches (set before the page loads, per test file):
          //   globalThis.__ESPTOOL_BUNDLE_MODE = "missing"  -> import throws
          //   globalThis.__ESPTOOL_BUNDLE_MODE = "invalid"  -> exports absent
          `if (globalThis.__ESPTOOL_BUNDLE_MODE === "missing") {`,
          `  throw new Error("bundle load failed (test)");`,
          `}`,
          `const __mode = globalThis.__ESPTOOL_BUNDLE_MODE;`,
          `export const ESPLoader = __mode === "invalid" ? undefined : stub.ESPLoader;`,
          `export const Transport = __mode === "invalid" ? undefined : stub.Transport;`,
        ].join("\n");
      }
    },
  };
}

export default defineConfig({
  plugins: [esptoolBundleStub()],
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        // Real origin (the app's default port) so relative URLs resolve.
        url: "http://localhost:5060/",
      },
    },
    include: ["tests/**/*.test.js"],
  },
});
