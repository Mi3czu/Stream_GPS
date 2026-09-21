#!/usr/bin/env bash
set -euo pipefail

# Intentionally requires an explicit file and a typed confirmation. Restore
# only after creating and verifying a fresh backup of the current database.
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 /absolute/path/to/stream-gps-YYYYMMDD-HHMMSS.dump" >&2
  exit 64
fi

read -r -p "This replaces the current Stream GPS database. Type RESTORE to continue: " confirmation
[[ "$confirmation" == "RESTORE" ]] || { echo "Cancelled."; exit 1; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
docker compose -f "$PROJECT_DIR/compose.yaml" exec -T postgres \
  pg_restore -U stream_gps -d stream_gps --clean --if-exists --no-owner < "$1"
echo "Restore completed. Run docker compose -f $PROJECT_DIR/compose.yaml restart backend to refresh live caches."
