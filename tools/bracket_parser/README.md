# bracket_parser — 組合せ表(トーナメント表)罫線パーサー

卓球協会形式のブラケット Excel を解析し、出場者リスト(シード順)を抽出する
**独立ライブラリ**。本体(server.js / db.js)にはロジックを置かず、
subprocess(`python3 -m bracket_parser FILE.xlsx`)で疎結合に呼ぶ前提で設計。
依存は **openpyxl のみ**(罫線=セル境界線を読めるのが SheetJS に対する決定的優位)。

## 実測精度(VICTAS杯 2026 / 正解JSON突合)

| 種目 | 構成 | 氏名 | 所属 |
|---|---|---|---|
| 男子シングルス | 8列・通し番号(両側) | 239/239 | 239/239 |
| 女子シングルス | 2列・通し番号 | 90/90 | 90/90 |
| 女子ダブルス | 2列・上下段ペア(両側) | 41/41 | 41/41 |
| 男子ダブルス | マスター一覧・隣接列ペア | 105/105 | 105/105 |
| **合計** | | **475/475** | **475/475** |

`python3 -m bracket_parser.selftest --real` で再現(合成フィクスチャ+実データ)。

## モジュール構成(将来改修の単位)

- `grid.py` — Excel→「値 + 罫線」正規化グリッド。結合セル解決、
  罫線の二重表現(下罫線/上隣の上罫線)を OR して `edge_below/edge_right` に正規化。
- `tokens.py` — 文字種別(氏名/所属/番号/BYE/ラベル)判定と正規化。
- `entries.py` — 番号アンカーからリーフ抽出。左右の鏡像(L/R)、段組
  (single / 隣接列 adjacent / 上下段 stacked)、マスター一覧 vs ブロック列の自動判別。
- `topology.py` — 罫線から構造を検証(リーフ水平線・コネクタ数・番号↔物理行の単調性)。
  番号が無い表は罫線/行順でシード順を復元(フォールバック)。
- `emit.py` — 取込契約形への整形(`name/partner_name/team/partner_team/is_doubles/seed`)。
- `api.py` — `parse_workbook(path)` / `parse_sheet(...)` 公開API。非対戦シート除外。
- `__main__.py` — CLI 入口。`--sheet/--event/--format/--meta/--sheets`。
- `selftest.py` — 依存フリー自己テスト(pytest不要)。

## 使い方(CLI / subprocess)

```bash
python3 -m bracket_parser FILE.xlsx                 # 全シート → seed-list-v1 JSON
python3 -m bracket_parser FILE.xlsx --sheet 男子シングルス
python3 -m bracket_parser FILE.xlsx --meta          # 解析メタ込み(デバッグ)
python3 -m bracket_parser FILE.xlsx --sheets        # シート名一覧のみ
```

出力(`tabletennis-seed-list-v1`、`db.importBracket` がそのまま消費):

```json
{ "format": "tabletennis-seed-list-v1", "source": "bracket_excel_py",
  "events": [ { "event": "女子ダブルス", "format": "doubles", "regenerate": true,
    "players": [ { "seed": 1, "name": "...", "team": "...",
                   "partner_name": "...", "partner_team": "...", "is_doubles": true } ] } ] }
```

## server.js への接続(任意・疎結合)

`/kumiawase/upload` の JS パーサー(`parse_bracket_seedlist.js`)の後段フォールバックとして、
`spawn("python3", ["-m","bracket_parser", xlsxPath])` の stdout(JSON)を
既存の `events[]` 取込ループにそのまま渡せる。本体にロジックは増えない。

## 解析の要点(罫線の読み方)

- 表は左右二分割。左半分は番号が左端 `[番号][氏名][所属]`、右半分は鏡像
  `[所属][氏名][番号]`。**所属は常に氏名の右隣**(番号位置のみ左右で反転)。
- ダブルスは2形態: 同一行の隣接列ペア(マスター一覧)/2行に跨る上下段ペア。
  上下段で同一所属はセルが縦結合=1値(→単一表示)、別所属は2値(→連結表示)。
- 大規模種目(男子D)はブロックごとにローカル番号を持ち、別に通し番号の
  マスター一覧列を持つ。連番1..Nが単独の列に揃い、かつ他列と範囲が重なる列を
  マスターとして優先採用する。
- 同一ドロー番号が2組に付く事前戦(女子Dの「3」×2)も正解どおり両方保持する。
