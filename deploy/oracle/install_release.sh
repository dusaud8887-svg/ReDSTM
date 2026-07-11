#!/usr/bin/env bash
set -euo pipefail

UV_VERSION=0.9.21
RELEASES=/opt/redstm/releases
CURRENT=/opt/redstm/current
PREVIOUS=/opt/redstm/previous

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

validate_release() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "invalid release identity"
}

install_uv() {
  if [[ -x /usr/local/bin/uv ]]; then
    local current_version
    current_version="$(/usr/local/bin/uv --version)"
    if [[ "$current_version" == "uv ${UV_VERSION}" || \
      "$current_version" == "uv ${UV_VERSION} "* ]]; then
      return
    fi
  fi
  local installer="/tmp/uv-${UV_VERSION}-install.sh"
  curl --fail --silent --show-error --location \
    "https://astral.sh/uv/${UV_VERSION}/install.sh" --output "$installer"
  UV_UNMANAGED_INSTALL=/usr/local/bin UV_NO_MODIFY_PATH=1 sh "$installer"
  rm -f -- "$installer"
  local installed_version
  installed_version="$(/usr/local/bin/uv --version)"
  [[ "$installed_version" == "uv ${UV_VERSION}" || \
    "$installed_version" == "uv ${UV_VERSION} "* ]] || fail "uv version mismatch"
}

