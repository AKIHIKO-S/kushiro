// ═══════════════════════════════════════════════════════
// 共通JS（admin/viewer共通ユーティリティ）
// ═══════════════════════════════════════════════════════
(function(global){
  'use strict';

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
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      const r = await fetch(this.baseUrl + url);
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
    const listeners = [];
    function loadQ() { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch (e) { return []; } }
    function saveQ(q) { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e) {} notify(); }
    function notify() { const n = loadQ().length; listeners.forEach(cb => { try { cb(n, api.online); } catch (e) {} }); }
    function uuid() { try { return crypto.randomUUID(); } catch (e) { return "op-" + Date.now() + "-" + Math.random().toString(16).slice(2); } }

    api.online = (typeof navigator === "undefined") ? true : (navigator.onLine !== false);
    api.onPending = function (cb) { listeners.push(cb); try { cb(loadQ().length, api.online); } catch (e) {} };
    api.pendingCount = function () { return loadQ().length; };
    api.pendingTags = function () { const s = {}; loadQ().forEach(o => { if (o.tag) s[o.tag] = true; }); return s; };
    api.hasPending = function (tag) { return !!(tag && api.pendingTags()[tag]); };
    api.onQueueFlushed = null; // アプリ側で再描画したい時に差し込む

    function deliver(item) {
      const headers = api._headers();
      if (item.op_id) headers["X-Op-Id"] = item.op_id;
      return fetch(api.baseUrl + item.url, {
        method: item.method, headers,
        body: (item.method === "DELETE") ? undefined : JSON.stringify(item.body || {}),
      }).then(r => r.json().catch(() => ({})));
    }

    let flushing = false;
    api.flushQueue = async function () {
      if (flushing) return;
      flushing = true;
      let delivered = 0;
      try {
        let q = loadQ();
        while (q.length) {
          const item = q[0];
          try {
            await deliver(item);          // 応答が返れば到達成功 (成否問わずキューから除去・冪等で二重防止)
            q = loadQ(); q.shift(); saveQ(q); delivered++;
          } catch (e) {
            break;                        // ネット断: 中断して残す
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
      try {
        return await deliver(item);       // オンライン: 即時送信
      } catch (e) {
        const q = loadQ(); q.push(item); saveQ(q);   // ネット断: キューへ
        api.online = false; notify();
        return { queued: true, op_id };
      }
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

  // ── 選手の数値化スタッツ (卓球向け) ──
  // player.matches (getMatchesByPlayer: BYE/不戦勝除外済・tournament_name/date付) から算出。
  function computePlayerStats(player) {
    const pid = player && player.id;
    const ms = ((player && player.matches) || []).filter(m => m && (m.winner_id === pid || m.loser_id === pid));
    let wins = 0, losses = 0, setsWon = 0, setsLost = 0;
    const byT = {}, byE = {};
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
    });
    const recent = ms.slice(0, 10).map(m => (m.winner_id === pid ? "W" : "L")); // 新しい順 (queryがdate DESC)
    const total = wins + losses;
    const pctOf = (w, n) => (n ? Math.round((w / n) * 100) : 0);
    const setsTotal = setsWon + setsLost;
    const tournaments = Object.values(byT)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map(t => ({ name: t.name, date: t.date, w: t.w, l: t.l, total: t.w + t.l, rate: pctOf(t.w, t.w + t.l) }));
    const events = Object.values(byE)
      .sort((a, b) => (b.w + b.l) - (a.w + a.l))
      .map(e => ({ event: e.event, w: e.w, l: e.l, total: e.w + e.l, rate: pctOf(e.w, e.w + e.l) }));
    return {
      total, wins, losses, rate: pctOf(wins, total),
      setsWon, setsLost, setRate: pctOf(setsWon, setsTotal),
      recent, streakCurrent: cur, streakLongest: longest,
      tournaments, events,
    };
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
  function openModal(title, bodyEl, footEl) {
    const bg = h("div", { className: "modal-bg" });
    const box = h("div", { className: "modal-box fi" });
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
    const tagText = opts.tagText || "KUSHIRO · TABLE TENNIS";
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
    h, esc, clear, api, toast,
    ratingLabel, ratingBadge,
    lookupFurigana, parsePaste,
    fmtDate, fmtDateShort, fmtDuration, computePlayerStats,
    createPoller, downloadCSV, downloadJSON, openModal,
    logoHTML, statusBadge,
    HOKKAIDO_BRANCHES, normalizeBranch, branchColor, branchColorMap, branchBadge,
    eventColor, eventBadge, catLabel,
  };
})(window);
