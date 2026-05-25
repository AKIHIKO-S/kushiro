# 🏓 卓球大会運営アプリ

クラウド・ローカルの両方で動作する、JTTA(日本卓球協会)風の試合記録管理Webアプリ。
選手データベース、大会管理、試合結果(セット単位)を一元管理。

- **閲覧画面** `/viewer` - 誰でも閲覧可能。選手検索・大会別試合結果・ランキング
- **管理画面** `/admin` - 管理キー保護。選手CRUD・大会作成・試合入力・外部アプリ連携
- **REST API** `/api/*` - 外部アプリ(大会進行運営アプリ等)から試合結果を直接投入可能

## 主な機能

| カテゴリ | 内容 |
|---------|------|
| 閲覧 | JTTA風試合カード (勝者上・敗者下・セットスコア横並び) |
| 検索 | 名前・ふりがな・所属で選手を検索・プロフィール表示 |
| 大会 | 大会ごとに種目・ラウンド別試合を管理 |
| 自動更新 | ポーリング方式(4秒毎)で管理画面の更新が閲覧側に即反映 |
| **進行管理** | 出場選手→トーナメント自動生成(標準シーディング・BYE自動進行) |
| **台レイアウト** | 任意の行×列(例 4×11=44台)、本部位置設定、視覚的グリッド |
| **次に呼べる対戦** | 両者揃った試合を自動抽出、台選択ダイアログ |
| **敗者審判** | 試合終了時、敗者を自動で審判候補プールに追加 |
| **自動進行** | 結果入力→勝者を次ラウンドに自動advance |
| **進行公開** | `/viewer/#live` で台割と進行状況をリアルタイム公開 |
| **公開申込** | `/viewer` から大会へオンライン申込、新規選手は自動作成 |
| **申込管理** | admin で承認/却下、seed割当、申込→確定参加者へ |
| **試合検索DB** | JTTA風: 大会・年度・種目・選手名・所属で横断検索＋ページング |
| **H2H** | 選手プロフィールに対戦相手別戦績(勝率)、種目別統計 |
| レーティング | 試合結果からElo方式で自動計算(S/A/B/C/D) |
| 戦績 | 優勝・準優勝・3位を手動でも登録可 |
| 外部連携 | `/api/sync/matches`でバルク投入、名前マッチング自動 |
| フォント | BIZ UDPGothic / UDゴシック(ユニバーサルデザイン) |

## クイックスタート (ローカル)

```bash
npm install
npm run dev
```

- 閲覧: http://localhost:3000/viewer
- 管理: http://localhost:3000/admin (初回アクセス時に管理キー入力)

環境変数 `ADMIN_KEY` 未設定なら管理キー空欄で動作(ローカル開発用)。

## デプロイ先の比較

| サービス | コスト/月 | DB永続化 | 向いているケース |
|---------|----------|---------|----------------|
| **Render.com** | $7 (Starter + 1GB Disk) | ○ | 最も推奨。`render.yaml` で一発 |
| **Fly.io** | 無料枠あり | ○ (Volumes) | Dockerfile で動作 |
| **Railway** | $5〜 | ○ | UIがシンプル、SQLite対応 |
| **VPS (さくら/ConoHa)** | ¥500〜 | ○ | 国内・独自ドメイン可 |
| **Google Apps Script** | 無料 | Sheets | 別実装(`gas/`配下) |

### Render.com (推奨)

1. このリポジトリをGitHubにpush
2. https://dashboard.render.com/ → New → Blueprint → リポジトリ選択
3. `render.yaml` が自動検出されてデプロイ開始
4. 環境変数 `ADMIN_KEY` は自動生成される。Renderダッシュボードで確認して管理画面に入力

### Fly.io

```bash
fly launch      # Dockerfile が検出される
fly volumes create tabletennis_data --size 1
fly secrets set ADMIN_KEY=$(openssl rand -hex 32)
fly deploy
```

`fly.toml` の `mounts` に `source = "tabletennis_data", destination = "/data"` を追加。

