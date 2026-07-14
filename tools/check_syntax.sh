#!/bin/bash
# 全 JS/HTML の構文チェック
# 使い方: bash tools/check_syntax.sh
# 戻り値: 0=OK, 1=エラー
set -e
cd "$(dirname "$0")/.."

ERR=0

echo "=== サーバー側 JS ==="
for f in server.js db.js reports.js; do
  if [ -f "$f" ]; then
    if node --check "$f" 2>/dev/null; then
      echo "  [OK] $f"
    else
      echo "  [NG] $f"
      node --check "$f" 2>&1 | head -5 | sed 's/^/      /'
      ERR=1
    fi
  fi
done

echo ""
echo "=== クライアント側 (HTML 埋込 JS) ==="
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

for HTML in public/admin/index.html public/viewer/index.html public/viewer/live/index.html; do
  if [ ! -f "$HTML" ]; then continue; fi
  # 注意: 「python | while read」はサブシェル化して ERR=1 が親に伝わらない(NGでもSUCCESSになる事故が実在)。
  # 一覧を一時ファイル経由にしてリダイレクトで回す(同一シェル=ERRが生きる)。
  LIST="$TMP/list.txt"
  python3 -c "
import re, sys
src = open('$HTML').read()
# <script>...</script> (src 属性なし) を抽出
for i, m in enumerate(re.finditer(r'<script>\n(.*?)\n</script>', src, re.DOTALL)):
    fname = '$TMP/$(basename $HTML .html).' + str(i) + '.js'
    open(fname, 'w').write(m.group(1))
    print(fname)
" > "$LIST"
  while read f; do
    if node --check "$f" 2>/dev/null; then
      echo "  [OK] $HTML (embed #$(basename $f | sed 's/.*\.\([0-9]*\)\.js/\1/'))"
    else
      echo "  [NG] $HTML"
      node --check "$f" 2>&1 | head -5 | sed 's/^/      /'
      ERR=1
    fi
  done < "$LIST"
done

echo ""
echo "=== /shared/ 共通 JS ==="
for f in public/shared/common.js public/shared/tournament-templates.js public/shared/tie-order.js; do
  if [ -f "$f" ]; then
    if node --check "$f" 2>/dev/null; then
      echo "  [OK] $f"
    else
      echo "  [NG] $f"
      node --check "$f" 2>&1 | head -5 | sed 's/^/      /'
      ERR=1
    fi
  fi
done

if [ $ERR -eq 0 ]; then
  echo ""
  echo "[SUCCESS] 全ファイル構文 OK"
  exit 0
else
  echo ""
  echo "[FAIL] 構文エラーあり"
  exit 1
fi
