# 設計: 登録団体マスタで「団体を選手にしない」取込

- 日付: 2026-06-08
- 対象: KTTA-Platform / トーナメント表取込（3パーサ + DB取込）
- 関連メモリ: ktta-bracket-accuracy / ktta-bracket-reading-rules / ktta-player-database

## 目的 / 背景

トーナメント表取込で、登録団体（クラブ・学校）名が**選手名として誤取込**される（特にダブルス）。接尾辞の無い団体（`.Rball` `AMATAKU` `infinity` `MPC` `T-Union` `サザンクロス` `トウタス` `ひまわり` `ワンスター` `釧友会` 等）は3パーサ全ての氏名/団体ヒューリスティックを擦り抜ける。DB取込ではダブルス相方名が妥当性チェック無しで選手を自動作成し、選手作成が弾かれても entrant は作られるため団体名が選手として残る。

登録団体の共有リストは現状どこにも無い。

## 確定方針（ユーザー承認済み）

- リスト保持: **管理画面で編集できるDBマスタ**（`registered_teams`）。
- 適用範囲: **DB取込の関所（全パーサ共通）＋ 3パーサ両方**。
- 照合: **正規化完全一致＋末尾部分一致**（俱/倶などの異体字は正規化で吸収）。
- 実装順: **(A) マスタ＋管理UI＋DB関所 → (B) 3パーサ連携**（各々デプロイ）。

## コンポーネント

### 1. 登録団体マスタ（DB）
- テーブル `registered_teams(id TEXT PK, name TEXT, normalized TEXT, active INTEGER DEFAULT 1, created_at TEXT)`。`CREATE TABLE IF NOT EXISTS` ＋起動時に空なら41団体を冪等シード。
- db: `listRegisteredTeams()` / `addRegisteredTeam(name)` / `deleteRegisteredTeam(id)` / `registeredTeamSet()`（normalized の Set・メモリキャッシュ、add/delete で無効化）。

### 2. 照合ヘルパ（JS / Python 同一規則）
- `normalizeTeam(s)`: NFKC（全半角統一）→ 全空白除去 → 既知異体字畳み（俱(U+4FF1)→倶(U+5036) 等）→ ラテン文字小文字化。
- `isRegisteredTeam(s)`: `normalizeTeam(s)` が Set に含まれる（完全一致）。
- `splitTrailingTeam(s)`: 文字列の**末尾**が登録団体に一致すれば `{ name, team }` に分離（最長一致）。無ければ `{ name: s, team: "" }`。

### 3. DB取込の関所（保証ライン）
取込パス（`importFromSeedList` / `importFromMatches` がパーサ出力から entrant を作る直前）に `guardRegisteredTeams(rec)` を挟む。rec = `{ name, team, partner_name, partner_team }`：
- 各氏名フィールド(name / partner_name)について：
  - 完全一致で登録団体 → その値は**氏名ではない**。対応する所属欄(team / partner_team)が空なら団体名をそこへ移し、氏名は空にする。所属が既にあれば氏名側の団体名は捨てて空にする。
  - 完全一致しないが**末尾が登録団体** → `splitTrailingTeam` で氏名と所属に分離（所属が空のとき）。
- 反映後、**登録団体名から player を自動作成しない**（auto_link / createPlayer 前に再チェック）。
- 不変条件: 登録団体名が `name`/`partner_name`（=選手名）や players に保存されない。

### 4. 3パーサへのリスト連携（B）
- Node が取込時にDBから正規化リストを取得し各パーサへ渡す：
  - in-process JS パーサ（parse_bracket_seedlist.js / parse_pdf_bracket.js）: パース関数に `registeredTeams`(Set/Array) を引数で注入し、`looksLikeName`/`looksLikeTeam` が登録団体を最優先で団体判定。
  - Python `bracket_parser`: 正規化リストを一時ファイルに書き、`--teams <path>`（or env `KTTA_REGISTERED_TEAMS`）で渡す。`tokens.looks_like_name` が登録団体を団体扱い。
- 効果: ダブルスの位置ズレ（団体が相方/氏名スロットに入る）を発生源で抑止。

### 5. 管理UI
- 「インポート/エクスポート」タブに「登録団体マスタ」パネル：一覧・追加（入力→追加）・削除。`GET/POST/DELETE /api/registered-teams`（requireAdmin）。

## エラー処理 / エッジ

- 取込時にDB未シード（テーブル空）でも落ちない（Set 空＝従来挙動）。
- 末尾一致は最長一致で、氏名が偶然団体名を含むケースは「末尾＋所属が空」のときのみ作用（誤爆抑制）。
- Python へ渡せない/一時ファイル失敗時はリスト無しで従来動作（取込自体は止めない）。

## テスト（回帰）

- ヘルパ: normalizeTeam（全半角・俱/倶・ラテン小文字・空白）、isRegisteredTeam、splitTrailingTeam（末尾分離・最長一致・非一致）。
- 関所 guardRegisteredTeams: partner_name=登録団体→partner_team へ移動・選手非作成／name 末尾団体→分離／所属既存時は氏名側団体を破棄。
- シード冪等（2回起動で重複しない）。
- CRUD: add→list→delete、normalized 反映、キャッシュ無効化。
- (B) パーサ: 登録団体トークンが name でなく team に分類される（JS各パーサ／Python）。

## 非目標

- パーサ全体の精度改善（座標/結合セル等）はこの spec の対象外（別途）。
- 氏名側の旧字/旧姓正規化（選手名寄せは ktta-player-database 側）。

## 既知の登録団体（初期シード・41件）

.Rball, AMATAKU, infinity, MPC, Neo俱楽部, Relier標茶, TTA.C, T-Union, クラブ柏, サザンクロス,
シニアクラブ, トウタス, ひまわり, ワンスター, ワンスターTTC, 教育大釧路, 暁クラブ, 釧友会, 釧路公立大,
釧路市役所, 青雲クラブ, 釧路高専, 湖陵高校, 工業高校, 江南高校, 商業高校, 標茶高校, 武修館高校,
北陽高校, 明輝高校, 共栄中学校, 景雲中学校, 桜が丘中学校, 春採中学校, 茶内中学校, 鳥取中学校,
標茶中学校, 浜中中学校, 富原中学校, 幣舞中学校, 北中学校