## 大会進行運営アプリからの連携

試合結果を POST するだけで自動反映されます。選手IDは名前から自動マッチング。

```bash
curl -X POST https://your-app.example.com/api/sync/matches \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: your-admin-key" \
  -d '{
    "tournament_id": "TOURNAMENT_UUID",
    "matches": [
      {
        "event": "男子シングルス",
        "round": "決勝",
        "match_no": 1,
        "winner_name": "山田 太郎",
        "winner_team": "A高校",
        "loser_name": "鈴木 次郎",
        "loser_team": "B高校",
        "sets": [[11,8],[9,11],[11,6],[11,9]]
      }
    ]
  }'
```

大会ごと一括アップサート:

```bash
POST /api/sync/tournament
{ "tournament": { "name": "...", "date": "..." }, "matches": [...] }
```

## アーキテクチャ

```
┌─────────────┐     ┌──────────────┐
│   /viewer   │◀───▶│              │
│  (公開閲覧) │ HTTP│  Express     │
└─────────────┘     │  + SQLite    │◀── /api/sync/matches
┌─────────────┐     │  (WAL, FK)   │   (外部大会アプリ)
│   /admin    │◀───▶│              │
│  (X-Admin)  │     └──────────────┘
└─────────────┘            │
                           ▼
                    data/tournament.db
                    (players, tournaments,
                     matches, achievements,
                     tournament_players)
```

## ファイル構成

```
tabletennis/
├── server.js         - Express ルーティング
├── db.js             - SQLite データアクセス層 (prepared statements)
├── package.json
├── render.yaml       - Render.com Blueprint
├── Dockerfile        - Fly.io / Railway 用
├── public/
│   ├── viewer/       - 閲覧画面 (JTTA風)
│   ├── admin/        - 管理画面
│   └── shared/       - 共通CSS (UD Gothic) + JS ユーティリティ
└── gas/              - Google Apps Script 版(参考)
```

## 🎯 一気通貫ワークフロー(申込→運営→DB反映)

```
[公開申込フォーム]
  ↓ (選手が自分で申込・新規選手は自動作成)
[admin: 申込管理]
  ↓ (承認 + seed 割当)
[admin: トーナメント生成]
  ↓ (シーディング + BYE 自動)
[admin: 大会運営]
  ↓ (台に呼ぶ → 結果入力 → 自動進行)
[全試合終了]
  ↓ (自動反映)
[viewer: 試合結果DB / 選手プロフィール]
  └─ 試合検索・H2H・種目別統計が全公開
```

### 1. 申込受付の有効化（admin）

大会管理タブ → 大会選択 → 「📝 申込設定」
- 申込受付を有効にする
- 申込締切日
- 申込可能種目（チップで選択）
- カテゴリ(公式戦/オープン等)、主催

→ 公開URL `[host]/viewer/#entry` で申込フォームが開く

### 2. 公開申込（誰でも）

`/viewer` → 「📝 大会申込」タブ → 受付中の大会を選択 → フォーム入力
- 氏名(必須)、ふりがな、所属、性別、カテゴリ
- 出場種目（複数選択可）
- 既存選手と一致(氏名+所属)した場合は自動リンク、なければ新規登録

### 3. 承認とブラケット生成（admin）

大会管理タブ → 大会選択 → 申込管理
- 「承認」/「却下」、seed番号入力
- 進行管理タブ → 「🏗 トーナメント生成」→ 承認済選手から自動生成

### 4. 大会運営（進行管理タブ）

- コートレイアウト(44台等)
- 「📣 呼ぶ」で台割+審判選択
- 「結果入力」で勝者+セットスコア確定
- 勝者は次ラウンド自動advance、敗者は審判プール

### 5. DB反映（自動）

完了試合は即座に:
- 選手のElo更新
- 選手プロフィールの試合履歴に追加
- 公開試合検索DBにヒット
- H2H・種目別統計に集計

## 申込・集計・領収書 (協会運用フロー)

### 全体の流れ

