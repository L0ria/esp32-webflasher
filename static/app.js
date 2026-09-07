/**
 * ESP32 Web Flasher — frontend logic (issue #8, spec §6 of issue #3).
 *
 * Vanilla JS, no build step, no framework, no CDN. The only third-party
 * code is the vendored esptool-js 0.6.1 browser bundle, loaded
 * dynamically from `static/vendor/esptool-js.bundle.js` (the bundle is an
 * ES module — verified against the esptool-js 0.6.1 npm tarball — so it is
 * loaded with a dynamic `import()`; it exposes `ESPLoader` and `Transport`
 * as named exports, which we destructure and use directly).
 *
 * Flash flow (spec §6.2, verified against the esptool-js 0.6.1 README and
 * bundle):
 *   navigator.serial.requestPort()          — inside the click handler
 *   new Transport(port, true)
 *   terminal object → appends to the log <pre>
 *   new ESPLoader({ transport, baudrate, terminal })
 *   await loader.main()                     — connect + detect chip
 *   fetch each selected .bin from the API
 *   await loader.writeFlash({ fileArray, flashMode: "keep",
 *                            flashFreq: "keep", flashSize: "keep",
 *                            eraseAll, compress: true, reportProgress })
 *   await loader.after("hard_reset")
 *   finally: await transport.disconnect()   — 0.6.1 method name;
 *                                            close() kept as a fallback
 */
