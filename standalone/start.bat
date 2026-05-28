@echo off
REM ===============================================================
REM  KTTA Platform - オンプレ起動 (Windows)
REM  このファイルをダブルクリックすると、ローカルPCでサーバーが起動します。
REM  インターネット不要 (申込フォーム/GAS連携を除く)。データは data\ に保存。
REM ===============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."
echo ===============================================
echo  KTTA Platform - オンプレ起動
echo  場所: %CD%
echo ===============================================

REM 1) Node.js 確認
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [エラー] Node.js が見つかりません。
  echo https://nodejs.org/ja から LTS 版をインストールしてから、もう一度開いてください。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo [OK] Node.js %%v

REM 2) 依存パッケージ (初回のみ)
if not exist node_modules (
  echo [初回セットアップ] 依存パッケージをインストールします...
  call npm install --omit=dev
)

REM 3) 管理キー (.env.local) - 無ければ自動生成
if not exist .env.local (
  for /f "delims=" %%k in ('node -e "console.log(require('crypto').randomBytes(12).toString('hex'))"') do set GENKEY=%%k
  echo ADMIN_KEY=!GENKEY!> .env.local
  echo.
  echo   ★ 管理キーを生成しました: !GENKEY!
  echo     管理画面 (/admin) で最初にこのキーを入力してください。
  echo.
)
REM .env.local から ADMIN_KEY を読み込む
for /f "usebackq tokens=1,* delims==" %%a in (".env.local") do (
  if "%%a"=="ADMIN_KEY" set ADMIN_KEY=%%b
)
set NODE_ENV=production
if "%PORT%"=="" set PORT=3000

REM 4) ブラウザを開いて起動
echo.
echo 起動中... ブラウザで以下を開きます:
echo   管理:   http://localhost:%PORT%/admin/
echo   観戦:   http://localhost:%PORT%/viewer/
echo   大画面: http://localhost:%PORT%/viewer/live/
echo.
echo 終了するには この画面で Ctrl+C を押すか、ウィンドウを閉じてください。
echo ===============================================
start "" "http://localhost:%PORT%/admin/"
node server.js
