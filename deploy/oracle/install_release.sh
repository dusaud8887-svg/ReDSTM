#!/usr/bin/env bash
set -Eeuo pipefail

UV_VERSION=0.11.28
UV_X86_64_SHA256=e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224
UV_AARCH64_SHA256=03e9fe0a81b0718d0bc84625de3885df6cc3f89a8b6af6121d6b9f6113fb6533
RCLONE_MIN_VERSION=1.74.3
RCLONE_AMD64_SHA256=408cde598307dedc26b7108553cb2147a8d2d12853100447e802f47454582ecc
RCLONE_ARM64_SHA256=f3216d5a73fe11e2604cc204b91502757b37c23e9ea47e14b7c0caf727f47343
RELEASES=/opt/redstm/releases
CURRENT=/opt/redstm/current
PREVIOUS=/opt/redstm/previous
CANONICAL_TRANSFER=/srv/redstm/canonical/archive.sqlite.transfer.partial
CANONICAL_STAGING=/srv/redstm/canonical/archive.sqlite.partial
CANONICAL_TARGET=/srv/redstm/canonical/archive.sqlite
COMPLETE=/opt/redstm/current-release.complete
CANONICAL_MIGRATION_FREE_MARGIN_BYTES=5368709120
INSTALL_ARCHIVE=""
INSTALLER_UPLOAD=""
INSTALL_ACTIVE=0
INSTALL_MUTATED=0
INSTALL_BRIDGE=0
MAINTENANCE_MARKER="/srv/redstm/state/maintenance"
MAINTENANCE_ACTIVE=0

cleanup_maintenance() {
  if (( MAINTENANCE_ACTIVE == 1 )); then
    rm -f -- "$MAINTENANCE_MARKER" "${MAINTENANCE_MARKER}.partial" || true
    MAINTENANCE_ACTIVE=0
  fi
}

begin_maintenance() {
  [[ "$1" =~ ^[a-z0-9-]{1,64}$ ]] || fail "invalid maintenance reason"
  MAINTENANCE_ACTIVE=1
  printf '%s\n' "$1" > "${MAINTENANCE_MARKER}.partial"
  chown redstm:redstm "${MAINTENANCE_MARKER}.partial"
  chmod 0600 "${MAINTENANCE_MARKER}.partial"
  mv -Tf -- "${MAINTENANCE_MARKER}.partial" "$MAINTENANCE_MARKER"
}

handle_error() {
  local code=$?
  if (( INSTALL_ACTIVE == 1 && INSTALL_MUTATED == 0 )); then
    fail_not_started "install failed before current release mutation"
  fi
  if (( code == 75 )); then
    exit 1
  fi
  exit "$code"
}

trap handle_error ERR
trap cleanup_maintenance EXIT

fail() {
  if (( INSTALL_ACTIVE == 1 && INSTALL_MUTATED == 0 )); then
    fail_not_started "$1"
  fi
  printf '%s\n' "$1" >&2
  exit 1
}

fail_not_started() {
  trap - ERR
  printf 'redstm_install_not_started\n%s\n' "$1" >&2
  exit 75
}

acquire_release_lock() {
  exec 9>/run/lock/redstm-release.lock
  if ! flock --nonblock 9; then
    fail_not_started "another release operation is running"
  fi
}

acquire_runner_lock() {
  local lock=/srv/redstm/state/control.lock
  if [[ ! -d /srv/redstm/state ]]; then
    [[ ! -e "$CURRENT" && ! -L "$CURRENT" ]] || \
      fail_not_started "runner state directory is unavailable"
    return
  fi
  if [[ ! -e "$lock" ]]; then
    sudo -u redstm touch -- "$lock"
    chmod 0600 "$lock"
  fi
  exec 8<>"$lock"
  if ! flock --nonblock 8; then
    fail_not_started "crawler or control runner is active"
  fi
}

acquire_archive_locks() {
  local cycle_lock="${CANONICAL_TARGET}.cycle.lock"
  local sync_lock="${CANONICAL_TARGET}.sync.lock"
  sudo -u redstm touch -- "$cycle_lock" "$sync_lock"
  exec 7<>"$cycle_lock"
  flock --nonblock 7 || fail_not_started "canonical cycle is active"
  exec 6<>"$sync_lock"
  flock --nonblock 6 || fail_not_started "canonical sync is active"
}

release_is_complete() {
  local completed=""
  [[ -f "$COMPLETE" ]] || return 1
  IFS= read -r completed < "$COMPLETE" || return 1
  [[ "$completed" == "$1" ]]
}

release_attempt_matches() {
  local state="" release="" nonce="" extra=""
  [[ -f "$COMPLETE" ]] || return 1
  IFS= read -r state release nonce extra < "$COMPLETE" || return 1
  [[ "$state" == "attempt" && "$release" == "$1" && "$nonce" == "$2" && -z "$extra" ]]
}

mark_release_attempt() {
  printf 'attempt %s %s\n' "$1" "$2" > "${COMPLETE}.new"
  chown root:root "${COMPLETE}.new"
  chmod 0644 "${COMPLETE}.new"
  mv -Tf -- "${COMPLETE}.new" "$COMPLETE"
}

