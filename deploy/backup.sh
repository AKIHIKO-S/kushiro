#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - SQLite DB 自動バックアップ
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 使い方:
#   crontab -e に次の行を追加して毎日午前2時実行
#     0 2 * * * /opt/ktta/deploy/backup.sh
#
# 保存先: $BACKUP_DIR (デフォルト ./backups)
# ローテーション: 30日分保持
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

# 既定値
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# DB の場所: DB_FILE 明示 > DB_PATH(env) > Oracle本番(/var/data) > ローカル(data/) の順に自動判定。
# 旧既定 $APP_DIR/tabletennis.db は実在せずバックアップが失敗していたため修正。
if [ -z "${DB_FILE:-}" ]; then
  if [ -n "${DB_PATH:-}" ] && [ -f "$DB_PATH" ]; then DB_FILE="$DB_PATH"
  elif [ -f /var/data/tournament.db ]; then DB_FILE="/var/data/tournament.db"
  else DB_FILE="$APP_DIR/data/tournament.db"; fi
fi
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB_FILE")/backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
LOG_FILE="${LOG_FILE:-$BACKUP_DIR/backup.log}"

mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

if [ ! -f "$DB_FILE" ]; then
  log "[ERROR] DB ファイルが見つかりません: $DB_FILE"
  exit 1
fi

# タイムスタンプ付きファイル名
STAMP=$(date '+%Y%m%d-%H%M%S')
BACKUP_FILE="$BACKUP_DIR/ktta-$STAMP.db.gz"

# SQLite VACUUM INTO で整合性のあるバックアップ作成
# (実行中のサーバーがあっても WAL モードで安全にコピー可能)
TMP_DB="$BACKUP_DIR/.tmp-$STAMP.db"
if command -v sqlite3 >/dev/null 2>&1; then
  log "sqlite3 VACUUM INTO でバックアップ中..."
  sqlite3 "$DB_FILE" "VACUUM INTO '$TMP_DB'"
  gzip -9 "$TMP_DB"
  mv "$TMP_DB.gz" "$BACKUP_FILE"
else
  # フォールバック: 単純コピー (停止時推奨)
  log "[WARN] sqlite3 コマンドが無いため単純コピー (実行中の場合 WAL がコピーされない可能性)"
  gzip -9 -c "$DB_FILE" > "$BACKUP_FILE"
fi

SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "?")
log "[OK] バックアップ完了: $BACKUP_FILE (${SIZE} bytes)"

# 30日より古いファイルを削除
find "$BACKUP_DIR" -name 'ktta-*.db.gz' -type f -mtime +$KEEP_DAYS -delete
DELETED=$(find "$BACKUP_DIR" -name 'ktta-*.db.gz' -type f -mtime +$KEEP_DAYS | wc -l | tr -d ' ')
log "ローテーション: ${KEEP_DAYS}日以上前のファイル削除 ($DELETED 件)"

# 最終ステータス: 現状のバックアップ数
COUNT=$(find "$BACKUP_DIR" -name 'ktta-*.db.gz' -type f | wc -l | tr -d ' ')
log "現在のバックアップ保持数: $COUNT 件"
