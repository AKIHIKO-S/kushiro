// 受付台帳(申込集計モードの受付画面) — 2026-11-15 オーナー承認の見本「受付台帳 サイト調」を移植。
// 画面: #list(大会を選ぶ) / #desk/<id>(受付) / #more(その他=既存画面への入口)。
// 既存の管理画面(A)の部品を流用する: 修正=A.openSubmissionEdit / 手入力=A.openManualSubmission /
// フォーム設定=A.openEntryFormGenerator / 集計表=A.downloadAggregation / 名簿=A.openAuthedHtmlWindow。
// 純関数 shortEventName は node のテストからも読めるよう UMD で公開する。
(function (root) {
  "use strict";

  // ── 種目の略称(表の見出し用)。正式名は title/aria-label に残す ──
  function shortOne(name) {
    const n = String(name || "").replace(/\s+/g, "");
    if (!n) return "";
    const sex = /混合|ミックス/.test(n) ? "混" : /女子|女性/.test(n) ? "女" : /男子|男性/.test(n) ? "男" : "";
    if (/団体/.test(n)) return sex + "団体";
    if (/ダブルス|複/.test(n)) return sex + "D";
    const lv = (n.match(/^(一般|中学|高校|小学|大学|シニア|ジュニア|カデット|ホープス|カブ|バンビ|ユース|ラージ|壮年|成年|教員|家庭婦人|レディース)/) || [])[1];
    if (/シングルス|単/.test(n) && sex) return (lv || "") + sex;
    return n.slice(0, 5);
  }
  function shortEventName(name, all) {
    const s = shortOne(name);
    if (!Array.isArray(all)) return s;
    const clash = all.filter(x => x !== name && shortOne(x) === s).length > 0;
    return clash ? String(name || "").replace(/\s+/g, "").slice(0, 6) : s;
  }
  if (typeof module === "object" && module.exports) { module.exports = { shortEventName }; return; }

  const doc = root.document;
  const ROUTE = { web: "Web", excel: "Excel", manual: "手入力" };
  const WD = "日月火水木金土";
  const isPC = () => root.matchMedia("(min-width:960px)").matches;
  const store = {
    get(k) { try { return root.localStorage.getItem(k) || ""; } catch (_) { return ""; } },
    set(k, v) { try { root.localStorage.setItem(k, v); } catch (_) {} },
  };

  function h(tag, attrs) {
    const el = doc.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    [].slice.call(arguments, 2).flat(Infinity).forEach(c => {
      if (c == null || c === false) return;
      el.appendChild(typeof c === "object" ? c : doc.createTextNode(String(c)));
    });
    return el;
  }
  const toast = (m, k) => { try { root.TT.toast(m, k); } catch (_) {} };
  const api = () => root.TT.api;
  // 管理画面の A は script 直下の const(=window には載らない)。同じグローバル字句環境から参照する
  // eslint-disable-next-line no-undef
  const app = () => (typeof A !== "undefined" ? A : root.A);

  function jpDate(d, withWd) {
    const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(d || "");
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return (+m[2]) + "月" + (+m[3]) + "日" + (withWd ? "（" + WD[dt.getUTCDay()] + "）" : "");
  }
  function leftLabel(n) {
    if (n == null) return "";
    if (n > 0) return "あと" + n + "日";
    if (n === 0) return "今日まで";
    return "";
  }

  // ── 状態 ──
  const S = { view: "", tid: "", data: null, q: "", only: "all", picked: "", sort: "", dir: 1, ev: "", lq: "", lsort: "", lstate: "all", drawer: null, backBar: null, root: null, main: null, listBox: null };

  function ensureRoot() {
    if (S.root) return;
    S.root = h("div", { id: "entryDesk" });
    doc.body.insertBefore(S.root, doc.body.firstChild);
  }

  function top(active) {
    const last = S.tid || store.get("ktta.desk.last");
    return h("header", { class: "ed-top" },
      h("a", { class: "ed-top__brand", href: "#list" },
        h("img", { class: "ed-top__logo", src: "/shared/assets/ktta-logo-256.png", alt: "" }),
        h("span", { class: "ed-top__org" }, "釧路卓球協会", h("small", { lang: "en" }, "KUSHIRO TABLE TENNIS ASSOCIATION"))),
      h("span", { class: "ed-top__sub" }, "申込の受付"),
      (app().buildBell ? app().buildBell() : null),   // 通知の鈴(新しい申込・変更の数)
      (app().buildModeSwitch ? app().buildModeSwitch() : null),   // 申込集計 / 大会運営(ベータ版) の切替(大会運営モードへ戻る入口)
      h("nav", { class: "ed-top__nav", "aria-label": "主な画面" },
        h("a", { href: "#list", "aria-current": active === "list" ? "page" : null }, "大会"),
        h("a", { href: last ? "#desk/" + last : "#list", "aria-current": active === "desk" ? "page" : null }, "受付"),
        h("a", { href: "#players" }, "選手DB"),
        h("a", { href: "#more", "aria-current": active === "more" ? "page" : null }, "その他")),
      who());
  }
  // 誰でログイン中か+ログアウト(狭い画面では「その他」の先頭に出す)
  function who() {
    const s = app().session;
    if (!s) return null;
    return h("div", { class: "ed-top__who" },
      h("span", { class: "ed-top__name", title: s.label }, s.label),
      h("span", { class: "ed-top__role" }, s.role),
      h("button", { class: "ed-top__out", type: "button", onclick: () => app().logout() }, "ログアウト"));
  }

  function frame(active, body) {
    ensureRoot();
    doc.documentElement.classList.add("desk-on");
    if (S.backBar) { S.backBar.remove(); S.backBar = null; }
    S.root.textContent = "";
    S.main = h("main", {}, body);
    S.root.append(top(active), S.main);
  }

  function failBox(msg, retry) {
    return h("div", { class: "ed-loading", role: "alert" },
      h("p", { style: "margin:0 0 10px" }, msg || "読み込めませんでした。"),
      h("button", { class: "ed-btn", type: "button", onclick: retry }, "もう一度読み込む"));
  }

  // ── 大会を選ぶ ──
  async function showList() {
    S.view = "list";
    frame("list", h("p", { class: "ed-loading" }, "大会を読み込んでいます…"));
    let d = null;
    try { d = await api().get("/api/entry-desk/tournaments"); } catch (_) {}
    if (S.view !== "list") return;
    if (!d || !Array.isArray(d.items)) {
      S.main.textContent = "";
      S.main.append(failBox(d && d.error ? d.error : "大会を読み込めませんでした。ログインし直すと直ることがあります。", showList));
      return;
    }
    const meta = (t) => {
      const day = t.date ? jpDate(t.date, true) : "日付未定";
      if (t.state === "open") {
        const l = leftLabel(t.days_left);
        return [day + "・締切 ", l ? h("b", {}, l) : (t.deadline ? jpDate(t.deadline) : "未設定")];
      }
      if (t.state === "before") return [day + "・受付はまだ始めていません"];
      return [day + "・受付を終えました"];
    };
    // 大会の一覧: 名前で探す・状態で絞る・並べ替え(既定は受付中→受付前→終了の順)
    const LSORTS = [["", "標準の順(受付中が先)"], ["date_desc", "大会日が新しい順"], ["date_asc", "大会日が古い順"], ["deadline", "締切が近い順"],
      ["name", "大会名の順"], ["entries", "出場が多い順"]];
    const listBox = h("div", {});
    const renderTl = () => {
      const q = S.lq.trim();
      let items = d.items.filter(t => (S.lstate === "all" || t.state === S.lstate) && (!q || String(t.name || "").indexOf(q) >= 0));
      const by = {
        date_desc: (a, b) => String(b.date || "").localeCompare(String(a.date || "")),
        date_asc: (a, b) => String(a.date || "9999").localeCompare(String(b.date || "9999")),
        deadline: (a, b) => String(a.deadline || "9999").localeCompare(String(b.deadline || "9999")),
        name: (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja"),
        entries: (a, b) => (b.entries || 0) - (a.entries || 0),
      }[S.lsort];
      if (by) items = items.slice().sort(by);
      listBox.textContent = "";
      listBox.append(items.length
        ? h("div", { class: "ed-tl" }, items.map(t => h("a", { class: "ed-tl__row", href: "#desk/" + encodeURIComponent(t.id) },
          h("span", { class: "ed-tl__name" }, t.name || "(名前なし)"),
          h("span", { class: "ed-tl__meta" }, meta(t)),
          h("span", { class: "ed-tl__count" }, h("b", { class: "ed-num" }, t.entries), "出場・確定申込 " + t.teams + "件"))))
        : h("div", { class: "ed-tl" }, h("p", { class: "ed-empty" }, d.items.length ? "条件に合う大会は見つかりません。" : "まだ大会がありません。「大会をつくる」から始めてください。")));
    };
    const count = (st) => d.items.filter(t => st === "all" || t.state === st).length;
    const chip = (v, label) => { const b = h("button", { class: "ed-chip", type: "button", "aria-pressed": String(S.lstate === v),
      onclick: () => { S.lstate = v; showList.chips.forEach(c => c.setAttribute("aria-pressed", String(c.dataset.v === v))); renderTl(); } }, label, h("b", { class: "ed-num" }, count(v))); b.dataset.v = v; return b; };
    showList.chips = [chip("all", "すべて"), chip("open", "受付中"), chip("before", "受付前"), chip("closed", "終了")];
    S.main.textContent = "";
    S.main.append(
      h("div", { class: "ed-head" }, h("h1", {}, "受付する大会を選ぶ"),
        h("div", {}, h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => app().newTournament() }, "大会をつくる"))),
      d.items.length > 1 ? h("div", { class: "ed-tools" },
        h("div", { class: "ed-find" }, h("input", { class: "ed-search", type: "search", value: S.lq, placeholder: "大会名で探す", "aria-label": "大会を探す",
          oninput: (e) => { S.lq = e.target.value; renderTl(); } })),
        h("div", { class: "ed-filters" }, showList.chips,
          h("label", { class: "ed-sel" }, h("span", {}, "並び順"),
            h("select", { "aria-label": "大会の並び順", onchange: (e) => { S.lsort = e.target.value; renderTl(); } },
              LSORTS.map(o => h("option", { value: o[0], selected: S.lsort === o[0] ? "" : null }, o[1])))))) : null,
      listBox);
    renderTl();
  }

  // ── その他(既存の画面への入口) ──
  function showMore() {
    S.view = "more";
    const go = (tab) => () => { leaveTo(tab); };
    const item = (title, note, fn) => h("button", { class: "ed-more__row", type: "button", onclick: fn }, h("b", {}, title), h("span", {}, note));
    const s = app().session;
    frame("more", [
      h("div", { class: "ed-head" }, h("h1", {}, "その他")),
      s ? h("div", { class: "ed-account" },
        h("span", {}, "ログイン中: ", h("b", {}, s.label), "（" + s.role + "）"),
        h("button", { class: "ed-btn", type: "button", onclick: () => app().logout() }, "ログアウト")) : null,
      h("div", { class: "ed-more" },
        item("選手の名寄せ", "選手データベースで、同じ人の登録をまとめる・所属を整える", go("players")),
        item("データの書き出し・取り込み", "Excel・CSVの書き出しと、名簿の取り込み", go("import")),
        item("外部の申込フォーム", "他団体・外部大会の申込フォームへのリンク一覧", go("external-forms")),
        item("以前の申込一覧", "これまでの申込一覧の画面", go("entries")),
        item("システム管理（オーナー）", "バックアップ・運営アカウント・選手登録台帳との統合", () => app().openOwnerPanel())),
    ]);
  }

  // 既存のタブへ移る。上に「受付へ戻る」を出す
  function leaveTo(tab) {
    hide();
    location.hash = tab;
  }
  function hide() {
    doc.documentElement.classList.remove("desk-on");
    S.view = "";
    if (!S.backBar) {
      const last = S.tid || store.get("ktta.desk.last");
      S.backBar = h("div", { class: "ed-backbar" },
        h("a", { href: last ? "#desk/" + last : "#list" }, "← 受付へ戻る"),
        h("span", {}, "申込集計モードの補助画面です"));
      doc.body.insertBefore(S.backBar, doc.body.firstChild);
    }
  }

  // ── 受付 ──
  async function showDesk(tid, keep) {
    S.view = "desk";
    if (S.tid !== tid) { closeDrawer(true); S.q = ""; S.only = "all"; S.sort = ""; S.dir = 1; S.ev = ""; S.picked = ""; S.data = null; }
    S.tid = tid;
    store.set("ktta.desk.last", tid);
    const scrollY = keep ? root.scrollY : 0;
    if (!keep || !S.data) frame("desk", h("p", { class: "ed-loading" }, "申込を読み込んでいます…"));
    let d = null;
    try { d = await api().get("/api/tournaments/" + encodeURIComponent(tid) + "/desk"); } catch (_) {}
    if (S.view !== "desk" || S.tid !== tid) return;
    if (!d || d.error || !d.tournament) {
      frame("desk", failBox(d && d.error ? d.error : "申込を読み込めませんでした。", () => showDesk(tid)));
      return;
    }
    const names = d.events.map(e => e.name);
    d.events.forEach(e => { e.short = shortEventName(e.name, names); });
    S.data = d;
    renderDesk();
    if (S.drawer) {
      const cur = d.rows.find(x => x.submission_id === S.picked);
      if (cur) { showDrawer(cur); markPicked(); } else closeDrawer(true);
    }
    if (keep) root.scrollTo(0, scrollY);
  }

  function tournamentObj() {
    const t = S.data.tournament;
    const full = ((app().state && app().state.tournaments) || []).find(x => x.id === t.id);
    return full || { id: t.id, name: t.name, date: t.date };
  }
  async function fullTournament() {
    const t = S.data.tournament;
    try { const f = await api().get("/api/tournaments/" + encodeURIComponent(t.id)); if (f && !f.error) return f; } catch (_) {}
    return tournamentObj();
  }
  function entryUrl() { return app().publicOrigin() + "/entry/" + S.data.tournament.id; }
  async function copyUrl() {
    try { await root.navigator.clipboard.writeText(entryUrl()); toast("申込ページのURLをコピーしました", "ok"); }
    catch (_) { root.prompt("申込ページのURL", entryUrl()); }
  }
  async function openForm() { app().openEntryFormGenerator(await fullTournament()); }
  const reload = () => showDesk(S.tid, true);

  function visible() {
    const q = S.q.trim();
    const rows = S.data.rows.filter(r => {
      if (S.ev && !((r.by_event && r.by_event[S.ev]) > 0)) return false;
      if (S.only === "warn" && !r.issues.length) return false;
      if (["web", "excel", "manual"].includes(S.only) && r.route !== S.only) return false;
      if (!q) return true;
      const hay = [r.team_name, r.contact_name].concat(r.players.map(p => p.label + " " + p.kana)).join(" ");
      return hay.indexOf(q) >= 0;
    });
    // 並べ替え(見出しを押す / 並び順の選択)。同じ値のときは団体名の順を保つ
    if (S.sort) {
      const key = (r) => S.sort === "name" ? r.team_name : S.sort === "entries" ? r.entries : S.sort === "received" ? (r.received_at || "")
        : S.sort === "issues" ? r.issues.length : S.sort.indexOf("ev:") === 0 ? ((r.by_event && r.by_event[S.sort.slice(3)]) || 0) : 0;
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), "ja");
        return (c * S.dir) || String(a.team_name).localeCompare(String(b.team_name), "ja");
      });
    }
    return rows;
  }
  // 見出しを押したときの並べ替え(同じ見出しをもう一度押すと逆順、3回目で元の順)
  const sortMark = (k) => S.sort === k ? (S.dir === 1 ? " ▲" : " ▼") : "";
  const sortAria = (k) => S.sort === k ? (S.dir === 1 ? "ascending" : "descending") : "none";
  function sortBy(key) {
    const first = (key === "name") ? 1 : -1;   // 最初に押したときの向き(団体名は昇順、人数・日付は多い/新しい順)
    if (S.sort === key) { if (S.dir === first) S.dir = -first; else { S.sort = ""; S.dir = 1; } } else { S.sort = key; S.dir = first; }
    renderDesk();
  }
  const SORTS = [["", "団体名の順"], ["name", "団体名"], ["entries", "確定出場の多い順"], ["received", "受付の新しい順"], ["issues", "確認事項の多い順"]];
  const tagOf = (i) => h("span", { class: "ed-tag " + (i.type === "dup" ? "ed-tag--dup" : "ed-tag--warn") }, i.title);

  function headBox() {
    const t = S.data.tournament;
    const st = { open: ["受付中", ""], before: ["受付前", " ed-state--before"], closed: ["受付終了", " ed-state--closed"] }[t.state] || ["", ""];
    const l = t.state === "open" ? leftLabel(t.days_left) : "";
    return h("div", { class: "ed-head" },
      h("div", {},
        h("h1", {}, t.name, st[0] ? h("span", { class: "ed-state" + st[1] }, st[0]) : null),
        h("div", { class: "ed-head__meta" },
          [t.date ? jpDate(t.date, true) : "", t.venue, t.deadline ? "締切 " + jpDate(t.deadline, true) : "締切 未設定"].filter(Boolean).join("・"),
          l ? " " : "", l ? h("b", {}, l) : null)),
      h("div", { class: "ed-btns ed-head-btns--pc" },
        h("button", { class: "ed-btn", type: "button", onclick: copyUrl }, "申込URLをコピー"),
        h("button", { class: "ed-btn", type: "button", onclick: openForm }, "フォーム設定")));
  }

  function outButtons() {
    const t = tournamentObj();
    return [
      h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => app().downloadAggregation(t) }, "集計表をExcelで保存"),
      h("button", { class: "ed-btn", type: "button",
        onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/reception.html", "受付名簿_" + (t.name || "")) }, "名簿を印刷"),
      h("button", { class: "ed-btn", type: "button",
        onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/receipt-print.html", "領収書_" + (t.name || "")) }, "領収書を印刷"),
      h("button", { class: "ed-btn", type: "button", onclick: () => app().openPlayerMatch(t) }, "選手DBと照合・連携"),
      h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: deletedSheet }, "削除した申込"),
    ];
  }

  function renderDesk() {
    const d = S.data;
    const routeN = (k) => d.rows.filter(r => r.route === k).length;
    const chip = (v, label, n, extra) => h("button", { class: "ed-chip" + (extra || ""), type: "button", "aria-pressed": String(S.only === v),
      onclick: () => { S.only = v; renderDesk(); } }, label, h("b", { class: "ed-num" }, n));
    const chips = [chip("all", "すべて", d.rows.length), chip("warn", "確認", d.rows.filter(r => r.issues.length).length, " ed-chip--warn")];
    if (routeN("excel")) chips.push(chip("excel", "Excel", routeN("excel")));
    if (routeN("manual")) chips.push(chip("manual", "手入力", routeN("manual")));
    const search = h("input", { class: "ed-search", type: "search", value: S.q, placeholder: "団体名・氏名で探す", "aria-label": "申込を探す",
      oninput: (e) => { S.q = e.target.value; renderList(); } });
    S.listBox = h("div", {});
    frame("desk", [
      headBox(),
      h("div", { class: "ed-tools" },
        h("div", { class: "ed-find" }, search, h("button", { class: "ed-btn", type: "button", onclick: addSheet }, "申込を追加")),
        h("div", { class: "ed-filters" }, chips,
          h("label", { class: "ed-sel" }, h("span", {}, "種目"),
            h("select", { "aria-label": "種目で絞る", onchange: (e) => { S.ev = e.target.value; renderDesk(); } },
              h("option", { value: "" }, "すべての種目"),
              d.events.map(e => h("option", { value: e.name, selected: S.ev === e.name ? "" : null }, e.name)))),
          h("label", { class: "ed-sel" }, h("span", {}, "並び順"),
            h("select", { "aria-label": "並び順", onchange: (e) => { const v = e.target.value; S.sort = v; S.dir = (v === "name" || v === "") ? 1 : -1; renderDesk(); } },
              SORTS.map(o => h("option", { value: o[0], selected: S.sort === o[0] ? "" : null }, o[1])),
              S.sort.indexOf("ev:") === 0 ? h("option", { value: S.sort, selected: "" }, S.sort.slice(3) + "の多い順") : null)))),
      d.unlinked ? h("p", { class: "ed-routes" }, "申込番号のない出場（取込や以前の画面で入れた分）が " + d.unlinked + " 件あります。合計には入っていますが、団体の行には出ません。") : null,
      S.listBox,
    ]);
    renderList();
  }

  // 種目の性別の色分けのクラス(判定は shared/event-gender.js の共通関数。判定できない種目は無色)
  function gxClass(name) {
    const g = root.KTTAEventGender ? root.KTTAEventGender.of(name) : "";
    return g ? " ed-gx-" + g : "";
  }
  function count(r, ev) { return (r.by_event && r.by_event[ev]) || 0; }

  function renderList() {
    const d = S.data, box = S.listBox;
    box.textContent = "";
    const rows = visible();
    const empty = d.rows.length
      ? h("div", { class: "ed-empty" }, h("p", { style: "margin:0 0 8px" }, "条件に合う申込は見つかりません。"),
        h("button", { class: "ed-btn", type: "button", onclick: () => { S.q = ""; S.only = "all"; S.ev = ""; renderDesk(); } }, "条件を消す"))
      : h("div", { class: "ed-empty" }, h("p", { style: "margin:0 0 8px" }, "まだ申込はありません。"),
        h("button", { class: "ed-btn", type: "button", onclick: copyUrl }, "申込URLをコピー"));
    // スマホの台帳
    box.append(h("div", { class: "ed-ledger" }, rows.map(r =>
      h("button", { class: "ed-row", type: "button", onclick: () => openSub(r.submission_id) },
        h("span", { class: "ed-row__team" }, r.team_name || "(団体名なし)"),
        h("span", { class: "ed-row__sum ed-num" }, r.entries, h("small", {}, "出場")),
        h("span", { class: "ed-row__by" }, d.events.filter(e => count(r, e.name)).map((e, i) =>
          [i ? "・" : "", e.short + " ", h("b", { class: "ed-num" }, count(r, e.name))])),
        r.issues.length ? h("span", { class: "ed-row__tags" }, r.issues.map(tagOf)) : null)),
      rows.length ? null : empty));
    box.append(h("div", { class: "ed-totals ed-num" },
      d.events.map(e => h("div", {}, h("span", {}, e.short), h("b", {}, e.count))),
      h("div", {}, h("span", {}, "確定出場 計"), h("b", {}, d.totals.entries))));
    box.append(h("div", { class: "ed-mobile-links ed-btns" },
      h("button", { class: "ed-btn", type: "button", onclick: copyUrl }, "申込URLをコピー"),
      h("button", { class: "ed-btn", type: "button", onclick: openForm }, "フォーム設定")));
    box.append(h("div", { class: "ed-dock" }, outButtons()));
    // PCの台帳
    const picked = d.rows.find(r => r.submission_id === S.picked);
    const tr = (r) => {
      const sel = () => openSub(r.submission_id);
      return h("tr", { tabindex: "0", "data-sid": r.submission_id, "aria-selected": picked === r ? "true" : "false", onclick: sel,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sel(); } } },
        h("td", {}, r.team_name || "(団体名なし)"),
        d.events.map(e => { const c = count(r, e.name); return h("td", { class: "num" + (c ? "" : " zero") }, c || "−"); }),
        h("td", { class: "num sum" }, r.entries), h("td", {}, ROUTE[r.route] || ""), h("td", { class: "num" }, jpDate(r.received_at)),
        h("td", {}, r.issues.length ? h("span", { class: "ed-tag " + (r.issues.some(i => i.type === "dup") ? "ed-tag--dup" : "ed-tag--warn") }, r.issues.length + "件") : ""));
    };
    box.append(h("div", { class: "ed-wrap" },
      h("div", { class: "ed-table", tabindex: "0", "aria-label": "申込の台帳" },
        rows.length ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("name"), onclick: () => sortBy("name"), title: "押すと団体名で並べ替え" }, "団体" + sortMark("name")),
            d.events.map(e => h("th", { scope: "col", class: "ed-ev ed-sortable" + gxClass(e.name), title: e.name + "(押すと、この種目の多い順に並べ替え)", "aria-label": e.name, "aria-sort": sortAria("ev:" + e.name), onclick: () => sortBy("ev:" + e.name) }, e.name + sortMark("ev:" + e.name))),
            h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("entries"), onclick: () => sortBy("entries") }, "確定出場" + sortMark("entries")), h("th", { scope: "col" }, "経路"), h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("received"), onclick: () => sortBy("received") }, "受付" + sortMark("received")), h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("issues"), onclick: () => sortBy("issues") }, "確認" + sortMark("issues")))),
          h("tbody", {}, rows.map(tr)),
          h("tfoot", {}, h("tr", {}, h("td", {}, "確定申込 " + d.totals.teams + "件"),
            d.events.map(e => h("td", { class: "num" }, e.count)), h("td", { class: "num" }, d.totals.entries), h("td", {}), h("td", {}), h("td", {}))))
          : h("div", { style: "padding:0 12px" }, empty)),
      h("div", { class: "ed-pc-out ed-btns" }, outButtons())));
  }

  // 行を押すと右から大きな詳細パネルが滑り込む。同じ行をもう一度押す・閉じる・Esc で滑り出る。
  // 左の台帳はパネルぶんだけ幅を絞って見え続ける(PC)。スマホは全幅のパネル。
  function openSub(sid) {
    const r = S.data.rows.find(x => x.submission_id === sid);
    if (!r) return;
    if (S.drawer && S.picked === sid) return closeDrawer();
    S.picked = sid;
    if (isPC()) markPicked();
    showDrawer(r);
  }
  function markPicked() {
    doc.querySelectorAll(".ed-table tbody tr").forEach(tr => tr.setAttribute("aria-selected", String(tr.dataset.sid === S.picked)));
  }
  function showDrawer(r) {
    const title = r.team_name || "(団体名なし)";
    if (S.drawer) {
      S.drawer.title.textContent = title;
      S.drawer.body.textContent = "";
      S.drawer.body.append(...[].concat(detail(r)).filter(Boolean));
      S.drawer.box.scrollTop = 0;
      return;
    }
    const before = doc.activeElement;
    const bg = h("div", { class: "ed-drawer-bg", onclick: () => closeDrawer() });
    const titleEl = h("h2", {}, title);
    const body = h("div", { class: "ed-drawer__body" }, [].concat(detail(r)).filter(Boolean));
    const box = h("aside", { class: "ed-drawer", role: "dialog", "aria-label": "申込の中身" },
      h("div", { class: "ed-drawer__head" }, titleEl,
        h("button", { class: "ed-drawer__x", type: "button", onclick: () => closeDrawer() }, "閉じる")), body);
    const esc = (e) => { if (e.key === "Escape" && !doc.querySelector(".ed-sheet")) closeDrawer(); };
    doc.addEventListener("keydown", esc);
    doc.body.append(bg, box);
    doc.getElementById("entryDesk").classList.add("is-drawer");
    root.requestAnimationFrame(() => root.requestAnimationFrame(() => { bg.classList.add("on"); box.classList.add("on"); }));
    S.drawer = { box, bg, title: titleEl, body, esc, before };
  }
  function closeDrawer(now) {
    const d = S.drawer;
    if (!d) return;
    S.drawer = null;
    S.picked = "";
    if (S.listBox && isPC()) markPicked();
    const rootEl = doc.getElementById("entryDesk");
    if (rootEl) rootEl.classList.remove("is-drawer");
    doc.removeEventListener("keydown", d.esc);
    const done = () => { d.bg.remove(); d.box.remove(); try { if (d.before && d.before.isConnected) d.before.focus(); } catch (_) {} };
    if (now) return done();
    d.box.classList.remove("on"); d.bg.classList.remove("on");
    d.box.addEventListener("transitionend", done, { once: true });
    root.setTimeout(done, 400);
  }

  // 出場者を種目ごとにまとめる。見出しは「種目名」と人数(個人=名・ダブルス=組・団体=チーム)。
  // 団体戦はチーム名と人数を見出し直下に置き、メンバーを続ける。種目の並びは要項の順。
  function eventGroups(r) {
    const order = S.data.events.map(e => e.name);
    const by = new Map();
    r.players.forEach(p => { if (!by.has(p.event)) by.set(p.event, []); by.get(p.event).push(p); });
    const names = [...by.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return h("div", { class: "ed-groups" }, names.map(ev => {
      const list = by.get(ev);
      const live = list.filter(p => p.status !== "cancelled");
      const kind = (list[0] && list[0].kind) || "singles";
      const unit = kind === "team" ? "チーム" : kind === "doubles" ? "組" : "名";
      return h("section", { class: "ed-group" },
        h("h3", { class: "ed-group__h" + gxClass(ev) }, ev, h("span", { class: "ed-num" }, live.length + unit)),
        h("ul", { class: "ed-plist" }, list.map(p => h("li", { class: p.status === "cancelled" ? "is-cancelled" : "" },
          kind === "team"
            ? [h("b", {}, (p.team_label || p.label)), h("small", {}, (p.members && p.members.length ? p.members.length + "名" : "") + (p.status === "cancelled" ? "・取り消し済み" : "") + (p.status === "pending" ? "・承認待ち" : "")),
              p.members && p.members.length ? h("small", { class: "ed-members" }, p.members.join("、")) : null]
            : [h("b", {}, p.label), h("small", {}, (p.kana ? p.kana : "ふりがな空欄") + (p.pair_wish ? "・ペア希望" : "") + (S.data.tournament.zendo_enabled ? "・全道出場 " + (p.zendo || "未回答") : "") + (p.status === "cancelled" ? "・取り消し済み" : "") + (p.status === "pending" ? "・承認待ち" : ""))]))));
    }));
  }

  // 申込1件の中身(PCの右・スマホの下から出るシートで共通)
  function detail(r) {
    const t = tournamentObj();
    const live = r.players.filter(p => p.status !== "cancelled");
    return [
      h("p", { class: "ed-sub" }, [r.contact_name ? "連絡者 " + r.contact_name : "", jpDate(r.received_at) + " 受付", ROUTE[r.route] || ""].filter(Boolean).join("・")),
      (r.mail || []).map(m => h("p", { class: "ed-sub" },
        (m.recipient === "admin" ? "運営通知" : "申込者控え") + "：" +
        ({ pending: "送信待ち", sending: "送信中", sent: "メールサーバー受付済み", failed: "送信失敗", skipped: "送信対象外" }[m.state] || "未確認"))),
      r.issues.map(i => h("div", { class: "ed-issue" + (i.type === "dup" ? " ed-issue--dup" : "") },
        h("b", {}, i.title), h("br"), i.detail,
        i.type === "mail" ? h("div", {}, h("button", { class: "ed-btn", type: "button", onclick: (e) => resend(r, i, e.currentTarget) }, "このメールを再送")) : null)),
      eventGroups(r),
      h("div", { class: "ed-btns" },
        h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => { closeSheet(); app().openSubmissionEdit(t, r.submission_id, reload); } }, "内容を直す"),
        live.length ? h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => cancelAsk(r, live) }, "この申込を取り消す") : null,
        live.length ? h("button", { class: "ed-btn", type: "button",
          onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/receipt-print.html?team=" + encodeURIComponent(r.team_name || ""), "領収書_" + (r.team_name || "")) }, "この団体の領収書を印刷") : null),
      h("div", { class: "ed-danger" },
        h("p", { class: "ed-sub" }, "取り消しは出場を数から外すだけです。申込そのものを台帳から消すときは削除します（削除前の内容は控えに残り、あとで戻せます）。"),
        h("button", { class: "ed-btn ed-btn--danger", type: "button", onclick: () => deleteAsk(r) }, "この申込を削除")),
    ];
  }

  async function resend(r, i, btn) {
    btn.disabled = true;
    const url = "/api/submissions/" + r.submission_id + "/mail-resend";
    let res = null;
    try { res = await api().post(url, { recipient: i.recipient }); } catch (_) {}
    if (!res || res.error) { btn.disabled = false; return toast((res && res.error) || "送れませんでした", "err"); }
    toast("メールの再送を予約しました", "ok");
    closeSheet();
    reload();
  }

  // 取り消し: 団体名と出場数を見せ、理由を書いてから。全出場を1つの変更として取り消す
  function cancelAsk(r, live) {
    const reason = h("input", { type: "text", maxlength: "200", placeholder: "例: 電話で取り消しの連絡あり" });
    const go = h("button", { class: "ed-btn ed-btn--danger", type: "button" }, "取り消す");
    const body = [
      h("p", { class: "ed-sub" }, (r.team_name || "(団体名なし)") + " の出場 " + live.length + " 件をすべて取り消します。取り消した出場は数から外れ、シートにも「取消」と送ります。"),
      h("label", { class: "ed-field" }, "取り消す理由", reason),
      h("div", { class: "ed-btns", style: "margin-top:14px" }, go,
        h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => closeSheet() }, "やめる")),
    ];
    sheet("この申込を取り消す", body);
    go.addEventListener("click", async () => {
      const why = reason.value.trim();
      if (!why) { reason.focus(); return toast("取り消す理由を書いてください", "err"); }
      go.disabled = true;
      let res = null;
      try {
        res = await api().put("/api/submissions/" + r.submission_id,
          { entries: live.map(p => ({ entrant_id: p.entrant_id, cancel: true })), reason: why });
      } catch (_) {}
      if (!res || res.error) { go.disabled = false; return toast((res && res.error) || "取り消せませんでした", "err"); }
      toast("取り消しました", "ok");
      closeSheet();
      reload();
    });
  }

  // 削除: 団体名・出場数を見せ、理由を書き、団体名を打ち直して確かめてから。削除前の中身は控えに残る
  function deleteAsk(r) {
    const name = r.team_name || "(団体名なし)";
    const reason = h("input", { type: "text", maxlength: "200", placeholder: "例: 同じ団体から二重に届いたため" });
    const confirmBox = h("input", { type: "text", autocomplete: "off", placeholder: r.team_name ? "団体名を入力" : "「削除」と入力" });
    const word = r.team_name ? r.team_name : "削除";
    const go = h("button", { class: "ed-btn ed-btn--danger", type: "button", disabled: "" }, "削除する");
    confirmBox.addEventListener("input", () => { go.disabled = confirmBox.value.trim() !== word; });
    sheet("この申込を削除する", [
      h("p", { class: "ed-sub" }, name + " の申込（出場 " + r.players.length + " 件）を台帳から削除します。削除前の内容は控えに残り、「削除した申込」から元に戻せます。"),
      h("label", { class: "ed-field" }, "削除する理由", reason),
      h("label", { class: "ed-field" }, "確認のため「" + word + "」と入力してください", confirmBox),
      h("div", { class: "ed-btns", style: "margin-top:14px" }, go,
        h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => closeSheet() }, "やめる")),
    ]);
    go.addEventListener("click", async () => {
      const why = reason.value.trim();
      if (!why) { reason.focus(); return toast("削除する理由を書いてください", "err"); }
      go.disabled = true;
      let res = null;
      try { res = await api().post("/api/submissions/" + r.submission_id + "/delete", { reason: why }); } catch (_) {}
      if (!res || res.error) { go.disabled = false; return toast((res && res.error) || "削除できませんでした", "err"); }
      toast("削除しました。「削除した申込」から戻せます", "ok");
      closeSheet(); closeDrawer(true);
      reload();
    });
  }

  // 削除した申込の一覧と、元に戻す操作
  async function deletedSheet() {
    let res = null;
    try { res = await api().get("/api/tournaments/" + encodeURIComponent(S.tid) + "/deleted-submissions"); } catch (_) {}
    const items = (res && res.items) || [];
    sheet("削除した申込", items.length ? h("ul", { class: "ed-plist" }, items.map(it => h("li", {},
      h("b", {}, it.team_name || "(団体名なし)"),
      h("small", {}, it.entrant_count + "件・" + String(it.deleted_at || "").slice(0, 16) + (it.operator ? "・担当 " + it.operator : "") + (it.reason ? "・" + it.reason : "")),
      it.restored_at ? h("small", {}, "元に戻し済み")
        : h("button", { class: "ed-btn", type: "button", style: "margin-top:6px;min-height:40px", onclick: async (e) => {
          e.currentTarget.disabled = true;
          let r2 = null;
          try { r2 = await api().post("/api/deleted-submissions/" + it.id + "/restore", {}); } catch (_) {}
          if (!r2 || r2.error) { e.currentTarget.disabled = false; return toast((r2 && r2.error) || "戻せませんでした", "err"); }
          toast("元に戻しました", "ok"); closeSheet(); reload();
        } }, "元に戻す")))) : h("p", { class: "ed-sub", style: "margin:10px 0" }, "削除した申込はありません。"));
  }

  function addSheet() {
    const t = tournamentObj();
    sheet("申込を追加する", [
      h("p", { class: "ed-sub", style: "margin:8px 0 12px" }, "Webフォームの申込は自動で入ります。紙・電話で届いた分をここから足すと、同じ台帳に揃います。"),
      h("div", { style: "display:grid;gap:8px" },
        h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => { closeSheet(); app().openManualSubmission(t, reload); } }, "紙・電話の分を手で入力する")),
    ]);
  }

  // 下から出るシート(PCでは中央)。Esc・背景・閉じるで閉じ、開く前の場所へフォーカスを戻す
  let sheetClose = null;
  function sheet(title, body) {
    closeSheet();
    const before = doc.activeElement;
    const bg = h("div", { class: "ed-sheet-bg", onclick: () => closeSheet() });
    const box = h("section", { class: "ed-sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("button", { class: "ed-sheet__x", type: "button", onclick: () => closeSheet() }, "閉じる"),
      h("h2", {}, title), body);
    const esc = (e) => { if (e.key === "Escape") closeSheet(); };
    doc.addEventListener("keydown", esc);
    doc.body.append(bg, box);
    box.querySelector("button").focus();
    sheetClose = () => { bg.remove(); box.remove(); doc.removeEventListener("keydown", esc); try { if (before) before.focus(); } catch (_) {} };
  }
  function closeSheet() { if (sheetClose) { const f = sheetClose; sheetClose = null; f(); } }

  // ── 画面の切替(index.html の handleHash から呼ぶ) ──
  // 受付台帳で扱うハッシュなら表示して true。既存のタブなら隠して false。
  function route(hash) {
    const parts = String(hash || "").replace(/^#/, "").split("/");
    const type = parts[0], id = parts[1];
    closeSheet(); closeDrawer(true);
    if (type === "list" || type === "" || type === "tournaments") { showList(); return true; }
    if (type === "more") { showMore(); return true; }
    if ((type === "desk" || type === "t" || type === "tournament") && id) { showDesk(decodeURIComponent(id)); return true; }
    if (type === "desk") {
      const last = store.get("ktta.desk.last");
      if (last) showDesk(last); else showList();
      return true;
    }
    hide();
    return false;
  }

  root.EntryDesk = { route, hide, refresh: () => (S.view === "desk" ? reload() : S.view === "list" ? showList() : null), shortEventName };
})(typeof window !== "undefined" ? window : globalThis);
