#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 && ! -e /etc/redstm-text/rclone.conf ]] || {
  echo 'r2_config_precondition_failed' >&2
  exit 2
}
IFS= read -r secret || {
  echo 'r2_secret_input_missing' >&2
  exit 2
}
secret="${secret#$'\xef\xbb\xbf'}"
secret="${secret%$'\r'}"
[[ "$secret" =~ ^[0-9a-f]{64}$ ]] || {
  echo "r2_secret_input_invalid length=${#secret}" >&2
  exit 2
}
umask 077
rclone --config /etc/redstm-text/rclone.conf config create r2text s3 \
  provider Cloudflare env_auth false no_check_bucket true \
  access_key_id 9b5b5ee24b843b0f480db13962d6f6c6 \
  secret_access_key "$secret" \
  endpoint https://81d1e7334e4ef4bcbbeffc9b96297699.r2.cloudflarestorage.com \
  --no-output
chown redstm-text:redstm-text /etc/redstm-text/rclone.conf
chmod 0600 /etc/redstm-text/rclone.conf
unset secret
sudo -u redstm-text rclone --config /etc/redstm-text/rclone.conf \
  lsf r2text:redstm-text-archive >/dev/null
echo r2text_configured
