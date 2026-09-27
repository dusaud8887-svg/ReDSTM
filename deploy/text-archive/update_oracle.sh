#!/usr/bin/env bash
set -Eeuo pipefail

stage="${1:?staged package directory required}"
[[ $EUID -eq 0 && "$stage" == /tmp/redstm-text-stage-* ]] || exit 2
[[ -d /opt/redstm-text/current/.venv && -f "$stage/scripts/text_archive/runtime.py" \
   && -f "$stage/crawler/collections.py" ]] || exit 2

release="/opt/redstm-text/releases/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0755 "$release"
cp -a /opt/redstm-text/current/. "$release/"
cp -a "$stage/scripts/text_archive/"*.py "$release/scripts/text_archive/"
install -d -o root -g root -m 0755 "$release/crawler"
install -o root -g root -m 0644 "$stage/crawler/__init__.py" "$stage/crawler/collections.py" \
  "$release/crawler/"
(cd "$release" && sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.collector --help >/dev/null && \
  sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.publisher --help >/dev/null && \
  sudo -u redstm-text "$release/.venv/bin/python" \
  -m scripts.text_archive.media_importer --help >/dev/null)

for kind in collector import publish media; do
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.service" \
    "/etc/systemd/system/redstm-text-$kind.service"
done
for kind in collector media; do
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.timer" \
    "/etc/systemd/system/redstm-text-$kind.timer"
done
for kind in import media; do
  install -o root -g root -m 0644 "$stage/deploy/text-archive/redstm-text-$kind.path" \
    "/etc/systemd/system/redstm-text-$kind.path"
done
systemd-analyze verify /etc/systemd/system/redstm-text-{collector,import,publish,media}.service \
  /etc/systemd/system/redstm-text-{import,media}.path \
  /etc/systemd/system/redstm-text-{collector,media}.timer
systemctl daemon-reload
systemctl enable --now redstm-text-import.path
systemctl restart redstm-text-collector.timer
ln -s "$release" /opt/redstm-text/current.next
mv -Tf /opt/redstm-text/current.next /opt/redstm-text/current
# The media units start only once the release that contains media_importer is current.
systemctl enable --now redstm-text-media.path redstm-text-media.timer
setfacl -x u:redstm-text /srv/redstm/state/control.lock /srv/redstm/state
echo "redstm_text_updated=${release##*/}"
