#!/usr/bin/env bash
set -Eeuo pipefail

stage="${1:?staged package directory required}"
[[ $EUID -eq 0 && "$stage" == /tmp/redstm-text-stage-* ]] || exit 2
[[ -d /opt/redstm-text/current/.venv && -f "$stage/scripts/text_archive/runtime.py" ]] || exit 2

release="/opt/redstm-text/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0755 "$release"
cp -a /opt/redstm-text/current/. "$release/"
cp -a "$stage/scripts/text_archive/"*.py "$release/scripts/text_archive/"
(cd "$release" && sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.collector --help >/dev/null)

for kind in collector import publish; do
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.service" \
    "/etc/systemd/system/redstm-text-$kind.service"
done
systemd-analyze verify /etc/systemd/system/redstm-text-{collector,import,publish}.service
systemctl daemon-reload
ln -s "$release" /opt/redstm-text/current.next
mv -Tf /opt/redstm-text/current.next /opt/redstm-text/current
setfacl -x u:redstm-text /srv/redstm/state/control.lock /srv/redstm/state
echo "redstm_text_updated=${release##*/}"
