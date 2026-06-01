// ═══════════════════════════════════════════════════════
// 共通JS（admin/viewer共通ユーティリティ）
// ═══════════════════════════════════════════════════════
(function(global){
  'use strict';

  // ストレージ無効 / Safari プライベートモードで localStorage が例外を投げても画面が壊れないよう保護。
  // 正常時は何もせず本物の localStorage を使う。例外時のみメモリ実装に差し替える。
  try { var __lsProbe = '__ls_probe__'; global.localStorage.setItem(__lsProbe, '1'); global.localStorage.removeItem(__lsProbe); }
  catch (e) {
    try {
      var __mem = {};
      var __shim = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(__mem, k) ? __mem[k] : null; },
        setItem: function (k, v) { __mem[k] = String(v); },
        removeItem: function (k) { delete __mem[k]; },
        clear: function () { __mem = {}; },
        key: function (i) { return Object.keys(__mem)[i] || null; },
      };
      Object.defineProperty(__shim, 'length', { get: function () { return Object.keys(__mem).length; } });
      Object.defineProperty(global, 'localStorage', { configurable: true, get: function () { return __shim; } });
    } catch (_e) {}
  }

  // flex の gap 非対応(Safari<14.1 / iOS<14.5)を検出して <html>.no-flexgap を付与。
  // CSS 側で gap ユーティリティに margin フォールバックを当てる。正常ブラウザでは何も付かない(無変更)。
  try {
    var __fg = document.createElement('div');
    __fg.style.cssText = 'display:flex;gap:1px;position:absolute;visibility:hidden;height:0;pointer-events:none';
    __fg.appendChild(document.createElement('div'));
    __fg.appendChild(document.createElement('div'));
    var __host = document.body || document.documentElement;
    __host.appendChild(__fg);
    var __gapOK = __fg.scrollWidth === 1;
    __host.removeChild(__fg);
    if (!__gapOK) document.documentElement.classList.add('no-flexgap');
  } catch (_e) {}

  const GENDERS = [{v:"male",l:"男子"},{v:"female",l:"女子"}];
  const CATS = [
    {v:"elementary",l:"小学生"},{v:"middle",l:"中学生"},{v:"high",l:"高校生"},
    {v:"university",l:"大学生"},{v:"general",l:"一般"},{v:"individual",l:"個人"}
  ];
  // 値→ラベル (旧 senior 等の後方互換も含めフォールバック)
  function catLabel(v) {
    const f = CATS.find(c => c.v === v);
    if (f) return f.l;
    if (v === "senior") return "シニア";
    return v ? v : "未設定";
  }
  const EV_TYPES = ["シングルス","ダブルス","団体戦","混合ダブルス"];
  const ROUNDS = [
    "決勝","準決勝","準々決勝","ベスト16","ベスト32",
    "6回戦","5回戦","4回戦","3回戦","2回戦","1回戦","予選リーグ"
  ];
  const PLACES = [
    {v:1,l:"優勝",e:"🥇",c:"#ca8a04"},
    {v:2,l:"準優勝",e:"🥈",c:"#6b7280"},
    {v:3,l:"3位",e:"🥉",c:"#b45309"}
  ];

  // ── DOMユーティリティ ──
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      }
      else if (k === "className") el.className = v;
      else if (k === "innerHTML") el.innerHTML = v;
      else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
      else el.setAttribute(k, v);
    });
    children.flat(Infinity).forEach(c => {
      if (c == null || c === false) return;
      el.appendChild(typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c)) : c);
    });
    return el;
  }

  function esc(s) {
    // HTML特殊文字をエスケープ。引用符(" ')も対象にして、属性値に展開された場合の
    // 属性インジェクション(XSS)も防ぐ。テキスト/属性どちらの文脈でも安全。
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // ── APIクライアント ──
  const api = {
    adminKey: localStorage.getItem("tt_admin_key") || "",
    setAdminKey(k) { this.adminKey = k; localStorage.setItem("tt_admin_key", k); },
    baseUrl: "",
    _headers() {
      const h = { "Content-Type": "application/json" };
      if (this.adminKey) h["X-Admin-Key"] = this.adminKey;
      return h;
    },
    async get(url) {
      // 管理キーを付与 (ADMIN_KEY 設定時に /api/admin/* 等の GET が 401 になる不具合を修正)。
      // 閲覧/審判ページは adminKey 未設定なので X-Admin-Key は付かない (_headers 参照)。
      const r = await fetch(this.baseUrl + url, { headers: this._headers() });
      return r.json();
    },
    async post(url, data) {
      const r = await fetch(this.baseUrl + url, {
        method: "POST", headers: this._headers(),
        body: JSON.stringify(data || {})
      });
      return r.json();
    },
    async put(url, data) {
      const r = await fetch(this.baseUrl + url, {
        method: "PUT", headers: this._headers(),
        body: JSON.stringify(data || {})
      });
      return r.json();
    },
    async del(url) {
      const r = await fetch(this.baseUrl + url, {
        method: "DELETE", headers: this._headers()
      });
      return r.json();
    },
  };

  // ── オフライン耐性: 書込みのリトライキュー (op_id 冪等) ───────────────
  // 会場の WiFi 断で結果入力が「無言で消える/二重入力」になるのを防ぐ。
  // opSend: 即時送信を試み、ネット断なら localStorage に積んで自動再送。
  // 各 op に op_id を付け、サーバ側で冪等判定して二重適用を防止する。
  (function () {
    const QKEY = "tt_op_queue_v1";
    const QMAX = 300;   // 送信待ちの上限。無制限だと localStorage 枯渇(QuotaExceeded)で新規opが黙って落ちる
    const listeners = [];
    function loadQ() { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch (e) { return []; } }
    function saveQ(q) { try { localStorage.setItem(QKEY, JSON.stringify((q || []).slice(-QMAX))); } catch (e) {} notify(); }
    function notify() { const n = loadQ().length; listeners.forEach(cb => { try { cb(n, api.online); } catch (e) {} }); }
    function uuid() { try { return crypto.randomUUID(); } catch (e) { return "op-" + Date.now() + "-" + Math.random().toString(16).slice(2); } }

    api.online = (typeof navigator === "undefined") ? true : (navigator.onLine !== false);
    api.onPending = function (cb) { listeners.push(cb); try { cb(loadQ().length, api.online); } catch (e) {} };
    api.pendingCount = function () { return loadQ().length; };
    api.pendingTags = function () { const s = {}; loadQ().forEach(o => { if (o.tag) s[o.tag] = true; }); return s; };
    api.hasPending = function (tag) { return !!(tag && api.pendingTags()[tag]); };
    api.onQueueFlushed = null; // アプリ側で再描画したい時に差し込む

    // 応答は status まで見る。2xx か X-Idempotent-Replay(既適用)=成功、5xx=一時障害(残して再試行)、
    // 4xx=恒久エラー(再送不可)。旧実装は応答が返れば成否問わず除去しており、5xx/401で
    // 未適用なのに finish/correct を取りこぼしていた(本部の書込みキュー=結果消失)。
    function deliver(item) {
      const headers = api._headers();
      if (item.op_id) headers["X-Op-Id"] = item.op_id;
      return fetch(api.baseUrl + item.url, {
        method: item.method, headers,
        body: (item.method === "DELETE") ? undefined : JSON.stringify(item.body || {}),
      }).then(async (r) => ({
        ok: r.ok,
        status: r.status,
        replay: !!(r.headers && r.headers.get && r.headers.get("X-Idempotent-Replay") === "1"),
        json: await r.json().catch(() => ({})),
      }));
    }

    api.onQueueDrop = null;  // 4xx恒久エラーで破棄した op をアプリへ通知 (任意)
    let flushing = false;
    api.flushQueue = async function () {
      if (flushing) return;
      flushing = true;
      let delivered = 0;
      try {
        let q = loadQ();
        while (q.length) {
          const item = q[0];
          let res;
          try {
            res = await deliver(item);
          } catch (e) {
            break;                        // ネット断: 中断して残す(次回再試行)
          }
          if (res.ok || res.replay) {
            q = loadQ(); q.shift(); saveQ(q); delivered++;   // 適用成功 or 既適用 → 除去
          } else if (res.status >= 500) {
            break;                        // サーバ一時障害: 残して次回再試行
          } else {
            // 4xx(検証/認可/競合)は再送しても通らない。先頭で詰まらせないよう除去し記録。
            q = loadQ(); const dropped = q.shift(); saveQ(q);
            console.warn("opQueue: 恒久エラー(status " + res.status + ")で破棄:", dropped && dropped.url);
            try { if (typeof api.onQueueDrop === "function") api.onQueueDrop(dropped, res.status, res.json); } catch (e) {}
          }
        }
        if (delivered && api.online !== true) { api.online = true; notify(); }
      } finally {
        flushing = false; notify();
        if (delivered && typeof api.onQueueFlushed === "function") { try { api.onQueueFlushed(delivered); } catch (e) {} }
      }
    };

    // 書込み送信。成功時=サーバ応答JSON / ネット断時=キューに積み {queued:true, op_id}
    // opts: { op_id?, tag? }  tag は「この対戦の送信待ち」などの目印
    api.opSend = async function (method, url, data, opts) {
      opts = opts || {};
      const op_id = opts.op_id || uuid();
      const body = Object.assign({}, data || {}, { op_id });
      const item = { op_id, method, url, body, tag: opts.tag || "", ts: Date.now() };
      let res;
      try {
        res = await deliver(item);        // オンライン: 即時送信
      } catch (e) {
        const q = loadQ(); q.push(item); saveQ(q);   // ネット断: キューへ
        api.online = false; notify();
        return { queued: true, op_id };
      }
      if (res.ok || res.replay) return res.json;       // 適用成功 or 既適用
      if (res.status >= 500) {                         // サーバ一時障害: キューへ積み再試行(取りこぼし防止)
        const q = loadQ(); q.push(item); saveQ(q); notify();
        return { queued: true, op_id, retry: true };
      }
      return res.json;                                 // 4xx 恒久エラー: 応答をそのまま返す(呼出側がエラー表示)
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", () => { api.online = true; notify(); api.flushQueue(); });
      window.addEventListener("offline", () => { api.online = false; notify(); });
      setInterval(() => { if (loadQ().length) api.flushQueue(); }, 8000);
      setTimeout(() => { if (loadQ().length) api.flushQueue(); }, 1500);
    }
  })();

  // ── 所要時間フォーマット (秒 → "12分" / "1時間5分" / "45秒") ──
  function fmtDuration(sec) {
    sec = parseInt(sec) || 0;
    if (sec <= 0) return "";
    if (sec < 60) return sec + "秒";
    const m = Math.round(sec / 60);
    if (m < 60) return m + "分";
    return Math.floor(m / 60) + "時間" + (m % 60 ? (m % 60) + "分" : "");
  }

  // 結果スコア表示。両方0は「勝者のみ入力」なので "○"(勝ち) を返す。
  // それ以外は "勝-敗" (例 "3-1")。winSymbol で記号を上書き可能。
  function fmtScore(ws, ls, opts) {
    ws = parseInt(ws) || 0; ls = parseInt(ls) || 0;
    if (ws === 0 && ls === 0) return (opts && opts.winSymbol) || "○";
    return ws + "-" + ls;
  }

  // ── 経過時間 (呼出→現在) を1分ごとにカウントアップ ──
  // 日時文字列(localtime "YYYY-MM-DD HH:MM:SS" or ISO)からの経過分を返す。
  function elapsedMinSince(sinceStr) {
    if (!sinceStr) return null;
    const t0 = Date.parse(String(sinceStr).replace(" ", "T"));
    if (isNaN(t0)) return null;
    const min = Math.floor((Date.now() - t0) / 60000);
    return min >= 0 ? min : null;
  }
  function fmtElapsedClock(sinceStr) {
    const m = elapsedMinSince(sinceStr);
    if (m == null) return "";
    return m < 60 ? (m + "分") : (Math.floor(m / 60) + "時間" + (m % 60) + "分");
  }
  // ページ内の全 [data-elapsed-since] を「経過 N分」に更新し、30秒ごとに自動更新。
  // (LIVE/進行管理は変化検知でしか再描画しないため、独立タイマーで時計を進める)
  function startElapsedTicker() {
    const upd = () => {
      const els = (typeof document !== "undefined")
        ? document.querySelectorAll("[data-elapsed-since]") : [];
      els.forEach(el => {
        const txt = fmtElapsedClock(el.getAttribute("data-elapsed-since"));
        const prefix = el.getAttribute("data-elapsed-prefix");
        const next = txt ? ((prefix != null ? prefix : "経過 ") + txt) : "";
        if (el.textContent !== next) el.textContent = next;
      });
    };
    upd();
    if (!startElapsedTicker._t && typeof setInterval !== "undefined") {
      startElapsedTicker._t = setInterval(upd, 30000);
    }
  }

  // ── 選手の数値化スタッツ (卓球向け) ──
  // player.matches (getMatchesByPlayer: BYE/不戦勝除外済・tournament_name/date付) から算出。
  function computePlayerStats(player) {
    const pid = player && player.id;
    const ms = ((player && player.matches) || []).filter(m => m && (m.winner_id === pid || m.loser_id === pid));
    let wins = 0, losses = 0, setsWon = 0, setsLost = 0, fullW = 0, fullL = 0;
    const byT = {}, byE = {}, byM = {}, byOpp = {}, byBranch = {}, grp = {};
    const scoreW = {}, scoreL = {}, byRound = {}, byOppTeam = {};   // 分布/ラウンド別/相手所属 (野球的指標 #250/#251)
    let shutoutW = 0, shutoutL = 0;                  // 完封勝ち(相手0セット) / 被完封
    let killW = 0, killN = 0, upsetL = 0, upsetN = 0;   // 対格上勝/対格上数, 格下取りこぼし/対格下数 (#250)
    let ptsFor = 0, ptsAgainst = 0, gamesScored = 0, deuceW = 0, deuceN = 0;  // ゲーム別点数 → 得点率/デュース勝率
    const time = { am: { w: 0, l: 0 }, pm: { w: 0, l: 0 }, eve: { w: 0, l: 0 } };
    // 到達ラウンドの深さ: ベスト16=1, 準々決勝=2, 準決勝=3, 決勝=4 (準々/準 を先に判定)
    const roundRank = (r) => { r = String(r || ""); if (r.indexOf("準々決勝") >= 0) return 2; if (r.indexOf("準決勝") >= 0) return 3; if (r.indexOf("決勝") >= 0) return 4; if (r.indexOf("ベスト16") >= 0 || r.indexOf("ﾍﾞｽﾄ" + "16") >= 0) return 1; return 0; };
    const hourOf = (s) => { const mm = /\s(\d{2}):/.exec(String(s || "")); return mm ? parseInt(mm[1]) : null; };
    // 古い順 (連勝計算用)
    const chrono = ms.slice().sort((a, b) =>
      String(a.tournament_date || "").localeCompare(String(b.tournament_date || "")) ||
      (a.round_order || 0) - (b.round_order || 0) || (a.match_no || 0) - (b.match_no || 0));
    let cur = 0, longest = 0;
    chrono.forEach(m => {
      const won = m.winner_id === pid;
      if (won) { wins++; cur++; if (cur > longest) longest = cur; } else { losses++; cur = 0; }
      const ws = m.winner_sets || 0, ls = m.loser_sets || 0;
      setsWon += won ? ws : ls; setsLost += won ? ls : ws;
      const tk = (m.tournament_name || "?") + "" + (m.tournament_date || "");
      (byT[tk] = byT[tk] || { name: m.tournament_name || "?", date: m.tournament_date || "", w: 0, l: 0 })[won ? "w" : "l"]++;
      const ek = m.event || "?";
      (byE[ek] = byE[ek] || { event: ek, w: 0, l: 0 })[won ? "w" : "l"]++;
      if (ws > 0 && ls === ws - 1) { if (won) fullW++; else fullL++; }
      // ゲームカウント分布(自分視点) / 完封 / ラウンド別 (野球的な細かい指標)
      const mySets = won ? ws : ls, oppSets = won ? ls : ws;
      const dk = mySets + "-" + oppSets;
      if (won) { scoreW[dk] = (scoreW[dk] || 0) + 1; if (oppSets === 0) shutoutW++; }
      else { scoreL[dk] = (scoreL[dk] || 0) + 1; if (mySets === 0) shutoutL++; }
      const rkey = (m.round && String(m.round).trim()) || "";
      if (rkey) (byRound[rkey] = byRound[rkey] || { name: rkey, order: m.round_order || 99, w: 0, l: 0 })[won ? "w" : "l"]++;
      const ym = String(m.tournament_date || "").slice(0, 7);
      if (ym) (byM[ym] = byM[ym] || { ym: ym, w: 0, l: 0 })[won ? "w" : "l"]++;
      const oppName = won ? (m.loser_name || "") : (m.winner_name || "");
      if (oppName) (byOpp[oppName] = byOpp[oppName] || { name: oppName, w: 0, l: 0 })[won ? "w" : "l"]++;
      // 対 支部別: 相手の所属を「公式支部」に正規化できた時のみ支部単位で集計。
      // (正規化できない=所属チーム名そのままは支部別ではないので除外。所属チーム別に化けるのを防止)
      const oppTeam = won ? (m.loser_team || "") : (m.winner_team || "");
      const oppBranch = normalizeBranch(oppTeam || "") || "";
      const isOfficialBranch = /支部$/.test(oppBranch) && HOKKAIDO_BRANCHES.indexOf(oppBranch.replace(/支部$/, "")) >= 0;
      if (isOfficialBranch) (byBranch[oppBranch] = byBranch[oppBranch] || { name: oppBranch, w: 0, l: 0 })[won ? "w" : "l"]++;
      // よく対戦する所属チーム分布 (#251)
      if (oppTeam) (byOppTeam[oppTeam] = byOppTeam[oppTeam] || { name: oppTeam, w: 0, l: 0 })[won ? "w" : "l"]++;
      // 対シード(格上撃破/格下取りこぼし) + ゲーム別点数→得点率 (#250 / 得点率)
      const iAmP1 = !!(m.player1_id && pid === m.player1_id);
      const iAmP2 = !!(m.player2_id && pid === m.player2_id);
      if (iAmP1 || iAmP2) {
        const mySeed = iAmP1 ? (m.player1_seed || 0) : (m.player2_seed || 0);
        const oppSeed = iAmP1 ? (m.player2_seed || 0) : (m.player1_seed || 0);
        if (oppSeed > 0 && (mySeed === 0 || oppSeed < mySeed)) { killN++; if (won) killW++; }       // 相手が格上
        if (mySeed > 0 && (oppSeed === 0 || oppSeed > mySeed)) { upsetN++; if (!won) upsetL++; }     // 相手が格下
        if (Array.isArray(m.sets)) m.sets.forEach(s => {
          if (Array.isArray(s) && s.length === 2) {
            const mine = iAmP1 ? (parseInt(s[0]) || 0) : (parseInt(s[1]) || 0);
            const op = iAmP1 ? (parseInt(s[1]) || 0) : (parseInt(s[0]) || 0);
            if (mine || op) { ptsFor += mine; ptsAgainst += op; gamesScored++;
              if (Math.min(mine, op) >= 10) { deuceN++; if (mine > op) deuceW++; } }  // デュース(10-10〜)
          }
        });
      }
      const hr = hourOf(m.finished_at);
      if (hr != null) { const tb = hr < 12 ? "am" : (hr < 16 ? "pm" : "eve"); time[tb][won ? "w" : "l"]++; }
      const gk = (m.tournament_id || "") + "|" + (m.event || "");
      const g = grp[gk] = grp[gk] || { deepest: 0, champ: false };
      const rk = roundRank(m.round);
      if (rk > g.deepest) g.deepest = rk;
      if (rk === 4 && won) g.champ = true;
    });
    const recent = ms.slice(0, 10).map(m => (m.winner_id === pid ? "W" : "L")); // 新しい順 (queryがdate DESC)
    // 対戦時間 (duration_sec: 呼出→結果入力)。0や異常値は除外。
    const durs = ms.map(m => parseInt(m.duration_sec) || 0).filter(d => d > 0 && d < 24 * 3600);
    const avgDur = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : 0;
    const maxDur = durs.length ? Math.max.apply(null, durs) : 0;
    const total = wins + losses;
    const pctOf = (w, n) => (n ? Math.round((w / n) * 100) : 0);
    const setsTotal = setsWon + setsLost;
    const tournaments = Object.values(byT)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map(t => ({ name: t.name, date: t.date, w: t.w, l: t.l, total: t.w + t.l, rate: pctOf(t.w, t.w + t.l) }));
    const events = Object.values(byE)
      .sort((a, b) => (b.w + b.l) - (a.w + a.l))
      .map(e => ({ event: e.event, w: e.w, l: e.l, total: e.w + e.l, rate: pctOf(e.w, e.w + e.l) }));
    const months = Object.values(byM).sort((a, b) => b.ym.localeCompare(a.ym))
      .map(x => ({ ym: x.ym, w: x.w, l: x.l, total: x.w + x.l, rate: pctOf(x.w, x.w + x.l) }));
    const h2h = Object.values(byOpp).sort((a, b) => (b.w + b.l) - (a.w + a.l))
      .map(o => ({ name: o.name, w: o.w, l: o.l, total: o.w + o.l, rate: pctOf(o.w, o.w + o.l) }));
    const branches = Object.values(byBranch).sort((a, b) => (b.w + b.l) - (a.w + a.l))
      .map(b => ({ name: b.name, w: b.w, l: b.l, total: b.w + b.l, rate: pctOf(b.w, b.w + b.l) }));
    const byTime = [["am", "午前"], ["pm", "午後"], ["eve", "夕方〜"]]
      .map(kv => ({ label: kv[1], w: time[kv[0]].w, l: time[kv[0]].l, total: time[kv[0]].w + time[kv[0]].l, rate: pctOf(time[kv[0]].w, time[kv[0]].w + time[kv[0]].l) }))
      .filter(x => x.total > 0);
    const grps = Object.values(grp);
    // 最終成績 (各 大会×種目 で「実際に到達した位置」を1つだけ計上)
    const rounds = {
      entries: grps.length,
      champion: grps.filter(g => g.champ).length,
      runnerup: grps.filter(g => !g.champ && g.deepest >= 4).length, // 決勝で敗退
      best4: grps.filter(g => g.deepest === 3).length,
      best8: grps.filter(g => g.deepest === 2).length,
      best16: grps.filter(g => g.deepest === 1).length,
    };
    const fullTotal = fullW + fullL;
    return {
      total, wins, losses, rate: pctOf(wins, total),
      setsWon, setsLost, setRate: pctOf(setsWon, setsTotal),
      avgWon: total ? (setsWon / total).toFixed(1) : "0", avgLost: total ? (setsLost / total).toFixed(1) : "0",
      fullSet: { w: fullW, l: fullL, total: fullTotal, rate: pctOf(fullW, fullTotal) },
      recent, streakCurrent: cur, streakLongest: longest,
      avgDur, maxDur, durCount: durs.length, totalDur: durs.reduce((a, b) => a + b, 0),
      tournaments, events, months, h2h, byTime, rounds, branches,
      scoreDist: {
        win: Object.entries(scoreW).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })),
        lose: Object.entries(scoreL).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })),
      },
      shutout: { w: shutoutW, l: shutoutL, winRate: pctOf(shutoutW, wins), loseRate: pctOf(shutoutL, losses) },
      rounds_wl: Object.values(byRound).sort((a, b) => a.order - b.order)
        .map(r => ({ name: r.name, w: r.w, l: r.l, total: r.w + r.l, rate: pctOf(r.w, r.w + r.l) })),
      oppTeams: Object.values(byOppTeam).sort((a, b) => (b.w + b.l) - (a.w + a.l))
        .map(o => ({ name: o.name, w: o.w, l: o.l, total: o.w + o.l, rate: pctOf(o.w, o.w + o.l) })),
      seedBattle: { killW, killN, killRate: pctOf(killW, killN), upsetL, upsetN },
      points: {
        games: gamesScored,
        rate: (ptsFor + ptsAgainst) ? Math.round(ptsFor / (ptsFor + ptsAgainst) * 100) : 0,
        avgFor: gamesScored ? (ptsFor / gamesScored).toFixed(1) : "0",
        avgAgainst: gamesScored ? (ptsAgainst / gamesScored).toFixed(1) : "0",
      },
      pointDiff: ptsFor - ptsAgainst,                                  // 得点デフ(総得点-総失点) #野球的
      deuce: { w: deuceW, n: deuceN, rate: pctOf(deuceW, deuceN) },    // デュース(10-10〜)勝率
      recent10: (() => { const w = recent.filter(r => r === "W").length; return { w, n: recent.length, rate: pctOf(w, recent.length) }; })(),
      finalGame: { w: fullW, n: fullW + fullL, rate: pctOf(fullW, fullW + fullL) },  // ファイナルゲーム(接戦)勝率
    };
  }

  // ── 選手スタッツ セクション (閲覧/admin 共通描画) ──
  function playerStatsSection(player, opts) {
    opts = opts || {};
    const avg = opts.averages || null;
    const st = computePlayerStats(player);
    const wrap = h("div", {});
    if (!st.total) {
      wrap.appendChild(h("div", { className: "section-title" }, "数値で見る成績"));
      wrap.appendChild(h("div", { className: "pstat-empty" }, "記録された試合がまだありません。"));
      return wrap;
    }
    const tile = (v, l, s, cmp) => h("div", { className: "pstat-tile" },
      h("div", { className: "pstat-v" }, v), h("div", { className: "pstat-l" }, l),
      s ? h("div", { className: "pstat-s" }, s) : null, cmp || null);
    // 全試合平均との相対 (比較できる指標のみ)。勝率/セット率/フルセット勝率は
    // 全対戦が勝敗1:1のため平均50%が基準。平均対戦時間は全試合の集計平均と比較。
    const deltaTxt = (d, unit) => d > 0 ? "▲ +" + d + unit : (d < 0 ? "▼ −" + Math.abs(d) + unit : "＝ 同等");
    const cmpPct = (val, base, higherGood) => {
      if (val == null) return null;
      const d = Math.round((val - base) * 10) / 10;
      const tone = d === 0 ? "even" : ((d > 0) === !!higherGood ? "up" : "down");
      return h("div", { className: "pstat-cmp " + tone },
        h("span", { className: "pstat-cmp-a" }, "全体平均 " + base + "%"),
        h("span", { className: "pstat-cmp-d" }, deltaTxt(d, "pt")));
    };
    const cmpDur = (sec, avgSec) => {
      if (!sec || !avgSec) return null;
      const d = Math.round((sec - avgSec) / 60);
      return h("div", { className: "pstat-cmp even" },
        h("span", { className: "pstat-cmp-a" }, "全体平均 " + fmtDuration(avgSec)),
        h("span", { className: "pstat-cmp-d" }, deltaTxt(d, "分")));
    };
    const bar = (rate) => h("span", { className: "pstat-bar" },
      h("i", { className: (rate >= 50 ? "hi" : ""), style: { width: Math.max(3, Math.min(100, rate || 0)) + "%" } }));
    const rateRow = (label, o) => h("div", { className: "pstat-row" },
      h("span", { className: "pstat-rk" }, label),
      h("span", { className: "pstat-rv" }, o.w + "勝 " + o.l + "敗"),
      bar(o.rate),
      h("span", { className: "pstat-rp" + (o.rate >= 50 ? " hi" : "") }, o.rate + "%"));
    const table = (rows) => { const t = h("div", { className: "pstat-table" }); rows.forEach(r => t.appendChild(r)); return t; };
    const details = (title, node, open) => {
      const d = h("details", { className: "pmore" });
      if (open) d.open = true;
      d.appendChild(h("summary", { className: "pmore-sum" }, title));
      const b = h("div", { className: "pmore-body" }); b.appendChild(node); d.appendChild(b);
      return d;
    };

    // ── ① サマリー帯 (一目で分かる主要成績) ──
    const medals = [
      ["優勝", st.rounds.champion, "gold"], ["準優勝", st.rounds.runnerup, "silver"],
      ["3位", st.rounds.best4, "bronze"], ["ベスト8", st.rounds.best8, ""],
    ].filter(m => m[1] > 0);
    const band = h("div", { className: "psum" });
    band.appendChild(h("div", { className: "psum-main" },
      h("div", { className: "psum-rate" },
        h("span", { className: "psum-rate-v" }, st.rate + "%"),
        h("span", { className: "psum-rate-k" }, "通算勝率")),
      h("div", { className: "psum-rec" }, st.wins + "勝 " + st.losses + "敗"),
      h("div", { className: "psum-wl", title: st.wins + "勝 / " + st.losses + "敗" },
        h("i", { className: "w", style: { flexGrow: String(st.wins || 0) } }),
        h("i", { className: "l", style: { flexGrow: String(st.losses || 0) } }))));
    const kvItem = (v, l) => h("div", { className: "psum-kv-i" }, h("b", {}, String(v)), h("span", {}, l));
    const kv = h("div", { className: "psum-kv" },
      kvItem(st.total, "試合"), kvItem(st.tournaments.length, "出場大会"), kvItem(st.setRate + "%", "セット率"));
    if (st.recent && st.recent.length) kv.appendChild(kvItem(st.recent.filter(r => r === "W").length + "/" + st.recent.length, "直近"));
    band.appendChild(kv);
    if (medals.length) band.appendChild(h("div", { className: "psum-medals" },
      ...medals.map(m => h("span", { className: "preach-chip " + (m[2] || "") }, m[0] + " " + m[1] + "回"))));
    wrap.appendChild(band);

    // ── ② 主要指標 (厳選タイル) ──
    const keyTiles = [
      tile(st.setRate + "%", "セット取得率", st.setsWon + "-" + st.setsLost, cmpPct(st.setRate, 50, true)),
      tile(st.total ? Math.round(st.fullSet.total / st.total * 100) + "%" : "—", "接戦率", "フルセット " + st.fullSet.total + " 試合"),
      tile(st.wins ? st.shutout.winRate + "%" : "—", "ストレート勝率", st.shutout.w + " / " + st.wins + " 勝"),
    ];
    if (st.recent10 && st.recent10.n > 0)
      keyTiles.push(tile(st.recent10.rate + "%", "直近" + st.recent10.n + "戦勝率", st.recent10.w + "勝 " + (st.recent10.n - st.recent10.w) + "敗"));
    if (st.fullSet.total)
      keyTiles.push(tile(st.fullSet.rate + "%", "フルセット勝率", st.fullSet.w + "-" + st.fullSet.l, cmpPct(st.fullSet.rate, 50, true)));
    if (st.points && st.points.games > 0)
      keyTiles.push(tile(st.points.rate + "%", "得点率", "1G平均 " + st.points.avgFor + "-" + st.points.avgAgainst));
    wrap.appendChild(h("div", { className: "pkey-tiles" }, ...keyTiles));

    // ── ③ 直近フォーム ──
    if (st.recent.length) {
      wrap.appendChild(h("div", { className: "pform" },
        h("span", { className: "pform-label" }, "直近 (新しい順)"),
        ...st.recent.map(r => h("span", { className: "pform-dot " + (r === "W" ? "win" : "lose") }, r === "W" ? "勝" : "敗"))));
    }

    // ── ④ 詳細スタッツ (折りたたみ) ──
    const moreTiles = [
      tile(st.avgWon, "平均取得セット", "1試合あたり"),
      tile(st.avgLost, "平均失セット", "1試合あたり"),
      tile(st.losses ? st.shutout.loseRate + "%" : "—", "被ストレート率", st.shutout.l + " / " + st.losses + " 敗"),
      tile(String(st.streakLongest), "最多連勝", "現在 " + st.streakCurrent + " 連勝中"),
      tile(st.avgDur ? fmtDuration(st.avgDur) : "—", "平均対戦時間", st.durCount ? (st.durCount + " 試合") : "記録なし", (avg && st.avgDur) ? cmpDur(st.avgDur, avg.avgDurationSec) : null),
      tile(st.maxDur ? fmtDuration(st.maxDur) : "—", "最長の対戦", "呼出→結果入力"),
      tile(st.totalDur ? fmtDuration(st.totalDur) : "—", "総試合時間", st.durCount + " 試合の合計"),
    ];
    if (st.points && st.points.games > 0)
      moreTiles.push(tile((st.pointDiff > 0 ? "+" : "") + st.pointDiff, "得点デフ", "総得点−総失点"));
    if (st.deuce && st.deuce.n > 0)
      moreTiles.push(tile(st.deuce.rate + "%", "デュース勝率", st.deuce.w + " / " + st.deuce.n + " (10-10〜)"));
    if (st.finalGame && st.finalGame.n > 0)
      moreTiles.push(tile(st.finalGame.rate + "%", "ファイナルゲーム勝率", st.finalGame.w + " / " + st.finalGame.n + " 接戦"));
    if (st.seedBattle && st.seedBattle.killN > 0)
      moreTiles.push(tile(st.seedBattle.killRate + "%", "対格上 勝率", "格上撃破 " + st.seedBattle.killW + " / " + st.seedBattle.killN));
    if (st.seedBattle && st.seedBattle.upsetN > 0)
      moreTiles.push(tile(String(st.seedBattle.upsetL), "格下取りこぼし", "対格下 " + st.seedBattle.upsetN + " 戦"));
    wrap.appendChild(details("詳細スタッツ (" + moreTiles.length + "項目)", h("div", { className: "pstat-tiles" }, ...moreTiles)));

    // ── ⑤ 詳しい内訳 (折りたたみ: 種目別・大会別・対戦相手など) ──
    const more = h("div", {});
    const addSub = (title, node) => { more.appendChild(h("div", { className: "section-sub" }, title)); more.appendChild(node); };
    if (st.scoreDist && (st.scoreDist.win.length || st.scoreDist.lose.length)) {
      const distRow = (label, arr, cls) => h("div", { className: "pdist-row" },
        h("span", { className: "pdist-label " + cls }, label),
        h("span", { className: "pdist-chips" },
          arr.length ? arr.map(d => h("span", { className: "pdist-chip " + cls }, d.k + " ×" + d.n))
                     : h("span", { className: "pdist-none" }, "—")));
      addSub("ゲームカウント分布", h("div", { className: "pdist" },
        distRow("勝ち", st.scoreDist.win, "w"), distRow("負け", st.scoreDist.lose, "l")));
    }
    if (st.rounds_wl && st.rounds_wl.length >= 2) addSub("ラウンド別 勝率（勝負強さ）", table(st.rounds_wl.map(r => rateRow(r.name, r))));
    if (st.events.length) addSub("種目別 勝率", table(st.events.map(e => rateRow(e.event, e))));
    if (st.tournaments.length) addSub("大会別成績", table(st.tournaments.slice(0, 12).map(t => rateRow(t.name + (t.date ? " (" + t.date + ")" : ""), t))));
    if (st.months.length >= 2) addSub("月別成績", table(st.months.slice(0, 12).map(m => rateRow(m.ym, m))));
    {
      const topB = (st.branches && st.branches[0]) || null;
      const topT = (st.oppTeams && st.oppTeams[0]) || null;
      if (topB || topT) {
        const rows = [];
        if (topB) rows.push(rateRow("支部: " + topB.name, topB));
        if (topT) rows.push(rateRow("所属: " + topT.name, topT));
        addSub("よく対戦する相手", table(rows));
      }
    }
    if (st.branches && st.branches.length) addSub("対 支部別 勝率", table(st.branches.slice(0, 16).map(b => rateRow(b.name, b))));
    if (st.h2h.length) addSub("対戦成績 (相手別・対戦数順)", table(st.h2h.slice(0, 10).map(o => rateRow(o.name, o))));
    if (more.children.length) wrap.appendChild(details("詳しい内訳（種目別・大会別・対戦相手など）", more));
    return wrap;
  }

  // ── Toast ──
  function toast(msg, type) {
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.style.opacity = "0", 1800);
    setTimeout(() => el.remove(), 2100);
  }

  // ── 読み込み中スピナー (円タイプ・多重呼び出しはカウンタで管理) ──
  let _loadEl = null, _loadN = 0;
  function showLoading() {
    _loadN++;
    if (_loadEl || typeof document === "undefined") return;
    _loadEl = document.createElement("div");
    _loadEl.className = "tt-loading";
    _loadEl.innerHTML = '<div class="tt-spin" role="status" aria-label="読み込み中"></div>';
    document.body.appendChild(_loadEl);
  }
  function hideLoading() {
    _loadN = Math.max(0, _loadN - 1);
    if (_loadN === 0 && _loadEl) { _loadEl.remove(); _loadEl = null; }
  }

  // ── レーティングバッジ ──
  function ratingLabel(r) {
    r = r || 1500;
    if (r >= 1800) return "S";
    if (r >= 1600) return "A";
    if (r >= 1400) return "B";
    if (r >= 1200) return "C";
    return "D";
  }
  function ratingBadge(r) {
    r = r || 1500;
    const l = ratingLabel(r);
    return `<span class="rating-badge rating-${l}">${l} ${r}</span>`;
  }

  // ── ふりがな辞書（フロント側） ──
  const FD = {
    "佐藤":"さとう","鈴木":"すずき","高橋":"たかはし","田中":"たなか","伊藤":"いとう",
    "渡辺":"わたなべ","山本":"やまもと","中村":"なかむら","小林":"こばやし","加藤":"かとう",
    "吉田":"よしだ","山田":"やまだ","佐々木":"ささき","松本":"まつもと","井上":"いのうえ",
    "木村":"きむら","林":"はやし","斎藤":"さいとう","清水":"しみず","山口":"やまぐち",
    "森":"もり","阿部":"あべ","池田":"いけだ","橋本":"はしもと","山崎":"やまざき",
    "石川":"いしかわ","中島":"なかじま","前田":"まえだ","藤田":"ふじた","小川":"おがわ",
    "後藤":"ごとう","岡田":"おかだ","長谷川":"はせがわ","村上":"むらかみ","近藤":"こんどう",
    "石井":"いしい","遠藤":"えんどう","坂本":"さかもと","藤井":"ふじい","福田":"ふくだ",
    "西村":"にしむら","太田":"おおた","三浦":"みうら","藤原":"ふじわら","松田":"まつだ",
    "岡本":"おかもと","中川":"なかがわ","原田":"はらだ","小野":"おの","田村":"たむら",
    "竹内":"たけうち","金子":"かねこ","和田":"わだ","中山":"なかやま","石田":"いしだ",
    "上田":"うえだ","森田":"もりた","柴田":"しばた","酒井":"さかい","工藤":"くどう"
  };
  function lookupFurigana(name) {
    if (!name) return "";
    const n = String(name).replace(/\s+/g, "");
    if (FD[n]) return FD[n];
    for (let len = Math.min(4, n.length); len >= 1; len--) {
      if (FD[n.substring(0, len)]) return FD[n.substring(0, len)];
    }
    return "";
  }

  // ── ペースト解析（Excel/CSV/タブ区切り） ──
  function parsePaste(text) {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const sample = lines.slice(0, 3).join("");
    const delim = sample.includes("\t") ? "\t"
                : (sample.includes(",") && !sample.match(/^\d+,\d+$/)) ? ","
                : sample.includes("、") ? "、" : null;
    const out = [];
    lines.forEach(l => {
      const cols = delim ? l.split(delim).map(s => s.trim().replace(/^"|"$/g, ""))
                         : l.split(/\s+/);
      let name = cols[0], team = cols[1] || "", gender = "", cat = "";
      if (/^\d+$/.test(name) && cols.length > 1) {
        name = cols[1]; team = cols[2] || ""; gender = cols[3] || ""; cat = cols[4] || "";
      } else {
        gender = cols[2] || ""; cat = cols[3] || "";
      }
      if (!name || /^(名前|選手名|No|#|番号|氏名)/i.test(name)) return;
      const g = gender.includes("女") ? "female" : "male";
      const c = CATS.find(x => x.l === cat)?.v || "general";
      out.push({ name, team, gender: g, category: c });
    });
    return out;
  }

  // ── 日付フォーマット ──
  function fmtDate(d) {
    if (!d) return "";
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${y}年${m}月${dd}日`;
  }
  function fmtDateShort(d) {
    if (!d) return "";
    const date = new Date(d);
    if (isNaN(date.getTime())) return d;
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  // ── 自動更新 (ポーリング) ──
  function createPoller(fetchFn, intervalMs) {
    intervalMs = intervalMs || 4000;
    let lastTs = null;
    let timer = null;
    let onUpdate = null;
    async function tick() {
      try {
        const r = await fetch("/api/public/last-updated");
        const { t } = await r.json();
        if (t && t !== lastTs) {
          lastTs = t;
          if (onUpdate) onUpdate();
          else if (fetchFn) fetchFn();
        }
      } catch {}
    }
    return {
      start(cb) {
        onUpdate = cb || fetchFn;
        tick();
        timer = setInterval(tick, intervalMs);
      },
      stop() { if (timer) clearInterval(timer); timer = null; }
    };
  }

  // ── CSV出力 ──
  function downloadCSV(filename, rows) {
    const csv = "\uFEFF" + rows.map(r => r.map(c =>
      `"${String(c == null ? "" : c).replace(/"/g, '""')}"`
    ).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── モーダル ──
  function openModal(title, bodyEl, footEl, opts) {
    opts = opts || {};
    const bg = h("div", { className: "modal-bg" });
    const box = h("div", { className: "modal-box fi" + (opts.size === "lg" ? " modal-lg" : "") });
    const head = h("div", { className: "modal-head" },
      h("div", { className: "modal-title" }, title),
      h("button", { className: "modal-close", onClick: () => bg.remove(), innerHTML: "×" })
    );
    const body = h("div", { className: "modal-body" });
    if (bodyEl) body.appendChild(bodyEl);
    box.append(head, body);
    if (footEl) {
      const foot = h("div", { className: "modal-foot" });
      foot.appendChild(footEl);
      box.appendChild(foot);
    }
    bg.appendChild(box);
    bg.addEventListener("click", e => { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg);
    return bg;
  }

  // KTTA Platform ロゴ (インライン HTML)
  // size: "sm" | "md" (default md), inverse: ダーク背景用
  function logoHTML(opts) {
    opts = opts || {};
    const inv = opts.inverse ? " ktta-logo--inverse" : "";
    const link = opts.href !== undefined ? opts.href : null;
    const tag = opts.tag !== false;
    const tagText = opts.tagText || "KUSHIRO · TABLE TENNIS · ASSOCIATION";
    const el = (link != null ? "a" : "span");
    const linkAttr = link != null ? ` href="${link}"` : "";
    return `<${el} class="ktta-logo${inv}"${linkAttr}>
      <span class="ktta-logo-mark">K</span>
      <span class="ktta-logo-text">
        <span class="ktta-logo-name">KTTA Platform</span>
        ${tag ? `<span class="ktta-logo-tag">${tagText}</span>` : ""}
      </span>
    </${el}>`;
  }

  // ステータスバッジ HTML
  function statusBadge(status, opts) {
    opts = opts || {};
    const labels = {
      scheduled: "予定", preparation: "準備中",
      ongoing: "進行中", completed: "終了", cancelled: "中止"
    };
    const lbl = labels[status] || status || "予定";
    const cls = opts.block ? "status-block" : "badge";
    return `<span class="${cls} status-${status || "scheduled"}">${lbl}</span>`;
  }

  function _hslPair(hue, sat, light) {
    return {
      bg: `hsl(${hue}, ${sat}%, ${light}%)`,
      fg: `hsl(${hue}, ${Math.min(sat + 10, 88)}%, 30%)`,
    };
  }
  // 北海道の公式支部 (地名部分のみ)。表示は「地名+支部」。順序=色の割当順 (固定)
  const HOKKAIDO_BRANCHES = [
    "札幌", "函館", "旭川", "釧路", "十勝", "千歳", "苫小牧", "江別",
    "室蘭", "名寄", "根室", "後志", "滝川", "北見", "岩見沢", "留萌",
    "日高", "稚内", "紋別", "小樽", "深川", "網走", "富良野", "斜里",
  ];
  const GRAY_BRANCH = { bg: "#f1f5f9", fg: "#64748b" };
  // 任意表記 → 公式の地名 (該当なければ null)。
  // 例: 札幌卓球連盟/函館卓球協会/根室管内卓球連盟/○○支部 → 地名
  function _branchBase(raw) {
    let s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    s = s.replace(/[\s　]+/g, "");
    // 末尾の語を順に剥がす
    let base = s
      .replace(/管内/g, "")
      .replace(/(卓球)?(協会|連盟|クラブ|協議会)$/g, "")
      .replace(/支部$/g, "")
      .trim();
    if (HOKKAIDO_BRANCHES.includes(base)) return base;
    // 前方一致 (例: 「札幌市」「釧路地区」等)
    for (const b of HOKKAIDO_BRANCHES) { if (s.indexOf(b) === 0) return b; }
    return null;
  }
  // 表示用に正規化: 公式支部 → 「地名+支部」 / 対象外 → 元の文字列 / 空 → ""
  function normalizeBranch(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return "";
    const base = _branchBase(s);
    return base ? base + "支部" : s;
  }
  // 公式24支部のみに正規化 (#267)。公式支部なら "◯◯支部"、それ以外/空は "" を返す。
  // 支部別グルーピング用: 所属チーム名がそのまま支部扱いになる誤りを防ぐ
  // (normalizeBranch は非公式入力をそのまま返すため、グルーピングには使わない)。
  function officialBranch(raw) {
    const base = _branchBase(raw);
    return base ? base + "支部" : "";
  }
  // 支部名 → 色。公式24支部は固定の異色、対象外/空はグレー。同名は常に同色。
  function branchColor(raw) {
    const base = _branchBase(raw);
    if (base == null) return GRAY_BRANCH;
    const idx = HOKKAIDO_BRANCHES.indexOf(base);
    const hue = Math.round(idx * 137.508) % 360; // 黄金角で必ず色相が離れる
    const sat = 64 + (idx % 3) * 6;   // 64/70/76
    const light = 90 + (idx % 2) * 3; // 90/93
    return _hslPair(hue, sat, light);
  }
  // 互換API: 名前集合 → name→色 Map (色は branchColor に委譲し全画面で一致)
  function branchColorMap(names) {
    const map = new Map();
    (names || []).forEach(n => {
      const s = String(n == null ? "" : n).trim();
      if (s && !map.has(s)) map.set(s, branchColor(s));
    });
    return map;
  }
  // 支部バッジ要素を生成 (h が必要)。表示は正規化名、色は branchColor。
  function branchBadge(raw, extraStyle, color) {
    const label = normalizeBranch(raw);
    if (!label) return null;
    const c = color || branchColor(raw);
    return h("span", { className: "branch-tag",
      style: Object.assign({ background: c.bg, color: c.fg }, extraStyle || {}) }, label);
  }
  // 支部に応じたヒーロー用グラデ(濃色)。対象外/未設定はトンマナの緑系。
  function branchGradient(raw) {
    const base = _branchBase(raw);
    if (base == null) return { from: "#0f766e", to: "#134e4a", accent: "#5eead4", hue: 172, official: false };
    const idx = HOKKAIDO_BRANCHES.indexOf(base);
    const hue = Math.round(idx * 137.508) % 360;
    return {
      from: "hsl(" + hue + ", 58%, 40%)",
      to: "hsl(" + ((hue + 26) % 360) + ", 64%, 23%)",
      accent: "hsl(" + hue + ", 85%, 68%)",
      hue, official: true,
    };
  }
  // ヒーロー背景の CSS 文字列 (放射ハイライト + 斜めグラデの2層)。要素に inline 適用。
  function branchHeroBg(raw) {
    const g = branchGradient(raw);
    // 3層: 斜めの薄いライン模様(アーキテクチャ感) + 放射ハイライト + 斜めグラデ。文字可読性のため模様は5%以下。
    return "repeating-linear-gradient(135deg, rgba(255,255,255,.05) 0 2px, rgba(255,255,255,0) 2px 22px), "
      + "radial-gradient(125% 145% at 86% -12%, rgba(255,255,255,.22), rgba(255,255,255,0) 55%), "
      + "linear-gradient(135deg, " + g.from + " 0%, " + g.to + " 100%)";
  }

  // 種目 → 色。性別×形式のキーワードで直感的な基本色を割り当て、
  // 同カテゴリ内の細分(年齢別など)は名前ハッシュで少しずらして識別性を確保。
  // 例: 男子S=青 / 女子S=赤 / 男子D=緑 / 女子D=黄 / 混合=紫 / 団体=ティール。
  // 返り値: { hue, bg(濃・白文字想定), fg, border, soft(淡背景) }
  function eventColor(event) {
    const e = String(event == null ? "" : event);
    const hasW = /女|レディース|ガール/.test(e);
    const hasM = /男|メンズ|ボーイ/.test(e);
    const isMix = /混合|ミックス|MIX/i.test(e);
    const isTeam = /団体|チーム/.test(e);
    const isDbl = /ダブルス|複|ペア/.test(e);
    let hue;
    if (isMix) hue = 288;            // 紫
    else if (isTeam) hue = 172;      // ティール
    else if (hasW && isDbl) hue = 46;  // 女子D 黄
    else if (hasW) hue = 352;        // 女子S 赤
    else if (hasM && isDbl) hue = 142; // 男子D 緑
    else if (hasM) hue = 214;        // 男子S 青
    else hue = null;
    // 名前ハッシュ
    let hsh = 0; for (let i = 0; i < e.length; i++) hsh = (hsh * 131 + e.charCodeAt(i)) >>> 0;
    if (hue == null) hue = hsh % 360;            // キーワード無し → 完全ハッシュ
    else hue = (hue + (hsh % 18) - 9 + 360) % 360; // ±9°のゆらぎで同系統を区別
    const yellowish = hue >= 40 && hue <= 80;     // 黄〜黄緑は白文字だと見えにくい
    return {
      hue,
      bg: `hsl(${hue}, 70%, ${yellowish ? 50 : 46}%)`,
      fg: yellowish ? "#1c1917" : "#ffffff",
      border: `hsl(${hue}, 66%, 38%)`,
      soft: `hsl(${hue}, 72%, 94%)`,
    };
  }
  // 種目バッジ要素 (h が必要)
  function eventBadge(event, extraStyle) {
    const label = String(event == null ? "" : event).trim();
    if (!label) return null;
    const c = eventColor(label);
    return h("span", { className: "event-tag",
      style: Object.assign({ background: c.bg, color: c.fg }, extraStyle || {}) }, label);
  }

  // Export
  global.TT = {
    GENDERS, CATS, EV_TYPES, ROUNDS, PLACES,
    h, esc, clear, api, toast, showLoading, hideLoading,
    ratingLabel, ratingBadge,
    lookupFurigana, parsePaste,
    fmtDate, fmtDateShort, fmtDuration, fmtScore, computePlayerStats, playerStatsSection,
    elapsedMinSince, fmtElapsedClock, startElapsedTicker,
    createPoller, downloadCSV, downloadJSON, openModal,
    logoHTML, statusBadge,
    HOKKAIDO_BRANCHES, normalizeBranch, officialBranch, branchColor, branchColorMap, branchBadge,
    branchGradient, branchHeroBg,
    eventColor, eventBadge, catLabel,
  };
})(window);
