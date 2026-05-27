#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Render → Oracle Cloud DB 移行 ヘルパー
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 使い方 (Oracle VM 上で実行):
#   1. Render の「Shell」タブで:
#        bash /opt/ktta/deploy/dump-db-base64.sh > /tmp/db.b64
#   2. /tmp/db.b64 の内容をコピー
#   3. Oracle VM で:
#        sudo bash /opt/ktta/deploy/migrate-from-render.sh
#      → プロンプトで Base64 文字列を貼り付け → Enter
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/data}"
DB_PATH="${DB_PATH:-$DATA_DIR/tournament.db}"
BACKUP_DIR="$DATA_DIR/backups"
APP_USER="${APP_USER:-ktta}"

if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] sudo で実行してください"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# 既存 DB のバックアップ
if [ -f "$DB_PATH" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  echo "[1/4] 既存 DB をバックアップ: $BACKUP_DIR/tournament-${TS}.db.gz"
  gzip -c "$DB_PATH" > "$BACKUP_DIR/tournament-${TS}.db.gz"
fi

echo ""
echo "Render の「Shell」タブで以下を実行し、出力された Base64 文字列をコピーしてください:"
echo ""
echo "  cd /var/data && sqlite3 tournament.db '.backup /tmp/render.db' && base64 -w 0 /tmp/render.db"
echo ""
echo "Base64 文字列をここに貼り付けて Enter を押してください (Ctrl+D で終了):"
echo ""

# 標準入力から Base64 文字列を読み取り
B64=$(cat)
if [ -z "$B64" ]; then
  echo "[ERROR] Base64 文字列が空です"
  exit 1
fi

# サービス停止
echo "[2/4] サービス停止"
systemctl stop ktta || true

# 復元
echo "[3/4] DB 復元"
echo "$B64" | base64 -d > "$DB_PATH.new"
# SQLite 整合性チェック
sqlite3 "$DB_PATH.new" "PRAGMA integrity_check;" | grep -q "^ok$" || {
  echo "[ERROR] DB 整合性チェック失敗"
  rm -f "$DB_PATH.new"
  systemctl start ktta
  exit 1
}
mv "$DB_PATH.new" "$DB_PATH"
chown "$APP_USER:$APP_USER" "$DB_PATH"

# 統計表示
TBL_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table';")
PLAYER_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM players;" 2>/dev/null || echo 0)
TOURN_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM tournaments;" 2>/dev/null || echo 0)
MATCH_COUNT=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM matches;" 2>/dev/null || echo 0)

# サービス起動
echo "[4/4] サービス起動"
systemctl start ktta
sleep 2
systemctl is-active --quiet ktta && echo "  OK: ktta サービス稼働中" || echo "  [警告] サービス起動失敗。journalctl -u ktta を確認"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DB 移行完了"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  テーブル数: $TBL_COUNT"
echo "  選手数: $PLAYER_COUNT"
echo "  大会数: $TOURN_COUNT"
echo "  試合数: $MATCH_COUNT"
echo ""
echo "  ブラウザで動作確認: curl -sI http://localhost:3000/api/health"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
