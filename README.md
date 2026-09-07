# esp32-webflasher

Flash ESP32 / Espressif firmware **directly from the browser** using the
[Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Serial) and
[esptool-js](https://github.com/espressif/esptool-js).

Upload firmware binaries to a web server, pick a version in the web UI, and
flash it to a connected ESP32 with one click — no desktop tools, no command
line.

## How it works

Upload your firmware binaries to the server, open the web app, select a
version and the files to flash, and click **Connect & Flash** — the flashing
runs entirely in your browser over the serial port.

> The ESP32 must be connected over USB to the machine running the browser —
> Web Serial talks to the local serial port.

## Prerequisites

- **Docker** with the **docker compose** plugin.
- A **browser with Web Serial** support — **Chrome or Edge 89+** (see
  [Browser requirements](#browser-requirements)).

## Run

```bash
docker compose up --build
```

That's it. No host directory is required: firmware binaries are stored in a
Docker **named volume** (`binaries`), and the Caddyfile is **baked into the
Caddy image** at build time. So the stack starts cleanly in any Docker
environment (including a Docker daemon running in a container / DinD).

This starts the app on port **5060** and the HTTPS proxy on **443**. Open
either of the following in your browser:

- App (HTTP): <http://localhost:5060> — `localhost` is a secure context, so
  Web Serial works here.
- App (HTTPS): <https://flash.local> — served with a **self-signed certificate**
  (see [HTTPS / domain setup](#https-domain-setup)).

Then upload a version (below), select it, and click **Connect & Flash**.

## Uploading firmware

Upload one or more `.bin` files into a version directory:

```bash
curl -F version=v1.0.0 \
     -F files=@bootloader-esp32.bin \
     -F files=@partition-table-esp32.bin \
     -F files=@firmware-esp32.bin \
     http://localhost:5060/api/upload
```

- `version` — the version name (a directory under `/srv/binaries/`). Must
  start with a letter or digit, then letters/digits/`.`/`_`/`-`, 1–64 chars.
- `files` — repeat the field for multiple files. Only `.bin` files are
  accepted.
- Uploads **overwrite** same-named files.
- Total request size is capped at **64 MB**.
- Response `201`:
  `{"version": "v1.0.0", "saved": [{"name": "firmware-esp32.bin", "size": 1234567}]}`.

List the uploaded versions and their computed flash addresses:

```bash
curl http://localhost:5060/api/versions
```

## Browser requirements

- **Web Serial** is required and is only available in a **secure context**
  (`https://…` or `http://localhost`).
- Supported: **Chrome / Edge 89+** (desktop and Android; on Android via the
  Web Serial polyfill).
- **Not supported: Firefox, Safari.**

## Flash address convention

esptool-js needs an explicit flash address per file. The server infers it from
the **file name** (case-insensitive prefix match, first match wins):

| Filename starts with        | Flash address |
|-----------------------------|---------------|
| `bootloader`                | `0x0`         |
| `partition`                 | `0x8000`      |
| `ota_data`                  | `0x0`         |
| `firmware`, `app`, `factory`| `0x10000`     |
| *(anything else, e.g. `custom.bin`)* | `0x10000` (default) |

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

Upload it to a version like any other file:

```bash
curl -F version=v1.0.0 \
     -F files=@meta.json \
     http://localhost:5060/api/upload
```

## HTTPS / domain setup

Web Serial requires a secure context, so the compose file runs an HTTPS proxy
in front of the app. Out of the box, Caddy serves the site under the hostname
**`flash.local`** using a **self-signed certificate** (Caddy's internal CA):

```
flash.local {
    tls internal
    reverse_proxy webflasher:5060
}
```

Point the browser at `https://flash.local/` after adding an `/etc/hosts` entry
mapping `flash.local` to this machine's IP. The certificate is self-signed, so
the browser will show a warning until the Caddy internal CA is trusted.

> Why a hostname and not a bare `:443`? With Caddy's internal (self-signed)
> CA, a bare port address fails the TLS handshake when the client connects by
> IP (there is no SNI hostname for the certificate to match). A hostname makes
> the self-signed setup actually serve. See issue #17.

The Caddyfile is **baked into the Caddy image** at build time (not bind-mounted
from the host), so after editing `Caddyfile`, rebuild to pick up the change:

```bash
docker compose up --build
```

### Switching to a real domain + Let's Encrypt later

1. Point a DNS `A`/`AAAA` record (e.g. `flash.example.com`) at the host.
2. Make sure ports **80** and **443** are reachable from the internet (needed
   for Let's Encrypt ACME).
3. Edit the `Caddyfile` to serve the domain:
   ```
   flash.example.com {
       reverse_proxy webflasher:5060
   }
   ```
   The certificate is obtained and renewed automatically — no `tls internal`
   needed.
4. Rebuild: `docker compose up --build` (the Caddyfile is baked into the
   image).

## Storage

Uploaded firmware binaries are written to the `binaries` named volume
(container path `/srv/binaries`). To inspect them on the host:

```bash
docker volume inspect esp32-webflasher_binaries
```

## Security note

The **upload endpoint is intentionally unauthenticated** — this is a local
tool for binary testing, and anyone who can reach the service can upload or
overwrite binaries.

## esptool-js license

The flashing engine is [esptool-js](https://github.com/espressif/esptool-js)
**0.6.1**, licensed under **Apache-2.0**. The prebuilt browser bundle is
**vendored** — copied from the pinned npm tarball at Docker build time into
`static/vendor/esptool-js.bundle.js` — so there is no runtime CDN dependency.

## Repository layout

```
├── app.py                          # Flask API server
├── requirements.txt                # flask (pinned)
├── static/
│   ├── index.html                  # single-page app
│   ├── app.js                      # UI logic + esptool-js integration
│   ├── style.css
│   └── vendor/
│       └── esptool-js.bundle.js    # copied from the npm tarball at build time
├── Dockerfile
├── docker-compose.yaml
└── Caddyfile
```

## References

- Planning issue / full spec: https://github.com/L0ria/esp32-webflasher/issues/3
- esptool-js: https://github.com/espressif/esptool-js
- Web Serial API: https://developer.mozilla.org/en-US/docs/Web/API/Serial
- Caddy automatic HTTPS: https://caddyserver.com/docs/autoshttps
