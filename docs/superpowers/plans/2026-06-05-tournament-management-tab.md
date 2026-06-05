# トーナメント管理タブ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development または superpowers:executing-plans でタスク単位に実装。`- [ ]` はチェックボックス進捗管理。

**Goal:** 進行管理と選手DBの間に「トーナメント管理」専用タブを追加し、左=エクセル風枠グリッド（セル直接編集）／右=トーナメント表ツリーで、取込整合性・ダブルスのペア/個人編集・シード・登場回戦を1画面で高度編集できるようにする。

**Architecture:** 新フロントモジュール `TMgmt`（`public/admin/index.html` インライン、`O`/`EnT` と同じ `tournamentId`/`selectTournament` パターン）。表示は既存 `renderVisualBracket` を再利用、編集は既存ブラケットAPI（`set-slot`/`promote-seed`/`add-seed`/`PUT entrants`/`seed`/`entry-round`）を再利用し、全書込は `base_rev`(bracketRev) で同時編集409ガード。新規バックエンドは「ペア相方の原子的入替」1エンドポイントのみ。重複検出はクライアント側。

**Tech Stack:** Express + better-sqlite3（同期/WAL）、素のJSフロント（`h()` ハイパースクリプト、ビルド無し）、`node:test`。

---

## ファイル構成

- Modify: `public/admin/index.html` — タブ追加（~1162）、`showTab` 分岐（~1508）、ハッシュ許可リスト（~1483）、新モジュール `TMgmt`（`O` 近傍に新設）、CSS（グリッド/分割）。
- Modify: `server.js` — `POST /api/tournaments/:id/bracket/swap-partner`（~3628 promote-seed の隣）。
- Modify: `db.js` — `swapEntrantPartners(tid, event, aId, bId)`（~2916 promoteToSeed 近傍）。
- Create: `test/bracket-swap-partner.test.js`。

既存資産の参照位置（再利用）: `renderVisualBracket`(index.html:9882) / `makeCard`(9919) / `_editSlot`(10083) / `openAddSeed`(7762) / `EnT.openEdit`(10818) / `openModal`(common.js:759) / `A.openEntriesFullView`(4647) / `findEntrantDataIssues`・`bulkFixEntrantInference`・`fixEntrant`(db.js) / `bracketRev`(db.js:3518) / entrants schema(db.js:188-209, `name/team/furigana/partner_name/partner_team/partner_furigana/gender/partner_gender/seed/entry_round/is_doubles`)。

---

## Phase 1 — タブ枠組み＋大会/種目選択＋右ツリー表示（読み取り専用）

### Task 1.1: タブ・パネル・ルーティングの追加

**Files:** Modify `public/admin/index.html`

- [ ] **Step 1: タブボタンを追加**（進行管理と選手DBの間、~1162 行）

```html
<button class="tab" data-tab="bracket-mgmt">トーナメント管理</button>
```

- [ ] **Step 2: タブパネルを追加**（既存パネル群の末尾、例 ~1220 付近に追記）

```html
<!-- トーナメント管理 -->
<div class="tab-panel hidden" id="tab-bracket-mgmt">
 <div class="card">
  <div class="card-head"><div class="card-title">トーナメント管理</div></div>
  <div class="tm-bar">
   <select id="tmTournamentSel" class="input"></select>
   <select id="tmEventSel" class="input"></select>
   <span id="tmStatus" class="muted" style="margin-left:8px"></span>
  </div>
  <div id="tmMain"></div>
 </div>
</div>
```

- [ ] **Step 3: `showTab` に分岐追加**（~1508、`else if (name === "coaches")...` の並びに）

```javascript
else if (name === "bracket-mgmt") TMgmt.init();
```

- [ ] **Step 4: ハッシュ許可リストに追加**（~1483、`["tournaments","players","operations","entrants",...]` に `"bracket-mgmt"` を追加）

- [ ] **Step 5: 構文チェック**

Run: `node -e 'const fs=require("fs");const h=fs.readFileSync("public/admin/index.html","utf8");const re=/<script>([\s\S]*?)<\/script>/g;let m,ok=true;while((m=re.exec(h)))if(m[1].length>2000){try{new Function(m[1])}catch(e){ok=false;console.log("NG:"+e.message)}}console.log(ok?"OK":"NG")'`
Expected: `OK`

### Task 1.2: TMgmt モジュール（init/選択/右ツリー）

**Files:** Modify `public/admin/index.html`（`O` モジュール近傍に新設）

- [ ] **Step 1: モジュール骨格を追加**

