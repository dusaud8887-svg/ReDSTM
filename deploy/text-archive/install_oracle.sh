#!/usr/bin/env bash
set -Eeuo pipefail

stage="${1:?staged package directory required}"
[[ $EUID -eq 0 && "$stage" == /tmp/redstm-text-stage-* ]] || exit 2
[[ -f "$stage/scripts/text_archive/runtime.py" && -f "$stage/crawler/collections.py" \
   && -f "$stage/redstm-inbox.pub" ]] || exit 2
[[ -f "$stage/sshd_config.base" && -f "$stage/sshd_config.patched" ]] || exit 2
cmp -s /etc/ssh/sshd_config "$stage/sshd_config.base" || {
  echo 'sshd_config changed since staging' >&2
  exit 2
}
command -v setfacl >/dev/null
command -v uv >/dev/null

getent group redstm-text >/dev/null || groupadd --system redstm-text
getent group redstm-inbox >/dev/null || groupadd --system redstm-inbox
getent group redstm-inbox-read >/dev/null || groupadd --system redstm-inbox-read
id redstm-text >/dev/null 2>&1 || useradd --system --no-create-home \
  --home-dir /srv/redstm-text --shell /usr/sbin/nologin --gid redstm-text redstm-text
id redstm-inbox >/dev/null 2>&1 || useradd --system --no-create-home \
  --home-dir /srv/redstm-text-inbox --shell /usr/sbin/nologin --gid redstm-inbox \
  --groups redstm-inbox-read redstm-inbox
usermod --password "$(openssl rand -hex 32 | openssl passwd -6 -stdin)" redstm-inbox
usermod -aG redstm-inbox-read redstm-text

install -d -o root -g root -m 0755 /opt/redstm-text /opt/redstm-text/releases
install -d -o redstm-text -g redstm-text -m 0700 /srv/redstm-text
install -d -o root -g root -m 0755 /srv/redstm-text-inbox
install -d -o root -g root -m 0500 /srv/redstm-text-inbox/drop
install -d -o redstm-text -g redstm-inbox-read -m 2750 /srv/redstm-text-inbox/receipts
install -d -o root -g root -m 0755 /etc/redstm-text /etc/ssh/authorized_keys
install -o root -g root -m 0644 "$stage/redstm-inbox.pub" \
  /etc/ssh/authorized_keys/redstm-inbox

if [[ ! -e /srv/redstm-text-inbox/drop.img ]]; then
  truncate -s 2G /srv/redstm-text-inbox/drop.img
  chmod 0600 /srv/redstm-text-inbox/drop.img
  mkfs.ext4 -F -q /srv/redstm-text-inbox/drop.img
fi
mount_unit="$(systemd-escape --path --suffix=mount /srv/redstm-text-inbox/drop)"
install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-drop.mount.in" \
  "/etc/systemd/system/$mount_unit"
systemd-analyze verify "/etc/systemd/system/$mount_unit"
systemctl daemon-reload
systemctl enable --now "$mount_unit"
mountpoint -q /srv/redstm-text-inbox/drop
chown redstm-inbox:redstm-inbox-read /srv/redstm-text-inbox/drop
chmod 2750 /srv/redstm-text-inbox/drop

setfacl -m u:redstm-text:--x /srv/redstm/static
setfacl -m u:redstm-text:rw- /srv/redstm/static/.publish.lock

version="$(date -u +%Y%m%dT%H%M%SZ)"
release="/opt/redstm-text/releases/$version"
install -d -o root -g root -m 0755 "$release"
cp -r "$stage/scripts" "$release/scripts"
install -d -o root -g root -m 0755 "$release/crawler"
install -o root -g root -m 0644 "$stage/crawler/__init__.py" "$stage/crawler/collections.py" \
  "$release/crawler/"
uv python install 3.14.2 --install-dir /opt/redstm-text/python
uv venv --python /opt/redstm-text/python/cpython-3.14.2-linux-x86_64-gnu/bin/python3.14 \
  "$release/.venv"
uv pip install --python "$release/.venv/bin/python" filelock==3.32.2 requests==2.34.2
(cd "$release" && sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.collector --help >/dev/null && \
  sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.publisher --help >/dev/null)
ln -s "$release" /opt/redstm-text/current.next
mv -Tf /opt/redstm-text/current.next /opt/redstm-text/current

for kind in collector import publish; do
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.service" \
    "/etc/systemd/system/redstm-text-$kind.service"
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.timer" \
    "/etc/systemd/system/redstm-text-$kind.timer"
done
install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-import.path" \
  /etc/systemd/system/redstm-text-import.path
systemd-analyze verify /etc/systemd/system/redstm-text-{collector,import,publish}.{service,timer} \
  /etc/systemd/system/redstm-text-import.path
systemctl daemon-reload
systemctl enable --now redstm-text-import.path

install -o root -g root -m 0644 "$stage/deploy/text-archive/sshd-match.conf" \
  /etc/ssh/redstm-inbox-match.conf
sshd -t -f "$stage/sshd_config.patched"
cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.redstm-text-pre
install -o root -g root -m 0644 "$stage/sshd_config.patched" /etc/ssh/sshd_config
sshd -t
systemctl reload ssh
echo "redstm_text_installed=$version"
