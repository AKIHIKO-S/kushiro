# 🌐 ホスティング選択ガイド

## なぜ GitHub Pages 単独では動かないか

GitHub Pages は **静的ファイル配信のみ**。サーバー側で:
- データを書き込む API (試合結果記録)
- SQLite データベースの保持
- 認証 (管理キー)

これらが必要なので、**バックエンドが動くホスティング** が要ります。

ただし「フロントエンドは GitHub Pages、バックエンド API は別の所」というハイブリッド構成は可能です。詳しくは後述。

---

## 🏆 推奨度ランキング

### 🥇 第1位: Render.com (¥1,000/月)

**この用途には最適**。すでにこのリポジトリに `render.yaml` が同梱されているので、GitHub から繋ぐだけで完了。

| 項目 | 内容 |
|------|------|
| 月額 | $7 Starter プラン (永続ディスク必須) |
| デプロイ | Git push で自動デプロイ |
| DB | SQLite (1GB永続ディスク標準) |
| リージョン | Singapore / Oregon / Frankfurt |
| 設定変更 | コード変更不要、`render.yaml` のみ |
| 帯域 | 100GB/月 含む |

**手順:**
```bash
# 1. このコードを GitHub にpush
git remote add origin https://github.com/YOUR_NAME/tabletennis.git
git push -u origin main

# 2. https://dashboard.render.com/ にログイン
# 3. New → Blueprint → このリポジトリ選択 → render.yaml 自動検出 → デプロイ
# 4. ADMIN_KEY が自動生成されるのでメモ
# 5. https://tabletennis-XXXX.onrender.com/admin で開く
```

**長所:** 設定が楽、SQLiteそのまま、無料SSL、自動スリープなし
**短所:** 月額発生、無料プランは15分操作なしでスリープ

---

### 🥈 第2位: Fly.io (無料〜月¥500程度)

**ほぼ無料で動かしたい場合**。Dockerfile 同梱済。

| 項目 | 内容 |
|------|------|
| 月額 | 無料枠あり (256MB VM + 1GB volume) / 軽い大会なら無料 |
| デプロイ | `fly deploy` 一発 |
| DB | SQLite (Volumes で永続化) |
| リージョン | 東京(nrt) 選択可 |

**手順:**
```bash
# Fly CLI インストール
brew install flyctl
fly auth signup

# 初回デプロイ
cd tabletennis
fly launch --no-deploy   # Dockerfile を検出、対話設定
fly volumes create tabletennis_data --size 1 --region nrt
fly secrets set ADMIN_KEY=$(openssl rand -hex 32)
# fly.toml の [mounts] に追加:
#   source = "tabletennis_data"
#   destination = "/data"
fly deploy
```

**長所:** 無料枠で200人規模の大会1日運用ok、東京リージョン、応答速い
**短所:** クレカ登録必須、無料枠超過で課金

---

### 🥉 第3位: さくらVPS / ConoHa VPS (¥500〜)

**国内データ主権を重視する場合**。OS 全制御可。

| 項目 | 内容 |
|------|------|
| 月額 | ¥600〜 (1GB プラン) |
| デプロイ | SSH で手動 or systemd |
| DB | SQLite or PostgreSQL 何でもOK |
| リージョン | 国内 (東京/大阪/石狩) |

**手順:** Node.js + nginx を入れて systemd でサービス化。本リポジトリ内の `Dockerfile` を参考にすれば再現可能。

**長所:** 完全な自由度、独自ドメインも安価、データは国内
**短所:** 自分でOS管理が必要、SSL は Let's Encrypt 手動設定

---

## 💡 完全無料で動かしたい場合の選択肢

### A. GitHub Actions + Issues データベース (非推奨)

データ書き込みを GitHub の issue / commits に保存。技術的には可能だが速度遅く競合多発。**運営アプリには不適**。

### B. Google Apps Script + Sheets (gas/ に実装あり)

このリポジトリの `gas/` フォルダに参考実装あり。Sheets を DB として使う構成。
- ✅ 完全無料
- ✅ 認証もGoogle連携
- ❌ 速度遅い (1リクエスト1-2秒)
- ❌ SQL風クエリは自前実装が必要

**用途:** 小規模(50人以下)・年1-2回開催の大会向け。

### C. Cloudflare Pages + D1 (要DBレイヤ書き換え)

- ✅ 完全無料 (D1: 100k reads, 1k writes/日まで)
- ✅ Cloudflareの高速CDN
- ❌ SQLite → D1 (Cloudflare's SQLite) への移行が必要
- ❌ コードを Workers 用に書き換え必要

**労力:** 1-2日のコード移植作業。完成すれば運用コスト 0 円。

---

## 📊 ユースケース別おすすめ

| あなたの状況 | おすすめ |
|--------------|----------|
| とにかく簡単に始めたい | **Render.com** ($7/月) ← 推奨 |
| お金を1円も払いたくない、200人以下の大会 | **Fly.io** 無料枠 |
| 国内サーバー必須、複数大会で年間運用 | **さくら/ConoHa VPS** (¥600/月) |
| 年1回の小規模イベントのみ | **GAS版** (無料) |
| 開発時間に余裕あり、運用は無料がいい | **Cloudflare Pages+D1** (要書換) |
| 既存環境(社内サーバー等)があるか? | 自前 Docker run |

---

## 🔀 ハイブリッド構成 (GitHub Pagesを生かしたい場合)

「閲覧画面は GitHub Pages で公開、書き込みAPIだけ別ホスト」も可能:

```
┌──────────────────────────┐         ┌──────────────────────┐
│  GitHub Pages (無料)     │         │  Render / Fly        │
│  /viewer (読み取り専用)  │ ──API─→ │  バックエンド API    │
│  独自ドメインOK          │         │  + SQLite           │
└──────────────────────────┘         └──────────────────────┘
```

**メリット:**
- 観客向け閲覧画面は CDN 高速 (GitHub Pages)
- ベンダー側コストは API ホスト分のみ
- 独自ドメイン (例: 大会名.example.com) を GitHub Pages に向けられる

**実装手順:**
1. `public/viewer/index.html` の `api.baseUrl = "https://tabletennis.onrender.com"` に書き換え
2. `public/viewer/` だけを別の GitHub リポジトリ (gh-pages) に push
3. CORS は server.js で既に `*` 許可済みなのでそのまま動く

---

## 🎯 私の最終推奨

**まず Render.com で動かす ($7/月、即運用可能)。**

理由:
- 設定ファイル(render.yaml)が既に整備済み
- SQLite ファイルがそのまま使える → 既存データを失わない
- 自動デプロイ・自動SSL・自動バックアップ可能
- 大会の数日前にデプロイ、本番稼働、終わったら一時停止($0)もできる

その後、年間運用コストが気になるなら Fly.io 無料枠への移行や、独自VPSへの引っ越しは比較的容易です (SQLite ファイルを scp するだけ)。

データ移行や運用支援が必要な場合は別途相談してください。
