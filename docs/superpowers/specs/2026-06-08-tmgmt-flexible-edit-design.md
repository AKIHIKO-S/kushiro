# 設計: トーナメント管理の「自由な入替 ＋ 選手DB選択」

- 日付: 2026-06-08
- 対象: KTTA-Platform / 管理画面「トーナメント管理(TMgmt)」タブ
- 関連メモリ: ktta-tournament-mgmt-tab / ktta-player-database / ktta-tournament-operations

## 目的 / 背景

トーナメント管理タブで、

1. 「枠の編集」グリッドで **選手マスタDBから選手を選んで枠に入れられる**ようにする。
2. 「トーナメント表」ビューで **氏名修正・選手のドラッグ入替・試合まるごとの入替** を自由に行えるようにする。

現状: トーナメント表タブは `readOnly`。進行管理(O)側のブラケットには既にドラッグ入替(`_dndSwap`→`/bracket/swap`)とスロット編集モーダル(`_editSlot`: BYE/空き/置換/シード繰上)があるが、置換は「その種目の出場選手リスト」からのみで **選手マスタDBからは選べない**。選手ピッカー部品 `_makePlayerPicker`(`/api/players`検索) は既存。`swapBracketSlots` は任意2スロット入替(完了/試合中ガード)、`setBracketSlot` はスロット設定。これらは op_log 未記録(undo非対応)。

## 確定した方針(ユーザー承認済み)

- 対戦入替の粒度: **選手単位(ドラッグ)＋試合まるごと 両方**。
- トーナメント表の編集: **「編集モード」トグル**(誤操作防止)。
- 選手DB選択の範囲: **選手マスタDB全体 ＋ 未エントリーなら自動で出場追加**(player_idで紐づけ)。

## コンポーネント設計

### A. 編集コンテキストの分離(土台リファクタ)

`_editSlot` / `_dndSwap`(および新規の試合入替)は現在 `O.tournamentId` / `O._bracketRev[event]` / `O._vbReload` に直結。これを **コンテキスト注入**へ変更する。

- `renderVisualBracket(bdata, { editable, ctx, showSlotNo })`。
- `ctx = { tournamentId, event, getRev(), setRev(rev), reload() }`。
- ブラケットの drag/click ハンドラは `ctx` 経由で書き込み・再描画する。
- 進行管理(O)は自身の ctx(O.tournamentId / O._bracketRev / O._vbReload)を渡す。トーナメント管理(TMgmt)は自身の ctx(TMgmt.tournamentId / TMgmt._gridRev / TMgmt のタブ再描画)を渡す。
- 後方互換: `opts` 無し or `editable` 未指定なら従来通り(readOnly相当 / O依存の既存呼び出しは ctx を O から組み立てて渡す薄いラッパに置換)。

**境界**: edit ハンドラは「どの大会/種目に、どう書き込み、どう再描画するか」を ctx だけに依存する。renderVisualBracket は描画と ctx 配線のみを知る。

### B. トーナメント表タブの「✏ 編集モード」トグル

- TMgmt のトーナメント表タブ上部にトグル(`TMgmt._treeEdit`)。OFF=閲覧(連番バッジ付き・現状)、ON=`editable:true` で描画。
- 状態は再描画/リロードを跨いで保持。タブ/種目切替時は OFF に戻す(安全側)。
- 編集モードONで使える操作:
  1. **クリックでスロット編集**: `_editSlot`(ctx対応版)。氏名修正・BYE化・空き・置換・シード繰上。
  2. **選手単位のドラッグ入替**: `_dndSwap`(ctx対応版, `/bracket/swap`)。
  3. **試合まるごと入替**(新規): カードに「⇄ 試合入替」。押下→対象の別試合を選ぶ→両選手を一括入替。

### C. 選手マスタDBから選択(枠の編集グリッド ＋ トーナメント表 両方)

