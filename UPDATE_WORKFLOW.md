# 本番更新ワークフロー — KTTA Platform

本番運用しながらコード修正・即時反映するための実践ガイド。

---

## 1. 全体フロー

```
[ローカル動作確認] → [git push] → [Render 自動デプロイ] → [本番確認] → [問題あればロールバック]
        ↑                                                              ↓
        └──────────────────── 修正 ←───────────────────────────────────┘
```

**所要時間**: コード変更 → 本番反映まで通常 **3〜5分**。

---

## 2. 標準的な修正サイクル (推奨)

### ステップ1: ローカルで確認
```bash
cd ~/Desktop/claude/tabletennis
npm run dev
# → http://localhost:3000/admin/ で動作確認
```

### ステップ2: コード修正
任意のファイルを編集。

### ステップ3: 構文チェック
```bash
bash tools/check_syntax.sh
```
全ファイル OK が出ることを確認。

### ステップ4: ローカル再確認
ブラウザリロード (`npm run dev` は変更を自動反映しないので Ctrl+C → 再起動)。

### ステップ5: GitHub にプッシュ
```bash
git add .
git commit -m "fix: バグ修正の内容を簡潔に"
git push
```

### ステップ6: Render が自動デプロイ (3〜5分)
ブラウザで Render Dashboard を開く:
- https://dashboard.render.com/web/srv-XXXXX/deploys
- 「Live」になるまで待つ

### ステップ7: 本番で動作確認
本番URL `https://ktta-platform-xxxx.onrender.com/admin/` を開く
- 設定 (⚙) → **「本番診断パネルを開く」** で状態確認

---

## 3. リアルタイム監視ツール

### A. Render Logs (リアルタイム ログ)
Render Dashboard → サービス → **Logs** タブ
- console.log / console.error がすべて表示
- 検索可能 (時刻・キーワード)
- 過去7日間保持

### B. 本番診断パネル (admin 内蔵)
管理画面 → 設定 (⚙) → **「本番診断パネルを開く」**
- ✅ サーバー稼働時間・Node バージョン・メモリ使用量
- ✅ DB サイズ・大会数・選手数・試合数
- ✅ 総リクエスト数・エラー数・エラー率
- ✅ 直近10件のエラー (stack trace 込み)
- ✅ 直近30件のリクエスト履歴 (method/URL/status/応答時間)
- 10秒ごと自動更新

### C. ヘルスチェック (誰でも閲覧可能)
```bash
curl https://ktta-platform-xxxx.onrender.com/api/health
```
DB 状態・メモリ・アップタイム が JSON で返る。
監視サービス (UptimeRobot 等) との連携可能。

---

## 4. ホットフィックス手順 (大会当日の緊急修正)

大会中にバグ発見 → 即座に修正反映:

```bash
# ステップ1: ローカルで修正
vim server.js   # 例

# ステップ2: 構文確認
bash tools/check_syntax.sh

# ステップ3: ローカルで素早く動作確認
node server.js &
curl http://localhost:3000/api/health
kill %1

# ステップ4: プッシュ
git add . && git commit -m "hotfix: 大会当日緊急修正 - XXX" && git push

# ステップ5: Render Dashboard で デプロイ状態を確認
open https://dashboard.render.com/

# ステップ6: 約3-5分後に本番反映 → 動作確認
```

**重要**: 大会当日のホットフィックスは可能な限り避け、回避策で凌ぐことを推奨。
事前に dev/staging で検証を済ませる。

---

## 5. ロールバック方法

問題のあるデプロイを元に戻したい場合:

### A. Render Dashboard でロールバック (最も簡単)
1. Render Dashboard → サービス → **Deploys** タブ
2. 1つ前の "Live" だったデプロイを選択
3. **「Rollback to this deploy」** をクリック
4. 30秒で元のバージョンに復帰

### B. Git revert (バージョン管理上)
```bash
# 直前のコミットを取り消す
git revert HEAD
git push
# → Render が自動でデプロイ
```

### C. 強制リセット (緊急)
```bash
# 特定のコミットに戻す
git reset --hard <commit_hash>
git push --force-with-lease
# ※ 履歴破壊なので慎重に
```

---

## 6. ブランチ戦略 (オプション)

複数の機能を並行開発したい場合:

### シンプル運用 (現在の設定)
- **main** ブランチ = 本番 (Render auto-deploy)
- すべての変更を直接 main にコミット
- 適: 1人開発・小規模