```javascript
const TMgmt = {
  tournamentId: null, event: null, _rev: {}, _bracket: null,
  async init(){
    const sel = document.getElementById("tmTournamentSel");
    const ts = await api.get("/api/tournaments") || [];
    sel.innerHTML = "";
    sel.appendChild(h("option",{value:""},"大会を選択…"));
    ts.forEach(t=> sel.appendChild(h("option",{value:t.id}, t.name)));
    sel.onchange = ()=> TMgmt.selectTournament(sel.value);
    document.getElementById("tmEventSel").onchange = (e)=> TMgmt.selectEvent(e.target.value);
    if (TMgmt.tournamentId) { sel.value = TMgmt.tournamentId; TMgmt.selectTournament(TMgmt.tournamentId); }
  },
  async selectTournament(id){
    TMgmt.tournamentId = id || null; TMgmt.event = null;
    const evSel = document.getElementById("tmEventSel"); evSel.innerHTML = "";
    document.getElementById("tmMain").innerHTML = "";
    if (!id) return;
    const ents = await api.get(`/api/tournaments/${id}/entrants`) || [];
    const events = [...new Set(ents.map(e=>e.event).filter(Boolean))];
    evSel.appendChild(h("option",{value:""},"種目を選択…"));
    events.forEach(ev=> evSel.appendChild(h("option",{value:ev}, ev)));
    if (events.length===1){ evSel.value=events[0]; TMgmt.selectEvent(events[0]); }
  },
  async selectEvent(ev){
    TMgmt.event = ev || null;
    if (!ev) { document.getElementById("tmMain").innerHTML=""; return; }
    await TMgmt.reload();
  },
  async reload(){
    const {tournamentId:tid, event:ev} = TMgmt; if(!tid||!ev) return;
    const live = await api.get(`/api/tournaments/${tid}/bracket?event=${encodeURIComponent(ev)}`);
    const rev = await api.get(`/api/tournaments/${tid}/bracket/rev?event=${encodeURIComponent(ev)}`);
    TMgmt._rev[ev] = rev && rev.bracket_rev;
    TMgmt._bracket = live;
    TMgmt.render();
  },
  render(){
    const main = document.getElementById("tmMain"); main.innerHTML="";
    const b = TMgmt._bracket;
    if (!b || !b.matches || !b.matches.length){
      main.appendChild(h("div",{class:"empty"},"この種目の表はまだありません。"));
      // Phase1: 生成導線は既存の申込一覧/進行管理を案内。Phase2以降で空状態アクションを追加。
      return;
    }
    const split = h("div",{class:"tm-split"});
    const left = h("div",{class:"tm-left"}, h("div",{class:"muted"},"（編集グリッドは Phase 2 で実装）"));
    const right = h("div",{class:"tm-right"});
    right.appendChild(O.renderVisualBracket ? O.renderVisualBracket(b) : renderVisualBracket(b));
    split.appendChild(left); split.appendChild(right);
    main.appendChild(split);
  }
};
```

> 注: `renderVisualBracket` の実際の参照名（グローバル or `O.`配下）を Task 着手時に確認し、`TMgmt.render` の呼び出しを合わせる。`GET /bracket` のレスポンス形（matches/bracket_size/total_rounds）が `renderVisualBracket` の入力 `bdata` 形と一致するか確認、必要なら `{matches:live, ...}` に整形。

- [ ] **Step 2: 最小CSS追加**（既存 `<style>` 内）

```css
.tm-bar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.tm-split{display:flex;gap:12px;align-items:flex-start}
.tm-left{flex:1 1 50%;min-width:360px}
.tm-right{flex:1 1 50%;min-width:320px;overflow:auto}
@media(max-width:900px){.tm-split{flex-direction:column}.tm-left,.tm-right{width:100%}}
```

- [ ] **Step 3: 構文チェック**（Task1.1 Step5 と同コマンド）→ `OK`

- [ ] **Step 4: 全テスト＆コミット**

```bash
npm test 2>&1 | grep -E "ℹ (pass|fail)"
git add public/admin/index.html docs/superpowers/plans
git commit -m "feat: トーナメント管理タブ(Phase1) 大会/種目選択＋表ツリー表示"
```

### Task 1.3: Phase1 デプロイ前レビュー＆デプロイ
- [ ] 既存 deploy ループ：Workflow で find→verify→go/no-go（タブ配線・ルーティング・既存タブへの副作用なきこと）→ `git push origin main` →GitHub Actions 成功確認。

---

## Phase 2 — エクセル風グリッド＋セル直接編集＋409ガード

