# esp32-webflasher

A web-based flasher for ESP32 devices.

> This README is a placeholder for now.

## Running with Docker

Pre-create the host binaries directory first (otherwise Docker creates it root-owned):

```bash
mkdir -p /srv/binaries
docker compose up --build
```

The app listens on port 5060; the Caddy `https-proxy` service serves it over
HTTPS (self-signed via Caddy's internal CA — see `Caddyfile`).