### 安全運用 (Pull Request 経由)
- **main** = 本番
- **dev** = 開発・テスト
- feature/* = 機能ブランチ
- 流れ:
  ```bash
  git checkout -b feature/awesome-feature
  # 開発
  git push origin feature/awesome-feature
  # GitHub で PR 作成 → レビュー → main にマージ
  ```
- 適: 複数人開発・本番が安定している必要がある場合

### ステージング環境 (お試し)
Render で 2つ目のサービスを立てる:
1. Dashboard → New → Web Service
2. 同じリポを選択
3. Branch: `dev` を指定
4. 名前: `ktta-platform-staging`
5. main にマージ前に staging で確認

---

## 7. よく使うコマンド集

### ローカル
```bash
# 開発サーバー起動
npm run dev

# 構文チェック
bash tools/check_syntax.sh

# DBバックアップ
npm run backup

# DB復元
bash deploy/restore.sh --list
bash deploy/restore.sh 20260711-020001
```

### Git
```bash
# 通常のコミット
git add . && git commit -m "メッセージ" && git push

# 1行コミット
git commit -am "fix: typo" && git push

# 直前を取り消し (push前)
git reset --soft HEAD~

# 直前を取り消し (push後 - 慎重に)
git revert HEAD && git push
```

### Render CLI (オプション)
Render CLI をインストールすれば、ターミナルから直接操作可能:
```bash
# インストール: brew install render
render login
render services list
render logs --service ktta-platform --tail
render restart --service ktta-platform
```

---

## 8. 監視・通知設定 (推奨)

### A. メール通知 (Render組込)
Dashboard → Settings → Notifications
- デプロイ成功/失敗
- サービスダウン
- 高負荷

### B. UptimeRobot (無料・推奨)
1. https://uptimerobot.com/ に登録
2. New Monitor → HTTP(s)
3. URL: `https://ktta-platform-xxxx.onrender.com/api/health`
4. Interval: 5分
5. 通知先: メール・LINE・Slack

→ サーバーダウン時に通知が届く

### C. エラーログ メール送信 (オプション・将来実装)
診断 API に POST して Slack 通知する等の拡張可能。

---

## 9. デプロイ前チェックリスト

毎回のプッシュ前に確認:

- [ ] `bash tools/check_syntax.sh` → OK
- [ ] ローカルで意図した動作になる
- [ ] コミットメッセージが具体的 (例: `fix: 領収書印鑑表示` NOT `update`)
- [ ] 本番に影響する DB スキーマ変更を含まない (含む場合は事前バックアップ)
- [ ] 大会開催の直前 (1日以内) は緊急以外プッシュしない

---

## 10. トラブル時の確認順序

### 「本番でエラーが出てる」と聞いたら

1. **本番診断パネル** を開く (admin → 設定 → 診断パネル)
   - 直近エラーを確認
   - エラー率を確認
2. **Render Logs** を開く
   - リアルタイムログを観察
   - エラー発生時刻周辺の context を確認
3. ローカルで再現を試みる
4. 修正 → commit → push → 待機
5. 再度本番で確認

### 「Render デプロイが失敗する」場合

1. Render Dashboard → サービス → **Logs** で `npm install` のエラー確認
2. `package.json` の `engines.node` が 18+ になっているか
3. better-sqlite3 のビルドエラー → 再 Deploy で大抵解決
4. それでもだめなら依存を最小化して再試行

### 「DB が壊れた」場合 (滅多にない)

1. Render Shell で `ls -lh /var/data/`
2. バックアップから復元:
   ```bash
   # Render Shell から
   cd /opt/render/project/src
   ls /var/data/
   # ローカル: 一度バックアップを取得
   ```
3. 復元は新規 Render デプロイで永続ディスクをアタッチして実行

---

## 11. リファレンス

- 運用マニュアル: [OPERATIONS.md](./OPERATIONS.md)
- Render デプロイ: [RENDER_DEPLOY.md](./RENDER_DEPLOY.md)
- ホスティング比較: [HOSTING.md](./HOSTING.md)
- GitHub: https://github.com/AKIHIKO-S/kushiro
- Render Dashboard: https://dashboard.render.com/

---

## 12. 推奨運用パターン (まとめ)

| シナリオ | 推奨 |
|---|---|
| 日常的な改善 | ローカル確認 → main にプッシュ → 自動デプロイ |
| 大きな変更 | feature ブランチ + PR でレビュー → main マージ |
| 大会前日 | プッシュしない (前々日までに完了) |
| 大会当日 | ホットフィックス時のみ。即座に診断パネルで確認 |
| 大会後 | 反省点を Issue に記録 → 次回までに修正 |
| 月次 | 依存更新 (`npm outdated` → `npm update`) + バックアップ確認 |
