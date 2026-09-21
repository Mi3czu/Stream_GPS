#!/usr/bin/env bash
set -euo pipefail

# Run from the Docker host. Keeps a compressed PostgreSQL dump and removes
# backups older than the requested retention period (default: 21 days).
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-21}"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL_FILE="$BACKUP_DIR/stream-gps-$TIMESTAMP.dump"
TEMP_FILE="$FINAL_FILE.partial"

mkdir -p "$BACKUP_DIR"
trap 'rm -f "$TEMP_FILE"' EXIT

docker compose -f "$PROJECT_DIR/compose.yaml" exec -T postgres \
  pg_dump -U stream_gps -d stream_gps --format=custom > "$TEMP_FILE"

test -s "$TEMP_FILE"
mv "$TEMP_FILE" "$FINAL_FILE"
find "$BACKUP_DIR" -type f -name 'stream-gps-*.dump' -mtime "+$RETENTION_DAYS" -delete
trap - EXIT
printf 'Backup created: %s\n' "$FINAL_FILE"
