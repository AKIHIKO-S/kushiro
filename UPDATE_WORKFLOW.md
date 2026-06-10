# 本番更新ワークフロー — KTTA Platform

本番運用しながらコード修正・即時反映するための実践ガイド。

---

## 1. 全体フロー

```
[ローカル動作確認] → [git push] → [GitHub Actions: テスト→自動デプロイ] → [本番確認] → [問題あればロールバック]
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

### ステップ6: GitHub Actions が自動デプロイ (3〜5分)
GitHub リポジトリの **Actions** タブを開く:
- `deploy-oracle` ワークフローがテスト→デプロイを実行
- 緑のチェックになるまで待つ (テスト失敗時はデプロイされない)

### ステップ7: 本番で動作確認
本番URL の `/admin/` を開く
- 設定 (⚙) → **「本番診断パネルを開く」** で状態確認

---

## 3. リアルタイム監視ツール

### A. サーバーログ (リアルタイム)
Oracle Cloud のサーバーに SSH して journald を見る:
```bash
ssh -i ~/.ssh/ktta_oracle ubuntu@<本番IP>
sudo journalctl -u ktta -f        # リアルタイム追尾 (-n 200 で直近200行)
```

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
curl https://<本番ドメイン>/api/health
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

# ステップ5: GitHub Actions (deploy-oracle) の進行を確認
gh run watch   # または GitHub の Actions タブ

# ステップ6: 約3-5分後に本番反映 → 動作確認
```

**重要**: 大会当日のホットフィックスは可能な限り避け、回避策で凌ぐことを推奨。
事前に dev/staging で検証を済ませる。

---

## 5. ロールバック方法

問題のあるデプロイを元に戻したい場合:

### A. Git revert (推奨)
```bash
# 直前のコミットを取り消す
git revert HEAD
git push
# → GitHub Actions が自動で前の状態をデプロイ
```

### B. 強制リセット (緊急)
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
- **main** ブランチ = 本番 (GitHub Actions auto-deploy)
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
ローカルの `npm run dev`、または standalone 単機構成 (standalone/) を検証環境として使う。
クラウドに staging を立てたい場合は Oracle Cloud にもう1インスタンス用意して
`deploy/install.sh` を流す (本番と同一構成)。

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

### 本番サーバー操作 (SSH)
```bash
ssh -i ~/.ssh/ktta_oracle ubuntu@<本番IP>
sudo systemctl status ktta        # 稼働状態
sudo journalctl -u ktta -n 200    # ログ
sudo systemctl restart ktta       # 再起動
```

---

## 8. 監視・通知設定 (推奨)

### A. デプロイ結果の通知 (GitHub組込)
GitHub → Settings → Notifications で Actions の失敗通知を有効化
(deploy-oracle ワークフローが失敗するとメールが届く)

### B. UptimeRobot (無料・推奨)
1. https://uptimerobot.com/ に登録
2. New Monitor → HTTP(s)
3. URL: `https://<本番ドメイン>/api/health`
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
2. **サーバーログ** を開く (`sudo journalctl -u ktta -f`)
   - リアルタイムログを観察
   - エラー発生時刻周辺の context を確認
3. ローカルで再現を試みる
4. 修正 → commit → push → 待機
5. 再度本番で確認

### 「デプロイが失敗する」場合

1. GitHub → Actions → 失敗した deploy-oracle のログで原因確認 (テスト失敗 or SSH失敗)
2. テスト失敗なら修正して再 push、SSH 失敗なら Secrets (ORACLE_HOST/ORACLE_SSH_KEY) を確認
3. better-sqlite3 のビルドエラー → サーバー側で `npm rebuild better-sqlite3`

### 「DB が壊れた」場合 (滅多にない)

1. SSH で `ls -lh /var/data/`
2. バックアップから復元: `bash deploy/restore.sh --list` → `bash deploy/restore.sh <タイムスタンプ>`
3. 詳細は OPERATIONS.md / ORACLE_CLOUD_DEPLOY.md のバックアップ節を参照

---

## 11. リファレンス

- 運用マニュアル: [OPERATIONS.md](./OPERATIONS.md)
- 本番デプロイ: [ORACLE_CLOUD_DEPLOY.md](./ORACLE_CLOUD_DEPLOY.md)
- GitHub: https://github.com/AKIHIKO-S/kushiro

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