### Task 2.1: グリッド描画（行=R1枠順、列=枠/選手/所属/シード/登場回戦/相手/[⋮]）

**Files:** Modify `public/admin/index.html`（`TMgmt` 内）

- [ ] **Step 1: `TMgmt.renderGrid(left)` を実装し `render()` の left に差す**

```javascript
// R1 マッチを bracket_pos 昇順で並べ、各マッチの slot1/slot2 を行化。
// 各行 = {pos, slot, entrant_id, name, team, furigana, seed, entry_round, is_doubles, partner_*}
// 列セルは span（クリックで input 化）。状態列(相手/BYE)は読み取り。末尾に [⋮] ボタン。
```

行モデルは `TMgmt._bracket.matches`（bracket_round===1）＋ `entrants`（id引き）から構築。entrant 情報（furigana/seed/entry_round/partner_*）は `GET /api/tournaments/:id/entrants` をキャッシュして join。

- [ ] **Step 2: CSS（エクセル風テーブル）**

```css
.tm-grid{border-collapse:collapse;width:100%;font-size:13px}
.tm-grid th,.tm-grid td{border:1px solid var(--border);padding:3px 6px;white-space:nowrap}
.tm-grid th{background:var(--ink-50,#f1f5f9);position:sticky;top:0}
.tm-cell-edit{cursor:cell}
.tm-cell-edit:hover{background:#eef6ff}
.tm-grid input{width:100%;border:1px solid #60a5fa;font:inherit;padding:1px 3px}
.tm-row-bye{opacity:.55}
```

- [ ] **Step 3: 構文チェック → OK、目視（ローカル `npm run dev`）**

### Task 2.2: セル編集コミット（名前/所属/ふりがな/シード/登場回戦）

- [ ] **Step 1: セル→input 化、Enter/Tabで commit、Escでキャンセル**を実装。Tab は同行内→次行先頭セルへ移動。

- [ ] **Step 2: commit 振り分け**（全て `base_rev: TMgmt._rev[ev]` 同梱、409は `_onConflict()` で toast＋reload）

```javascript
// 選手名/所属/ふりがな(シングル or ペア選手1) → PUT /api/entrants/:id {surname/given_name or name, team, furigana, base_updated_at}
//   その後 枠の表示名を再同期: POST /bracket/set-slot {event,pos,slot,mode:"player",entrant_id,name,team,base_rev}
// ペア選手2 → PUT /api/entrants/:id {partner_surname/partner_given_name or partner_name, partner_team, partner_furigana} → 同様に set-slot 再同期
// シード → PUT /api/tournaments/:id/entries/:pid/seed {seed}
// 登場回戦(増やす) → POST /bracket/promote-seed {event,pos,slot,entry_round,side:"top",base_rev}
//   登場回戦を1に戻す等は [⋮]→再配置 で対応（Phase3）。グリッドの直接編集は「現状以上の回戦へ繰り上げ」のみ許可。
```

> 着手時の確認: (a) `set-slot` mode player が `name/team` を引数で上書きするか、entrant_id から再導出か——上書きなら新名を渡す。(b) `PUT /api/entrants/:id` の必須フィールド（surname/given_name 分割か name 一括か、`base_updated_at` occStale）を `EnT.openEdit`(10818) の送信形に合わせる。

- [ ] **Step 3: `_onConflict()`／成功後 `reload()`／`_rev` 更新を実装**（レスポンスの `bracket_rev` を `TMgmt._rev[ev]` に反映）。

- [ ] **Step 4: 構文チェック → OK。手動: シングル種目で名前/所属/シード/登場回戦を編集→右ツリー即反映、別タブ同時編集で409→自動リロードを確認。**

- [ ] **Step 5: コミット**

```bash
git add public/admin/index.html
git commit -m "feat: トーナメント管理(Phase2) エクセル風グリッド＋セル直接編集＋409ガード"
```

### Task 2.3: Phase2 レビュー＆デプロイ
- [ ] Workflow 適応レビュー（編集の保存先振り分け／set-slot 再同期で枠名が崩れない／409経路／登場回戦のpromote副作用）→ push →Actions成功。

---

## Phase 3 — ダブルス2行表示＋個人別編集＋[⋮]操作群＋相方入替

### Task 3.1: バックエンド `swapEntrantPartners`（TDD）

**Files:** Modify `db.js`、Create `test/bracket-swap-partner.test.js`

- [ ] **Step 1: 失敗するテストを書く**