```
[1] Jimdo / Google フォーム
     大会ごとの申込フォーム設置 (Jimdoサイトに埋込)
       ↓
[2] Google スプレッドシート
     回答が自動収集 → GAS が種目別シート生成
     (gas/jimdo_entry_to_app.gs に実装)
       ↓
[3] 卓球大会運営アプリ
     GAS から自動取込 (大会の entrants として登録)
     または admin の Excel取込で直接アップロード
       ↓
[4] 集計表/領収書 自動出力
     大会の出場選手登録セクションから
     ・集計表ダウンロード (.xlsx, 6シート構造)
     ・領収書一括出力 (HTML、印鑑入り、印刷でPDF化)
       ↓
[5] 進行管理 → 試合結果 → 選手DB に自動反映
```

### 集計表 (xlsx, まりもオープン形式)

`/api/tournaments/:id/aggregation.xlsx` から出力。6シート構成:

| シート | 内容 |
|--------|------|
| 集計用 | 団体×種目別人数×単価 = 合計金額 |
| 選手名簿 | 申込団体ごとに種目別 (団体/ダブルス/ミックス) |
| 団体 | 団体戦参加者一覧 + 男女別合計 |
| ダブルス | ダブルスペア一覧 + 男女別合計 |
| ミックス | 混合ダブルス参加者一覧 |
| 差し込み用 | 大会名・日付・団体名・合計 (Word 差込印刷用) |

### 領収書 一括出力 (印鑑入り)

`/api/tournaments/:id/receipts.html` を開く → ブラウザ印刷で PDF 化。

- 1団体 1ページ (A5横、複数ページの PDF にできる)
- **発行者**: 釧路卓球協会 会長 山本 満
- **電子印鑑**: 右下に押印 (画像は admin の「設定」→「印鑑画像」からアップロード)
- **内訳**: 種別×人数×単価×小計 のテーブル
- **金額**: 「金 ¥X,XXX 也」の伝統的書式

### GAS スクリプト (Jimdo 連携)

`gas/jimdo_entry_to_app.gs` をスプレッドシートに貼り付け:

1. スクリプトプロパティで `APP_BASE_URL`, `ADMIN_KEY`, `TOURNAMENT_ID` を設定
2. 「卓球大会」メニューから:
   - 「名簿を再生成」: フォーム回答 → 種目別シート (団体/ダブルス/ミックス)
   - 「アプリに取込」: 卓球大会運営アプリの entrants として登録
   - 「集計表を生成」: スプレッドシート上で集計表シートを作成

## 大会テンプレート (釧路卓球協会 16大会)

`public/shared/tournament-templates.js` に協会の年間16大会を定義済み。
「新規大会」ダイアログのテンプレ選択から1クリックで大会情報を投入できます。

| # | 大会 | 開催 | 種目数 |
|---|------|------|-------|
| 1 | 会長杯 / 高校釧根支部オープン | 5/3 | 11 (団体3+S8) |
| 2 | 国スポ (少年の部) 釧路地区予選 | 5/6 | 2 |
| 3 | ヤサカ杯 | 6/1 | 13 |
| 4 | くしろリーグ (夏) | 7/19 | 2 (リーグ戦) |
| 5 | 釧路選手権 (Nittaku杯) | 7/26 | 5 |
| 6 | カデット予選 | 7/28 | 6 |
| 7 | ジュニア選手権 | 8/9 | 2 |
| 8 | なごやか亭杯 くしろオープン | 9/27 | 10 |
| 9 | タンチョウオープン (ラージボール) | 10/18 | 18 (年代別) |
| 10 | 中学選抜大会 (団体戦) | 11/1 | 2 |
| 11 | 中学新人戦 | 11/24 | 2 |
| 12 | くしろリーグ (冬) | 1/12 | 2 (リーグ戦) |
| 13 | 湿原の風オープン (VICTAS杯) | 2/11 | 10 |
| 14 | バタフライダブルスチームカップ (タマス杯) | 3/20 | 13 |
| 15 | ホープス・カブ・バンビ地区予選 | 3/29 | 8 |
| 16 | まりもオープン in Akan (ラージボール) | 4/5 | 5 |

