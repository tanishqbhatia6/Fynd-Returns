#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

if [[ "${CONFIRM_RESTORE:-}" != "returnpromax" ]]; then
  echo "Refusing destructive restore. Set CONFIRM_RESTORE=returnpromax to continue." >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: CONFIRM_RESTORE=returnpromax $0 /path/to/returnpromax-backup.dump" >&2
  exit 1
fi

backup_file="$1"

if [[ ! -f "$backup_file" ]]; then
  echo "Backup file not found: $backup_file" >&2
  exit 1
fi

verify_checksum() {
  local checksum_file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum --check "$checksum_file"
  else
    shasum -a 256 --check "$checksum_file"
  fi
}

if [[ -f "${backup_file}.sha256" ]]; then
  verify_checksum "${backup_file}.sha256"
elif [[ "${SKIP_BACKUP_CHECKSUM:-}" != "true" ]]; then
  echo "Missing checksum file: ${backup_file}.sha256" >&2
  echo "Set SKIP_BACKUP_CHECKSUM=true only for an emergency restore with separately verified integrity." >&2
  exit 1
fi

pg_restore "$backup_file" \
  --dbname="$DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl
