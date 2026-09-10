# SKILLS.md — publishing built ESP32 binaries to the Web Flasher

A guide for **agents** (e.g. an LLM driving `arduino-cli`) that build ESP32
firmware and want to publish the resulting `.bin` files so a human can flash
them **from the browser** — no desktop tools, no command line on the target
machine.

The tool is the [ESP32 Web Flasher](README.md): a small Flask server that stores
uploaded binaries and lets a browser (Web Serial + esptool-js) flash them to a
USB-connected ESP32.

---

## 1. When to use this

Use this workflow when:

- You have **built** one or more ESP32 `.bin` files on disk (e.g. via the
  `esp32-arduino-development` / arduino-cli skill), and
- the human wants to flash them **through a browser** instead of a serial
  command line, and
- the Web Flasher server is reachable.

The agent's job is only to **upload** the binaries into a version. The human
does the flashing in the browser.

---

## 2. Prerequisites

- The server is running and reachable:
  ```bash
  docker compose up --build
  ```
- Pick the base URL of the running server:
  - HTTP: `http://localhost:5060`
  - HTTPS: `https://flash.local`
  In the examples below, `http://localhost:5060` is used. Replace it with the
  actual host/port if the server runs elsewhere.
- You have the built `.bin` files on disk and know their paths.
- A browser with **Web Serial** (Chrome / Edge 89+) on the machine that has the
  ESP32 connected over USB — this is for the *human* flashing step, not for the
  upload.

---

## 3. Upload workflow (the core)

### 3.1 Choose a version name

`version` becomes a directory under the server's `BINARIES_DIR` (default
`/srv/binaries`). It must be a **safe** name:

- 1–64 characters,
- starts with a letter or digit,
- then only letters, digits, `.`, `_`, `-`,
- no `/`, `..`, spaces, or newlines.

Good examples: `v1.0.0`, `2024-05-03`, `nb300-v2`, `dev-20240503`.
Bad examples: `..`, `.hidden`, `my version`, `C:\bin`, `v1.0.0/`.

Pick something meaningful — e.g. the firmware version, a date, or a
`<project>-<tag>` string — because the human will see it in the version
dropdown.

### 3.2 Upload the files

Send **one** multipart request with a `version` field and one or more
`files=@…` fields (repeat the field for multiple files). Only `.bin` files are
accepted, plus an optional `meta.json`. Total request size is capped at **64 MB**. Uploading a name that
already exists **overwrites** it.

```bash
curl -F version=v1.0.0 \
     -F files=@bootloader-esp32.bin \
     -F files=@partition-table-esp32.bin \
     -F files=@firmware-esp32.bin \
     http://localhost:5060/api/upload
```

Expected success response — `201 Created`:

```json
{
  "version": "v1.0.0",
  "saved": [
    { "name": "bootloader-esp32.bin", "size": 19592 },
    { "name": "partition-table-esp32.bin", "size": 2252 },
    { "name": "firmware-esp32.bin", "size": 1234567 }
  ]
}
```

Check that `saved[]` lists **every** file you sent, with the expected sizes.

### 3.3 Verify

List the versions and the flash address the server has computed for each file:

```bash
curl http://localhost:5060/api/versions
```

You should see your `version` entry, with each file and its `address`.

### 3.4 Delete a version (optional)

If you uploaded the wrong files (or the wrong version name), delete the whole
bundle — every `.bin` file plus `meta.json` — in one call:

```bash
curl -X DELETE http://localhost:5060/api/versions/v1.0.0
```

Expected success response — `200 OK`:

```json
{ "deleted": "v1.0.0" }
```

Verify with `curl http://localhost:5060/api/versions` that the version is
gone. A missing version answers `404` with `{"error": "..."}` — re-upload if
you need it back.

---

## 4. Naming & flash-address convention

esptool-js needs an explicit flash address per file. The server infers it from
the **file name** (case-insensitive prefix match, **first match wins**):

| Filename starts with        | Flash address |
|-----------------------------|---------------|
| `bootloader`                | `0x1000`      |
| `partition`                 | `0x8000`      |
| `ota_data`                  | `0xe000`      |
| `firmware`, `app`, `factory`| `0x10000`     |
| *(anything else)*           | `0x10000` (default) |

### Practical naming for built binaries

- **Name the application image** so it starts with `firmware`, `app`, or
  `factory` (→ `0x10000`). E.g. `firmware-esp32.bin`.
- **Prefer the app image, not the merged image.** When arduino-cli builds with
  custom partitions it emits both `<sketch>.ino.bin` (the app/OTA image) and
  `<sketch>.ino.merged.bin` (a full-flash image). Upload the **app** image
  (`*.ino.bin`, *not* `*.merged.bin`) as the `firmware`/`app` file — the merged
  image is for full-flash workflows and is typically the whole flash size.
- Name the bootloader `bootloader*` and the partition table `partition*` so the
  addresses are inferred correctly.

### Overriding with `meta.json`

To override the address (or add a display label) for a specific file, drop a
`meta.json` into the version directory:

```json
{
  "files": {
    "firmware-esp32.bin": { "address": "0x10000", "label": "Factory app" }
  }
}
```

Upload it to the same version like any other file:

```bash
curl -F version=v1.0.0 \
     -F files=@meta.json \
     http://localhost:5060/api/upload
```

A missing or broken `meta.json` is ignored by the server (it will not take the
API down).

---

## 5. How the human flashes (context)

1. Open the app in a **Chrome/Edge 89+** browser: `http://localhost:5060` or
   `https://flash.local`.
2. Select the **version** you just uploaded.
3. Tick the **files** to flash (their computed addresses are shown in the
   table).
4. Click **Connect & Flash** and pick the ESP32's serial port when prompted.

The flashing runs entirely in the browser over the serial port. The ESP32 must
be connected over USB to the machine running the browser.

---

## 6. Error handling

All errors are JSON: `{"error": "..."}`.

| Status | Meaning | Agent action |
|--------|---------|--------------|
| `400`  | Missing/invalid `version`, no `files`, a filename is neither a `.bin` nor `meta.json`, or an unsafe filename | Fix the `version` name and/or file list; re-send. |
| `404`  | A `DELETE /api/versions/<v>` for a version that does not exist (or was already deleted) | Re-upload the version if it is still needed. |
| `413`  | Total request exceeds the 64 MB limit | Split into smaller uploads (fewer/smaller files). |
| `500`  | Server-side failure (e.g. disk write error) | Check server logs; retry once, then report. |

On success, always confirm `saved[]` contains every file you intended to send —
a `201` with a short `saved[]` list means some files were not where you thought.

---

## 7. References

- `README.md` — full usage, HTTPS/domain setup, storage, security note.
- API spec: https://github.com/L0ria/esp32-webflasher/issues/3 (section 5)
- This issue: https://github.com/L0ria/esp32-webflasher/issues/19
- esptool-js (flashing engine): https://github.com/espressif/esptool-js
- Web Serial API: https://developer.mozilla.org/en-US/docs/Web/API/Serial
- Build skill that produces these binaries: `esp32-arduino-development`
  (arduino-cli workflow).