各テンプレは以下を自動セットします:
- 大会名・開催日 (今年度の同日)・会場・概要
- 種目リスト (参考表示・後から手動編集)
- ルール (ポイント数・ゲーム数・球・敗者審判 ON/OFF)
- 台レイアウト (44台 / サブアリーナ用 24台 / ラージ用 8台 等)
- スポンサー情報

**選択後はすべて手動修正可能**。日付・会場・種目・ルール等を運用に合わせて自由に書き換えてから保存できます。

## 出場選手 (Entrants) 管理タブ

`/admin` の「出場選手」タブで、大会参加選手の一元管理が可能:

| 機能 | 操作 |
|------|------|
| 大会選択 | 上部ドロップダウンで大会を切り替え |
| 種目選択 | 種目チップ（男子S / 男子D / 女子S / 女子D など）でフィルタ |
| ブロック選択 | ブロックチップ（A / B / C / D など）でさらにフィルタ |
| 検索 | 氏名/所属で絞り込み |
| 編集 | seed, ブロック, 苗字, 名前, 所属, ペア情報 (ダブルス時) を編集 |
| DB連携 | 同名選手提案・新規DB作成リンク・手動検索リンク |
| バリデーション | 重複・seed#重複・氏名空白・ブロック未割当を自動検出して表示 |
| 一括取込 | パーサー出力 JSON をその場で取り込み |
| CSV書出 | 選択中の種目を CSV にエクスポート |
| ブラケット生成 | 選択中の種目で標準シーディングのブラケット生成 |

ダブルスは「苗字のみ」入力でも「フルネーム」入力でも同じデータ構造に正規化されます (display_name=フル / display_short=苗字)。

## Excel トーナメント表の自動取り込み

`tools/parse_jtta_excel.py` で .xlsx → JSON 変換可能。
全シート一括 / 単一シート抽出に対応。

```bash
# 全シート一括 (推奨)
python3 tools/parse_jtta_excel.py 大会.xlsx --all-sheets --output bracket.json

# 罫線追跡で実 bracket layout を保存 (シード位置や予想外配置を維持)
python3 tools/parse_jtta_excel.py 大会.xlsx --sheet "男子シングルス" \
    --mode bracket-tree --output mens_bracket.json
```

**仕組み:**
1. 列分類: 各列の内容を統計分析し、name/team/region/seed の役割を自動判定
2. 形式検出: シングルス/ダブルス/master roster の有無を判別
3. エントリー抽出: name 列のみから選手を取得し、隣接列から team/region/seed を関連付け
4. ダブルスペア化: master roster 優先 → 列ペア → 同列連続行 の順で
5. (option) 罫線追跡: 各 name セルの水平罫線を右に追跡し、実 bracket レイアウトを保存

**実測精度 (VICTAS杯 2026):**
| 種目 | Excel枠 | 抽出 | 精度 |
|------|--------|-----|-----|
| 男子シングルス | 240枠 (1空席) | 238/239 | 99.6% |
| 女子シングルス | 90 | 90/90 | 100% |
| 男子ダブルス | 105 pairs | 105/105 | 100% |
| 女子ダブルス | 41 pairs | 41/41 | 100% |

出力は `tabletennis-seed-list-v1` 形式。アプリの「JSON読込」から直接インポート可能。

## ブラケット JSON 読み込み（外部ファイルからインポート）

トーナメント表(Excel等)を JSON に変換 → このアプリに読み込めます。
admin の進行管理タブ → 「📥 JSON 読込」ボタンから利用可能。

### 形式①: シード選手リスト形式（簡易）

選手を並べるだけで標準シーディングが自動展開されます:

```json
{
  "format": "tabletennis-seed-list-v1",
  "event": "男子シングルス",
  "regenerate": true,
  "players": [
    { "name": "選手A", "team": "○○高校", "seed": 1, "gender": "male" },
    { "name": "選手B", "team": "△△クラブ", "seed": 2 },
    { "name": "選手C", "seed": 3 },
    { "name": "選手D" },
    { "name": "選手E" },
    { "name": "選手F" },
    { "name": "選手G" },
    { "name": "選手H" }
  ]
}
```

