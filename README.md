# Stream GPS Device Agent

Source-available device-side agent for Stream GPS. It reads GNSS telemetry through ModemManager, uploads it securely to a Stream GPS service, and provides a password-protected local control panel on port `26666`.

Created and maintained by Mieczu.

The hosted server, web application, database, OBS overlay implementation, and deployment configuration are deliberately maintained in a separate private repository. This repository contains only the code needed to install, operate, and update the device agent.

## What it provides

- Standalone systemd service; it does not modify BelaUI or other device software.
- GNSS via ModemManager, local diagnostics, offline queue, privacy-focused position filtering and A-GPS controls.
- Optional Bluetooth LE heart-rate, cadence, and power sensors.
- A local administration panel at `http://DEVICE-IP:26666`.

## Install on a device

The device needs a compatible GNSS modem, `systemd`, Internet access to your Stream GPS service, and a device ID/key created in that service.

```sh
curl -fsSL https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/installer/install-device.sh -o /tmp/install-stream-gps-device.sh && sudo sh /tmp/install-stream-gps-device.sh
```

For the full installation and modem preparation guide, see [BELABOX / standalone installation](docs/belabox-standalone-installation.md). Bluetooth setup is optional and described in [Bluetooth sensors](docs/bluetooth-sensors.md).

## Security

Keep device keys and local-panel passwords private. Do not expose port `26666` directly to the Internet; use a trusted LAN or an SSH tunnel.

## Server access

To use this agent, create or obtain access to a Stream GPS service. The server-side source and deployment are not distributed in this repository.
