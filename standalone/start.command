#!/bin/bash
# ═══════════════════════════════════════════════════════════
# KTTA Platform — オンプレ起動 (macOS / Linux)
# このファイルをダブルクリックすると、ローカルPCでサーバーが起動します。
# インターネット不要 (申込フォーム/GAS連携を除く)。データは data/ に保存。
# ═══════════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")/.."   # リポジトリ(アプリ)ルートへ
APPDIR="$(pwd)"
echo "==============================================="
echo " KTTA Platform — オンプレ起動"
echo " 場所: $APPDIR"
echo "==============================================="

# 1) Node.js 確認
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[エラー] Node.js が見つかりません。"
  echo "https://nodejs.org/ja から LTS 版をインストールしてから、もう一度開いてください。"
  echo ""
  read -n 1 -s -r -p "何かキーを押すと閉じます..."
  exit 1
fi
echo "[OK] Node.js $(node -v)"

# 2) 依存パッケージ (初回のみ・オフラインなら node_modules を同梱しておく)
if [ ! -d node_modules ]; then
  echo "[初回セットアップ] 依存パッケージをインストールします..."
  npm install --omit=dev
fi

# 3) 管理キー (.env.local) — 無ければ自動生成
if [ ! -f .env.local ]; then
  KEY=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
  echo "ADMIN_KEY=$KEY" > .env.local
  echo ""
  echo "  ★ 管理キーを生成しました: $KEY"
  echo "    管理画面 (/admin) で最初にこのキーを入力してください。"
  echo "    (.env.local に保存。LAN内の他PCから操作されないための鍵です)"
  echo ""
fi
# .env.local を環境変数へ
set -a; . ./.env.local; set +a
export NODE_ENV=production
export PORT="${PORT:-3000}"

# 4) 起動 + ブラウザを開く
( sleep 2; (open "http://localhost:${PORT}/admin/" 2>/dev/null || xdg-open "http://localhost:${PORT}/admin/" 2>/dev/null) ) &
echo ""
echo "起動中... ブラウザで以下を開きます:"
echo "  管理:   http://localhost:${PORT}/admin/"
echo "  観戦:   http://localhost:${PORT}/viewer/"
echo "  大画面: http://localhost:${PORT}/viewer/live/"
echo ""
echo "同じWi-Fiの他の端末からは、このPCのIPアドレスで開けます:"
node -e "const os=require('os');const ns=os.networkInterfaces();for(const k in ns)for(const n of ns[k])if(n.family==='IPv4'&&!n.internal)console.log('  http://'+n.address+':'+(process.env.PORT||'3000')+'/viewer/live/');" 2>/dev/null || true
echo ""
echo ""
echo "※ 会場運用: 本PCのWi-Fiテザリング(ホットスポット)か モバイルルータで会場内ローカル網を作り、"
echo "   他の運営端末/大画面/観客を上記IPで接続してください。会場Wi-Fiが落ちても運用は止まりません。"
echo "   接続用のURL/QRは 管理画面 → ⚙設定 → 『📱端末接続(会場LAN)』 でも表示できます。"
echo ""
echo "終了するには この画面で Ctrl+C を押してください。"
echo "==============================================="
# 大会中に本PCがスリープすると全端末が止まるため、可能なら省電力スリープを抑止して起動する(macOS: caffeinate)。
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -is node server.js
else
  node server.js
fi