install_release() {
  [[ $# -eq 3 ]] || fail "install requires release, archive, and hash"
  local release="$1" archive="$2" expected="$3"
  validate_release "$release"
  [[ "$archive" == "/tmp/redstm-release-${release}.tar.gz.partial" ]] || fail "invalid archive path"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "invalid archive hash"
  [[ -f "$archive" ]] || fail "release archive is missing"
  [[ "$(sha256sum "$archive" | cut -d' ' -f1)" == "$expected" ]] || fail "archive hash mismatch"

  if ! id redstm >/dev/null 2>&1; then
    useradd --system --home-dir /srv/redstm/home --create-home --shell /usr/sbin/nologin redstm
  fi
  install -d -o root -g root -m 0755 /opt/redstm "$RELEASES"
  install -d -o redstm -g redstm -m 0750 \
    /srv/redstm/home /srv/redstm/canonical /srv/redstm/private /srv/redstm/warc \
    /srv/redstm/reports /srv/redstm/static /srv/redstm/state /srv/redstm/cache
  install -d -o root -g redstm -m 0750 /etc/redstm
  install -o root -g root -m 0755 "$0" /opt/redstm/install_release.sh
  install_uv
  sudo -u redstm env HOME=/srv/redstm/home UV_CACHE_DIR=/srv/redstm/cache UV_NO_CONFIG=1 \
    /usr/local/bin/uv python install 3.14

  local target="${RELEASES}/${release}" staging="${RELEASES}/${release}.partial"
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

  local old=""
  old="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  if [[ -n "$old" && "$old" != "$target" && "$old" == "${RELEASES}/"* ]]; then
    ln -sfn -- "$old" "${PREVIOUS}.new"
    mv -Tf -- "${PREVIOUS}.new" "$PREVIOUS"
  fi
  ln -sfn -- "$target" "${CURRENT}.new"
  mv -Tf -- "${CURRENT}.new" "$CURRENT"
  printf 'REDSTM_RUNNER_VERSION=%s\n' "$release" > /etc/redstm/runtime.env
  chown root:redstm /etc/redstm/runtime.env
  chmod 0640 /etc/redstm/runtime.env
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.service" /etc/systemd/system/redstm-control.service
  install -o root -g root -m 0644 \
    "$target/deploy/oracle/redstm-control.timer" /etc/systemd/system/redstm-control.timer
  systemd-analyze verify /etc/systemd/system/redstm-control.service \
    /etc/systemd/system/redstm-control.timer
  systemctl daemon-reload
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" -c \
    'import scripts.control_runner'
  rm -f -- "$archive"
  find /tmp -maxdepth 1 -type f -regextype posix-extended \
    -regex '/tmp/redstm-release-[0-9a-f]{40}\.tar\.gz\.partial' -delete
  if [[ "$0" == "/tmp/redstm-install-release.sh" ]]; then
    rm -f -- "$0"
  fi
  printf 'release=%s\ntimer_enabled=%s\n' "$release" \
    "$(systemctl is-enabled redstm-control.timer 2>/dev/null || true)"
}

activate_canonical() {
  [[ $# -eq 3 ]] || fail "activate-canonical requires path, bytes, and hash"
  local partial="$1" expected_bytes="$2" expected_hash="$3"
  [[ "$partial" == "/tmp/redstm-canonical.sqlite.partial" ]] || fail "invalid partial path"
  [[ "$expected_bytes" =~ ^[1-9][0-9]*$ ]] || fail "invalid canonical size"
  [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || fail "invalid canonical hash"
  [[ -f "$partial" ]] || fail "canonical partial is missing"
  [[ "$(stat -c '%s' "$partial")" == "$expected_bytes" ]] || fail "canonical size mismatch"
  [[ "$(sha256sum "$partial" | cut -d' ' -f1)" == "$expected_hash" ]] || fail "canonical hash mismatch"
  local canonical_partial=/srv/redstm/canonical/archive.sqlite.partial
  [[ ! -e "$canonical_partial" ]] || fail "canonical staging path already exists"
  mv -- "$partial" "$canonical_partial"
  chown redstm:redstm "$canonical_partial"
  chmod 0640 "$canonical_partial"
  sudo -u redstm "$CURRENT/.venv/bin/python" -m scripts.doctor "$canonical_partial" \
    --warc-dir /srv/redstm/warc --output /srv/redstm/reports/canonical-activation-doctor.json \
    >/dev/null
  local target=/srv/redstm/canonical/archive.sqlite
  if [[ -f "$target" ]]; then
    local current_hash
    current_hash="$(sha256sum "$target" | cut -d' ' -f1)"
    if [[ "$current_hash" == "$expected_hash" ]]; then
      rm -f -- "$canonical_partial"
      printf 'canonical=noop\n'
      return
    fi
    mv -- "$target" "/srv/redstm/canonical/archive.previous-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  fi
  mv -- "$canonical_partial" "$target"
  printf 'canonical=activated\nsha256=%s\n' "$expected_hash"
}

rollback_release() {
  local previous current
  previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  [[ "$previous" == "${RELEASES}/"* && -d "$previous" ]] || fail "previous release is unavailable"
  ln -sfn -- "$previous" "${CURRENT}.new"
  mv -Tf -- "${CURRENT}.new" "$CURRENT"
  if [[ "$current" == "${RELEASES}/"* && -d "$current" ]]; then
    ln -sfn -- "$current" "${PREVIOUS}.new"
    mv -Tf -- "${PREVIOUS}.new" "$PREVIOUS"
  fi
  printf 'REDSTM_RUNNER_VERSION=%s\n' "$(basename "$previous")" > /etc/redstm/runtime.env
  chown root:redstm /etc/redstm/runtime.env
  chmod 0640 /etc/redstm/runtime.env
  install -o root -g root -m 0644 \
    "$previous/deploy/oracle/redstm-control.service" /etc/systemd/system/redstm-control.service
  install -o root -g root -m 0644 \
    "$previous/deploy/oracle/redstm-control.timer" /etc/systemd/system/redstm-control.timer
  systemd-analyze verify /etc/systemd/system/redstm-control.service \
    /etc/systemd/system/redstm-control.timer
  systemctl daemon-reload
  sudo -u redstm env PYTHONPATH="$CURRENT" "$CURRENT/.venv/bin/python" -c \
    'import scripts.control_runner'
  printf 'rollback=%s\n' "$(basename "$previous")"
}

mode="${1:-}"
shift || true
case "$mode" in
  install) install_release "$@" ;;
  activate-canonical) activate_canonical "$@" ;;
  rollback) rollback_release "$@" ;;
  *) fail "unknown install mode" ;;
esac
