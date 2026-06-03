#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - DB 復元スクリプト
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 使い方:
#   ./restore.sh                    # 最新バックアップから復元
#   ./restore.sh 20260711-020001    # 指定バックアップから復元
#   ./restore.sh --list             # 一覧表示
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
# DB の場所は backup.sh と同一ロジックで自動判定(ここを取り違えると当日復旧が空振り/誤パス書込で失敗する)。
# DB_FILE 明示 > DB_PATH(env) > Oracle本番(/var/data) > ローカル(data/) の順。
if [ -z "${DB_FILE:-}" ]; then
  if [ -n "${DB_PATH:-}" ] && [ -f "$DB_PATH" ]; then DB_FILE="$DB_PATH"
  elif [ -f /var/data/tournament.db ]; then DB_FILE="/var/data/tournament.db"
  else DB_FILE="$APP_DIR/data/tournament.db"; fi
fi
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$DB_FILE")/backups}"
SERVICE_NAME="${SERVICE_NAME:-ktta}"

usage() {
  cat <<EOF
KTTA Platform DB 復元スクリプト

  $0                  最新バックアップから復元
  $0 <タイムスタンプ>   例: 20260711-020001
  $0 --list           バックアップ一覧表示
  $0 --help           このヘルプ
EOF
}

list_backups() {
  echo "保存済みバックアップ ($BACKUP_DIR):"
  ls -lh "$BACKUP_DIR"/ktta-*.db.gz 2>/dev/null \
    | awk '{print "  " $9 "  " $5 "  " $6 " " $7 " " $8}' \
    || echo "  (バックアップなし)"
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --list|-l) list_backups; exit 0 ;;
esac

# 復元元のバックアップファイル選定
STAMP="${1:-}"
if [ -z "$STAMP" ]; then
  # 最新を選ぶ
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/ktta-*.db.gz 2>/dev/null | head -1 || true)
  if [ -z "$BACKUP_FILE" ]; then
    echo "[ERROR] バックアップファイルがありません ($BACKUP_DIR)"
    exit 1
  fi
elif [ -f "$STAMP" ]; then
  # フルパス/.gz ファイルを直接指定(docs の例や別ロケーションから取得したファイルに対応)
  BACKUP_FILE="$STAMP"
else
  BACKUP_FILE="$BACKUP_DIR/ktta-$STAMP.db.gz"
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "[ERROR] 指定されたバックアップが見つかりません: $BACKUP_FILE"
    list_backups
    exit 1
  fi
fi

echo "================================================"
echo "  KTTA Platform DB 復元"
echo "================================================"
echo "  復元元: $BACKUP_FILE"
echo "  復元先: $DB_FILE"
echo "------------------------------------------------"
echo ""
read -p "上記の内容で復元しますか? (現在の DB は上書きされます) [yes/N]: " ANSWER
if [ "$ANSWER" != "yes" ]; then
  echo "中断しました。"
  exit 0
fi

# 現状の DB を退避
if [ -f "$DB_FILE" ]; then
  SAFE_STAMP=$(date '+%Y%m%d-%H%M%S')
  SAFE_FILE="$BACKUP_DIR/before-restore-$SAFE_STAMP.db"
  echo "[1/3] 現在の DB を退避 → $SAFE_FILE"
  cp "$DB_FILE" "$SAFE_FILE"
fi

# サーバー停止 (systemctl が使える場合)
RESTART_NEEDED=false
if command -v systemctl >/dev/null && systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "[2/3] $SERVICE_NAME サービス停止"
  sudo systemctl stop "$SERVICE_NAME"
  RESTART_NEEDED=true
fi

# 復元
echo "[3/3] バックアップから復元中..."
gunzip -c "$BACKUP_FILE" > "$DB_FILE"

# WAL/SHM ファイル削除 (古い WAL とDBの不整合回避)
rm -f "${DB_FILE}-wal" "${DB_FILE}-shm"

# サーバー再起動
if [ "$RESTART_NEEDED" = "true" ]; then
  echo "サービス再起動"
  sudo systemctl start "$SERVICE_NAME"
fi

echo ""
echo "[完了] 復元が完了しました。"
echo "管理画面 https://yourdomain/admin/ で動作確認してください。"
