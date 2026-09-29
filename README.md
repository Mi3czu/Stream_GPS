# Stream GPS Device Agent

Source-available device-side agent for Stream GPS. It reads GNSS telemetry through ModemManager, uploads it securely to a Stream GPS service, and provides a password-protected local control panel on port `26666`.

Created and maintained by Mieczu.

The hosted server, web application, database, OBS overlay implementation, and deployment configuration are deliberately maintained in a separate private repository. This repository contains only the code needed to install, operate, and update the device agent.

## Features

### Live GPS telemetry

Turn a GNSS-equipped streaming device into a live location source. Stream GPS tracks position, speed, heading, altitude and session distance, then makes them available to your dashboard and OBS overlay.

### Session statistics

Follow the numbers that matter while travelling:

- current, average and maximum speed;
- trip distance and active-session average;
- altitude, direction, accuracy and satellite count;
- estimated incline;
- current locality and local time.

### OBS Overlay Studio

Build a live travel overlay without editing HTML or CSS.

- interactive minimap with current position and recent trail;
- configurable map size, opacity and theme;
- telemetry HUD positioned around the map;
- choose visible statistics, their order, typography and layout;
- live scene preview matching the final OBS Browser Source.

### Destination routing and ETA

Set a destination from chat and show the journey directly on the overlay.

- road route for car, cycling or walking;
- remaining route distance;
- ETA based on the active travel pace;
- automatic rerouting when the stream changes course;
- optional destination, distance and ETA statistic cards.

### Twitch and Kick chat commands

Let viewers interact with the stream through configurable chat commands.

- GPS status and current-location commands;
- destination and ETA commands;
- emergency privacy stop;
- custom command names, aliases, minimum roles and cooldowns;
- shared configuration for connected Twitch and Kick channels.

### Optional Bluetooth sports sensors — beta

Extend the overlay with real-time sports telemetry from Bluetooth LE sensors.

- heart rate;
- cycling cadence;
- cycling power;
- local sensor discovery, saved-device reconnects and independent sensor telemetry.

Bluetooth support is opt-in: devices without Bluetooth hardware continue to run GPS normally.

### Device-first setup

The standalone agent runs independently of BelaUI and is managed from a local web panel. It provides GNSS diagnostics, offline delivery when connectivity drops, secure updates and optional Bluetooth setup.

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