→ 自動で `(1 vs 8), (4 vs 5), (3 vs 6), (2 vs 7)` の標準シーディングで bracket 生成。
選手が 6人など 2^N に満たない場合は BYE が seed上位に割り当てられ、自動進行されます。

### 形式②: 完全ブラケット形式（書き出しと同形式）

各試合の位置・対戦カードを明示する形式。「📤 JSON 書出」で出力されるものと同じ:

```json
{
  "format": "tabletennis-bracket-v1",
  "event": "男子シングルス",
  "bracket_size": 8,
  "tournament": { "name": "...", "date": "...", "venue": "..." },
  "matches": [
    {
      "bracket_round": 1, "bracket_pos": 0,
      "round": "準々決勝", "match_no": 1,
      "player1_name": "選手A", "player1_team": "○○高校",
      "player2_name": "選手H", "player2_team": "△△クラブ"
    },
    { "bracket_round": 1, "bracket_pos": 1, "round": "準々決勝", "match_no": 2,
      "player1_name": "選手D", "player2_name": "選手E" },
    { "bracket_round": 1, "bracket_pos": 2, "round": "準々決勝", "match_no": 3,
      "player1_name": "選手C", "player2_name": "選手F" },
    { "bracket_round": 1, "bracket_pos": 3, "round": "準々決勝", "match_no": 4,
      "player1_name": "選手B", "player2_name": "選手G" },
    { "bracket_round": 2, "bracket_pos": 0, "round": "準決勝" },
    { "bracket_round": 2, "bracket_pos": 1, "round": "準決勝" },
    { "bracket_round": 3, "bracket_pos": 0, "round": "決勝" }
  ]
}
```

ポジショニング規則:
- `bracket_round` は 1=1回戦 / 2=次ラウンド / ... と昇順
- `bracket_pos` は各ラウンド内の 0 始まりインデックス
- 次の試合は自動的に `(round+1, floor(pos/2))` にリンクされ、`pos%2` で slot1/slot2 が決まる
- BYE は `player1_name` または `player2_name` を `"BYE"` または空文字列に

### 結果込みでエクスポート/インポート

完了試合があれば、`result` フィールドに勝者・セットスコアが含まれます:

```json
{
  "bracket_round": 1, "bracket_pos": 0, "round": "準々決勝",
  "player1_name": "選手A", "player2_name": "選手H",
  "status": "completed",
  "result": {
    "winner_name": "選手A",
    "loser_name": "選手H",
    "winner_sets": 3, "loser_sets": 1,
    "sets": [[11,8],[9,11],[11,6],[11,9]]
  }
}
```

インポート時、result があれば finishMatch が呼ばれて勝者は次ラウンドに自動進行・敗者は審判プールに追加されます。

### 全種目まとめてエクスポート / インポート

大会の全ブラケットを一括で扱う場合:

```json
{
  "format": "tabletennis-tournament-v1",
  "tournament": { "name": "...", "date": "..." },
  "brackets": [
    { "format": "tabletennis-bracket-v1", "event": "男子シングルス", "matches": [...] },
    { "format": "tabletennis-bracket-v1", "event": "女子シングルス", "matches": [...] }
  ]
}
```

### 選手の自動登録

未登録選手はデフォルトで自動的に players テーブルに作成されます。
無効にするには `"auto_create_players": false` を付けます（その場合、未登録の選手は名前のみ表示・統計に集計されない）。

### 既存ブラケット上書き

同じ種目を再インポートする場合は `"regenerate": true`（デフォルト）で既存試合を削除して作り直し。`false` を指定すると追加マージ。

## 🌐 ホスティング (GitHub Pages 単独不可)

GitHub Pages は静的のみ。データ書き込みのため別ホストが必要。

詳しい比較は [HOSTING.md](./HOSTING.md) に。**簡単に始めたいなら Render.com ($7/月)、無料がいいなら Fly.io 無料枠** が推奨。

