# トーナメント管理 自由入替＋選手DB選択 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** トーナメント管理タブで、枠/トーナメント表から選手マスタDBの選手を枠へ入れられ、トーナメント表ビューで氏名修正・選手ドラッグ入替・試合まるごと入替を「編集モード」で自由に行えるようにする。

**Architecture:** db.js に新規操作(選手DBから枠設定 / 試合まるごと入替)を追加し、既存ブラケット編集を含め op_log でundo可能にする。frontend は `renderVisualBracket` をコンテキスト注入式に変えて進行管理(O)とトーナメント管理(TMgmt)で共有し、TMgmt に編集モードトグルと選手DBピッカーを足す。

**Tech Stack:** Node.js + better-sqlite3 (DAL=db.js, 単一ファイル) / Express (server.js) / 素のJSインラインフロント (public/admin/index.html) / `node --test` 統合テスト。

参照spec: `docs/superpowers/specs/2026-06-08-tmgmt-flexible-edit-design.md`

---

## File Structure

- `db.js` — 新規 `swapBracketMatches`, `setBracketSlotFromPlayer`。既存 `setBracketSlot`/`swapBracketSlots` に op_log 記録を追加。module.exports に追記。
- `server.js` — 新規 endpoint `POST /bracket/swap-match`, `POST /bracket/set-slot-from-player`。
- `public/admin/index.html` — `renderVisualBracket` のコンテキスト注入化、O 側呼び出しの ctx 化、TMgmt の編集モードトグル＋ctx、`_editSlot` への「選手DBから選択」、グリッド ⋮ への「選手DBから選択」、試合入替UI、op-log ラベル。
- `test/bracket-flex-edit.test.js` — 新規 db 関数とundoの回帰テスト。

各 db 操作は「変更前 matches をスナップショット → 変更 → recordOp」で統一する(既存 `undoLastOp` が matches を復元できる)。

---

## Task 1: db `swapBracketMatches`（試合まるごと入替）＋ op_log

**Files:**
- Modify: `db.js`（`swapBracketSlots` の直後、約6820行付近に追加。`module.exports` に追記）
- Test: `test/bracket-flex-edit.test.js`（新規）

- [ ] **Step 1: Write the failing test**

