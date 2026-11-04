#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - オフサイト退避 (Cloudflare R2)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 目的: Oracle 無料枠VMが回収されても DB を失わないよう、最新のバックアップを
#       別会社(Cloudflare R2)へ毎晩1件ずつ積み上げる。
#       offsite-sync.sh(rsync --delete ミラー)と違い、ここは「追加のみ」で消さない。
#       古い世代は R2 側の保持ルール(db/ 配下を180日で自動削除)で整理する。
#       そのため、破損に30日以上気づかなくても、180日分の正常な世代が遠隔に残る。
#
# 前提: backup.sh が先に走り、$BACKUP_DIR に ktta-*.db.gz があること。
#       rclone と ktta ユーザーの rclone 設定(リモート名 r2)は offsite-r2-setup.sh で作る。
#
# /etc/ktta.env で上書きできる変数:
#   OFFSITE_R2_REMOTE=r2:ktta-backups/db/   (省略時この値)
#
# cron 例(ktta ユーザー。backup.sh 成功後に、RSミラーと独立して実行):
#   0 3 * * * cd / && /opt/ktta/deploy/backup.sh && { /opt/ktta/deploy/offsite-sync.sh >> /var/data/backups/offsite.log 2>&1; /opt/ktta/deploy/offsite-r2.sh >> /var/data/backups/offsite-r2.log 2>&1; }
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

# cron は環境を引き継がないので、必要な行だけ /etc/ktta.env から拾う(offsite-sync.sh と同じ方式)
if [ -f /etc/ktta.env ]; then
  while IFS='=' read -r _k _v; do
    case "$_k" in
      OFFSITE_R2_REMOTE|DB_PATH|BACKUP_DIR) if [ -z "${!_k:-}" ]; then export "$_k=$_v"; fi ;;
    esac
  done < /etc/ktta.env
fi

DB_FILE="${DB_PATH:-/var/data/tournament.db}"
SRC_DIR="${BACKUP_DIR:-$(dirname "$DB_FILE")/backups}"
REMOTE="${OFFSITE_R2_REMOTE:-r2:ktta-backups/db/}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [r2] $*"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "[ERROR] rclone がありません。offsite-r2-setup.sh を先に実行してください。"; exit 1
fi

# 最新のバックアップ1件(ファイル名に日時が入っているので名前順の末尾=最新)
shopt -s nullglob
FILES=("$SRC_DIR"/ktta-*.db.gz)
if [ ${#FILES[@]} -eq 0 ]; then
  log "[ERROR] $SRC_DIR にバックアップ(ktta-*.db.gz)がありません。中止。"; exit 1
fi
LATEST="$(printf '%s\n' "${FILES[@]}" | sort | tail -1)"
NAME="$(basename "$LATEST")"

# 壊れた gzip を遠隔に積まない
if ! gzip -t "$LATEST" 2>/dev/null; then
  log "[ERROR] $NAME が gzip として壊れています。送信しません。"; exit 1
fi

log "送信: $NAME -> $REMOTE"
rclone copy --no-traverse --retries 3 "$LATEST" "$REMOTE"

# 届いたかをサイズで確認(一覧取得は1件だけ)
LOCAL_SIZE="$(stat -c %s "$LATEST")"
REMOTE_SIZE="$(rclone lsf --format s --files-only "$REMOTE$NAME" 2>/dev/null | head -1 || true)"
if [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ]; then
  log "[ERROR] 送信後の確認に失敗(手元 $LOCAL_SIZE / R2 ${REMOTE_SIZE:-なし})"; exit 1
fi
log "[OK] $NAME ($LOCAL_SIZE bytes) を R2 に保管しました"