mark_release_complete() {
  printf '%s\n' "$1" > "${COMPLETE}.new"
  chown root:root "${COMPLETE}.new"
  chmod 0644 "${COMPLETE}.new"
  mv -Tf -- "${COMPLETE}.new" "$COMPLETE"
}

cleanup_install_uploads() {
  if [[ -n "$INSTALL_ARCHIVE" && -n "$INSTALLER_UPLOAD" ]]; then
    rm -f -- "$INSTALL_ARCHIVE" "$INSTALLER_UPLOAD" || true
  fi
}

validate_release() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "invalid release identity"
}

install_uv() {
  if [[ -x /usr/local/bin/uv && -x /usr/local/bin/uvx ]]; then
    local current_version
    current_version="$(/usr/local/bin/uv --version)"
    if [[ "$current_version" == "uv ${UV_VERSION}" || \
      "$current_version" == "uv ${UV_VERSION} "* ]]; then
      return
    fi
  fi
  local machine target asset pinned_hash temporary archive checksum expected_hash expected_name extra
  machine="$(uname -m)"
  case "$machine" in
    x86_64) target=x86_64-unknown-linux-gnu; pinned_hash="$UV_X86_64_SHA256" ;;
    aarch64|arm64) target=aarch64-unknown-linux-gnu; pinned_hash="$UV_AARCH64_SHA256" ;;
    *) fail "unsupported uv architecture: ${machine}" ;;
  esac
  asset="uv-${target}.tar.gz"
  temporary="$(mktemp -d /tmp/redstm-uv.XXXXXX)"
  archive="${temporary}/${asset}"
  checksum="${archive}.sha256"
  (
    trap 'rm -rf -- "$temporary"' EXIT
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}" \
      --output "$archive"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}.sha256" \
      --output "$checksum"
    read -r expected_hash expected_name extra < "$checksum" || fail "uv checksum is invalid"
    [[ "$expected_hash" == "$pinned_hash" && "$expected_name" == "$asset" && \
      -z "$extra" ]] || fail "uv checksum is invalid"
    (cd "$temporary" && sha256sum --check --strict --status "${asset}.sha256")
    tar --extract --gzip --file "$archive" --directory "$temporary" --no-same-owner
    [[ -f "${temporary}/uv-${target}/uv" && -f "${temporary}/uv-${target}/uvx" ]] || \
      fail "uv archive is invalid"
    install -o root -g root -m 0755 "${temporary}/uv-${target}/uv" /usr/local/bin/uv
    install -o root -g root -m 0755 "${temporary}/uv-${target}/uvx" /usr/local/bin/uvx
  )
  local installed_version
  installed_version="$(/usr/local/bin/uv --version)"
  [[ "$installed_version" == "uv ${UV_VERSION}" || \
    "$installed_version" == "uv ${UV_VERSION} "* ]] || fail "uv version mismatch"
  [[ -x /usr/local/bin/uvx ]] || fail "uvx installation failed"
}

rclone_version() {
  local output version
  command -v rclone >/dev/null 2>&1 || return 1
  output="$(rclone version 2>/dev/null)" || return 1
  version="${output%%$'\n'*}"
  [[ "$version" =~ ^rclone\ v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

rclone_supported() {
  local installed
  installed="$(rclone_version)" || return 1
  [[ "$(printf '%s\n%s\n' "$RCLONE_MIN_VERSION" "$installed" | sort -V | head -n1)" == \
    "$RCLONE_MIN_VERSION" ]]
}

install_rclone() {
  local machine architecture pinned_hash temporary package
  if rclone_supported; then
    return
  fi
  machine="$(uname -m)"
  case "$machine" in
    x86_64) architecture=amd64; pinned_hash="$RCLONE_AMD64_SHA256" ;;
    aarch64|arm64) architecture=arm64; pinned_hash="$RCLONE_ARM64_SHA256" ;;
    *) fail "unsupported rclone architecture: ${machine}" ;;
  esac
  temporary="$(mktemp -d /tmp/redstm-rclone.XXXXXX)"
  (
    trap 'rm -rf -- "$temporary"' EXIT
    chown root:root "$temporary"
    chmod 0700 "$temporary"
    package="${temporary}/rclone-v${RCLONE_MIN_VERSION}-linux-${architecture}.deb"
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
      --fail --silent --show-error --location \
      "https://downloads.rclone.org/v${RCLONE_MIN_VERSION}/rclone-v${RCLONE_MIN_VERSION}-linux-${architecture}.deb" \
      --output "$package"
    [[ "$(sha256sum "$package" | cut -d' ' -f1)" == "$pinned_hash" ]] || \
      fail "rclone package hash mismatch"
    dpkg --install "$package" >/dev/null
  )
  rclone_supported || fail "rclone version mismatch"
}

release_json() {
  local resolved
  resolved="$(readlink -f "$1" 2>/dev/null || true)"
  if [[ "$resolved" =~ ^${RELEASES}/([0-9a-f]{40})$ && -d "$resolved" ]]; then
    printf '"%s"' "${BASH_REMATCH[1]}"
  else
    printf 'null'
  fi
}