```javascript
// test/bracket-swap-partner.test.js
process.env.DB_PATH = "/tmp/ktta_swappartner_" + process.pid + ".db";
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const db = require("../db");
after(()=>{ for(const x of ["","-wal","-shm"]) try{fs.rmSync(process.env.DB_PATH+x,{force:true})}catch(e){} });
const EV = "混合ダブルス";

test("swapEntrantPartners: 2ペアの選手2(相方)を入替え、表示名も更新", () => {
  const t = db.createTournament({ name:"ペア入替", date:"2027-09-09" });
  const a = db.createEntrant({ tournament_id:t.id, event:EV, seed:1, is_doubles:1,
    surname:"前", given_name:"太", team:"工業", partner_surname:"小山内", partner_given_name:"花", partner_team:"北陽", status:"confirmed" });
  const b = db.createEntrant({ tournament_id:t.id, event:EV, seed:2, is_doubles:1,
    surname:"今野", given_name:"健", team:"北陽", partner_surname:"板垣", partner_given_name:"翼", partner_team:"Neo", status:"confirmed" });
  db.generateBracket(t.id, EV, { regenerate:true });

  const r = db.swapEntrantPartners(t.id, EV, a.id, b.id);
  assert.ok(r && !r.error, "入替成功: "+JSON.stringify(r));

  const A = db.getEntrants(t.id, EV).find(e=>e.id===a.id);
  const B = db.getEntrants(t.id, EV).find(e=>e.id===b.id);
  assert.strictEqual(A.partner_name && A.partner_name.indexOf("板垣")>=0, true, "Aの相方が板垣に");
  assert.strictEqual(B.partner_name && B.partner_name.indexOf("小山内")>=0, true, "Bの相方が小山内に");
  // 枠の表示名(display) もペアの新構成を反映
  const m = db.getMatchesByTournament(t.id).filter(x=>x.event===EV && x.bracket_round===1);
  const names = m.flatMap(x=>[x.player1_name,x.player2_name]).filter(Boolean).join(" / ");
  assert.ok(names.indexOf("板垣")>=0 && names.indexOf("小山内")>=0, "枠の表示名が更新: "+names);
});

test("swapEntrantPartners: 種目違い/不存在はエラー", () => {
  const t = db.createTournament({ name:"err", date:"2027-09-10" });
  const a = db.createEntrant({ tournament_id:t.id, event:EV, is_doubles:1, surname:"X", team:"x", partner_surname:"Y", partner_team:"y", status:"confirmed" });
  const r = db.swapEntrantPartners(t.id, EV, a.id, 999999);
  assert.ok(r && r.error, "不存在はエラー: "+JSON.stringify(r));
});
```

- [ ] **Step 2: 失敗確認**  Run: `node --test test/bracket-swap-partner.test.js`  Expected: FAIL（`swapEntrantPartners is not a function`）

- [ ] **Step 3: `db.swapEntrantPartners` を実装**（`promoteToSeed` 近傍、~2916）

```javascript
// 1トランザクションで a,b の partner_* 一式(surname/given_name/name/furigana/team/gender/player_id)を交換。
// 交換後 createEntrant と同じ表示名導出で display_name/partner_name を再計算し entrants を更新。
// 両 entrant が R1 枠に居れば、その枠の player1_name/player2_name を新表示名で更新（set-slot 相当の内部関数を再利用）。
// 種目不一致 or 不存在 or どちらか is_doubles!=1 は {error}。成功は {ok:true}。
function swapEntrantPartners(tournamentId, event, aId, bId){ /* 実装 */ }
module.exports.swapEntrantPartners = swapEntrantPartners; // 既存 export 群に追加
```

- [ ] **Step 4: テスト通過確認**  Run: `node --test test/bracket-swap-partner.test.js`  Expected: PASS

- [ ] **Step 5: サーバ経路を追加**（`server.js` ~3628、promote-seed の隣、bracketRevStale ガード）

```javascript
app.post("/api/tournaments/:id/bracket/swap-partner", requireAdmin, (req,res)=>{
  const { event, a_entrant_id, b_entrant_id } = req.body || {};
  if (bracketRevStale(req.params.id, event, req.body)) return sendBracketConflict(res, req.params.id, event);
  const r = db.swapEntrantPartners(req.params.id, event, a_entrant_id, b_entrant_id);
  if (r && r.error) return res.status(400).json(r);
  res.json({ ...r, bracket_rev: db.bracketRev(req.params.id, event) });
});
```

- [ ] **Step 6: 全テスト＆コミット**