(() => {
  "use strict";

  // Absolute URL of this script, captured synchronously (classic script, so
  // document.currentScript is reliably the app.js element). Used to resolve
  // the vendored bundle relative to *this* file, independent of how the page
  // is mounted (root, sub-path, reverse-proxy prefix, ...).
  const SELF_URL = document.currentScript ? document.currentScript.src : null;

  // ------------------------------------------------------------------
  // DOM handles (all via getElementById / querySelector; no globals leaked)
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  const els = {
    banner: $("browser-support"),
    versionSelect: $("version-select"),
    refreshVersions: $("refresh-versions"),
    fileTable: $("file-table"),
    fileTbody: $("file-tbody"),
    noFiles: $("no-files"),
    versionHint: $("version-hint"),
    baudSelect: $("baud-select"),
    eraseAll: $("erase-all"),
    flashButton: $("flash-button"),
    status: $("status"),
    progress: $("progress"),
    progressRows: $("progress-rows"),
    log: $("log"),
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    serialSupported: typeof navigator !== "undefined" && !!navigator.serial,
    bundle: null, // { ESPLoader, Transport } once the vendor bundle loads
    versions: [], // last GET /api/versions payload: [{version, files: []}]
    flashing: false,
  };

  // ------------------------------------------------------------------
  // Log panel + status line
  // ------------------------------------------------------------------
  function appendToLog(line) {
    els.log.textContent += String(line).replace(/\r?\n$/, "") + "\n";
    els.log.scrollTop = els.log.scrollHeight; // auto-scroll
  }

  function logInfo(message) {
    appendToLog(`[ui] ${message}`);
  }

  function logError(message) {
    appendToLog(`[ui][error] ${message}`);
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.dataset.kind = kind || "idle";
  }

  // The terminal object consumed by ESPLoader (spec §6.2).
  const terminal = {
    clean() {}, // no-op: the log panel keeps its history
    writeLine(line) {
      appendToLog(line);
    },
    write(chunk) {
      appendToLog(chunk);
    },
  };

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function formatBytes(bytes) {
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

  function parseAddress(raw, fallback = 0x10000) {
    const value = parseInt(String(raw), 16);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  function selectedVersion() {
    return state.versions.find((v) => v.version === els.versionSelect.value);
  }

  function checkedFiles() {
    const version = selectedVersion();
    if (!version) return [];
    const boxes = Array.from(els.fileTbody.querySelectorAll('input[type="checkbox"]'));
    const byName = new Map(boxes.map((b) => [b.dataset.name, b]));
    return version.files.filter((f) => byName.get(f.name) && byName.get(f.name).checked);
  }

  // ------------------------------------------------------------------
  // Version list + file table
  // ------------------------------------------------------------------
  async function loadVersions() {
    let data;
    try {
      const res = await fetch("/api/versions", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`GET /api/versions → HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      logError(`could not load versions: ${err.message}`);
      setStatus("Failed to load versions.", "error");
      return;
    }

    state.versions = Array.isArray(data.versions) ? data.versions : [];

    const previous = els.versionSelect.value;
    els.versionSelect.innerHTML = "";
    if (state.versions.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "— no versions uploaded yet —";
      els.versionSelect.appendChild(opt);
      els.versionSelect.disabled = true;
    } else {
      els.versionSelect.disabled = false;
      for (const v of state.versions) {
        const opt = document.createElement("option");
        opt.value = v.version;
        opt.textContent = v.version;
        els.versionSelect.appendChild(opt);
      }
      if (previous && state.versions.some((v) => v.version === previous)) {
        els.versionSelect.value = previous;
      } else {
        // No previous selection (or it went away) → select the first version.
        els.versionSelect.value = state.versions[0].version;
      }
    }

    renderFileTable();
    syncUiState();
  }

  function renderFileTable() {
    const version = selectedVersion();
    els.fileTbody.innerHTML = "";
    if (!version) {
      els.fileTable.hidden = true;
      els.noFiles.hidden = true;
      return;
    }
    if (version.files.length === 0) {
      els.fileTable.hidden = true;
      els.noFiles.hidden = false;
      return;
    }
    els.noFiles.hidden = true;
    els.fileTable.hidden = false;
    for (const f of version.files) {
      const tr = document.createElement("tr");
      const label = f.label ? `${f.name} (${f.label})` : f.name;

      const tdCheck = document.createElement("td");
      tdCheck.className = "col-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true; // all checked by default (spec §6.1)
      box.dataset.name = f.name;
      box.setAttribute("aria-label", `Flash ${f.name}`);
      tdCheck.appendChild(box);

      const tdName = document.createElement("td");
      tdName.textContent = f.name;
      tdName.title = label;

      const tdSize = document.createElement("td");
      tdSize.textContent = formatBytes(f.size);
      tdSize.title = `${f.size} bytes`;

      const tdAddr = document.createElement("td");
      tdAddr.textContent = String(f.address);

      tr.append(tdCheck, tdName, tdSize, tdAddr);
      els.fileTbody.appendChild(tr);
    }
  }

  // ------------------------------------------------------------------
  // Progress bars (one row per selected file)
  // ------------------------------------------------------------------
  function buildProgressRows(files) {
    els.progressRows.innerHTML = "";
    els.progress.hidden = false;
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "progress-row";
      row.dataset.name = f.name;

      const name = document.createElement("span");
      name.className = "progress-name";
      name.textContent = `${f.name} @ ${f.address}`;

      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = "0%";
      bar.appendChild(fill);

      const pct = document.createElement("span");
      pct.className = "progress-pct";
      pct.textContent = "0%";

      row.append(name, bar, pct);
      els.progressRows.appendChild(row);
    }
  }

  function updateProgress(fileIndex, written, total) {
    // Progress rows were built in the same order as the fileArray that is
    // being flashed, so the index maps 1:1 (independent of checkbox state).
    const rows = els.progressRows.querySelectorAll(".progress-row");
    const row = rows[fileIndex];
    if (!row) return;
    const name = row.dataset.name;
    const percent = total > 0 ? Math.min(100, (written / total) * 100) : 100;
    row.querySelector(".progress-fill").style.width = `${percent.toFixed(1)}%`;
    row.querySelector(".progress-pct").textContent = `${percent.toFixed(0)}%`;
    setStatus(
      `Flashing ${name} (${fileIndex + 1}/${rows.length}): ` +
        `${formatBytes(written)} / ${formatBytes(total)}`
    );
  }

  // ------------------------------------------------------------------
  // esptool-js bundle (vendored, ES module)
  // ------------------------------------------------------------------
  async function loadBundle() {
    if (state.bundle) return state.bundle;
    let mod;
    try {
      // Dynamic import: the bundle is an ES module (verified against the
      // esptool-js 0.6.1 npm tarball — named exports, no default export).
      // Resolve it relative to *this* script's location (a sibling vendor/
      // dir), which is independent of how the page is mounted. Fallback to
      // the site-root-relative path if the script URL is unavailable.
      const bundleUrl = SELF_URL
        ? new URL("vendor/esptool-js.bundle.js", SELF_URL).href
        : "static/vendor/esptool-js.bundle.js";
      mod = await import(bundleUrl);
    } catch (err) {
      logError(
        "esptool-js bundle not found — build with Docker (the bundle is " +
          "vendored into static/vendor/ at image build time)."
      );
      logError(`details: ${err.message}`);
      setStatus("esptool-js bundle not found — build with Docker.", "error");
      return null;
    }
    if (typeof mod.ESPLoader !== "function" || typeof mod.Transport !== "function") {
      logError("esptool-js bundle is missing the ESPLoader/Transport exports.");
      setStatus("esptool-js bundle is invalid.", "error");
      return null;
    }
    state.bundle = { ESPLoader: mod.ESPLoader, Transport: mod.Transport };
    return state.bundle;
  }

  // ------------------------------------------------------------------
  // Flash flow (spec §6.2)
  // ------------------------------------------------------------------
  async function flash() {
    if (state.flashing) return;
    if (!state.serialSupported) {
      setStatus("Web Serial is not available in this browser.", "error");
      return;
    }
    const bundle = await loadBundle();
    if (!bundle) return;
    const version = selectedVersion();
    if (!version) {
      setStatus("Select a firmware version first.", "error");
      return;
    }
    const files = checkedFiles();
    if (files.length === 0) {
      setStatus("Select at least one file to flash.", "error");
      return;
    }

    const baudrate = parseInt(els.baudSelect.value, 10) || 115200;
    const eraseAll = els.eraseAll.checked;

    state.flashing = true;
    els.flashButton.disabled = true;
    els.versionSelect.disabled = true;
    els.refreshVersions.disabled = true;
    buildProgressRows(files);
    setStatus(`Requesting serial port (baud ${baudrate}, erase-all: ${eraseAll ? "yes" : "no"})…`);

    let transport = null;
    try {
      // 1. Request the port — must happen inside the user gesture.
      const port = await navigator.serial.requestPort();
      logInfo(`serial port selected: ${JSON.stringify(port.getInfo ? port.getInfo() : {})}`);

      // 2. Transport (tracing = true, per spec §6.2).
      transport = new bundle.Transport(port, true);

      // 3. Loader with the selected baud rate + our log-panel terminal.
      const loader = new bundle.ESPLoader({
        transport,
        baudrate,
        terminal,
      });

      // 4. Connect + detect the chip (resets the device).
      setStatus("Connecting — put the ESP board into download mode if it does not connect.");
      const chip = await loader.main();
      logInfo(`connected: ${chip}`);

      // 5. Fetch the selected binaries from the API.
      const fileArray = [];
      for (const f of files) {
        setStatus(`Downloading ${f.name}…`);
        const res = await fetch(
          `/api/versions/${encodeURIComponent(version.version)}/files/${encodeURIComponent(f.name)}`,
          { headers: { Accept: "application/octet-stream" } }
        );
        if (!res.ok) throw new Error(`GET binary ${f.name} → HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== f.size) {
          logError(`${f.name}: served ${buf.byteLength} bytes, expected ${f.size}`);
        }
        fileArray.push({ data: new Uint8Array(buf), address: parseAddress(f.address) });
      }

      // 6. Flash (compress on, keep flash mode/freq/size, optional full erase).
      setStatus("Flashing…");
      await loader.writeFlash({
        fileArray,
        flashMode: "keep",
        flashFreq: "keep",
        flashSize: "keep",
        eraseAll,
        compress: true,
        reportProgress: (fileIndex, written, total) => updateProgress(fileIndex, written, total),
      });

      // 7. Reset the device.
      setStatus("Flashing complete — resetting device…");
      await loader.after("hard_reset");
      setStatus("Done — device reset. Check the log for details.", "ok");
      logInfo("flash sequence finished successfully");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logError(message);
      setStatus(`Flash failed: ${message}`, "error");
    } finally {
      // 8. Always release the serial port. `disconnect()` is the 0.6.1
      //    method name; `close()` is kept as a future-proof fallback.
      if (transport) {
        try {
          if (typeof transport.disconnect === "function") {
            await transport.disconnect();
          } else if (typeof transport.close === "function") {
            await transport.close();
          }
        } catch {
          /* port already gone — nothing to do */
        }
      }
      state.flashing = false;
      els.versionSelect.disabled = false;
      els.refreshVersions.disabled = false;
      syncUiState();
    }
  }

  // ------------------------------------------------------------------
  // UI state
  // ------------------------------------------------------------------
  function syncUiState() {
    const canFlash =
      state.serialSupported &&
      !!state.bundle &&
      !state.flashing &&
      !!selectedVersion() &&
      checkedFiles().length > 0;
    els.flashButton.disabled = !canFlash;

    if (!state.serialSupported) {
      els.banner.hidden = false;
    }
  }

  // ------------------------------------------------------------------
  // Wiring + boot
  // ------------------------------------------------------------------
  function init() {
    if (!state.serialSupported) {
      // navigator.serial undefined → banner + disabled button (spec §6.1).
      logError("navigator.serial is undefined — Web Serial is unavailable " +
        "(needs Chrome/Edge 89+, over HTTPS or localhost).");
    } else {
      logInfo("Web Serial API is available.");
    }

    els.refreshVersions.addEventListener("click", () => {
      loadVersions().then(() => logInfo("version list refreshed"));
    });

    els.versionSelect.addEventListener("change", () => {
      renderFileTable();
      syncUiState();
    });

    els.fileTbody.addEventListener("change", () => syncUiState());
    els.eraseAll.addEventListener("change", () => syncUiState());
    els.baudSelect.addEventListener("change", () => syncUiState());

    els.flashButton.addEventListener("click", () => {
      // requestPort() is called inside this user-gesture handler chain.
      flash();
    });

    // Listen for devices being plugged/unplugged (informational only).
    if (state.serialSupported && typeof navigator.serial.addEventListener === "function") {
      navigator.serial.addEventListener("connect", (e) => {
        logInfo(`serial device connected: ${e.port ? e.port.getInfo().usbVendorId : "?"}`);
      });
      navigator.serial.addEventListener("disconnect", () => {
        logInfo("serial device disconnected");
      });
    }

    // Boot: load the bundle (may fail pre-Docker-build) + the version list.
    loadBundle().then(() => syncUiState());
    loadVersions();
    syncUiState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