systemd_flag() {
  if systemctl "$1" --quiet "$2" >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

release_status() {
  [[ $# -eq 0 ]] || fail "status takes no arguments"
  local path name releases_count=0 canonical_previous_count=0
  local root_free_bytes rclone_available=false rclone_json=null version
  for path in "$RELEASES"/*; do
    [[ -d "$path" ]] || continue
    name="${path##*/}"
    if [[ "$name" =~ ^[0-9a-f]{40}$ ]]; then
      ((releases_count += 1))
    fi
  done
  for path in /srv/redstm/canonical/archive.previous-*.sqlite; do
    [[ -f "$path" ]] || continue
    ((canonical_previous_count += 1))
  done
  root_free_bytes="$(df -B1 --output=avail / | awk 'NR == 2 {print $1}')"
  [[ "$root_free_bytes" =~ ^[0-9]+$ ]] || fail "root free space is invalid"
  if version="$(rclone_version)"; then
    rclone_available=true
    rclone_json="\"${version}\""
  fi
  printf '{"canonical_previous_count":%s,"control_timer":{"active":%s,"enabled":%s},' \
    "$canonical_previous_count" "$(systemd_flag is-active redstm-control.timer)" \
    "$(systemd_flag is-enabled redstm-control.timer)"
  printf '"current_release":%s,"previous_release":%s,' \
    "$(release_json "$CURRENT")" "$(release_json "$PREVIOUS")"
  printf '"rclone":{"available":%s,"version":%s},"releases_count":%s,' \
    "$rclone_available" "$rclone_json" "$releases_count"
  printf '"root_free_bytes":%s,"schedule_timer":{"active":%s,"enabled":%s}}\n' \
    "$root_free_bytes" "$(systemd_flag is-active redstm-schedule.timer)" \
    "$(systemd_flag is-enabled redstm-schedule.timer)"
}

bridge_install_guard() {
  [[ $# -eq 1 ]] || fail "bridge guard requires a release path"
  local target="$1"
  [[ -f "$CANONICAL_TARGET" && ! -L "$CANONICAL_TARGET" ]] || \
    fail_not_started "canonical archive is unavailable"
  if systemctl is-active --quiet redstm-schedule.timer || \
     systemctl is-enabled --quiet redstm-schedule.timer; then
    fail_not_started "automatic schedule must be disabled before bridge install"
  fi
  sudo -u redstm env PYTHONPATH="$target" "$target/.venv/bin/python" \
    - "$CANONICAL_TARGET" <<'PY'
import sys
from pathlib import Path

from crawler.archive import RUNTIME_SCHEMA_POLICY, SCHEMA_VERSION
from scripts.migrate_archive import migration_source_version

if RUNTIME_SCHEMA_POLICY != "explicit-v1":
    raise SystemExit("bridge release runtime schema policy is invalid")
source_version = migration_source_version(Path(sys.argv[1]))
if source_version >= SCHEMA_VERSION:
    raise SystemExit("canonical bridge is not required")
PY
}

install_release() {
  [[ $# -eq 4 ]] || fail "install requires release, archive, hash, and expected current"
  local release="$1" archive="$2" expected="$3" expected_current="$4"
  local target="${RELEASES}/${release}" staging="${RELEASES}/${release}.partial"
  local old="" previous="" nonce=""
  validate_release "$release"
  if [[ "$expected_current" != "none" ]]; then
    validate_release "$expected_current"
  fi
  if [[ "$archive" =~ ^/tmp/redstm-release-${release}-([0-9a-f]{32})\.tar\.gz\.partial$ ]]; then
    nonce="${BASH_REMATCH[1]}"
  else
    fail "invalid archive path"
  fi
  [[ "$0" == "/tmp/redstm-install-release-${release}-${nonce}.sh.partial" ]] || \
    fail "invalid installer path"
  INSTALL_ARCHIVE="$archive"
  INSTALLER_UPLOAD="$0"
  trap 'cleanup_install_uploads; cleanup_maintenance' EXIT
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "invalid archive hash"
  [[ -f "$archive" ]] || fail "release archive is missing"
  [[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$expected" ]] || fail "archive hash mismatch"
  old="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  if [[ "$old" == "$target" ]]; then
    if (( INSTALL_BRIDGE == 0 )) && release_is_complete "$release" && \
      [[ "$expected_current" != "$release" ]]; then
      printf 'release=%s\n' "$release"
      return
    fi
    if [[ "$expected_current" == "none" ]]; then
      [[ -z "$previous" ]] || \
        fail_not_started "previous release changed before partial reconciliation"
    elif [[ "$expected_current" != "$release" ]]; then
      [[ "$previous" == "${RELEASES}/${expected_current}" ]] || \
        fail_not_started "previous release changed before partial reconciliation"
    fi
  else
    if [[ "$expected_current" == "none" ]]; then
      [[ -z "$old" ]] || fail_not_started "current release changed"
    else
      [[ "$old" == "${RELEASES}/${expected_current}" && -d "$old" ]] || \
        fail_not_started "current release changed"
    fi
  fi

  acquire_runner_lock
  INSTALL_MUTATED=1
  if ! id redstm >/dev/null 2>&1; then
    useradd --system --home-dir /srv/redstm/home --create-home --shell /usr/sbin/nologin redstm
  fi
  install -d -o root -g root -m 0755 /opt/redstm "$RELEASES"
  install -d -o redstm -g redstm -m 0750 \
    /srv/redstm/home /srv/redstm/canonical /srv/redstm/private /srv/redstm/reports \
    /srv/redstm/snapshots /srv/redstm/static /srv/redstm/state /srv/redstm/cache
  install -d -o redstm -g redstm -m 0700 /srv/redstm/warc
  install -d -o root -g redstm -m 0750 /etc/redstm
  install -o root -g root -m 0755 "$0" /opt/redstm/install_release.sh
  install_uv
  install_rclone
  sudo -u redstm env HOME=/srv/redstm/home UV_CACHE_DIR=/srv/redstm/cache UV_NO_CONFIG=1 \
    /usr/local/bin/uv python install 3.14

  if [[ ! -d "$target" ]]; then
    if [[ -e "$staging" ]]; then
      rm -rf -- "$staging"
    fi
    install -d -o redstm -g redstm -m 0750 "$staging"
    tar --extract --gzip --file "$archive" --directory "$staging" --no-same-owner
    chown -R redstm:redstm "$staging"
    sudo -u redstm env HOME=/srv/redstm/home UV_CACHE_DIR=/srv/redstm/cache UV_NO_CONFIG=1 \
      /usr/local/bin/uv sync --frozen --no-dev --managed-python --directory "$staging"
    sudo -u redstm env PYTHONPATH="$staging" "$staging/.venv/bin/python" -c \
      'import crawler.archive, scripts.control_runner'
    mv -- "$staging" "$target"
  fi

  if (( INSTALL_BRIDGE == 1 )); then
    acquire_archive_locks
    bridge_install_guard "$target"
  fi

  mark_release_attempt "$release" "$nonce"
  if [[ "$old" != "$target" ]]; then
    ln -sfn -- "$target" "${CURRENT}.new"
    mv -Tf -- "${CURRENT}.new" "$CURRENT"
    if [[ -n "$old" ]]; then
      ln -sfn -- "$old" "${PREVIOUS}.new"
      mv -Tf -- "${PREVIOUS}.new" "$PREVIOUS"
    fi
  fi
  printf 'REDSTM_RUNNER_VERSION=%s\n' "$release" > /etc/redstm/runtime.env.new
  chown root:redstm /etc/redstm/runtime.env.new
  chmod 0640 /etc/redstm/runtime.env.new
  mv -Tf -- /etc/redstm/runtime.env.new /etc/redstm/runtime.env
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.service" /etc/systemd/system/redstm-control.service
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.timer" /etc/systemd/system/redstm-control.timer
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-schedule.service" /etc/systemd/system/redstm-schedule.service
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-schedule.timer" /etc/systemd/system/redstm-schedule.timer
  install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-journald.conf" /etc/systemd/journald.conf.d/redstm.conf
  systemd-analyze verify /etc/systemd/system/redstm-control.service \
    /etc/systemd/system/redstm-control.timer \
    /etc/systemd/system/redstm-schedule.service \
    /etc/systemd/system/redstm-schedule.timer
  systemctl daemon-reload
  systemd-analyze cat-config systemd/journald.conf >/dev/null
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" -c \
    'import scripts.control_runner'
  rclone_supported || fail "rclone version is unsupported"
  systemctl enable --now redstm-control.timer
  mark_release_complete "$release"
  INSTALL_MUTATED=0
  INSTALL_ACTIVE=0
  printf 'release=%s\n' "$release"
}

canonical_transfer_size() {
  [[ $# -eq 0 ]] || fail "canonical-transfer-size takes no arguments"
  if [[ -f "$CANONICAL_TRANSFER" ]]; then
    stat -c '%s' "$CANONICAL_TRANSFER"
  elif [[ -f "$CANONICAL_STAGING" ]]; then
    stat -c '%s' "$CANONICAL_STAGING"
  else
    printf '0\n'
  fi
}

truncate_canonical_transfer() {
  [[ $# -eq 1 ]] || fail "truncate-canonical-transfer requires bytes"
  local expected_bytes="$1" current_bytes
  [[ "$expected_bytes" =~ ^[0-9]+$ ]] || fail "invalid canonical truncate size"
  [[ -f "$CANONICAL_TRANSFER" ]] || fail "canonical transfer is missing"
  current_bytes="$(stat -c '%s' "$CANONICAL_TRANSFER")"
  (( expected_bytes <= current_bytes )) || fail "canonical truncate size exceeds transfer"
  truncate -s "$expected_bytes" "$CANONICAL_TRANSFER"
  sync -d "$CANONICAL_TRANSFER"
  printf 'canonical_transfer_bytes=%s\n' "$expected_bytes"
}

append_canonical_chunk() {
  [[ $# -eq 4 ]] || fail "append-canonical-chunk requires path, offset, bytes, and hash"
  local chunk="$1" offset="$2" expected_bytes="$3" expected_hash="$4" current_bytes=0
  [[ "$chunk" =~ ^/tmp/redstm-canonical-[0-9a-f]{32}\.chunk\.partial$ ]] || \
    fail "invalid canonical chunk path"
  [[ "$offset" =~ ^[0-9]+$ ]] || fail "invalid canonical chunk offset"
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || fail "invalid canonical chunk size"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || fail "invalid canonical chunk hash"
  [[ -f "$chunk" && ! -L "$chunk" ]] || fail "canonical chunk is missing or invalid"
  [[ "$(stat -c '%s' "$chunk")" == "$expected_bytes" ]] || \
    fail "canonical chunk size mismatch"
  [[ "$(sha256sum "$chunk" | cut -d' ' -f1)" == "$expected_hash" ]] || \
    fail "canonical chunk hash mismatch"
  if [[ -f "$CANONICAL_TRANSFER" ]]; then
    current_bytes="$(stat -c '%s' "$CANONICAL_TRANSFER")"
  else
    install -o redstm -g redstm -m 0640 /dev/null "$CANONICAL_TRANSFER"
  fi
  [[ "$current_bytes" == "$offset" ]] || fail "canonical transfer offset mismatch"
  cat -- "$chunk" >> "$CANONICAL_TRANSFER"
  sync -d "$CANONICAL_TRANSFER"
  [[ "$(stat -c '%s' "$CANONICAL_TRANSFER")" == "$((offset + expected_bytes))" ]] || \
    fail "canonical transfer append mismatch"
  rm -f -- "$chunk"
  printf 'canonical_transfer_bytes=%s\n' "$((offset + expected_bytes))"
}

canonical_activation_checkpoint() {
  :
}

activate_canonical() {
  [[ $# -eq 2 ]] || fail "activate-canonical requires bytes and hash"
  local expected_bytes="$1" expected_hash="$2" canonical_dir="${CANONICAL_TARGET%/*}"
  local current_hash nonce previous_snapshot
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || fail "invalid canonical size"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || fail "invalid canonical hash"
  acquire_runner_lock
  if [[ -e "$CANONICAL_TARGET" || -L "$CANONICAL_TARGET" ]]; then
    [[ -f "$CANONICAL_TARGET" && ! -L "$CANONICAL_TARGET" ]] || \
      fail "canonical target is not a regular file"
    if [[ "$(stat -c '%s' "$CANONICAL_TARGET")" == "$expected_bytes" ]]; then
      current_hash="$(sha256sum "$CANONICAL_TARGET" | cut -d' ' -f1)"
      if [[ "$current_hash" == "$expected_hash" ]]; then
        sync -d "$CANONICAL_TARGET"
        sync -f "$canonical_dir"
        rm -f -- "$CANONICAL_TRANSFER" "$CANONICAL_STAGING"
        printf 'canonical=noop\nsha256=%s\n' "$expected_hash"
        return
      fi
    fi
  fi
  if [[ -f "$CANONICAL_TRANSFER" && ! -L "$CANONICAL_TRANSFER" ]]; then
    [[ "$(stat -c '%s' "$CANONICAL_TRANSFER")" == "$expected_bytes" ]] || \
      fail "canonical size mismatch"
    if [[ "$(sha256sum "$CANONICAL_TRANSFER" | cut -d' ' -f1)" != "$expected_hash" ]]; then
      rm -f -- "$CANONICAL_TRANSFER"
      fail "canonical hash mismatch; transfer reset"
    fi
    [[ ! -e "$CANONICAL_STAGING" && ! -L "$CANONICAL_STAGING" ]] || \
      fail "canonical staging path already exists"
    mv -- "$CANONICAL_TRANSFER" "$CANONICAL_STAGING"
  elif [[ -e "$CANONICAL_TRANSFER" || -L "$CANONICAL_TRANSFER" ]]; then
    fail "canonical transfer is not a regular file"
  elif [[ -f "$CANONICAL_STAGING" && ! -L "$CANONICAL_STAGING" ]]; then
    [[ "$(stat -c '%s' "$CANONICAL_STAGING")" == "$expected_bytes" ]] || \
      fail "canonical staging size mismatch"
    [[ "$(sha256sum "$CANONICAL_STAGING" | cut -d' ' -f1)" == "$expected_hash" ]] || \
      fail "canonical staging hash mismatch"
  elif [[ -e "$CANONICAL_STAGING" || -L "$CANONICAL_STAGING" ]]; then
    fail "canonical staging is not a regular file"
  else
    fail "canonical transfer is missing"
  fi
  begin_maintenance "canonical-activation"
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" \
    -m scripts.doctor "$CANONICAL_STAGING" \
    --warc-dir /srv/redstm/warc --output /srv/redstm/reports/canonical-activation-doctor.json \
    >/dev/null
  sync -d "$CANONICAL_STAGING"
  if [[ -f "$CANONICAL_TARGET" ]]; then
    sync -d "$CANONICAL_TARGET"
    nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || fail "canonical snapshot nonce is invalid"
    previous_snapshot="${canonical_dir}/archive.previous-$(date -u +%Y%m%dT%H%M%SZ)-${nonce}.sqlite"
    ln -- "$CANONICAL_TARGET" "$previous_snapshot"
    canonical_activation_checkpoint before-snapshot-commit
    sync -f "$canonical_dir"
  fi
  mv -Tf -- "$CANONICAL_STAGING" "$CANONICAL_TARGET"
  sync -d "$CANONICAL_TARGET"
  sync -f "$canonical_dir"
  canonical_activation_checkpoint after-replace
  printf 'canonical=activated\nsha256=%s\n' "$expected_hash"
}

canonical_schema_status() {
  [[ $# -eq 0 ]] || fail "canonical-schema-status takes no arguments"
  [[ -f "$CANONICAL_TARGET" && ! -L "$CANONICAL_TARGET" ]] || \
    fail "canonical archive is unavailable"
  [[ -x "$CURRENT/.venv/bin/python" ]] || fail "current release Python is unavailable"
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" \
    - "$CANONICAL_TARGET" <<'PY'
import json
import sqlite3
import sys
from pathlib import Path

from crawler.archive import (
    APPLICATION_ID,
    MIGRATIONS,
    RUNTIME_SCHEMA_POLICY,
    SCHEMA_VERSION,
    connect_archive,
    validate_archive_for_release,
)

path = Path(sys.argv[1]).resolve(strict=True)
with connect_archive(path, read_only=True) as connection:
    application_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
    schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    try:
        migrations = [
            [int(row[0]), str(row[1])]
            for row in connection.execute(
                "SELECT version, sha256 FROM schema_migrations ORDER BY version"
            )
        ]
    except sqlite3.DatabaseError:
        migrations = []
    compatible = False
    try:
        validate_archive_for_release(
            connection,
            target_schema_version=SCHEMA_VERSION,
            target_migration_hashes={item.version: item.sha256 for item in MIGRATIONS},
        )
        compatible = True
    except (RuntimeError, sqlite3.DatabaseError):
        pass
    expected = [[item.version, item.sha256] for item in MIGRATIONS]
    payload = {
        "application_id": application_id,
        "compatible": compatible,
        "exact": compatible and schema_version == SCHEMA_VERSION and migrations == expected,
        "migration_count": len(migrations),
        "migrations": migrations,
        "schema_policy": RUNTIME_SCHEMA_POLICY,
        "schema_version": schema_version,
    }
print(json.dumps(payload, sort_keys=True))
PY
}

migrate_canonical_schema() {
  [[ $# -eq 2 ]] || fail "migrate-canonical requires expected current and previous releases"
  local expected_current="$1" expected_previous="$2"
  local current previous metadata schema_version target_schema
  local canonical_bytes free_bytes nonce snapshot manifest doctor_report canonical_dir
  validate_release "$expected_current"
  validate_release "$expected_previous"
  [[ "$expected_current" != "$expected_previous" ]] || \
    fail_not_started "canonical migration requires two distinct compatible releases"
  acquire_runner_lock
  acquire_archive_locks
  if systemctl is-active --quiet redstm-schedule.timer || \
     systemctl is-enabled --quiet redstm-schedule.timer; then
    fail_not_started "automatic schedule must be disabled before canonical migration"
  fi
  current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  [[ "$current" == "${RELEASES}/${expected_current}" ]] || \
    fail_not_started "current release changed before canonical migration"
  [[ "$previous" == "${RELEASES}/${expected_previous}" ]] || \
    fail_not_started "previous release changed before canonical migration"
  [[ -f "$CANONICAL_TARGET" && ! -L "$CANONICAL_TARGET" ]] || \
    fail_not_started "canonical archive is unavailable"

  metadata="$(sudo -u redstm env PYTHONPATH="$current" "$current/.venv/bin/python" \
    - "$CANONICAL_TARGET" "$current" "$previous" <<'PY'
import sys
from pathlib import Path

from crawler.archive import SCHEMA_VERSION
from scripts.migrate_archive import migration_source_version, validate_release_pair

validate_release_pair(Path(sys.argv[2]), Path(sys.argv[3]))
print(f"{migration_source_version(Path(sys.argv[1]))} {SCHEMA_VERSION}")
PY
  )"
  read -r schema_version target_schema <<<"$metadata"
  [[ "$schema_version" =~ ^[0-9]+$ && "$target_schema" =~ ^[0-9]+$ ]] || \
    fail "canonical migration metadata output is invalid"
  begin_maintenance "canonical-schema"
  if [[ "$schema_version" == "$target_schema" ]]; then
    sudo -u redstm env PYTHONPATH="$current" "$current/.venv/bin/python" \
      -m scripts.doctor "$CANONICAL_TARGET" --warc-dir /srv/redstm/warc \
      --output /srv/redstm/reports/canonical-schema-doctor.json >/dev/null
    printf 'canonical-schema=noop\nschema-version=%s\n' "$target_schema"
    return
  fi

  canonical_bytes="$(stat -c '%s' "$CANONICAL_TARGET")"
  free_bytes="$(df -B1 --output=avail /srv/redstm/snapshots | awk 'NR == 2 {print $1}')"
  [[ "$canonical_bytes" =~ ^[0-9]+$ && "$free_bytes" =~ ^[0-9]+$ ]] || \
    fail "canonical migration capacity is invalid"
  (( free_bytes >= canonical_bytes + CANONICAL_MIGRATION_FREE_MARGIN_BYTES )) || \
    fail_not_started "insufficient free space for canonical migration snapshot"
  nonce="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$nonce" =~ ^[0-9a-f]{32}$ ]] || fail "canonical migration nonce is invalid"
  snapshot="/srv/redstm/snapshots/canonical-pre-v${target_schema}-$(date -u +%Y%m%dT%H%M%SZ)-${nonce}.sqlite"
  manifest="${snapshot}.json"
  doctor_report="/srv/redstm/reports/canonical-schema-v${target_schema}-doctor.json"
  sudo -u redstm env PYTHONPATH="$current" "$current/.venv/bin/python" \
    - "$CANONICAL_TARGET" "$snapshot" "$manifest" "$current" "$previous" <<'PY' \
    >/dev/null
import sys
from pathlib import Path

from scripts.migrate_archive import migrate_archive_locked

migrate_archive_locked(
    Path(sys.argv[1]),
    snapshot=Path(sys.argv[2]),
    manifest=Path(sys.argv[3]),
    current_release=Path(sys.argv[4]),
    previous_release=Path(sys.argv[5]),
)
PY
  canonical_dir="$(dirname "$CANONICAL_TARGET")"
  sync -d "$CANONICAL_TARGET"
  sync -f "$canonical_dir"
  sudo -u redstm env PYTHONPATH="$current" "$current/.venv/bin/python" \
    -m scripts.doctor "$CANONICAL_TARGET" --warc-dir /srv/redstm/warc \
    --output "$doctor_report" >/dev/null
  printf 'canonical-schema=migrated\nschema-version=%s\nsnapshot=%s\nmanifest=%s\n' \
    "$target_schema" "$snapshot" "$manifest"
}

rollback_release() {
  [[ $# -eq 3 ]] || fail "rollback requires expected current, target release, and attempt"
  local expected_current="$1" target_release="$2" expected_attempt="$3"
  local previous current target source_release
  validate_release "$expected_current"
  validate_release "$target_release"
  if [[ "$expected_attempt" != "none" && \
        ! "$expected_attempt" =~ ^[0-9a-f]{32}$ ]]; then
    fail "invalid rollback attempt"
  fi
  acquire_runner_lock
  target="${RELEASES}/${target_release}"
  source_release="${RELEASES}/${expected_current}"
  previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  [[ "$current" == "${RELEASES}/"* && -d "$current" ]] || fail "current release is unavailable"
  [[ -d "$target" ]] || fail "target release is unavailable"
  [[ -d "$source_release" ]] || fail "expected release is unavailable"
  if [[ "$expected_attempt" != "none" ]]; then
    release_attempt_matches "$expected_current" "$expected_attempt" || \
      fail_not_started "release attempt ownership changed"
  fi
  if [[ "$current" == "$target" ]]; then
    if [[ "$expected_attempt" == "none" && \
          "$expected_current" != "$target_release" ]]; then
      [[ "$previous" == "${RELEASES}/${expected_current}" ]] || \
        fail_not_started "previous release changed before partial rollback reconciliation"
    fi
  elif [[ "$current" == "${RELEASES}/${expected_current}" ]]; then
    if [[ "$expected_attempt" == "none" ]]; then
      [[ "$previous" == "$target" ]] || fail_not_started "target previous release changed"
    fi
  else
    fail_not_started "current release changed"
  fi
  if [[ -f /srv/redstm/canonical/archive.sqlite ]]; then
    sudo -u redstm env PYTHONPATH="$source_release" "$source_release/.venv/bin/python" \
      - /srv/redstm/canonical/archive.sqlite "$target" <<'PY'
import json
import os
import subprocess
import sys
from pathlib import Path

from crawler.archive import connect_archive, validate_archive_for_release

target_release = Path(sys.argv[2])
target_environment = dict(os.environ)
target_environment["PYTHONPATH"] = str(target_release)
target_result = subprocess.run(
    [
        str(target_release / ".venv/bin/python"),
        "-c",
        "import json; from crawler.archive import MIGRATIONS, RUNTIME_SCHEMA_POLICY, "
        "SCHEMA_VERSION; "
        "print(json.dumps({'schema_version': SCHEMA_VERSION, "
        "'schema_policy': RUNTIME_SCHEMA_POLICY, "
        "'migrations': [[item.version, item.sha256] for item in MIGRATIONS]}))",
    ],
    cwd=target_release,
    env=target_environment,
    check=True,
    stdout=subprocess.PIPE,
    text=True,
)
target_payload = json.loads(target_result.stdout)
if (
    not isinstance(target_payload, dict)
    or set(target_payload) != {"schema_version", "schema_policy", "migrations"}
    or type(target_payload["schema_version"]) is not int
    or target_payload["schema_policy"] != "explicit-v1"
    or not isinstance(target_payload["migrations"], list)
    or not all(
    isinstance(item, list)
    and len(item) == 2
    and type(item[0]) is int
    and isinstance(item[1], str)
    for item in target_payload["migrations"]
    )
    or len({item[0] for item in target_payload["migrations"]})
    != len(target_payload["migrations"])
):
    raise SystemExit("rollback target migration metadata is invalid")
target_known = {version: sha256 for version, sha256 in target_payload["migrations"]}
with connect_archive(sys.argv[1], read_only=True) as connection:
    validate_archive_for_release(
        connection,
        target_schema_version=target_payload["schema_version"],
        target_migration_hashes=target_known,
    )
PY
  fi
  if [[ "$current" != "$target" ]]; then
    if [[ "$expected_attempt" == "none" ]]; then
      rm -f -- "$COMPLETE"
    fi
    ln -sfn -- "$target" "${CURRENT}.new"
    mv -Tf -- "${CURRENT}.new" "$CURRENT"
  elif [[ "$expected_attempt" == "none" ]]; then
    rm -f -- "$COMPLETE"
  fi
  if [[ "$expected_current" != "$target_release" ]]; then
    [[ -d "${RELEASES}/${expected_current}" ]] || fail "expected release is unavailable"
    ln -sfn -- "${RELEASES}/${expected_current}" "${PREVIOUS}.new"
    mv -Tf -- "${PREVIOUS}.new" "$PREVIOUS"
  fi
  printf 'REDSTM_RUNNER_VERSION=%s\n' "$target_release" > /etc/redstm/runtime.env.new
  chown root:redstm /etc/redstm/runtime.env.new
  chmod 0640 /etc/redstm/runtime.env.new
  mv -Tf -- /etc/redstm/runtime.env.new /etc/redstm/runtime.env
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.service" /etc/systemd/system/redstm-control.service
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.timer" /etc/systemd/system/redstm-control.timer
  if [[ -f "$target/deploy/oracle/redstm-journald.conf" ]]; then
    install -d -o root -g root -m 0755 /etc/systemd/journald.conf.d
    install -o root -g root -m 0644 \
      "$target/deploy/oracle/redstm-journald.conf" /etc/systemd/journald.conf.d/redstm.conf
  else
    rm -f -- /etc/systemd/journald.conf.d/redstm.conf
  fi
  if [[ -f "$target/deploy/oracle/redstm-schedule.service" && \
        -f "$target/deploy/oracle/redstm-schedule.timer" ]]; then
    install -o root -g root -m 0644 \
      "$target/deploy/oracle/redstm-schedule.service" /etc/systemd/system/redstm-schedule.service
    install -o root -g root -m 0644 \
      "$target/deploy/oracle/redstm-schedule.timer" /etc/systemd/system/redstm-schedule.timer
    systemd-analyze verify /etc/systemd/system/redstm-control.service \
      /etc/systemd/system/redstm-control.timer \
      /etc/systemd/system/redstm-schedule.service \
      /etc/systemd/system/redstm-schedule.timer
  else
    systemctl disable --now redstm-schedule.timer 2>/dev/null || true
    rm -f -- /etc/systemd/system/redstm-schedule.service \
      /etc/systemd/system/redstm-schedule.timer
    systemd-analyze verify /etc/systemd/system/redstm-control.service \
      /etc/systemd/system/redstm-control.timer
  fi
  systemctl daemon-reload
  systemd-analyze cat-config systemd/journald.conf >/dev/null
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" -c \
    'import scripts.control_runner'
  rclone_supported || fail "rclone version is unsupported"
  systemctl enable --now redstm-control.timer
  mark_release_complete "$target_release"
  printf 'rollback=%s\n' "$target_release"
}

mode="${1:-}"
shift || true
case "$mode" in
  install) acquire_release_lock; INSTALL_ACTIVE=1; INSTALL_MUTATED=0; install_release "$@" ;;
  install-bridge) acquire_release_lock; INSTALL_ACTIVE=1; INSTALL_MUTATED=0; INSTALL_BRIDGE=1; install_release "$@" ;;
  canonical-transfer-size) canonical_transfer_size "$@" ;;
  truncate-canonical-transfer) acquire_release_lock; truncate_canonical_transfer "$@" ;;
  append-canonical-chunk) acquire_release_lock; append_canonical_chunk "$@" ;;
  activate-canonical) acquire_release_lock; activate_canonical "$@" ;;
  canonical-schema-status) canonical_schema_status "$@" ;;
  migrate-canonical) acquire_release_lock; migrate_canonical_schema "$@" ;;
  rollback) acquire_release_lock; rollback_release "$@" ;;
  status) release_status "$@" ;;
  *) fail "unknown install mode" ;;
esac
