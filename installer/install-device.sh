#!/bin/sh
set -eu

INSTALL_DIR=/opt/stream-gps-device
CONFIG_DIR=/etc/stream-gps-device
STATE_DIR=/var/lib/stream-gps-device
BACKUP_DIR=/var/backups/stream-gps-device
SERVICE_FILE=/etc/systemd/system/stream-gps-device.service
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../device-agent" 2>/dev/null && pwd || true)
REMOTE_BASE=${STREAM_GPS_INSTALL_BASE:-https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/device-agent}

need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo sh $0"; exit 1; }; }
backup() { mkdir -p "$BACKUP_DIR"; stamp=$(date +%Y%m%d-%H%M%S); [ ! -f "$CONFIG_DIR/config.json" ] || cp -p "$CONFIG_DIR/config.json" "$BACKUP_DIR/config-$stamp.json"; echo "Backup directory: $BACKUP_DIR"; }
copy_or_download() {
  name=$1; destination=$2
  if [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/$name" ]; then cp "$SOURCE_DIR/$name" "$destination"
  else command -v curl >/dev/null || { echo "curl is required"; exit 1; }; curl -fL "$REMOTE_BASE/$name" -o "$destination"; fi
}
uninstall() { systemctl disable --now stream-gps-device 2>/dev/null || true; rm -f "$SERVICE_FILE" /usr/local/bin/stream-gps-device; rm -rf "$INSTALL_DIR"; systemctl daemon-reload; echo "Agent removed. Configuration and queued data were preserved in $CONFIG_DIR and $STATE_DIR."; }

need_root
case "${1:-install}" in
  --status) systemctl --no-pager status stream-gps-device; exit $? ;;
  --test) /opt/stream-gps-device/stream_gps_agent.py test; exit $? ;;
  --backup) backup; exit 0 ;;
  --restore) latest=$(find "$BACKUP_DIR" -name 'config-*.json' -type f 2>/dev/null | sort | tail -n 1); [ -n "$latest" ] || { echo "No backup found"; exit 1; }; cp -p "$latest" "$CONFIG_DIR/config.json"; systemctl restart stream-gps-device; echo "Restored $latest"; exit 0 ;;
  --uninstall) uninstall; exit 0 ;;
  install) ;;
  *) echo "Usage: $0 [install|--status|--test|--backup|--restore|--uninstall]"; exit 2 ;;
esac

command -v python3 >/dev/null || { echo "Installing Python 3..."; apt-get update; apt-get install -y python3; }
command -v mmcli >/dev/null || { echo "Installing ModemManager..."; apt-get update; apt-get install -y modemmanager; }
command -v systemctl >/dev/null || { echo "This installer requires systemd"; exit 1; }

echo "This standalone agent does not modify BelaUI."
printf "Platform base URL (example https://gps.example.com): "; read -r API_URL
printf "DEVICE_ID from the Stream GPS Devices page: "; read -r DEVICE_ID
printf "DEVICE_KEY (input hidden): "; stty -echo; read -r DEVICE_KEY; stty echo; printf '\n'
printf "Password for local configuration panel (minimum 12 characters, input hidden): "; stty -echo; read -r UI_PASSWORD; stty echo; printf '\n'
[ "${#UI_PASSWORD}" -ge 12 ] || { echo "Panel password must contain at least 12 characters"; exit 1; }
[ -n "$API_URL" ] && [ -n "$DEVICE_ID" ] && [ -n "$DEVICE_KEY" ] || { echo "URL, device ID and key are required"; exit 1; }

backup
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"
copy_or_download stream_gps_agent.py "$INSTALL_DIR/stream_gps_agent.py"
copy_or_download stream-gps-device "$INSTALL_DIR/stream-gps-device"
copy_or_download stream-gps-device.service "$SERVICE_FILE"
install -m 755 "$INSTALL_DIR/stream_gps_agent.py" /usr/local/bin/stream-gps-agent
install -m 755 "$INSTALL_DIR/stream-gps-device" /usr/local/bin/stream-gps-device

python3 - "$CONFIG_DIR/config.json" "$API_URL" "$DEVICE_ID" "$DEVICE_KEY" "$UI_PASSWORD" <<'PY'
import base64, hashlib, json, os, sys
path, url, device_id, device_key, password = sys.argv[1:]
salt = os.urandom(16)
config = {'api_url': url.rstrip('/'), 'device_id': device_id, 'device_key': device_key, 'interval_seconds': 2,
          'modem_id': 'auto', 'ui_bind': '0.0.0.0', 'ui_port': 26666,
          'ui_password_salt': base64.b64encode(salt).decode(),
          'ui_password_hash': base64.b64encode(hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 200000)).decode()}
with open(path, 'w', encoding='utf-8') as handle: json.dump(config, handle, indent=2); handle.write('\n')
os.chmod(path, 0o600)
PY
chmod 700 "$CONFIG_DIR" "$STATE_DIR"; chmod 600 "$CONFIG_DIR/config.json"
systemctl daemon-reload; systemctl enable --now stream-gps-device
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Installation complete."
echo "Configuration panel: http://${IP:-BELABOX-IP}:26666"
echo "Login name: admin"
echo "Use the panel password entered during installation."
echo "Run diagnostics: sudo stream-gps-device test"
