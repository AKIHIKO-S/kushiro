#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - オフサイト退避の一括セットアップ (お名前ドットコム等 / 伴走用)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 長い ssh コマンドを手で打つとコピペ改行で壊れやすいため、複雑な処理は全てこのスクリプトに集約する。
# 使い方 (root で1行):
#   sudo bash /opt/ktta/deploy/offsite-setup.sh <host> <port> <user>
#   例: sudo bash /opt/ktta/deploy/offsite-setup.sh www1066.onamae.ne.jp 8022 r2348212
#
# 前提: /var/data/.ssh/onamae_rsa (RSA秘密鍵) が存在し、その公開鍵が転送先に登録済みであること。
#       (公開鍵は `sudo ssh-keygen -y -f /var/data/.ssh/onamae_rsa` で表示できる)
#
# 実行内容: 鍵の権限調整 → 疎通テスト → 退避先フォルダ作成 → /etc/ktta.env 追記(冪等) →
#           /var/data/backups を ktta 所有へ → 毎晩3時の cron 登録(冪等)。実バックアップは行わない。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -uo pipefail

HOST="${1:-}"; PORT="${2:-22}"; RUSER="${3:-}"
KEY=/var/data/.ssh/onamae_rsa
KNOWN=/var/data/.ssh/known_hosts
DEST="$RUSER@$HOST:~/ktta-backups/"
BK=/var/data/backups
ENVF=/etc/ktta.env

die() { echo "[NG] $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "root で実行してください: sudo bash $0 <host> <port> <user>"
[ -n "$HOST" ] && [ -n "$RUSER" ] || die "引数が必要です: sudo bash $0 <host> <port> <user>"
[ -f "$KEY" ] || die "SSH鍵がありません: $KEY (先に作成してください)"

echo "== 1) 鍵の所有権・権限を整える =="
install -d -o ktta -g ktta -m 700 /var/data/.ssh
chown ktta:ktta "$KEY" "$KEY.pub" 2>/dev/null || true
chmod 600 "$KEY"

echo "== 2) 疎通テスト ($RUSER@$HOST:$PORT へ ktta として鍵ログイン) =="
SSHO="-i $KEY -p $PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KNOWN -o ConnectTimeout=20"
if sudo -u ktta ssh $SSHO "$RUSER@$HOST" 'mkdir -p ~/ktta-backups && echo CONNECT_OK && pwd && ls -la ~/ktta-backups'; then
  echo "[OK] お名前ドットコムへ鍵だけでログインできました（退避先 ~/ktta-backups も用意）"
else
  die "ログインできませんでした。次を確認: 公開鍵(ssh-rsa)の登録 / host=$HOST port=$PORT user=$RUSER / コントロールパネルでSSH有効化"
fi

echo "== 3) /etc/ktta.env に退避設定を追記(既存はそのまま) =="
touch "$ENVF"
grep -q '^OFFSITE_DEST='     "$ENVF" || echo "OFFSITE_DEST=$DEST"     >> "$ENVF"
grep -q '^OFFSITE_SSH_KEY='  "$ENVF" || echo "OFFSITE_SSH_KEY=$KEY"   >> "$ENVF"
grep -q '^OFFSITE_SSH_PORT=' "$ENVF" || echo "OFFSITE_SSH_PORT=$PORT" >> "$ENVF"
echo "  現在の OFFSITE 設定:"; grep -E '^OFFSITE_' "$ENVF" | sed 's/^/    /'

echo "== 4) バックアップ保存先を ktta 所有へ(cronがkttaで書けるように) =="
install -d -o ktta -g ktta -m 755 "$BK"
chown -R ktta:ktta "$BK"

echo "== 5) 毎晩3時の自動バックアップ→退避 cron を登録(ktta・冪等) =="
CRON_LINE='0 3 * * * . /etc/ktta.env; /opt/ktta/deploy/backup.sh && /opt/ktta/deploy/offsite-sync.sh >> /var/data/backups/offsite.log 2>&1'
( crontab -u ktta -l 2>/dev/null | grep -v 'offsite-sync.sh' ; echo "$CRON_LINE" ) | crontab -u ktta -
echo "  登録された ktta cron:"; crontab -u ktta -l | grep -E 'backup|offsite' | sed 's/^/    /'

echo
echo "[完了] オフサイト退避のセットアップが完了しました。"
echo "今すぐ1回テスト退避するには(任意):"
echo "  sudo -u ktta bash -c '. /etc/ktta.env; /opt/ktta/deploy/backup.sh && /opt/ktta/deploy/offsite-sync.sh'"