## 🛠 すべて手動で書き換え可能

| 要素 | 編集方法 |
|------|---------|
| 大会 (名前/日付/会場/ステータス) | 大会管理タブ |
| 選手 (氏名/所属/性別/レーティング等) | 選手管理タブ |
| 種目名 | **自由入力**（datalist で既存名サジェスト・新規も追加可） |
| ラウンド名 | **自由入力**（決勝/準決勝/1回戦… 任意） |
| 試合の player1/player2 | 試合カードの「✎」→ 選手検索で任意の選手に差替可能 |
| 試合の table_no / 審判 | 同上の編集モーダル |
| 試合の結果 (勝者・セット) | 編集モーダル or 結果入力モーダル |
| 試合のステータス | 編集モーダル (waiting/pending/on_table/completed) |
| 試合の削除 | 編集モーダルの「🗑 削除」ボタン |
| 台レイアウト | 進行管理タブの「🏟 台レイアウト」→ プリセット (40/44/32...) or 手動入力 |
| 敗者審判ルール ON/OFF | 進行管理タブ右上のトグル |
| 試合の審判要否 | 各試合の「審判不要に」ボタン |

## 進行管理ワークフロー (大会当日)

1. **大会作成** → 開催日・会場・ステータスを「進行中」に
2. **出場選手登録** → `/admin` の選手管理から追加、または大会別エントリーで seed 番号を設定
3. **台レイアウト設定** → 進行管理タブで「🏟 台レイアウト」→ 横11×縦4=44台（本部下）等
4. **トーナメント生成** → 進行管理タブで「🏗 トーナメント生成」
   - 種目を選択（男子S/女子S/ダブルス/混合D/団体）
   - 出場選手を選択（Ctrl/Cmd で複数選択）
   - 自動的にブラケットサイズ計算（標準シーディング・BYE は seed 上位に割当）
   - BYE試合は自動完了→勝者は次ラウンドへ自動advance
5. **試合呼び出し** → 「📣 呼ぶ」ボタン → 空き台を選択 + 審判（敗者プールから）
6. **結果入力** → 進行中の試合カードで「結果入力」→ セットスコア入力 → 確定
   - 勝者は次ラウンドの試合スロットに自動セット
   - 敗者は審判候補プールに自動追加
7. **viewer に自動公開** → `/viewer/#live` で台割が4秒毎にリアルタイム更新

### 台レイアウトのカスタマイズ

大規模大会(44台)から練習会(4台)まで任意に設定可能:

| 構成 | 設定 |
|------|------|
| 大規模(44台) | 横11 × 縦4 |
| 中規模(20台) | 横5 × 縦4 |
| 練習会(4台) | 横2 × 縦2 |

本部位置は「下」(JTTA標準) または「上」を選択。

## API リファレンス(抜粋)

### 公開(認証不要)
- `GET /api/public/players?search=...` 選手検索
- `GET /api/public/players/:id` 選手プロフィール(戦績・試合履歴込)
- `GET /api/public/players/:id/opponents` 対戦相手別戦績(H2H)
- `GET /api/public/players/:id/event-stats` 種目別統計
- `GET /api/public/head-to-head?p1=X&p2=Y` 2選手間H2H
- `GET /api/public/tournaments` 大会一覧
- `GET /api/public/tournaments/:id/matches` 試合一覧
- `GET /api/public/tournaments/:id/live` 進行状況(viewer用)
- `GET /api/public/matches?player_name=&year=&event=&...` **JTTA風試合検索**
- `GET /api/public/matches/filters` 検索フィルタ選択肢
- `GET /api/public/open-tournaments` 申込受付中の大会
- `POST /api/public/tournaments/:id/entry` **公開申込** (no auth)
- `GET /api/public/stats` 集計
- `GET /api/public/last-updated` 最終更新時刻(ポーリング用)

