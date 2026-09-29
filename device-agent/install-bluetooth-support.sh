#!/bin/sh
# Optional dependencies for Stream GPS Bluetooth sensor support.
set -eu

[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y bluez python3-pip rfkill
if /usr/bin/python3 -c 'import bleak' 2>/dev/null; then
  echo "Python package bleak is already installed."
else
  /usr/bin/python3 -m pip install --break-system-packages bleak
fi
systemctl enable --now bluetooth.service
echo "Bluetooth support installed. Return to Stream GPS Device and enable Bluetooth sensors."
