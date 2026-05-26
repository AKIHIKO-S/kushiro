#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# KTTA Platform - Ubuntu VPS 一括セットアップ スクリプト
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 使い方:
#   1. Ubuntu 22.04 LTS の VPS を用意 (Vultr/Sakura/Lightsail/etc)
#   2. SSH 接続して以下を実行:
#       wget https://raw.githubusercontent.com/your-org/tabletennis/main/deploy/install.sh
#       chmod +x install.sh
#       sudo ./install.sh kttatakkyu.example.com  ← ドメイン名
#
# 要件:
#   - root or sudo 権限
#   - DNS が VPS の IP に向いていること
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

DOMAIN="${1:-}"
REPO_URL="${REPO_URL:-https://github.com/your-org/tabletennis.git}"
APP_DIR="/opt/ktta"
APP_USER="ktta"

if [ -z "$DOMAIN" ]; then
  echo "使い方: sudo $0 <ドメイン名>"
  echo "例:    sudo $0 kttatakkyu.example.com"
  exit 1
fi

if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] このスクリプトは sudo/root で実行してください"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  KTTA Platform セットアップ"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ドメイン: $DOMAIN"
echo "  インストール先: $APP_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
sleep 2

# 1. システム更新 + 依存パッケージ
echo "[1/7] システム更新+依存パッケージ"
apt update -y
apt install -y curl git nginx certbot python3-certbot-nginx sqlite3 python3 python3-pip

# 2. Node.js 20.x インストール
echo "[2/7] Node.js 20.x インストール"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v2[0-9]"; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi
node -v

# 3. Python パッケージ (Excel パーサー用)
echo "[3/7] Python パッケージ"
pip3 install --quiet openpyxl

# 4. アプリユーザー + ディレクトリ
echo "[4/7] アプリユーザー作成"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin -d "$APP_DIR" -m "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

# 5. アプリ取得 + 依存インストール
echo "[5/7] アプリ取得 + npm install"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" git pull
sudo -u "$APP_USER" npm install --omit=dev

# 6. 環境変数 + systemd
echo "[6/7] systemd + 環境設定"
if [ ! -f /etc/ktta.env ]; then
  ADMIN_KEY=$(openssl rand -hex 16)
  cat > /etc/ktta.env <<EOF
NODE_ENV=production
PORT=3000
ADMIN_KEY=$ADMIN_KEY
EOF
  chmod 600 /etc/ktta.env
  echo "  >> 管理キー (大切に保管): $ADMIN_KEY"
fi

cp "$APP_DIR/deploy/ktta.service" /etc/systemd/system/ktta.service
systemctl daemon-reload
systemctl enable --now ktta

# 7. Nginx + HTTPS
echo "[7/7] Nginx + HTTPS (Let's Encrypt)"
# ドメインを設定ファイルに反映
sed "s/kttatakkyu.example.com/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/ktta
ln -sf /etc/nginx/sites-available/ktta /etc/nginx/sites-enabled/ktta
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

# Oracle Cloud などで iptables も開放 (Ubuntu 22.04 デフォルト)
if command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT 2>/dev/null || true
  iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save 2>/dev/null || true
  fi
fi

# Let's Encrypt HTTPS (DNSが反映されてない場合はスキップ)
echo ""
echo "DNS 反映確認..."
if host "$DOMAIN" >/dev/null 2>&1; then
  echo "Let's Encrypt 証明書取得中..."
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect || \
    echo "[警告] HTTPS 化失敗。DNS 反映後に手動で: sudo certbot --nginx -d $DOMAIN"
else
  echo "[スキップ] DNS が未反映。後ほど手動で実行:"
  echo "         sudo certbot --nginx -d $DOMAIN"
fi

# Cron バックアップ
crontab -u "$APP_USER" -l 2>/dev/null > /tmp/cron-ktta || true
if ! grep -q backup.sh /tmp/cron-ktta; then
  echo "0 2 * * * $APP_DIR/deploy/backup.sh" >> /tmp/cron-ktta
  crontab -u "$APP_USER" /tmp/cron-ktta
  echo "  >> Cron 設定: 毎日 02:00 にバックアップ"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  セットアップ完了!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  管理画面:    https://$DOMAIN/admin/"
echo "  観戦ビュー:  https://$DOMAIN/viewer/live/"
echo "  管理キー:    /etc/ktta.env を確認 ($(grep ADMIN_KEY /etc/ktta.env))"
echo ""
echo "  ログ確認:    sudo journalctl -u ktta -f"
echo "  再起動:      sudo systemctl restart ktta"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