### 管理 (`X-Admin-Key` ヘッダー必須)
- `POST/PUT/DELETE /api/players[/:id]`
- `POST/PUT/DELETE /api/tournaments[/:id]`
- `POST /api/tournaments/:id/matches` 試合追加
- `PUT/DELETE /api/matches/:id`
- `POST /api/sync/matches` 試合バルク投入
- `POST /api/sync/tournament` 大会丸ごとアップサート
- `GET /api/export/all` 全データJSON
- `POST /api/import/players` 選手一括登録

### 申込管理 (`X-Admin-Key` 必須・公開GET除く)
- `GET /api/tournaments/:id/entries?status=pending|confirmed|rejected`
- `POST /api/tournaments/:id/entries` 管理者直接追加(承認済)
- `PUT /api/tournaments/:id/entries/:pid/status` 承認/却下 `{status, event}`
- `PUT /api/tournaments/:id/entries/:pid/seed` シード設定 `{event, seed}`
- `PUT /api/tournaments/:id/entry-settings` 申込設定 `{entries_open, entry_deadline, entry_events[], category, organizer}`

### ブラケット JSON I/O
- `GET /api/tournaments/:id/bracket/export?event=...` 単一種目を JSON書き出し
- `GET /api/tournaments/:id/bracket/export` 大会の全種目を JSON書き出し
- `GET /api/public/tournaments/:id/bracket/export[?event=...]` 公開版（認証不要）
- `POST /api/tournaments/:id/bracket/import` JSON読み込み（形式は自動判別）

### 敗者審判ルール (柔軟設定可能)

試合で負けた選手は審判に回り、その試合が終わるまで他の試合に出られないルールを実装。
柔軟に書き換え可能:

| 操作 | 場所 |
|-----|------|
| ルール ON/OFF 大会全体 | 進行管理タブ右上「🟢/⚪ 敗者審判ルール」ボタン |
| 試合単位で「審判不要」 | 各callable行の「審判不要に」ボタン |
| 敗者プールから審判選択 | 「📣 呼ぶ」→ タブ「📋 敗者プール」 |
| 任意の選手を審判に | 「📣 呼ぶ」→ タブ「🔍 任意の選手」（誰でも検索選択可） |
| 進行中の試合の審判変更 | on_table 行の「審判: X 変更」ボタン |
| 拘束無視で強制呼出 | 「📣 呼ぶ」ダイアログで自動的に強制ボタンに切替 |

callable リストでは、選手が他の試合の審判担当中／試合中の場合に **⚠️ 警告**が表示され、ボタンは「⚡ 強制呼出」に変わる。

### 進行管理(`X-Admin-Key` 必須・公開GET除く)
- `POST /api/tournaments/:id/bracket` トーナメント自動生成 `{event, player_ids[], regenerate}`
- `GET /api/tournaments/:id/bracket?event=...` ブラケット取得
- `DELETE /api/tournaments/:id/bracket?event=...` ブラケットクリア
- `GET /api/tournaments/:id/operations` 進行状況サマリ（admin）
- `GET /api/public/tournaments/:id/live` 進行状況（公開・viewer用）
- `POST /api/matches/:id/call` 台に呼ぶ `{table_no, referee_id?}`
- `POST /api/matches/:id/uncall` 台から戻す
- `POST /api/matches/:id/finish` 結果記録＋自動進行 `{winner_slot:1|2, sets:[[w,l],...]}`
- `POST /api/matches/:id/referee` 審判割り当て `{referee_id, force?}` (任意の選手OK)
- `PUT /api/matches/:id/referee-required` 審判要否切替 `{required: true|false}`
- `PUT /api/tournaments/:id/court-layout` 台レイアウト更新 `{court_rows, court_cols, hq_position}`
- `PUT /api/tournaments/:id/op-settings` 運営ルール `{enforce_referee_rule: true|false}`

callMatch (`POST /api/matches/:id/call`) は敗者審判ルール ON 時、選手が他試合の審判/プレイ中だと拒否される。`{force: true}` を付ければ拘束を無視して強制呼出。

## ライセンス

Private / 社内利用。再配布はご相談ください。
