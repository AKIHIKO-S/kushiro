// ═══════════════════════════════════════════════════════
// 共通JS（admin/viewer共通ユーティリティ）
// ═══════════════════════════════════════════════════════
(function(global){
  'use strict';

  const GENDERS = [{v:"male",l:"男子"},{v:"female",l:"女子"}];
  const CATS = [
    {v:"general",l:"一般"},{v:"high",l:"高校"},
    {v:"middle",l:"中学"},{v:"elementary",l:"小学"},{v:"senior",l:"シニア"}
  ];
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
  // 支部名 → 色 (単体バッジ用 / 全画面で同名は同色。ハッシュ分散で衝突は稀)
  function branchColor(name) {
    const s = String(name == null ? "" : name).trim();
    if (!s) return { bg: "#f1f5f9", fg: "#475569" };
    let h1 = 0, h2 = 0;
    for (let i = 0; i < s.length; i++) {
      h1 = (h1 * 131 + s.charCodeAt(i)) >>> 0;
      h2 = (h2 * 31 + s.charCodeAt(i) * 7 + i) >>> 0;
    }
    return _hslPair(h1 % 360, 62 + (h2 % 16), 89 + ((h2 >>> 4) % 6)); // sat62-77 light89-94
  }
  // 支部名の集合 → name→色 Map (一覧表示用。黄金角で必ず色相が離れる=必ず違う色)
  function branchColorMap(names) {
    const uniq = [...new Set((names || []).map(n => String(n == null ? "" : n).trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "ja"));
    const map = new Map();
    uniq.forEach((n, i) => {
      const hue = Math.round(i * 137.508) % 360; // 黄金角 → 隣接でも最大限に離れる
      const sat = 64 + (i % 3) * 6;   // 64/70/76
      const light = 90 + (i % 2) * 3; // 90/93 (同色相が万一来ても明度で分離)
      map.set(n, _hslPair(hue, sat, light));
    });
    return map;
  }
  // 支部バッジ要素を生成 (h が必要)。color を渡せばそれを使用、無ければ branchColor。
  function branchBadge(name, extraStyle, color) {
    if (!name) return null;
    const c = color || branchColor(name);
    return h("span", { className: "branch-tag",
      style: Object.assign({ background: c.bg, color: c.fg }, extraStyle || {}) }, name);
  }

  // Export
  global.TT = {
    GENDERS, CATS, EV_TYPES, ROUNDS, PLACES,
    h, esc, clear, api, toast,
    ratingLabel, ratingBadge,
    lookupFurigana, parsePaste,
    fmtDate, fmtDateShort,
    createPoller, downloadCSV, downloadJSON, openModal,
    logoHTML, statusBadge,
    branchColor, branchColorMap, branchBadge,
  };
})(window);