```js
// test/bracket-flex-edit.test.js
process.env.DB_PATH = "/tmp/ktta_flexedit_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(() => { for (const x of ["", "-wal", "-shm"]) try { fs.rmSync(process.env.DB_PATH + x, { force: true }); } catch (e) {} });

const EV = "男子シングルス";
let _seq = 0;
function setup4() {
  const t = db.createTournament({ name: "flex" + (++_seq), date: "2027-12-20" });
  ["甲","乙","丙","丁"].forEach((n, i) => db.createEntrant({ tournament_id: t.id, event: EV, surname: n, given_name: "一", team: "T" + i, status: "confirmed" }));
  db.generateBracket(t.id, EV, { regenerate: true });
  return t;
}
const r1 = (t) => db.getMatchesByTournament(t.id).filter(m => m.event === EV && m.bracket_round === 1).sort((a, b) => (a.bracket_pos||0)-(b.bracket_pos||0));

test("swapBracketMatches: 2試合の両選手を入替(配置以外は不変)", () => {
  const t = setup4();
  const before = r1(t);
  const m0 = before[0], m1 = before[1];
  const r = db.swapBracketMatches(t.id, EV, m0.bracket_pos, m1.bracket_pos);
  assert.ok(r && r.success, "入替成功: " + JSON.stringify(r));
  const after = r1(t);
  assert.strictEqual(after[0].player1_name, m1.player1_name, "pos0のp1がm1のp1に");
  assert.strictEqual(after[0].player2_name, m1.player2_name, "pos0のp2がm1のp2に");
  assert.strictEqual(after[1].player1_name, m0.player1_name, "pos1のp1がm0のp1に");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: FAIL（`db.swapBracketMatches is not a function`）

- [ ] **Step 3: Write minimal implementation**

`db.js` の `swapBracketSlots` 関数の直後に追加。`_matchesReferencingMatches` ではなく対象2試合の行を直接スナップショット。

```js
// 試合まるごと入替: 2つの1回戦試合(posA/posB)の両スロットを丸ごと入れ替える。
// 選手単位の swapBracketSlots を両スロットに適用したのと同じ結果。完了/試合中はガード。
function swapBracketMatches(tournamentId, event, posA, posB) {
  if (!event) return { error: "event が必要です" };
  const pA = parseInt(posA), pB = parseInt(posB);
  if (!Number.isInteger(pA) || !Number.isInteger(pB)) return { error: "位置が不正です" };
  if (pA === pB) return { error: "同じ試合です" };
  const round1 = sqlite.prepare(
    `SELECT * FROM matches WHERE tournament_id=? AND event=? AND bracket_round=1`
  ).all(tournamentId, event);
  const mA = round1.find(m => (m.bracket_pos || 0) === pA);
  const mB = round1.find(m => (m.bracket_pos || 0) === pB);
  if (!mA || !mB) return { error: "対象の試合が見つかりません" };
  for (const m of [mA, mB]) {
    if (m.status === "completed" || m.status === "on_table" || m.winner_name) {
      return { error: "進行中または終了した試合は入れ替えできません" };
    }
  }
  const beforeRows = [mA, mB].map(m => ({ ...m }));
  const cols = ["player1_id","player1_name","player1_team","player1_entrant_id",
                "player2_id","player2_name","player2_team","player2_entrant_id","status"];
  const tx = sqlite.transaction(() => {
    const set = cols.map(c => `${c}=@${c}`).join(", ");
    const upd = sqlite.prepare(`UPDATE matches SET ${set} WHERE id=@id`);
    const pick = (m) => { const o = { id: 0 }; cols.forEach(c => o[c] = m[c]); return o; };
    upd.run({ ...pick(mB), id: mA.id });
    upd.run({ ...pick(mA), id: mB.id });
  });
  tx();
  if (eventResultCount(tournamentId, event) > 0) autoAdvanceByes(tournamentId, event);
  recordOp(tournamentId, "swap_match", `試合まるごと入替(${event})`, [mA.id, mB.id], beforeRows);
  return { success: true };
}
```

`module.exports` の `swapBracketSlots,` の並びに `swapBracketMatches,` を追加。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: PASS（1 test）

- [ ] **Step 5: Commit**

```bash
git add db.js test/bracket-flex-edit.test.js
git commit -m "feat(db): swapBracketMatches 試合まるごと入替(op_log記録)"
```

---

## Task 2: db `setBracketSlotFromPlayer`（選手マスタDBから枠へ）

**Files:**
- Modify: `db.js`（`setBracketSlot` の直後に追加。`module.exports` に追記）
- Test: `test/bracket-flex-edit.test.js`（追記）

- [ ] **Step 1: Write the failing test**

```js
test("setBracketSlotFromPlayer: 未エントリーのマスタ選手を空き枠へ→entrant自動作成+紐付け", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "新規 太郎", furigana: "しんき", team: "新規ク", gender: "male" });
  // 1回戦pos0 の slot2 を空きにしてから入れる
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  const before = db.getEntrants(t.id, EV).length;
  const r = db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);
  assert.ok(r && r.success, "成功: " + JSON.stringify(r));
  const ents = db.getEntrants(t.id, EV);
  assert.strictEqual(ents.length, before + 1, "entrantが1件自動追加");
  const added = ents.find(e => e.player_id === p.id);
  assert.ok(added, "player_idで紐づくentrantがある");
  const m = r1(t)[0];
  assert.strictEqual(m.player2_name, added.display_name, "枠に選手名が入る");
  assert.strictEqual(m.player2_entrant_id, added.id, "枠にentrant_idが入る");
});