```bash
npm test 2>&1 | grep -E "ℹ (pass|fail)"
git add db.js server.js test/bracket-swap-partner.test.js
git commit -m "feat: swapEntrantPartners＋/bracket/swap-partner(ペア相方の原子的入替)"
```

### Task 3.2: ダブルス2行描画＋個人別セル編集＋[⋮]

**Files:** Modify `public/admin/index.html`（`TMgmt`）

- [ ] **Step 1: `is_doubles` 行を選手1/選手2の2サブ行で描画**（`枠`セルは rowspan=2）。各サブ行のセルは Phase2 のコミット振り分け（選手1=`name/team/furigana`、選手2=`partner_*`）。

- [ ] **Step 2: 行 `[⋮]` メニュー実装**（既存ロジック再利用）
  - 「選手を入れ替え/BYEにする/空きにする」→ `_editSlot` 相当（`set-slot`）。可能なら既存 `O._editSlot(event,pos,slot,name)` を直接呼ぶ。
  - 「シードに繰り上げ」→ `promote-seed`（既存）。
  - 「先頭/末尾にシード追加」→ `O.openAddSeed` 流用。
  - 「相方を入替」→ 別ペア選択ダイアログ→ `POST /bracket/swap-partner {event,a_entrant_id,b_entrant_id,base_rev}`→`reload()`。

- [ ] **Step 3: 構文チェック→OK。手動: 混合D種目で選手1/2を個別編集、相方入替で2ペアが組替り右ツリー反映を確認。**

- [ ] **Step 4: コミット**

```bash
git add public/admin/index.html
git commit -m "feat: トーナメント管理(Phase3) ダブルス2行・個人別編集＋[⋮]操作＋相方入替"
```

### Task 3.3: Phase3 レビュー＆デプロイ
- [ ] Workflow レビュー（相方入替のトランザクション/表示名整合・[⋮]操作の409ガード）→ push →Actions成功。

---

## Phase 4 — 整合性チェックパネル（3項目＋ワンクリック修正）

### Task 4.1: 整合性パネル

**Files:** Modify `public/admin/index.html`（`TMgmt`）

- [ ] **Step 1: 上部に「整合性チェック ⚠N」バッジ＋折りたたみパネル**を追加。`reload()` 後に集計。

- [ ] **Step 2: 3項目を実装**
  - 推定不一致（性別/カテゴリ/ふりがな）: `GET /api/tournaments/:id/entry-issues` 相当（`findEntrantDataIssues`）を取得し列挙。「推定値で一括修正」→ `POST /entry-issues/bulk-fix`、行別→ `POST /entries/:pid/fix`（既存）。
  - ダブルス並びパターン: 現エントリーの氏名/所属サンプルを提示し「氏名⇄所属を全員入替」「選手1⇄選手2を全員入替」。各 entrant に `PUT /api/entrants/:id`（入替後の値）を一括適用＋枠名再同期。
  - 重複検出: `entrants` をクライアント側で正規化（シングル=`氏名|所属`、ダブルス=`{2名|2所属}` の集合）でグルーピング。重複群を一覧し「この重複を削除」→ `DELETE /api/entrants/:id`（既存・結果ガードあり）。

- [ ] **Step 3: 構文チェック→OK。手動: 取込直後の種目で各検出→ワンクリック修正→再集計で件数が減ることを確認。**

- [ ] **Step 4: コミット**

```bash
git add public/admin/index.html
git commit -m "feat: トーナメント管理(Phase4) 整合性チェック(推定不一致/ダブルス並び/重複)＋一括修正"
```

### Task 4.2: Phase4 レビュー＆デプロイ
- [ ] Workflow レビュー（一括入替の取り違え/重複削除の結果ガード）→ push →Actions成功。

---

## Self-Review チェック結果
- **Spec coverage:** 左右2画面(P1右/P2左)・セル直接編集＋[⋮](P2/P3)・ダブルス2行個人別＋ペア組替(P3)・整合性3項目(P4)・大会ごと種目選択(P1)・既存API再利用＋最小バックエンド(P3 swap-partner)＝spec全項目に対応。人数/BYE妥当性は仕様どおり除外。
- **Placeholder:** 「着手時に確認」注記は実APIの細部（set-slotの名前上書き仕様/entrants PUTの必須フィールド/renderVisualBracketの参照名）に限定。実装本体のコード/コマンド/テストは具体化済み。
- **Type consistency:** `TMgmt._rev[ev]`/`bracket_rev` 往復、`swapEntrantPartners(tid,event,aId,bId)→{ok|error}`、`set-slot {mode:"player",entrant_id,name,team}` をP2/P3で統一使用。
