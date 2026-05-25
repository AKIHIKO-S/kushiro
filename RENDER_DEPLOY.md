# Render.com デプロイ手順 — KTTA Platform

GitHub にプッシュ → Render が自動デプロイ → HTTPS の URL を Jimdo に貼付け、の流れ。
所要時間: **約15分**。

---

## 0. 前提

- GitHub にこのリポジトリが push 済 (private/public どちらでも OK)
- Jimdo の公式サイトが既にある (kushirotta.jp 等)
- Render のアカウント (GitHub 認証で 1分)

---

## 1. Render.com アカウント作成・連携 (3分)

1. https://dashboard.render.com/ にアクセス
2. **「Sign Up with GitHub」** をクリック → GitHub 認証
3. リポジトリへのアクセス許可 (このリポジトリだけ選択可)

---

## 2. Blueprint で一括デプロイ (5分)

このリポジトリには `render.yaml` が既に含まれており、Web Service・永続ディスク・環境変数を自動構成します。

1. Dashboard 左メニュー → **「Blueprints」** → **「New Blueprint Instance」**
2. リポジトリを選択 (`your-org/tabletennis`)
3. **「Apply」** をクリック
4. 数分後に `ktta-platform` サービスが作成され、自動デプロイ開始

### 自動構成される内容
| 項目 | 値 |
|---|---|
| サービス名 | `ktta-platform` |
| Region | Singapore (日本に最も近い) |
| プラン | Starter ($7/月、永続ディスク用) |
| ビルド | `npm install --production` |
| 起動 | `npm start` |
| 永続ディスク | 1 GB マウント先 `/var/data` |
| ADMIN_KEY | Render が自動生成 (Dashboard で確認) |
| TZ | Asia/Tokyo |

### Free プランで試したい場合
`render.yaml` の `plan: starter` を `plan: free` に変更してプッシュ。
ただし **Free プランは永続ディスク非対応** — サーバー再起動で DB が消えるため大会本番には不向き。
お試し1〜2大会のみで運用するなら問題なし。

---

## 3. デプロイ完了確認 (2分)

1. Dashboard → サービス `ktta-platform` → **「Logs」** タブ
2. 数分後、最後に次のような行が出ればOK:
   ```
   🏓 卓球大会運営アプリ 起動中
      閲覧画面:  http://localhost:10000/viewer
      管理画面:  http://localhost:10000/admin
   ```
3. URL は Dashboard 上部の `https://ktta-platform-xxxx.onrender.com` 形式で確認

---

## 4. 管理キーの取得 (1分)

1. Dashboard → サービス → **「Environment」** タブ
2. **`ADMIN_KEY`** の値をコピー (例: `a3f7c2e89b...`)

---

## 5. KTTA Platform 初期設定 (3分)

1. `https://ktta-platform-xxxx.onrender.com/admin/` を開く
2. 設定 (⚙) ボタン → **管理キー** を貼付け → 保存
3. 本番URL設定 ボタン → デプロイ URL を入力 → 保存
4. 印鑑画像をアップロード (任意、領収書用)

**本番準備チェックリスト** がすべて緑になればOK。

---

## 6. Jimdo に申込フォームを貼付け (2分)

1. KTTA Platform 管理画面 → 大会を作成
2. 「申込フォーム生成 / 埋込コード」 → コードをコピー
3. Jimdo (kushirotta.jp) の編集モードで:
   - ページ → 「+ コンテンツ追加」 → 「ウィジェット/HTML」
   - 貼付け → 保存
4. 即座にフォーム表示 (HTTPS 必須なし、自己完結型なので Jimdo OK)

---

## 7. 観戦ビューを公開 (任意)

大会当日に参加者・保護者に共有:
- URL: `https://ktta-platform-xxxx.onrender.com/viewer/live/?t={大会ID}`
- 管理画面の「観戦ビュー / リアルタイム共有」 → QRコード取得
- Jimdo の大会案内ページにこの URL/QR を貼付け可能

---

## 8. カスタムドメイン (任意)

`ktta-platform-xxxx.onrender.com` ではなく `ktta.kushirotta.jp` のような独自サブドメインで運用したい場合:

1. Render Dashboard → サービス → **「Settings」** → **「Custom Domains」**
2. `ktta.kushirotta.jp` を追加
3. DNS (Jimdo のドメイン管理 or 別途) で CNAME レコード追加:
   ```
   ktta.kushirotta.jp.  CNAME  ktta-platform-xxxx.onrender.com.
   ```
4. Render が自動で Let's Encrypt SSL を取得

---

## 9. 継続運用

### コード更新
ローカルで変更 → GitHub にプッシュ → Render が自動で再デプロイ。
```bash
git add . && git commit -m "feat: 新機能" && git push
```

### 環境変数の追加・変更
Dashboard → サービス → Environment → 編集 → Save → 自動再デプロイ

### バックアップ
Render の永続ディスクは Render 側で自動冗長化されていますが、念のため:
- 大会前日: 管理画面 → 集計表 + ブラケット JSON エクスポート
- 月1回: SSH or Shell から `npm run backup`

### ログ確認
Dashboard → サービス → Logs (リアルタイム表示)

### サーバー再起動
Dashboard → サービス → Manual Deploy → Restart

---

## 10. 料金まとめ

| プラン | 月額 | 用途 |
|---|---|---|
| Free | $0 | お試し (永続ディスク無し、15分スリープ) |
| **Starter** ★ | **$7** | **本番運用 (永続ディスク 1GB + 常時稼働)** |
| Standard | $25 | 高負荷時 (50名以上の同時アクセス) |

**釧路卓球協会様の規模なら Starter で十分です。**
年間 ¥12,000 程度で全機能フル稼働可能。

---

## トラブルシューティング

### デプロイが失敗する
- Logs タブで `npm install` のエラーを確認
- Node.js バージョン: `package.json` の `engines.node` が 18+ になっているか
- better-sqlite3 のビルドエラー: Free プランでは時間がかかるため再試行

### 永続ディスクが認識されない
- Free プランでは永続ディスク使えない (Starter 以上)
- `render.yaml` で `disk:` セクションが正しく設定されているか確認

### 管理画面で「管理キーが違います」
- Dashboard の Environment → ADMIN_KEY 値を確認 (改行/空白注意)
- ブラウザの localStorage をクリアして再入力

### Jimdo でフォームが表示されない
- 管理画面 → 申込フォーム生成 → プラットフォーム=**Jimdo (推奨)** を選択
- Jimdo モードは iframe 不使用なので HTTPS 問題は発生しません

### 大会日の前に動作確認
- 1週間前: ダミー大会を作成 → 申込フォーム → 進行管理 まで一通り確認
- 前日: 集計表ダウンロード・領収書発行 まで確認
- 当日: 観戦ビューを実機 (iPhone/Android) で確認

---

## サポート

- 不具合報告: GitHub Issues
- Render の障害情報: https://status.render.com/
- 緊急時の連絡先: 開発者