- サーバ新規: `POST /api/tournaments/:id/bracket/set-slot-from-player`、body `{ event, pos, slot, player_id, base_rev }`。
  - db 新規: `setBracketSlotFromPlayer(tid, event, pos, slot, playerId)`。
    1. この種目に同 `player_id` の entrant があればそれを使う。
    2. 無ければ master player から `createEntrant`(event, surname/given_name/team/furigana/gender を master からコピー)＋`linkEntrantToPlayer` で自動追加。
    3. その entrant で当該スロットを `setBracketSlot(mode:"player")` 相当に設定。
    4. 全体を1トランザクション・冪等(同 player を再選択しても entrant が増えない)。
- UI 部品: `_makePlayerPicker`(マスタDB検索)を流用した「選手DBから選んで枠へ」モーダル/インライン。
  - **枠の編集グリッド**: 各行 ⋮ メニュー(`_rowMenu`)に「選手DBから選択」を追加。セルの自由入力(氏名直し)は現状維持。
  - **トーナメント表**: `_editSlot` モーダルに「選手DBから選択」セクション(既存の出場選手リスト置換と並べる)を追加。

### D. 安全策(undo ＋ 楽観ロック)

- `setBracketSlot` / `swapBracketSlots` / `setBracketSlotFromPlayer` / 新規 `swapBracketMatches` を **op_log に記録**(変更前 matches 行をスナップショット)。既存 `undoLastOp` がそのまま matches を復元 → 「↶ 取り消し」で戻せる。op-log ラベルも追加。
- 書き込みは全て `base_rev` ガード(TMgmt は `TMgmt._gridRev`、O は `O._bracketRev[event]`)。衝突は 409 → 再読込。

### 新規 db / endpoint まとめ

- db: `setBracketSlotFromPlayer(tid, event, pos, slot, playerId)` / `swapBracketMatches(tid, event, posA, posB)`。
- server: `POST /bracket/set-slot-from-player` / `POST /bracket/swap-match`(共に requireAdmin・bracketRevStale ガード・bracket_rev 返却)。

## スコープの線引き(v1)

- **ダブルス枠のDB選択**: v1 は「出場ペアから選択(既存)＋メンバー氏名のDB紐付けはグリッドのセル」。マスタから2名同時選択UIは v2。シングルス枠はマスタDB選択フル対応。
- **完了/試合中の試合**: 入替・置換不可(既存ガード踏襲)。
- 編集対象は1回戦スロット(既存の編集対象範囲を踏襲)。2回戦以降は勝ち上がりで自動。

## データフロー(例: トーナメント表でDB選手を空き枠へ)

1. 編集モードON → 空きスロットをクリック → `_editSlot`。
2. 「選手DBから選択」→ `_makePlayerPicker` でマスタ検索 → 選択。
3. `POST /bracket/set-slot-from-player {event,pos,slot,player_id,base_rev}`。
4. server: `bracketRevStale` チェック → `db.setBracketSlotFromPlayer`(entrant解決+slot設定+op_log) → 最新 `bracket_rev` 返却。
5. UI: ctx.setRev(rev) → ctx.reload() で再描画。

## エラー処理

- 完了/試合中: db 側で `{error}` → toast。
- 楽観ロック衝突(409 conflict): toast＋`ctx.reload()`。
- master player 不存在: `{error}`。
- DB選択で同名別所属の取り違え防止: entrant 解決は **player_id 一致のみ**(氏名一致では解決しない)。

## テスト(回帰)

- `setBracketSlotFromPlayer`: 未エントリー選手→entrant自動作成+slot設定、既存entrant→再利用(増えない)、player_id紐付け確認。
- `swapBracketMatches`: 2試合の両選手入替、完了/試合中はエラー、配置以外不変。
- undo: set-slot-from-player / swap-match を `undoLastOp` で元に戻せる(matches復元)。
- 既存 `bracket-concurrency` / `bracket-grid` の回帰が壊れないこと。

## 非目標(やらないこと)

- ブラケットのサイズ変更・回戦数変更(別機能)。
- 2回戦以降スロットの直接編集。
- ダブルスのマスタ2名同時選択(v2)。
