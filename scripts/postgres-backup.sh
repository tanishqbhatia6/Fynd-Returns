#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_dir="${BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="${backup_dir}/returnpromax-${timestamp}.dump"

write_checksum() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" > "${file}.sha256"
  else
    shasum -a 256 "$file" > "${file}.sha256"
  fi
}

upload_to_s3() {
  local file="$1"
  if [[ -z "${BACKUP_BUCKET:-}" ]]; then
    return 0
  fi
  if ! command -v aws >/dev/null 2>&1; then
    echo "aws CLI is required when BACKUP_BUCKET is set" >&2
    exit 1
  fi

  local sse="${BACKUP_S3_SSE:-AES256}"
  local sse_args=()
  if [[ "$sse" != "NONE" ]]; then
    sse_args+=(--sse "$sse")
    if [[ "$sse" == "aws:kms" && -n "${BACKUP_S3_KMS_KEY_ID:-}" ]]; then
      sse_args+=(--sse-kms-key-id "$BACKUP_S3_KMS_KEY_ID")
    fi
  fi

  aws s3 cp "$file" "s3://${BACKUP_BUCKET}/postgres/${file##*/}" "${sse_args[@]}"
  aws s3 cp "${file}.sha256" "s3://${BACKUP_BUCKET}/postgres/${file##*/}.sha256" "${sse_args[@]}"
}

pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$output"

write_checksum "$output"
upload_to_s3 "$output"
echo "$output"
