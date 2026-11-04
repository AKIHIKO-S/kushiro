#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - R2 退避の初回設定(1回だけ・オーナーが自分で鍵を入力する)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 実行: sudo bash /opt/ktta/deploy/offsite-r2-setup.sh
#   1) rclone を入れる(Ubuntu の公式パッケージ)
#   2) ktta ユーザーの rclone 設定(リモート名 r2)を作る。鍵はここで画面入力し、
#      チャット・GitHub・ログには残さない。設定ファイルは ktta 本人のみ読める(600)
#   3) 最新バックアップを1件送って、届いたかを確認する
#
# R2 の鍵は「ktta-backups バケットだけ・オブジェクトの読み取りと書き込み」に絞って発行すること。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo で実行してください: sudo bash $0"; exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
  echo "== rclone を入れます"
  apt-get update -qq && apt-get install -y -qq rclone
fi
rclone version | head -1

KTTA_HOME="$(getent passwd ktta | cut -d: -f6)"
CONF_DIR="$KTTA_HOME/.config/rclone"
CONF="$CONF_DIR/rclone.conf"

echo
echo "Cloudflare の画面に出ている3つの値を貼り付けてください(画面には表示されません)。"
read -r -p  "1) S3 クライアント用のエンドポイント(https://....r2.cloudflarestorage.com): " ENDPOINT
read -r -s -p "2) アクセスキー ID: " AKID; echo
read -r -s -p "3) シークレットアクセスキー: " SECRET; echo

case "$ENDPOINT" in
  https://*.r2.cloudflarestorage.com|https://*.r2.cloudflarestorage.com/) ;;
  *) echo "エンドポイントの形が違います(https://<アカウントID>.r2.cloudflarestorage.com)。中止。"; exit 1 ;;
esac
ENDPOINT="${ENDPOINT%/}"
if [ -z "$AKID" ] || [ -z "$SECRET" ]; then
  echo "鍵が空です。中止。"; exit 1
fi

install -d -m 700 -o ktta -g ktta "$CONF_DIR"
umask 077
cat > "$CONF" <<EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $AKID
secret_access_key = $SECRET
endpoint = $ENDPOINT
acl = private
no_check_bucket = true
EOF
chown ktta:ktta "$CONF"
chmod 600 "$CONF"
unset AKID SECRET
echo "== 設定を保存しました($CONF / 600)"

echo "== 試しに1件送ります"
sudo -u ktta -H bash /opt/ktta/deploy/offsite-r2.sh
echo
echo "== R2 に入っているもの"
sudo -u ktta -H rclone lsl r2:ktta-backups/db/ | tail -5
echo
echo "完了。この後の毎晩の送信設定(cron)は Claude 側で入れます。"
