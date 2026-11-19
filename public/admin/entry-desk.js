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
  const S = { view: "", tid: "", data: null, q: "", only: "all", picked: "", backBar: null, root: null, main: null, listBox: null };

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
    S.main.textContent = "";
    S.main.append(
      h("div", { class: "ed-head" }, h("h1", {}, "受付する大会を選ぶ"),
        h("div", {}, h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => app().newTournament() }, "大会をつくる"))),
      d.items.length
        ? h("div", { class: "ed-tl" }, d.items.map(t => h("a", { class: "ed-tl__row", href: "#desk/" + encodeURIComponent(t.id) },
          h("span", { class: "ed-tl__name" }, t.name || "(名前なし)"),
          h("span", { class: "ed-tl__meta" }, meta(t)),
          h("span", { class: "ed-tl__count" }, h("b", { class: "ed-num" }, t.entries), "出場・" + t.teams + "団体"))))
        : h("div", { class: "ed-tl" }, h("p", { class: "ed-empty" }, "まだ大会がありません。「大会をつくる」から始めてください。")));
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
    if (S.tid !== tid) { S.q = ""; S.only = "all"; S.picked = ""; S.data = null; }
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
    return S.data.rows.filter(r => {
      if (S.only === "warn" && !r.issues.length) return false;
      if (["web", "excel", "manual"].includes(S.only) && r.route !== S.only) return false;
      if (!q) return true;
      const hay = [r.team_name, r.contact_name].concat(r.players.map(p => p.label + " " + p.kana)).join(" ");
      return hay.indexOf(q) >= 0;
    });
  }
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
        h("div", { class: "ed-filters" }, chips)),
      d.unlinked ? h("p", { class: "ed-routes" }, "申込番号のない出場（取込や以前の画面で入れた分）が " + d.unlinked + " 件あります。合計には入っていますが、団体の行には出ません。") : null,
      S.listBox,
    ]);
    renderList();
  }

  function count(r, ev) { return (r.by_event && r.by_event[ev]) || 0; }

  function renderList() {
    const d = S.data, box = S.listBox;
    box.textContent = "";
    const rows = visible();
    const empty = d.rows.length
      ? h("div", { class: "ed-empty" }, h("p", { style: "margin:0 0 8px" }, "条件に合う申込は見つかりません。"),
        h("button", { class: "ed-btn", type: "button", onclick: () => { S.q = ""; S.only = "all"; renderDesk(); } }, "条件を消す"))
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
      h("div", {}, h("span", {}, "出場 計"), h("b", {}, d.totals.entries))));
    box.append(h("div", { class: "ed-mobile-links ed-btns" },
      h("button", { class: "ed-btn", type: "button", onclick: copyUrl }, "申込URLをコピー"),
      h("button", { class: "ed-btn", type: "button", onclick: openForm }, "フォーム設定")));
    box.append(h("div", { class: "ed-dock" }, outButtons()));
    // PCの台帳
    const picked = d.rows.find(r => r.submission_id === S.picked);
    const tr = (r) => {
      const sel = () => openSub(r.submission_id);
      return h("tr", { tabindex: "0", "aria-selected": picked === r ? "true" : "false", onclick: sel,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sel(); } } },
        h("td", {}, r.team_name || "(団体名なし)"),
        d.events.map(e => { const c = count(r, e.name); return h("td", { class: "num" + (c ? "" : " zero") }, c || "−"); }),
        h("td", { class: "num sum" }, r.entries), h("td", {}, ROUTE[r.route] || ""), h("td", { class: "num" }, jpDate(r.received_at)),
        h("td", {}, r.issues.length ? h("span", { class: "ed-tag " + (r.issues.some(i => i.type === "dup") ? "ed-tag--dup" : "ed-tag--warn") }, r.issues.length + "件") : ""));
    };
    box.append(h("div", { class: "ed-wrap" },
      h("div", { class: "ed-table", tabindex: "0", "aria-label": "申込の台帳" },
        rows.length ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "団体"),
            d.events.map(e => h("th", { scope: "col", title: e.name, "aria-label": e.name }, e.short)),
            h("th", { scope: "col" }, "出場"), h("th", { scope: "col" }, "経路"), h("th", { scope: "col" }, "受付"), h("th", { scope: "col" }, "確認"))),
          h("tbody", {}, rows.map(tr)),
          h("tfoot", {}, h("tr", {}, h("td", {}, "合計 " + d.totals.teams + "団体"),
            d.events.map(e => h("td", { class: "num" }, e.count)), h("td", { class: "num" }, d.totals.entries), h("td", {}), h("td", {}), h("td", {}))))
          : h("div", { style: "padding:0 12px" }, empty)),
      h("aside", { class: "ed-side", "aria-label": "申込の中身" },
        picked ? [h("h2", {}, picked.team_name || "(団体名なし)"), detail(picked)] : h("p", { class: "ed-side__empty" }, "表の行を押すと、選手の名前と連絡者がここに出ます。"),
        h("div", { class: "ed-side__out" }, outButtons()))));
  }

  function openSub(sid) {
    S.picked = sid;
    const r = S.data.rows.find(x => x.submission_id === sid);
    if (!r) return;
    if (isPC()) renderList();
    else sheet(r.team_name || "(団体名なし)", detail(r));
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
      h("ul", { class: "ed-plist" }, r.players.map(p => h("li", { class: p.status === "cancelled" ? "is-cancelled" : "" },
        h("b", {}, p.label), h("small", {}, p.event + (p.kana ? "・" + p.kana : "") + (p.status === "cancelled" ? "・取り消し済み" : "") + (p.status === "pending" ? "・承認待ち" : ""))))),
      h("div", { class: "ed-btns" },
        h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => { closeSheet(); app().openSubmissionEdit(t, r.submission_id, reload); } }, "内容を直す"),
        live.length ? h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => cancelAsk(r, live) }, "この申込を取り消す") : null),
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
    closeSheet();
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
