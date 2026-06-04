#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - オフサイト退避 (お名前ドットコム等の SFTP 先へ DB バックアップを退避)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 目的: Oracle 無料枠VMは予告なく回収され得る。ローカル(/var/data/backups)のバックアップを
#       別サーバ(お名前ドットコム レンタルサーバー等)へ毎晩ミラーし、VM喪失でも最新DBを残す(DR)。
#
# 前提: backup.sh が先に走り、$BACKUP_DIR に ktta-*.db.gz を作っていること。
#       転送先サーバへ SSH 公開鍵を登録済み(パスワード無しでログインできる)こと。
#
# /etc/ktta.env に設定する変数:
#   OFFSITE_DEST=user@your-onamae-host:~/ktta-backups/   (必須・末尾スラッシュ推奨)
#   OFFSITE_SSH_KEY=/home/ktta/.ssh/onamae_rsync          (省略時 ~/.ssh/onamae_rsync)
#   OFFSITE_SSH_PORT=22                                    (お名前RSは 2222 等のことがある)
#   BACKUP_DIR=/var/data/backups                          (省略時 DB_PATH の隣の backups)
#
# cron 例 (毎晩3時に ローカルバックアップ→オフサイト退避):
#   0 3 * * * . /etc/ktta.env; /opt/ktta/deploy/backup.sh && /opt/ktta/deploy/offsite-sync.sh >> /var/data/backups/offsite.log 2>&1
#
# ⚠ DR上の制約(rsync --delete ミラーの性質): 遠隔の保持は「ローカルの30日窓」と同一になり、独立世代は
#   持たない。つまり破損やデータ事故が30日以上気づかれないと、正常な世代が遠隔からも消え得る。重要大会の
#   後などは、上記とは別に append-only な世代(backup.sh の OFFSITE_CMD で S3/OCI/rclone へ1コピー、または
#   月初分を遠隔の month/ へ別退避)も併用すると安全。最低限、offsite.log のサイズ急減を時々確認すること。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

DB_FILE="${DB_PATH:-/var/data/tournament.db}"
SRC_DIR="${BACKUP_DIR:-$(dirname "$DB_FILE")/backups}"
KEY="${OFFSITE_SSH_KEY:-$HOME/.ssh/onamae_rsync}"
PORT="${OFFSITE_SSH_PORT:-22}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [offsite] $*"; }

if [ -z "${OFFSITE_DEST:-}" ]; then
  log "[ERROR] OFFSITE_DEST 未設定(user@host:~/ktta-backups/)。/etc/ktta.env に設定してください。"; exit 1
fi
if [ ! -f "$KEY" ]; then
  log "[ERROR] SSH鍵が見つかりません: $KEY (ssh-keygen で作成し、転送先に公開鍵を登録してください)"; exit 1
fi
# 安全ガード: ソースに退避対象が1つも無ければ中止(空ミラーで遠隔の既存バックアップを消さない)
shopt -s nullglob
FILES=("$SRC_DIR"/ktta-*.db.gz)
if [ ${#FILES[@]} -eq 0 ]; then
  log "[ERROR] $SRC_DIR にバックアップ(ktta-*.db.gz)がありません。先に backup.sh を実行してください。中止。"; exit 1
fi

KNOWN="${OFFSITE_KNOWN_HOSTS:-$(dirname "$KEY")/known_hosts}"
SSH_CMD="ssh -i $KEY -p $PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$KNOWN -o ConnectTimeout=20"

if command -v rsync >/dev/null 2>&1; then
  # rsync ミラー: ローカル(30日ローテ済)を遠隔へ反映。--delete でリモートも同じ30日窓に揃う(自動ローテ)。
  log "rsync ミラー: $SRC_DIR/ → $OFFSITE_DEST"
  rsync -az --delete --include='ktta-*.db.gz' --exclude='*' -e "$SSH_CMD" "$SRC_DIR"/ "$OFFSITE_DEST"
  log "[OK] rsync ミラー完了 (${#FILES[@]} 件)"
else
  # rsync 不在のフォールバック: scp で全 .db.gz を転送(リモート側ローテーションは無し)
  log "[WARN] rsync 不在 → scp で転送(リモート側の自動ローテーション無し)"
  for f in "${FILES[@]}"; do scp -i "$KEY" -P "$PORT" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$f" "$OFFSITE_DEST"; done
  log "[OK] scp 転送完了 (${#FILES[@]} 件)"
fi
