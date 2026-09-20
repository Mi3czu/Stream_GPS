#!/bin/sh
set -eu

INSTALL_DIR=/opt/stream-gps-device
CONFIG_DIR=/etc/stream-gps-device
STATE_DIR=/var/lib/stream-gps-device
BACKUP_DIR=/var/backups/stream-gps-device
SERVICE_FILE=/etc/systemd/system/stream-gps-device.service
SOURCE_DIR=$(unset CDPATH; cd -- "$(dirname -- "$0")/../device-agent" 2>/dev/null && pwd || true)
REMOTE_BASE=${STREAM_GPS_INSTALL_BASE:-https://raw.githubusercontent.com/Mi3czu/Stream_GPS/main/device-agent}

need_root() { [ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo sh $0"; exit 1; }; }
backup() {
  mkdir -p "$BACKUP_DIR"; BACKUP_PATH="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BACKUP_PATH"
  [ ! -f "$CONFIG_DIR/config.json" ] || cp -p "$CONFIG_DIR/config.json" "$BACKUP_PATH/config.json"
  [ ! -f "$INSTALL_DIR/stream_gps_agent.py" ] || cp -p "$INSTALL_DIR/stream_gps_agent.py" "$BACKUP_PATH/stream_gps_agent.py"
  [ ! -f "$INSTALL_DIR/stream-gps-device" ] || cp -p "$INSTALL_DIR/stream-gps-device" "$BACKUP_PATH/stream-gps-device"
  [ ! -f "$SERVICE_FILE" ] || cp -p "$SERVICE_FILE" "$BACKUP_PATH/stream-gps-device.service"
  echo "Backup directory: $BACKUP_PATH"
}
restore_path() {
  source_path=$1
  [ -f "$source_path/config.json" ] && cp -p "$source_path/config.json" "$CONFIG_DIR/config.json"
  [ -f "$source_path/stream_gps_agent.py" ] && cp -p "$source_path/stream_gps_agent.py" "$INSTALL_DIR/stream_gps_agent.py"
  [ -f "$source_path/stream-gps-device" ] && cp -p "$source_path/stream-gps-device" "$INSTALL_DIR/stream-gps-device"
  [ -f "$source_path/stream-gps-device.service" ] && cp -p "$source_path/stream-gps-device.service" "$SERVICE_FILE"
}
copy_or_download() {
  name=$1; destination=$2
  if [ -n "$SOURCE_DIR" ] && [ -f "$SOURCE_DIR/$name" ]; then cp "$SOURCE_DIR/$name" "$destination"
  else command -v curl >/dev/null || { echo "curl is required"; exit 1; }; curl -fL "$REMOTE_BASE/$name" -o "$destination"; fi
}
uninstall() { systemctl disable --now stream-gps-device 2>/dev/null || true; rm -f "$SERVICE_FILE" /usr/local/bin/stream-gps-device /usr/local/bin/stream-gps-agent; rm -rf "$INSTALL_DIR"; systemctl daemon-reload; echo "Agent removed. Configuration and queued data were preserved in $CONFIG_DIR and $STATE_DIR."; }

dry_run() {
  echo "Stream GPS Device installation preflight (no changes will be made)"
  for command in python3 mmcli systemctl curl sha256sum; do
    if command -v "$command" >/dev/null 2>&1; then echo "[OK] $command"; else echo "[MISSING] $command"; fi
  done
  if command -v mmcli >/dev/null 2>&1 && mmcli -L 2>/dev/null | grep -q '/Modem/'; then echo "[OK] Modem detected"; else echo "[WARN] No modem detected"; fi
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':26666 '; then echo "[WARN] Port 26666 is already listening"; else echo "[OK] Port 26666 is available"; fi
  if command -v curl >/dev/null 2>&1 && curl -fsI "$REMOTE_BASE/stream_gps_agent.py" >/dev/null; then echo "[OK] Release files are reachable"; else echo "[WARN] Release files could not be checked"; fi
}

case "${1:-install}" in
  --dry-run) dry_run; exit 0 ;;
esac
need_root
case "${1:-install}" in
  --status) systemctl --no-pager status stream-gps-device; exit $? ;;
  --test) /opt/stream-gps-device/stream_gps_agent.py test; exit $? ;;
  --backup) backup; exit 0 ;;
  --restore) latest=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -n 1); [ -n "$latest" ] || { echo "No backup found"; exit 1; }; restore_path "$latest"; systemctl daemon-reload; systemctl restart stream-gps-device; echo "Restored $latest"; exit 0 ;;
  --uninstall) uninstall; exit 0 ;;
  install) ;;
  *) echo "Usage: $0 [install|--dry-run|--status|--test|--backup|--restore|--uninstall]"; exit 2 ;;
esac

command -v python3 >/dev/null || { echo "Installing Python 3..."; apt-get update; apt-get install -y python3; }
command -v mmcli >/dev/null || { echo "Installing ModemManager..."; apt-get update; apt-get install -y modemmanager; }
command -v systemctl >/dev/null || { echo "This installer requires systemd"; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required"; exit 1; }
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ':26666 ' && ! systemctl is-active --quiet stream-gps-device; then
  echo "Port 26666 is already used by another service. Installation stopped."; exit 1
fi

echo "This standalone agent does not modify BelaUI."
printf "Platform base URL (example https://gps.example.com): "; read -r API_URL
printf "DEVICE_ID from the Stream GPS Devices page: "; read -r DEVICE_ID
printf "DEVICE_KEY (input hidden): "; stty -echo; read -r DEVICE_KEY; stty echo; printf '\n'
printf "Password for local configuration panel (minimum 12 characters, input hidden): "; stty -echo; read -r UI_PASSWORD; stty echo; printf '\n'
[ "${#UI_PASSWORD}" -ge 12 ] || { echo "Panel password must contain at least 12 characters"; exit 1; }
[ -n "$API_URL" ] && [ -n "$DEVICE_ID" ] && [ -n "$DEVICE_KEY" ] || { echo "URL, device ID and key are required"; exit 1; }
case "$API_URL" in http://*|https://*) ;; *) echo "Platform URL must begin with http:// or https://"; exit 1 ;; esac

backup
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$STATE_DIR"
copy_or_download stream_gps_agent.py "$INSTALL_DIR/stream_gps_agent.py"
copy_or_download stream-gps-device "$INSTALL_DIR/stream-gps-device"
copy_or_download stream-gps-device.service "$INSTALL_DIR/stream-gps-device.service"
copy_or_download VERSION "$INSTALL_DIR/VERSION"
copy_or_download checksums.sha256 "$INSTALL_DIR/checksums.sha256"
(cd "$INSTALL_DIR" && sha256sum -c checksums.sha256)
install -m 644 "$INSTALL_DIR/stream-gps-device.service" "$SERVICE_FILE"
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
systemctl daemon-reload
if ! systemctl enable --now stream-gps-device; then
  echo "Service failed to start. Restoring the backup."
  restore_path "$BACKUP_PATH"; systemctl daemon-reload; systemctl restart stream-gps-device 2>/dev/null || true; exit 1
fi
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Installation complete."
echo "Agent version: $(cat "$INSTALL_DIR/VERSION")"
echo "Configuration panel: http://${IP:-BELABOX-IP}:26666"
echo "Login name: admin"
echo "Use the panel password entered during installation."
echo "Run diagnostics: sudo stream-gps-device test"