test("setBracketSlotFromPlayer: 既存entrantがあるマスタ選手は再利用(増えない)・冪等", () => {
  const t = setup4();
  const p = db.createPlayer({ name: "既出 花子", furigana: "きしゅつ", team: "既出ク", gender: "female" });
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 0, 2, p.id);     // 1回目: 作成
  const n1 = db.getEntrants(t.id, EV).length;
  db.setBracketSlot(t.id, EV, 1, 2, { mode: "clear" });
  db.setBracketSlotFromPlayer(t.id, EV, 1, 2, p.id);     // 2回目: 同じ選手→再利用
  const n2 = db.getEntrants(t.id, EV).length;
  assert.strictEqual(n2, n1, "2回目は entrant を増やさない(player_idで再利用)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: FAIL（`db.setBracketSlotFromPlayer is not a function`）

- [ ] **Step 3: Write minimal implementation**

`db.js` の `setBracketSlot` 関数の直後に追加。

```js
// 選手マスタDBの選手をこの種目の枠へ。entrantを player_id で解決(無ければ自動作成)し、
// 当該1回戦スロットに設定する。氏名一致では解決せず player_id 一致のみ(取り違え防止)。
function setBracketSlotFromPlayer(tournamentId, event, pos, slot, playerId) {
  if (!event) return { error: "event が必要です" };
  if (!playerId) return { error: "選手が指定されていません" };
  const player = entrantStmts ? stmts.getPlayer.get(playerId) : null;
  if (!player) return { error: "選手が見つかりません" };
  // 既存entrant(同 player_id・同 event)を探す。無ければ master からコピーして作成。
  let ent = entrantStmts.listByEvent.all(tournamentId, event).find(e => e.player_id === playerId);
  if (!ent) {
    ent = createEntrant({ tournament_id: tournamentId, event,
      name: player.name, furigana: player.furigana || "", team: player.team || "",
      gender: player.gender || "male", player_id: playerId, status: "confirmed" });
  }
  // 既存 setBracketSlot を mode:"player" で流用(op_log もそこで記録される)。
  return setBracketSlot(tournamentId, event, pos, slot,
    { mode: "player", name: ent.display_name || ent.name, team: ent.team || "",
      entrant_id: ent.id, player_id: playerId });
}
```

`module.exports` に `setBracketSlotFromPlayer,` を追加。

> 注: `setBracketSlot` は Task 3 で op_log 記録を追加するため、この関数の undo も Task 3 完了後に効く。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add db.js test/bracket-flex-edit.test.js
git commit -m "feat(db): setBracketSlotFromPlayer 選手マスタDBから枠へ(entrant自動解決)"
```

---

## Task 3: 既存 `setBracketSlot`/`swapBracketSlots` を op_log 記録対応（undo）

**Files:**
- Modify: `db.js`（`setBracketSlot`, `swapBracketSlots` に recordOp 追加）
- Test: `test/bracket-flex-edit.test.js`（追記）

- [ ] **Step 1: Write the failing test**

```js
test("undo: setBracketSlot(clear) を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t)[0].player2_name;
  assert.ok(before, "pos0 slot2 に選手がいる");
  db.setBracketSlot(t.id, EV, 0, 2, { mode: "clear" });
  assert.strictEqual(r1(t)[0].player2_name, "", "clearで空に");
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功: " + JSON.stringify(u));
  assert.strictEqual(r1(t)[0].player2_name, before, "undoで選手が戻る: " + r1(t)[0].player2_name);
});

test("undo: swapBracketMatches を undoLastOp で元に戻せる", () => {
  const t = setup4();
  const before = r1(t).map(m => m.player1_name);
  db.swapBracketMatches(t.id, EV, 0, 1);
  const u = db.undoLastOp(t.id);
  assert.ok(u && u.ok, "undo成功");
  assert.deepStrictEqual(r1(t).map(m => m.player1_name), before, "undoで配置が戻る");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: FAIL（setBracketSlot の clear は op_log 未記録 → undoで戻らない or "取り消せる操作がありません"）

- [ ] **Step 3: Write minimal implementation**

`setBracketSlot` 内で、変更前に対象 match 行をスナップショットし、書き込み後に recordOp する。`swapBracketSlots` も同様（変更前 mA,mB をスナップショット→recordOp）。

`setBracketSlot`（関数の対象 match `m` 確定後・書込前）:
```js
  const beforeRow = { ...m };
```
書込（既存ロジック）後、`return` の直前:
```js
  recordOp(tournamentId, "set_slot", `枠の設定(${event})`, [m.id], [beforeRow]);
```

`swapBracketSlots`（`setSlot();` 実行前）:
```js
  const beforeRows = (mA.id === mB.id ? [mA] : [mA, mB]).map(m => ({ ...m }));
```
`return { success: true };` の直前:
```js
  recordOp(tournamentId, "swap_slot", `選手の位置入替(${event})`, beforeRows.map(r => r.id), beforeRows);
```

> autoAdvanceByes が走るケースでも、undoは「変更した match 行」を before に戻すので、対象スロットの復元は保証される(BYE自動進行は進行開始後のみ・編集フェーズでは発生しない)。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/bracket-flex-edit.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Run full suite (regression)**

Run: `npm test`
Expected: 既存 + 新規すべて PASS（`bracket-concurrency` 等が壊れていないこと）

- [ ] **Step 6: Commit**

```bash
git add db.js test/bracket-flex-edit.test.js
git commit -m "feat(db): set-slot/swap-slot を op_log 記録(undo対応)"
```

---

## Task 4: server endpoints（swap-match / set-slot-from-player）

**Files:**
- Modify: `server.js`（`/bracket/set-slot` 付近, 約3615行に2本追加）

- [ ] **Step 1: Implement endpoints**

`/bracket/swap-doubles-order`(約3666行)の並びに追加。両方 `requireAdmin` ＋ `bracketRevStale` ガード ＋ 最新 `bracket_rev` 返却（既存 swap-doubles-order と同形）。

```js
// 試合まるごと入替
app.post("/api/tournaments/:id/bracket/swap-match", requireAdmin, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.swapBracketMatches(req.params.id, event, req.body.posA, req.body.posB);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});
// 選手マスタDBから枠へ
app.post("/api/tournaments/:id/bracket/set-slot-from-player", requireAdmin, (req, res) => {
  const event = req.body && req.body.event;
  if (!event) return res.status(400).json({ error: "event が必要です" });
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.setBracketSlotFromPlayer(req.params.id, event, req.body.pos, req.body.slot, req.body.player_id);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});
```

- [ ] **Step 2: Smoke test (server boots)**

Run: `node --check server.js && PORT=3998 NODE_ENV=development node server.js & sleep 2; curl -s http://localhost:3998/api/health; kill %1`
Expected: `{"ok":true,...}`（起動・構文OK）

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(server): bracket swap-match / set-slot-from-player endpoints"
```

---

## Task 5: frontend A — `renderVisualBracket` のコンテキスト注入化

**Files:**
- Modify: `public/admin/index.html`（`renderVisualBracket`(約9933), `_dndSwap`(約10132), `_editSlot`(約10145), O 側の呼び出し3箇所）

- [ ] **Step 1: ctx を受け取れるようにする**

`renderVisualBracket(bdata, opts)` 内で編集コンテキストを決定:
```js
   const ctx = (opts && opts.ctx) || {
     tournamentId: O.tournamentId, event: bdata.event,
     getRev: () => (O._bracketRev && O._bracketRev[bdata.event]),
     setRev: (rev) => { O._bracketRev = O._bracketRev || {}; if (rev) O._bracketRev[bdata.event] = rev; },
     reload: () => { if (typeof O._vbReload === "function") O._vbReload(); },
   };
   const editable = opts && opts.editable !== undefined ? !!opts.editable : !readOnly;
```
`dndOn`/編集クリックの条件を `editable` に統一。drag/click ハンドラ内の `O._dndSwap(...)`/`O._editSlot(...)` を `O._dndSwap(ctx, from, to)` / `O._editSlot(ctx, pos, slot, name)` に変更し、ctx を渡す。

- [ ] **Step 2: `_dndSwap` / `_editSlot` を ctx 受け取り式に変更**

`_dndSwap(ctx, from, to)`: `O.tournamentId`→`ctx.tournamentId`、`event`→`ctx.event`、rev は `ctx.getRev()/ctx.setRev()`、再描画は `ctx.reload()`。
`_editSlot(ctx, pos, slot, currentName)`: 同様に全ての `O.tournamentId`/`O._bracketRev[event]`/`O._vbReload` を ctx 経由へ置換。`event` は `ctx.event`。

- [ ] **Step 3: O 側呼び出しを無改修で動かす**

`renderVisualBracket` の ctx デフォルト(Step1)が O 用なので、進行管理の既存呼び出し（`O.renderVisualBracket(bdata)`）はそのまま動く。drag/click は内部で ctx を作って渡すよう、makeCard 内のハンドラを `O._dndSwap(ctx, ...)` 形に統一。

- [ ] **Step 4: Verify (Playwright) — 進行管理のブラケットが従来通り編集できる**

dev サーバ(seed済みDB)で進行管理タブのブラケットを開き、ドラッグ入替・スロットクリック編集が従来通り動くことを確認。コンソールエラー0件。

- [ ] **Step 5: Commit**

```bash
git add public/admin/index.html
git commit -m "refactor(front): renderVisualBracket を ctx 注入式に(編集の大会/種目/rev/再描画を分離)"
```

---

## Task 6: frontend B — TMgmt 編集モードトグル＋ctx

**Files:**
- Modify: `public/admin/index.html`（TMgmt の render() トーナメント表タブ分岐, TMgmt に `_treeEdit` と ctx 生成）

- [ ] **Step 1: 編集モードトグルと editable ブラケット**

render() の `tab === "bracket"` 分岐を、トグル＋editable描画に変更:
```js
    if (tab === "bracket") {
      const editOn = !!TMgmt._treeEdit;
      const toolbar = h("div", { style: { marginBottom: "8px" } },
        h("button", { className: "btn btn-sm" + (editOn ? "" : " btn-ghost"),
          onClick: () => { TMgmt._treeEdit = !TMgmt._treeEdit; TMgmt.render(); } },
          editOn ? "✏ 編集モード: ON" : "✏ 編集モード: OFF"),
        editOn ? h("span", { style: { marginLeft: "8px", fontSize: "12px", color: "#64748b" } },
          "クリックで枠編集 / ドラッグで選手入替 / ⇄で試合入替") : null);
      main.appendChild(toolbar);
      const tree = h("div", { className: "tm-tree-pane" });
      tree.appendChild(O.renderVisualBracket(b, { editable: editOn, showSlotNo: true, ctx: TMgmt._treeCtx() }));
      main.appendChild(tree);
    }
```

- [ ] **Step 2: TMgmt._treeCtx() を追加**

TMgmt に追加（rev は `TMgmt._gridRev`、再描画は表タブを描き直す）:
```js
  _treeCtx() {
    return {
      tournamentId: TMgmt.tournamentId, event: TMgmt.event,
      getRev: () => TMgmt._gridRev,
      setRev: (rev) => { if (rev) TMgmt._gridRev = rev; },
      reload: () => { TMgmt._scheduleTreeRefresh(); TMgmt._reloadGridOnly(); },
    };
  },
```
種目/タブ切替時に編集モードを OFF へ: `selectEvent` 内（イベント切替時）で `TMgmt._treeEdit = false;`。

- [ ] **Step 3: Verify (Playwright)**

TMgmtのトーナメント表タブで「編集モード」トグルON→スロットクリックで `_editSlot` モーダルが開く / ドラッグで入替できる。OFFで閲覧のみ（連番バッジ表示）。コンソールエラー0件。

- [ ] **Step 4: Commit**

```bash
git add public/admin/index.html
git commit -m "feat(front): TMgmtトーナメント表に編集モードトグル(ctx経由で編集)"
```

---

## Task 7: frontend C — 「選手DBから選択」を `_editSlot` とグリッド⋮に追加

**Files:**
- Modify: `public/admin/index.html`（`_editSlot` モーダルにDBピッカー節を追加 / `_rowMenu` に項目追加）

- [ ] **Step 1: `_editSlot` に「選手DBから選択」節を追加**

`_editSlot` の置換リスト(出場選手リスト)の下に、マスタDB検索→選択で `set-slot-from-player` を呼ぶUIを追加（`_makePlayerPicker` を流用、選択時に player.id を取得）:
実装前に `_makePlayerPicker`(約5176行)の戻り値とコールバック仕様を Read で確認し、選択時に
master player の `id` が取れる配線にする(同コンポーネントは `/api/players` を検索し選択候補を返す)。

```js
   // 選手マスタDBから選択(未エントリーなら自動で出場追加)
   const dbSubmit = async (playerId) => {
     try {
       const r = await api.post(`/api/tournaments/${ctx.tournamentId}/bracket/set-slot-from-player`,
         { event: ctx.event, pos, slot, player_id: playerId, base_rev: ctx.getRev() });
       if (r && r.conflict) { toast(r.error || "他端末で更新", "err"); ctx.reload(); return; }
       if (r && r.error) return toast(r.error, "err");
       if (r && r.bracket_rev) ctx.setRev(r.bracket_rev);
       toast("選手を枠に入れました", "ok"); modal.remove(); ctx.reload();
     } catch (e) { toast("更新に失敗: " + (e.message || e), "err"); }
   };
```
`_makePlayerPicker` の選択コールバックで `dbSubmit(selectedPlayer.id)` を呼ぶ。section title「選手DBから選択（未エントリーは自動で出場追加）」。

> 注: `_editSlot` は Task5 で `ctx` を第1引数に取るよう変更済み。`O.tournamentId` ではなく `ctx.tournamentId`/`ctx.event` を使う。

- [ ] **Step 2: グリッド ⋮ メニューに「選手DBから選択」を追加**

`_rowMenu(row)` に項目を追加。クリックで `_editSlot` 相当のDBピッカーを開き、`row.pos`/`row.slot` を対象に `set-slot-from-player` を呼ぶ（TMgmt ctx を使用）。成功後 `TMgmt.reload()`。

- [ ] **Step 3: Verify (Playwright)**

- 枠の編集: ⋮→「選手DBから選択」→マスタ検索→選択→枠に入る・グリッド更新。
- トーナメント表(編集モード): 空き枠クリック→「選手DBから選択」→入る。
- 未エントリー選手を選ぶと出場(entrant)が自動追加され player_id 紐付け。コンソールエラー0件。

- [ ] **Step 4: Commit**

```bash
git add public/admin/index.html
git commit -m "feat(front): 枠編集/トーナメント表に「選手DBから選択」(自動出場追加)"
```

---

## Task 8: frontend — 試合まるごと入替 UI

**Files:**
- Modify: `public/admin/index.html`（makeCard 内に「⇄ 試合入替」ボタン・選択フロー）

- [ ] **Step 1: カードに「⇄ 試合入替」**

`editable` かつ `m.bracket_round === 1` のとき、カードヘッダに「⇄」ボタンを追加。1回押すと「入替元」として `TMgmt._swapMatchFrom = pos`(ctx経由でモジュール非依存に保持) にし、2つ目のカードの「⇄」で `swap-match` を実行:
```js
  // 擬似コード（ctxにswap選択状態を持たせる）
  onClick: () => O._matchSwapPick(ctx, m.bracket_pos)
```
`O._matchSwapPick(ctx, pos)`:
```js
 _matchSwapPick(ctx, pos) {
   if (O._swapFrom == null) { O._swapFrom = { ctx, pos }; toast("入替元を選択。もう1試合の⇄を押してください", "ok"); return; }
   const from = O._swapFrom; O._swapFrom = null;
   if (from.pos === pos) { toast("同じ試合です", "err"); return; }
   api.post(`/api/tournaments/${ctx.tournamentId}/bracket/swap-match`,
     { event: ctx.event, posA: from.pos, posB: pos, base_rev: ctx.getRev() })
     .then(r => {
       if (r && r.conflict) { toast(r.error || "他端末で更新", "err"); ctx.reload(); return; }
       if (r && r.error) return toast(r.error, "err");
       if (r && r.bracket_rev) ctx.setRev(r.bracket_rev);
       toast("試合を入れ替えました", "ok"); ctx.reload();
     }).catch(e => toast("入替失敗: " + (e.message || e), "err"));
 },
```

- [ ] **Step 2: Verify (Playwright)**

編集モードONで、ある試合の⇄→別の試合の⇄→両選手が入れ替わる。完了済み試合はエラー。コンソールエラー0件。

- [ ] **Step 3: Commit**

```bash
git add public/admin/index.html
git commit -m "feat(front): トーナメント表で試合まるごと入替UI(⇄)"
```

---

## Task 9: op-log ラベル ＋ 統合検証

**Files:**
- Modify: `public/admin/index.html`（`O._opLogLabel` にラベル追加）

- [ ] **Step 1: op-log ラベル追加**

`O._opLogLabel` のマップに追加:
```js
   set_slot: "枠の設定", swap_slot: "選手位置入替", swap_match: "試合入替",
```

- [ ] **Step 2: 統合 Verify (Playwright・seed済みDB)**

1. 枠の編集: ⋮→選手DBから選択→入る。
2. トーナメント表 編集モード: クリック編集・ドラッグ入替・⇄試合入替。
3. 進行管理の「↶ 取り消し」で set-slot/swap/swap-match が元に戻る。
4. コンソールエラー0件。

- [ ] **Step 3: 全テスト**

Run: `npm test`
Expected: 全 PASS。

- [ ] **Step 4: Commit**

```bash
git add public/admin/index.html
git commit -m "feat(front): op-logラベル追加 + 仕上げ"
```

---

## Self-Review メモ

- spec の A(ctx分離)=Task5、B(編集モード)=Task6、C(DB選択)=Task2/4/7、対戦入替=Task1/4/8、D(undo/楽観ロック)=Task3＋各endpointのbracketRevStale。全要件にタスク対応あり。
- ダブルスのマスタ2名同時選択は v1 非対象（spec通り）。`set-slot-from-player` はシングルス枠想定。ダブルス枠への適用は v2（ガード or 出場ペア選択へ誘導）。
- 型/シグネチャ整合: `setBracketSlotFromPlayer(tid,event,pos,slot,playerId)` / `swapBracketMatches(tid,event,posA,posB)` / `ctx={tournamentId,event,getRev,setRev,reload}` を全タスクで統一。
- frontend のコード片はインライン巨大ファイルの性質上、実装時に厳密なDOM配線へ調整（_makePlayerPicker の実シグネチャに合わせる）。
