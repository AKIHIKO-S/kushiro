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
    if (/団体/.test(n)) return sex + "団体戦";
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
  const ROUTE = { web: "ウェブ申込", excel: "Excel取込", manual: "本部で入力" };
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
  const S = { view: "", tid: "", data: null, q: "", only: "all", picked: "", sort: "", dir: 1, ev: "", lq: "", lsort: "", lstate: "all", drawer: null, backBar: null, root: null, main: null, listBox: null, sel: new Set() };

  function ensureRoot() {
    if (S.root) return;
    S.root = h("div", { id: "entryDesk" });
    doc.body.insertBefore(S.root, doc.body.firstChild);
  }

  const isFull = () => !app().entryOnly;   // 大会運営モード(ベータ版)
  function top(active) {
    const last = S.tid || store.get("ktta.desk.last");
    const nav = isFull()
      ? [h("a", { href: "#list", "aria-current": active === "list" || active === "tour" ? "page" : null }, "大会"),
         h("a", { href: "#operations", "aria-current": active === "operations" ? "page" : null }, "進行"),
         h("a", { href: "#players", "aria-current": active === "players" ? "page" : null }, "選手DB"),
         h("a", { href: "#coaches", "aria-current": active === "coaches" ? "page" : null }, "監督・申請"),
         h("a", { href: "/viewer", target: "_blank", rel: "noopener" }, "観戦画面"),
         h("a", { href: "#more", "aria-current": active === "more" ? "page" : null }, "その他")]
      : [h("a", { href: "#list", "aria-current": active === "list" ? "page" : null }, "大会"),
         h("a", { href: last ? "#desk/" + last : "#list", "aria-current": active === "desk" ? "page" : null }, "受付")];
    return h("header", { class: "ed-top" },
      h("a", { class: "ed-top__brand", href: "#list" },
        h("img", { class: "ed-top__logo", src: "/shared/assets/ktta-logo-256.png", alt: "" }),
        h("span", { class: "ed-top__org" }, "釧路卓球協会", h("small", { lang: "en" }, "KUSHIRO TABLE TENNIS ASSOCIATION"))),
      h("span", { class: "ed-top__sub" }, isFull() ? "大会運営(ベータ版)" : "申込の受付"),
      (app().buildBell ? app().buildBell() : null),   // 通知の鈴(新しい申込・変更の数)
      (app().buildModeSwitch ? (() => { const sw = app().buildModeSwitch(); return sw && sw.hidden ? null : sw; })() : null),   // 申込集計 / 大会運営(ベータ版) の切替
      h("nav", { class: "ed-top__nav", "aria-label": "主な画面" }, nav),
      who());
  }
  // 誰でログイン中か+ログアウト(狭い画面では「その他」の先頭に出す)
  function who() {
    const s = app().session;
    if (!s) return null;
    return h("div", { class: "ed-top__who" },
      h("span", { class: "ed-top__name", title: s.label }, s.label),
      h("span", { class: "ed-top__role" }, s.role),
      h("button", { class: "ed-top__out", type: "button", onclick: accountSheet }, "アカウント"));
  }
  // アカウントの操作(ログアウト・オーナーのシステム管理)。ナビには出さず、ここにまとめる
  function accountSheet() {
    const s = app().session;
    sheet("アカウント", [
      s ? h("p", { class: "ed-sub", style: "margin:8px 0 14px" }, "ログイン中: ", h("b", {}, s.label), "（" + s.role + "）") : null,
      h("div", { class: "ed-btns" },
        s && s.owner ? h("button", { class: "ed-btn", type: "button", onclick: () => { closeSheet(); app().openOwnerPanel(); } }, "システム管理（オーナー）") : null,
        h("button", { class: "ed-btn ed-btn--danger", type: "button", onclick: () => app().logout() }, "ログアウト")),
    ]);
  }

  function frame(active, body) {
    ensureRoot();
    doc.documentElement.classList.add("desk-on");
    doc.documentElement.classList.remove("desk-head-only");
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
        ? h("div", { class: "ed-tl" }, items.map(t => h("a", { class: "ed-tl__row", href: (isFull() ? "#t/" : "#desk/") + encodeURIComponent(t.id) },
          h("span", { class: "ed-tl__name" }, t.name || "(名前なし)"),
          h("span", { class: "ed-tl__meta" }, meta(t)),
          h("span", { class: "ed-tl__count" }, h("b", { class: "ed-num" }, t.entries), "出場確定・" + t.teams + "団体"))))
        : h("div", { class: "ed-tl" }, h("p", { class: "ed-empty" }, d.items.length ? "条件に合う大会は見つかりません。" : (isFull() ? "まだ大会がありません。大会は「申込集計」モードでつくります。" : "まだ大会がありません。「大会をつくる」から始めてください。"))));
    };
    const count = (st) => d.items.filter(t => st === "all" || t.state === st).length;
    const chip = (v, label) => { const b = h("button", { class: "ed-chip", type: "button", "aria-pressed": String(S.lstate === v),
      onclick: () => { S.lstate = v; showList.chips.forEach(c => c.setAttribute("aria-pressed", String(c.dataset.v === v))); renderTl(); } }, label, h("b", { class: "ed-num" }, count(v))); b.dataset.v = v; return b; };
    showList.chips = [chip("all", "すべて"), chip("open", "受付中"), chip("before", "受付前"), chip("closed", "終了")];
    S.main.textContent = "";
    S.main.append(
      h("div", { class: "ed-head" }, h("h1", {}, isFull() ? "運営する大会を選ぶ" : "受付する大会を選ぶ"),
        isFull() ? null : h("div", {}, h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => app().newTournament() }, "大会をつくる"))),
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

  // ── 大会運営モード(ベータ版): 大会のページ。組合せはJSONの取り込みで入れる ──
  async function showFullTournament(tid) {
    S.view = "tour"; S.tid = tid;
    frame("tour", h("p", { class: "ed-loading" }, "大会を読み込んでいます…"));
    let t = null;
    try { t = await api().get("/api/tournaments/" + encodeURIComponent(tid)); } catch (_) {}
    if (S.view !== "tour" || S.tid !== tid) return;
    if (!t || t.error || !t.id) {
      S.main.textContent = "";
      S.main.append(failBox(t && t.error ? t.error : "大会を読み込めませんでした。", () => showFullTournament(tid)));
      return;
    }
    const note = h("p", { class: "ed-sub", role: "status", style: "margin:10px 0 0;white-space:pre-wrap" });
    const area = h("textarea", { class: "ed-json", rows: "8", spellcheck: "false", placeholder: '組合せのJSONを貼り付けるか、下のボタンでファイルを選びます。\n形式: tabletennis-bracket-v1(完成した表)/ tabletennis-seed-list-v1(選手リスト)/ tabletennis-tournament-v1(複数種目)', "aria-label": "組合せのJSON" });
    const file = h("input", { type: "file", accept: ".json,application/json", class: "ed-file", "aria-label": "JSONファイルを選ぶ" });
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 5 * 1024 * 1024) { note.textContent = "ファイルが大きすぎます(5MBまで)。"; return; }
      const rd = new FileReader();
      rd.onload = () => { area.value = String(rd.result || ""); note.textContent = f.name + " を読み込みました。内容を確かめて「取り込む」を押してください。"; };
      rd.readAsText(f, "utf-8");
    });
    const force = h("input", { type: "checkbox", id: "edForce" });
    const go = h("button", { class: "ed-btn ed-btn--main", type: "button" }, "取り込む");
    go.addEventListener("click", async () => {
      let obj = null;
      try { obj = JSON.parse(area.value); } catch (e) { note.textContent = "JSONとして読めません: " + String(e.message || e).slice(0, 120); return; }
      if (!obj || typeof obj !== "object") { note.textContent = "JSONの中身が空です。"; return; }
      if (force.checked) obj.force = true;
      go.disabled = true; note.textContent = "取り込んでいます…";
      let res = null;
      try { res = await api().post("/api/tournaments/" + encodeURIComponent(tid) + "/bracket/import", obj); } catch (_) {}
      go.disabled = false;
      if (!res || res.error) { note.textContent = "取り込めませんでした: " + ((res && res.error) || "通信できませんでした"); return; }
      const parts = Array.isArray(res.imported) ? res.imported.map(r => (r.event || "") + (r.error ? "(失敗: " + r.error + ")" : "")) : [obj.event || ""];
      note.textContent = "取り込みました: " + parts.filter(Boolean).join("、");
      toast("組合せを取り込みました", "ok");
    });
    S.main.textContent = "";
    S.main.append(
      h("div", { class: "ed-head" }, h("div", {},
        h("h1", {}, t.name || "(名前なし)"),
        h("div", { class: "ed-head__meta" }, [t.date ? jpDate(t.date, true) : "", t.venue].filter(Boolean).join("・")))),
      h("section", { class: "ed-card" },
        h("h2", {}, "組合せを取り込む(JSON)"),
        h("p", { class: "ed-sub", style: "margin:4px 0 10px" }, "組合せは、作ったJSONをここから取り込みます。取り込むと、その種目のトーナメント表が入れ替わります。"),
        area,
        h("div", { class: "ed-btns", style: "margin-top:10px;align-items:center" }, file,
          h("label", { class: "ed-check" }, force, " 結果入力済みの種目でも取り込む")),
        h("div", { class: "ed-btns", style: "margin-top:10px" }, go),
        note),
      branchCard(t),
      reviewCard(t),
      h("section", { class: "ed-card" },
        h("h2", {}, "試合を進める・見せる"),
        h("div", { class: "ed-btns" },
          h("button", { class: "ed-btn", type: "button", onclick: () => leaveTo("operations") }, "進行(台の割り当て・結果入力)"),
          h("a", { class: "ed-btn", href: "/viewer", target: "_blank", rel: "noopener" }, "観戦画面を開く"))),
      h("section", { class: "ed-card" },
        h("h2", {}, "申込のこと"),
        h("p", { class: "ed-sub", style: "margin:4px 0 0" }, "申込フォームの作成・公開、申込の確認、名簿づくりは「申込集計」モードで行います(右上の切替から)。")));
  }

  // 取込で勝者を確定できなかった対戦(要確認・手動推奨)。運営が、どちらが勝ったか(分かればセット数・棄権)を選んで確定する。
  // 確定するまで勝敗に入らない。確定は押す前に確認を出し、誰がいつ確定したかを残す。取り消せる。
  function reviewCard(t) {
    const box = h("div", {}, h("p", { class: "ed-sub" }, "読み込み中…"));
    const base = "/api/tournaments/" + encodeURIComponent(t.id) + "/review-matches";
    const opCode = () => { try { return (app().ownerOperator && app().ownerOperator()) || ""; } catch (_) { return ""; } };
    const when = (iso) => { try { return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); } catch (_) { return iso || ""; } };
    const pend = (x) => {
      const name = "rv-" + x.id;
      const r1 = h("input", { type: "radio", name, value: "1" }), r2 = h("input", { type: "radio", name, value: "2" });
      const ws = h("input", { class: "ed-search", type: "number", min: "0", max: "9", inputmode: "numeric", "aria-label": "勝った側のセット数", style: "max-width:84px" });
      const ls = h("input", { class: "ed-search", type: "number", min: "0", max: "9", inputmode: "numeric", "aria-label": "負けた側のセット数", style: "max-width:84px" });
      const wo = h("input", { type: "checkbox" });
      const g = x.guess;
      const go = h("button", { class: "ed-btn ed-btn--main", type: "button" }, "この内容で確定する");
      go.addEventListener("click", async () => {
        const slot = r1.checked ? 1 : r2.checked ? 2 : 0;
        if (!slot) return toast("どちらが勝ったかを選んでください", "err");
        const wname = slot === 1 ? x.p1 : x.p2, lname = slot === 1 ? x.p2 : x.p1;
        const sc = (ws.value !== "" || ls.value !== "") ? ("　セット " + (ws.value || "?") + "-" + (ls.value || "?")) : "　セット数なし";
        if (!root.confirm(x.event + " " + x.round + "\n" + wname + " の勝ち、" + lname + " の負け" + (wo.checked ? "(" + lname + " は棄権・不戦勝)" : sc) + "\n\n確定すると、選手の勝敗と履歴に入ります。取り消すこともできます。確定しますか？")) return;
        go.disabled = true;
        const res = await api().post(base + "/" + encodeURIComponent(x.id) + "/resolve", { winner_slot: slot, winner_sets: wo.checked ? "" : ws.value, loser_sets: wo.checked ? "" : ls.value, walkover: wo.checked, operator: opCode() });
        go.disabled = false;
        if (res && res.ok) { toast("確定しました", "ok"); load(); } else toast((res && res.error) || "確定できませんでした", "err");
      });
      return h("div", { class: "ed-rv" },
        h("div", { class: "ed-rv__t" }, x.event + "　" + x.round + (x.match_label ? "(" + x.match_label + ")" : "")),
        h("div", { class: "ed-sub" }, x.note ? "確認が必要な理由: " + x.note : "確認が必要な対戦です。"),
        g ? h("div", { class: "ed-sub" }, "読み取りの候補(確定ではありません): " + g.winner + " の勝ち" + (g.walkover ? "(棄権)" : g.winner_sets != null ? " " + g.winner_sets + "-" + g.loser_sets : "")) : null,
        h("div", { class: "ed-rv__pick" },
          h("label", { class: "ed-check" }, r1, " " + x.p1 + "(" + x.p1_team + ")が勝ち"),
          h("label", { class: "ed-check" }, r2, " " + x.p2 + "(" + x.p2_team + ")が勝ち")),
        h("div", { class: "ed-btns", style: "align-items:center" }, h("span", {}, "セット数(分かれば)"), ws, h("span", {}, "-"), ls,
          h("label", { class: "ed-check" }, wo, " 棄権(相手の不戦勝)")),
        h("div", { class: "ed-btns", style: "margin-top:8px" }, go));
    };
    const done = (x) => {
      const undo = h("button", { class: "ed-btn ed-btn--quiet", type: "button" }, "取り消す");
      undo.addEventListener("click", async () => {
        if (!root.confirm(x.event + " " + x.round + "\n" + x.p1 + " 対 " + x.p2 + "\nこの確定を取り消して、「要確認」に戻しますか？(勝敗と履歴から外れます)")) return;
        const res = await api().post(base + "/" + encodeURIComponent(x.id) + "/undo", { operator: opCode() });
        if (res && res.ok) { toast("取り消しました", "ok"); load(); } else toast((res && res.error) || "取り消せませんでした", "err");
      });
      return h("div", { class: "ed-rv ed-rv--done" },
        h("div", { class: "ed-rv__t" }, x.event + "　" + x.round),
        h("div", {}, x.winner + " の勝ち(" + (x.p1 === x.winner ? x.p2 : x.p1) + " は" + (x.walkover ? "棄権" : "負け") + ")" + (!x.walkover && (x.winner_sets || x.loser_sets) ? "　" + x.winner_sets + "-" + x.loser_sets : "")),
        h("div", { class: "ed-sub" }, "確定した人: " + (x.by || "不明") + "　" + when(x.at)), undo);
    };
    async function load() {
      const d = await api().get(base).catch(() => null);
      box.textContent = "";
      if (!d || d.error) { box.append(h("p", { class: "ed-sub" }, (d && d.error) || "読み込めませんでした。")); return; }
      const p = d.items.filter(x => x.state === "pending"), r = d.items.filter(x => x.state === "resolved");
      if (!d.items.length) { box.append(h("p", { class: "ed-sub" }, "要確認の対戦はありません。")); return; }
      box.append(h("p", { class: "ed-sub", style: "font-weight:700" }, "確定待ち " + p.length + " 件(勝敗には、まだ入っていません)"), ...p.map(pend));
      if (r.length) box.append(h("p", { class: "ed-sub", style: "font-weight:700;margin-top:14px" }, "確定済み " + r.length + " 件"), ...r.map(done));
    }
    load();
    return h("section", { class: "ed-card" },
      h("h2", {}, "要確認の対戦(手動推奨)"),
      h("p", { class: "ed-sub", style: "margin:4px 0 10px" }, "取り込みで、勝者を確定できなかった対戦です。どちらが勝ったか(分かればセット数・棄権)を選んで確定します。確定するまで、選手の勝敗と履歴には入りません。"),
      box);
  }

  // この大会に出た選手の支部を、1つにそろえる(オーナー限定)。プレビュー → 適用。適用の直前に自動でバックアップ。
  // 変えるのは支部だけ。所属(学校名・クラブ名)は変えない。
  function branchCard(t) {
    const input = h("input", { class: "ed-search", type: "text", value: "釧路", maxlength: "20", "aria-label": "そろえる支部", style: "max-width:140px" });
    const over = h("input", { type: "checkbox" });
    const go = h("button", { class: "ed-btn", type: "button" }, "変更内容を確かめる");
    go.addEventListener("click", async () => {
      const branch = input.value.trim();
      if (!branch) return toast("支部を入力してください", "err");
      if (!(await app().ensureOwner())) return;
      const body = (dry) => ({ branch, overwrite: over.checked, dry_run: dry });
      const url = "/api/tournaments/" + encodeURIComponent(t.id) + "/players-branch";
      let pre = null;
      try { pre = (await app().ownerFetch(url, { method: "POST", body: body(true) })).json; } catch (_) {}
      if (!pre || pre.error) return toast((pre && pre.error) || "確かめられませんでした", "err");
      const note = "出場者 " + pre.total + " 名のうち、すでに「" + branch + "」の人 " + pre.already_same + " 名"
        + (pre.kept_other ? "、別の支部が入っていて今回は変えない人 " + pre.kept_other + " 名(上書きにチェックを付けると変わります)" : "") + "。";
      app().previewBulk({
        title: "出場者の支部を「" + branch + "」にそろえる(確認)",
        intro: note + " 変えるのは支部だけで、所属(学校名・クラブ名)は変わりません。",
        count: pre.changes.length, headers: ["氏名", "所属", "いまの支部", "変更後"],
        rows: pre.changes.map(c => [c.name, c.team, c.from, c.to]),
        applyLabel: "支部を変更する",
        onApply: async () => {
          const r = (await app().ownerFetch(url, { method: "POST", body: body(false) })).json || {};
          if (r.error) throw new Error(r.error);
          app().showBulkResult({ title: "支部をそろえました", summary: (r.updated || 0) + "名の支部を「" + branch + "」にしました。",
            check: "大会運営の「選手DB」で、この大会の選手の支部を確かめてください。", backup: r.backup });
        } });
    });
    return h("section", { class: "ed-card" },
      h("h2", {}, "出場者の支部をまとめて指定"),
      h("p", { class: "ed-sub", style: "margin:4px 0 10px" }, "この大会に出た選手の支部を、指定した1つにそろえます(オーナーのみ)。先に変更内容を確かめてから適用します。所属(学校名)は変えません。"),
      h("div", { class: "ed-btns", style: "align-items:center" }, h("span", {}, "支部"), input,
        h("label", { class: "ed-check" }, over, " 別の支部が入っている人も書き換える")),
      h("div", { class: "ed-btns", style: "margin-top:10px" }, go));
  }

  // ── その他(既存の画面への入口) ──
  function showMore() {
    S.view = "more";
    const go = (tab) => () => { leaveTo(tab); };
    const item = (title, note, fn) => h("button", { class: "ed-more__row", type: "button", onclick: fn }, h("b", {}, title), h("span", {}, note));
    const s = app().session;
    // 選手DBの公開ページ。公開前は、ログイン中の運営だけが開ける(確認用)。一般公開の切り替えはオーナーだけ
    const pubItems = [item("選手DB(公開ページの確認)", "選手の成績ページを、見る側の画面で確かめる(公開前はログイン中の運営だけが見られます)", () => window.open("/players", "_blank", "noopener"))]
      .concat(s && s.owner ? [item("選手DBの一般公開", "公開する・非公開にもどす(オーナーのみ・押す前に確認が出ます)", () => app().openPublicPlayersPanel())] : []);
    const items = isFull()
      ? pubItems.concat([item("システム管理（オーナー）", "バックアップ・運営アカウント・選手登録台帳との統合", () => app().openOwnerPanel())])
      : pubItems.concat([
        item("選手の名寄せ", "選手データベースで、同じ人の登録をまとめる・所属を整える", go("players")),
        item("データの書き出し・取り込み", "Excel・CSVの書き出しと、名簿の取り込み", go("import")),
        item("外部の申込フォーム", "他団体・外部大会の申込フォームへのリンク一覧", go("external-forms")),
        item("以前の申込一覧", "これまでの申込一覧の画面", go("entries")),
        item("システム管理（オーナー）", "バックアップ・運営アカウント・選手登録台帳との統合", () => app().openOwnerPanel())]);
    frame("more", [
      h("div", { class: "ed-head" }, h("h1", {}, "その他")),
      s ? h("div", { class: "ed-account" },
        h("span", {}, "ログイン中: ", h("b", {}, s.label), "（" + s.role + "）"),
        h("button", { class: "ed-btn", type: "button", onclick: () => app().logout() }, "ログアウト")) : null,
      h("div", { class: "ed-more" }, items),
    ]);
  }

  // 既存のタブへ移る。上に「受付へ戻る」を出す
  function leaveTo(tab) {
    hide();
    location.hash = tab;
  }
  function hide(type) {
    doc.documentElement.classList.remove("desk-on");
    S.view = "";
    if (isFull()) {
      // 大会運営モード(ベータ版): 既存の画面(進行・選手DB・監督)も、上は新しいヘッダー(協会サイト調)に揃える
      if (S.backBar) { S.backBar.remove(); S.backBar = null; }
      ensureRoot();
      S.root.textContent = "";
      S.root.append(top(type || ""));
      doc.documentElement.classList.add("desk-head-only");
      return;
    }
    doc.documentElement.classList.remove("desk-head-only");
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
  const SORTS = [["", "団体名の順"], ["name", "団体名"], ["entries", "出場確定数の多い順"], ["received", "受付の新しい順"], ["issues", "要確認の多い順"]];
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
          l ? " " : "", l ? h("b", {}, l) : null)));
  }

  // 申込の流れ(準備→受付中→締切後)ごとの区切り。いまの段階(大会の状態)を濃く出す
  function phase(n, title, note, now, kids) {
    return h("section", { class: "ed-phase" + (now ? " is-now" : ""), "aria-label": title },
      h("div", { class: "ed-phase__head" }, h("span", { class: "ed-phase__n" }, String(n)), h("h2", {}, title),
        note ? h("span", { class: "ed-phase__note" }, note) : null, now ? h("span", { class: "ed-phase__now" }, "いまここ") : null),
      kids);
  }
  function prepButtons() {
    return h("div", { class: "ed-btns" },
      h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: copyUrl }, "申込URLをコピー"),
      h("button", { class: "ed-btn", type: "button", onclick: openForm }, "フォーム設定"));
  }
  // 締め切ったあと: 出力(主ボタン)と、確認・整理(控えめ)を分ける
  function closeButtons() {
    const t = tournamentObj();
    return [
      h("div", { class: "ed-btns" },
        h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => app().downloadAggregation(t) }, "集計表をExcelで保存"),
        h("button", { class: "ed-btn ed-btn--main", type: "button",
          onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/reception.html", "受付名簿_" + (t.name || "")) }, "名簿を印刷"),
        h("button", { class: "ed-btn ed-btn--main", type: "button",
          onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/receipt-print.html", "領収書_" + (t.name || "")) }, "領収書を印刷")),
      h("div", { class: "ed-btns ed-btns--sub" },
        h("button", { class: "ed-btn", type: "button", onclick: () => app().openPlayerMatch(t) }, "選手DBと照合・連携")),
    ];
  }

  function renderDesk() {
    const d = S.data;
    const routeN = (k) => d.rows.filter(r => r.route === k).length;
    const chip = (v, label, n, extra) => h("button", { class: "ed-chip" + (extra || ""), type: "button", "aria-pressed": String(S.only === v),
      onclick: () => { S.only = v; renderDesk(); } }, label, h("b", { class: "ed-num" }, n));
    const chips = [chip("all", "すべて", d.rows.length), chip("warn", "要確認", d.rows.filter(r => r.issues.length).length, " ed-chip--warn")];
    if (routeN("excel")) chips.push(chip("excel", "Excel取込", routeN("excel")));
    if (routeN("manual")) chips.push(chip("manual", "本部で入力", routeN("manual")));
    const search = h("input", { class: "ed-search", type: "search", value: S.q, placeholder: "団体名・氏名で探す", "aria-label": "申込を探す",
      oninput: (e) => { S.q = e.target.value; renderList(); } });
    S.listBox = h("div", {});
    const st = d.tournament.state;
    frame("desk", [
      headBox(),
      phase(1, "準備", "申込フォームを用意して、URLを配る", st === "before", prepButtons()),
      phase(2, "受付中", "届いた申込を見て、要確認を直す", st === "open", [
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
        h("p", { class: "ed-flow" }, h("b", {}, "申込の流れ"), " 受付（申込が届く）→ 確認（要確認を直す）→ 出場確定（出場数に入る）"),
        d.unlinked ? h("p", { class: "ed-routes" }, "申込番号のない出場（取込や以前の画面で入れた分）が " + d.unlinked + " 件あります。合計には入っていますが、団体の行には出ません。") : null,
        S.listBox,
      ]),
      phase(3, "締切後", "集計と書類を出す", st === "closed", closeButtons()),
      backupCard(),
      h("div", { class: "ed-foot" }, h("button", { class: "ed-link", type: "button", onclick: deletedSheet }, "削除した申込を見る（元に戻せます）")),
    ]);
    renderList();
  }

  // ── この大会の申込のバックアップ(保存)と、保存した申込の読み込み(復元)。オーナーだけ ──
  // 保存: 復元用のJSONと、人が見るExcelの一覧を、ブラウザのダウンロードとして保存(サーバーには残さない)。
  // 読み込み: 先にプレビュー(新規/すでにある/内容が違う の件数)→「この内容で復元する」。直前に現在のDBの自動バックアップを取る。
  function backupCard() {
    const s = app().session;
    if (!(s && s.owner)) return null;
    const t = S.data.tournament;
    const base = "/api/tournaments/" + encodeURIComponent(t.id);
    const opCode = () => { try { return (app().ownerOperator && app().ownerOperator()) || ""; } catch (_) { return ""; } };
    const q = (extra) => "?operator=" + encodeURIComponent(opCode()) + (extra || "");
    const nameOf = (res, fb) => { const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") || ""); try { return m ? decodeURIComponent(m[1]) : fb; } catch (_) { return fb; } };
    const download = async (path, fb) => {
      const res = await fetch(base + path, { headers: app()._ownerHeaders(), credentials: "same-origin" });
      if (!res.ok) { let e = ""; try { e = (await res.json()).error; } catch (_) {} return { ok: false, error: e || ("HTTP " + res.status) }; }
      const blob = await res.blob(), url = URL.createObjectURL(blob), a = doc.createElement("a");
      a.href = url; a.download = nameOf(res, fb); doc.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { ok: true, name: a.download };
    };
    const saveBtn = h("button", { class: "ed-btn ed-btn--main", type: "button" }, "この大会の申込を保存する");
    saveBtn.addEventListener("click", async () => {
      if (!(await app().ensureOwner())) return;
      if (!root.confirm("この大会の申込を、このパソコンに保存します。\n\n個人情報(連絡先・氏名)を含みます。共有やコミットをしないでください。\n保存するのは、復元用のファイル(JSON)と、見るための一覧(Excel)の2つです。保存しますか？")) return;
      saveBtn.disabled = true;
      const j = await download("/entry-backup.json", "申込バックアップ.json");
      if (!j.ok) { saveBtn.disabled = false; return toast("保存できませんでした: " + j.error, "err"); }
      await new Promise(r => setTimeout(r, 600));
      const x = await download("/entry-backup.xlsx", "申込バックアップ(一覧).xlsx");
      saveBtn.disabled = false;
      toast(x.ok ? "保存しました(復元用のファイルと、見るための一覧)" : "復元用のファイルを保存しました(一覧のExcelは、申込がまだ無いため作っていません)", "ok");
    });
    const file = h("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    const loadBtn = h("button", { class: "ed-btn", type: "button" }, "保存した申込を読み込む");
    loadBtn.addEventListener("click", async () => { if (await app().ensureOwner()) file.click(); });
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0]; file.value = "";
      if (!f) return;
      if (f.size > 40 * 1024 * 1024) return toast("ファイルが大きすぎます", "err");
      const text = await f.text();
      const res = await fetch(base + "/entry-restore/preview" + q(), { method: "POST", headers: { ...app()._ownerHeaders(), "Content-Type": "text/plain" }, body: text, credentials: "same-origin" });
      const p = await res.json().catch(() => ({}));
      if (!res.ok || p.error) return toast((p && p.error) || "読み込めませんでした", "err");
      restoreSheet(t, base, text, p, f.name);
    });
    const restoreSheet = (tour, b, text, p, fname) => {
      const cnt = p.counts, lab = { entry_submissions: "申込", entrants: "出場者", entry_changes: "変更履歴", deleted_submissions: "削除した申込の控え", submission_tokens: "申込番号の対応" };
      const rows = Object.keys(lab).map(k => cnt[k]).map((c, i) => h("tr", {}, h("th", { scope: "row" }, lab[Object.keys(lab)[i]]),
        h("td", {}, h("b", {}, String(c.new)), " 件"), h("td", {}, String(c.same + c.skipped) + " 件"), h("td", {}, String(c.differs) + " 件")));
      const other = h("input", { type: "checkbox" }), setting = h("input", { type: "checkbox" });
      const go = h("button", { class: "ed-btn ed-btn--main", type: "button" }, "この内容で復元する");
      const totalNew = Object.values(cnt).reduce((a, c) => a + c.new, 0);
      const sync = () => { go.disabled = (p.other_tournament && !other.checked); };
      other.addEventListener("change", sync);
      const result = h("div", {});
      go.addEventListener("click", async () => {
        if (!root.confirm("この内容で、保存した申込を読み込みます。\n\n新規に入る: " + totalNew + " 件(申込" + cnt.entry_submissions.new + "件)\nすでにあるものは、上書きしません。\n読み込みの直前に、いまのデータの自動バックアップを取ります。\n\n復元しますか？")) return;
        go.disabled = true;
        const res = await fetch(b + "/entry-restore" + q((p.other_tournament && other.checked ? "&allow_other=1" : "") + (setting.checked ? "&apply_settings=1" : "")),
          { method: "POST", headers: { ...app()._ownerHeaders(), "Content-Type": "text/plain" }, body: text, credentials: "same-origin" });
        const r = await res.json().catch(() => ({}));
        go.disabled = false;
        if (!res.ok || r.error) return toast((r && r.error) || "復元できませんでした", "err");
        result.textContent = "";
        result.append(h("p", { class: "ed-sub", style: "font-weight:700;color:var(--st-ink)" }, "復元しました: 新しく入った行 " + r.inserted + " 件" + (r.settings_applied && r.settings_applied.length ? "(大会の申込設定も戻しました)" : "")),
          h("p", { class: "ed-sub" }, "復元の直前の自動バックアップ: " + (r.backup || "(なし)")),
          h("p", { class: "ed-sub" }, "取り消すとき: 「その他」→「システム管理（オーナー）」→「バックアップ / 復元」で、この名前のバックアップを「復元」すると、復元する前の状態に戻ります(それ以降の変更も戻ります)。"));
        go.style.display = "none"; toast("復元しました", "ok"); reload();
      });
      sheet("保存した申込を読み込む(確認)", h("div", {},
        h("p", { class: "ed-sub", style: "margin:6px 0" }, "ファイル: " + fname + "　保存した大会: " + (p.backup_tournament.name || "") + (p.exported_at ? "　保存日時: " + new Date(p.exported_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "")),
        p.other_tournament ? h("div", { class: "ed-warn", role: "alert" }, h("b", {}, "この大会のバックアップではありません。"), " 読み込み先は「" + p.target.name + "」で、ファイルは「" + (p.backup_tournament.name || "別の大会") + "」のものです。",
          h("label", { class: "ed-check" }, other, " 別の大会のファイルだと分かっていて、この大会へ読み込む")) : null,
        h("p", { class: "ed-sub", style: "margin:8px 0 4px" }, "まだ何も変わっていません。内容を確かめてから、「この内容で復元する」を押してください。"),
        h("table", { class: "ed-rtab" }, h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "新規で入る"), h("th", {}, "すでにあるので飛ばす"), h("th", {}, "内容が違うので飛ばす"))), h("tbody", {}, rows)),
        p.differs.length ? h("details", {}, h("summary", {}, "内容が違うもの(" + p.differs.length + "件・上書きしません)"),
          h("ul", { class: "ed-sub" }, p.differs.slice(0, 20).map(d => h("li", {}, d.table + " " + (d.label || d.id) + "(違う項目: " + d.fields.join("、") + ")")))) : null,
        p.warnings.length ? h("ul", { class: "ed-sub" }, p.warnings.map(w => h("li", {}, w))) : null,
        p.settings_differ.length ? h("label", { class: "ed-check" }, setting, " 大会の申込設定(" + p.settings_differ.length + "項目: 種目・参加費・項目など)も、保存した内容に戻す") : null,
        h("p", { class: "ed-sub" }, "個人情報を含みます。読み込んだあとのファイルも、共有やコミットをしないでください。同じファイルを2回読み込んでも、二重にはなりません。"),
        h("div", { class: "ed-btns", style: "margin-top:10px" }, go), result));
      sync();
    };
    return h("section", { class: "ed-card" },
      h("h2", {}, "この大会の申込のバックアップ"),
      h("p", { class: "ed-sub", style: "margin:4px 0 6px" }, "この大会の申込(申込・出場者・申込番号・変更履歴・削除した申込・申込の設定)を、このパソコンに保存します。復元するときは、保存したファイルを読み込みます(オーナーのみ)。"),
      h("p", { class: "ed-warn" }, h("b", {}, "個人情報を含みます。共有やコミットをしない。"), " ファイルはサーバーに残らず、ダウンロードとしてこのパソコンに保存されます。"),
      h("div", { class: "ed-btns", style: "margin-top:8px" }, saveBtn, loadBtn, file));
  }

  // 種目の性別の色分けのクラス(判定は shared/event-gender.js の共通関数。判定できない種目は無色)
  function gxClass(name) {
    const g = root.KTTAEventGender ? root.KTTAEventGender.of(name) : "";
    return g ? " ed-gx-" + g : "";
  }
  function count(r, ev) { return (r.by_event && r.by_event[ev]) || 0; }

  // ── まとめて操作(2段階): 選ぶ → 取り消す → 取り消し済みだけ削除できる ──
  const liveOf = (r) => r.players.filter(p => p.status !== "cancelled");
  const isCancelledRow = (r) => !liveOf(r).length;   // 生きている出場がない = 取り消し済み(削除できる)
  const selRows = () => S.data.rows.filter(r => S.sel.has(r.submission_id));
  function bulkBar(rows) {
    const chosen = selRows();
    const toCancel = chosen.filter(r => !isCancelledRow(r));
    const toDelete = chosen.filter(isCancelledRow);
    if (!chosen.length) {
      return rows.length ? h("div", { class: "ed-bulk ed-bulk--idle" },
        h("button", { class: "ed-link", type: "button", onclick: () => { rows.forEach(r => S.sel.add(r.submission_id)); renderList(); } }, "表示中の申込をまとめて選ぶ")) : h("span", {});
    }
    return h("div", { class: "ed-bulk", role: "region", "aria-label": "選んだ申込をまとめて操作" },
      h("b", { class: "ed-bulk__n" }, chosen.length + "件を選択中"),
      h("div", { class: "ed-btns" },
        h("button", { class: "ed-btn ed-btn--quiet", type: "button", disabled: toCancel.length ? null : "", onclick: () => cancelMany(toCancel) },
          toCancel.length ? "取り消す(" + toCancel.length + "件)" : "取り消せる申込なし"),
        h("button", { class: "ed-btn ed-btn--danger", type: "button", disabled: toDelete.length ? null : "", onclick: () => deleteMany(toDelete) },
          toDelete.length ? "削除する(" + toDelete.length + "件)" : "削除する"),
        h("button", { class: "ed-btn", type: "button", onclick: () => { S.sel.clear(); renderList(); } }, "選択をやめる")),
      h("p", { class: "ed-sub ed-bulk__note" }, toDelete.length === chosen.length
        ? "選んだ申込は取り消し済みです。削除できます(削除前の内容は控えに残り、あとで戻せます)。"
        : "削除できるのは、先に取り消した申込だけです。" + (toDelete.length ? "いま選んだ中の取り消し済み " + toDelete.length + " 件だけが削除の対象になります。" : "")));
  }
  const nameList = (rs) => rs.slice(0, 5).map(r => r.team_name || "(団体名なし)").join("、") + (rs.length > 5 ? " ほか" + (rs.length - 5) + "件" : "");
  // まとめて取り消し: 戻せる操作なので確認は出さず、すぐ取り消して「元に戻す」を出す
  async function cancelMany(rs) {
    const done = [];
    for (const r of rs) {
      const ids = liveOf(r).map(p => p.entrant_id);
      let res = null;
      try { res = await api().put("/api/submissions/" + r.submission_id, { entries: ids.map(id => ({ entrant_id: id, cancel: true })), reason: "運営がまとめて取り消し" }); } catch (_) {}
      if (res && !res.error) done.push({ sid: r.submission_id, ids });
    }
    S.sel.clear();
    closeDrawer(true);
    await reload();
    if (done.length < rs.length) toast((rs.length - done.length) + "件は取り消せませんでした", "err");
    if (!done.length) return;
    undoToast(done.length + "件の申込を取り消しました", async () => {
      let bad = 0;
      for (const d of done) {
        let r2 = null;
        try { r2 = await api().put("/api/submissions/" + d.sid, { entries: d.ids.map(id => ({ entrant_id: id, restore: true })), reason: "取り消しを元に戻した" }); } catch (_) {}
        if (!r2 || r2.error) bad++;
      }
      if (bad) { toast(bad + "件は戻せませんでした", "err"); return false; }
      reload();
    });
  }
  // まとめて削除: 元に戻せない操作として対象名入りの確認を出す。削除前の中身は申込ごとに控えへ残る(既存の控え・元に戻す機能)
  function deleteMany(rs) {
    confirmSheet(rs.length + "件の申込を削除します", nameList(rs) + " を台帳から削除します。削除前の内容は申込ごとに控えに残り、画面下の「削除した申込を見る」から元に戻せます。", "削除する", async () => {
      let ok = 0, ng = 0, why = "";
      for (const r of rs) {
        let res = null;
        try { res = await api().post("/api/submissions/" + r.submission_id + "/delete", { reason: "運営がまとめて削除" }); } catch (_) {}
        if (res && !res.error) ok++; else { ng++; why = (res && res.error) || why; }
      }
      S.sel.clear();
      closeSheet(); closeDrawer(true);
      toast(ok + "件を削除しました。「削除した申込」から戻せます" + (ng ? "(" + ng + "件は削除できませんでした" + (why ? ": " + why : "") + ")" : ""), ng ? "err" : "ok");
      reload();
    }, true);
  }

  function renderList() {
    const d = S.data, box = S.listBox;
    box.textContent = "";
    const rows = visible();
    // 選択は、いま台帳にある申込だけ残す(削除・取り消しの後の取り残しを防ぐ)
    const alive = new Set(d.rows.map(r => r.submission_id));
    [...S.sel].forEach(id => { if (!alive.has(id)) S.sel.delete(id); });
    const pick = (r) => h("label", { class: "ed-pick", title: "まとめて操作する申込を選ぶ", onclick: (e) => e.stopPropagation() },
      h("input", { type: "checkbox", checked: S.sel.has(r.submission_id) ? "" : null, "aria-label": (r.team_name || "(団体名なし)") + " を選ぶ",
        onchange: (e) => { if (e.target.checked) S.sel.add(r.submission_id); else S.sel.delete(r.submission_id); renderList(); } }));
    box.append(bulkBar(rows));
    const empty = d.rows.length
      ? h("div", { class: "ed-empty" }, h("p", { style: "margin:0 0 8px" }, "条件に合う申込は見つかりません。"),
        h("button", { class: "ed-btn", type: "button", onclick: () => { S.q = ""; S.only = "all"; S.ev = ""; renderDesk(); } }, "条件を消す"))
      : h("div", { class: "ed-empty" }, h("p", { style: "margin:0 0 8px" }, "まだ申込はありません。"),
        h("button", { class: "ed-btn", type: "button", onclick: copyUrl }, "申込URLをコピー"));
    // スマホの台帳
    box.append(h("div", { class: "ed-ledger" }, rows.map(r =>
      h("div", { class: "ed-rowwrap" + (S.sel.has(r.submission_id) ? " is-sel" : "") + (isCancelledRow(r) ? " is-cancelled-row" : "") }, pick(r),
        h("button", { class: "ed-row", type: "button", onclick: () => openSub(r.submission_id) },
          h("span", { class: "ed-row__team" }, r.team_name || "(団体名なし)", isCancelledRow(r) ? h("small", { class: "ed-cxl" }, "取り消し済み") : null),
          h("span", { class: "ed-row__sum ed-num" }, r.entries, h("small", {}, "出場")),
          h("span", { class: "ed-row__by" }, d.events.filter(e => count(r, e.name)).map((e, i) =>
            [i ? "・" : "", e.short + " ", h("b", { class: "ed-num" }, count(r, e.name))])),
          r.issues.length ? h("span", { class: "ed-row__tags" }, r.issues.map(tagOf)) : null))),
      rows.length ? null : empty));
    box.append(h("div", { class: "ed-totals ed-num" },
      d.events.map(e => h("div", {}, h("span", {}, e.short), h("b", {}, e.count))),
      h("div", {}, h("span", {}, "出場確定 計"), h("b", {}, d.totals.entries))));
    // PCの台帳
    const picked = d.rows.find(r => r.submission_id === S.picked);
    const tr = (r) => {
      const sel = () => openSub(r.submission_id);
      return h("tr", { tabindex: "0", "data-sid": r.submission_id, "aria-selected": picked === r ? "true" : "false", class: isCancelledRow(r) ? "is-cancelled-row" : "", onclick: sel,
        onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sel(); } } },
        h("td", {}, h("span", { class: "ed-tcell" }, pick(r), h("span", {}, r.team_name || "(団体名なし)", isCancelledRow(r) ? h("small", { class: "ed-cxl" }, "取り消し済み") : null))),
        d.events.map(e => { const c = count(r, e.name); return h("td", { class: "num" + (c ? "" : " zero") }, c || "−"); }),
        h("td", { class: "num sum" }, r.entries), h("td", {}, ROUTE[r.route] || ""), h("td", { class: "num" }, jpDate(r.received_at)),
        h("td", { class: "ed-issuecell" }, r.issues.length ? h("span", { class: "ed-tag " + (r.issues.some(i => i.type === "dup") ? "ed-tag--dup" : "ed-tag--warn"), title: r.issues.map(i => i.title).join(" / ") }, r.issues[0].title + (r.issues.length > 1 ? " ほか" + (r.issues.length - 1) + "件" : "")) : ""));
    };
    box.append(h("div", { class: "ed-wrap" },
      h("div", { class: "ed-table", tabindex: "0", "aria-label": "申込の台帳" },
        rows.length ? h("table", {},
          h("thead", {}, h("tr", {}, h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("name"), onclick: () => sortBy("name"), title: "押すと団体名で並べ替え" }, "団体名" + sortMark("name")),
            d.events.map(e => h("th", { scope: "col", class: "ed-ev ed-sortable" + gxClass(e.name), title: e.name + "(押すと、この種目の多い順に並べ替え)", "aria-label": e.name, "aria-sort": sortAria("ev:" + e.name), onclick: () => sortBy("ev:" + e.name) }, e.name + sortMark("ev:" + e.name))),
            h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("entries"), onclick: () => sortBy("entries") }, "出場確定数" + sortMark("entries")), h("th", { scope: "col" }, "受付方法"), h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("received"), onclick: () => sortBy("received") }, "受付日" + sortMark("received")), h("th", { scope: "col", class: "ed-sortable", "aria-sort": sortAria("issues"), onclick: () => sortBy("issues") }, "要確認" + sortMark("issues")))),
          h("tbody", {}, rows.map(tr)),
          h("tfoot", {}, h("tr", {}, h("td", {}, "申込 " + d.totals.teams + "団体"),
            d.events.map(e => h("td", { class: "num" }, e.count)), h("td", { class: "num" }, d.totals.entries), h("td", {}), h("td", {}), h("td", {}))))
          : h("div", { style: "padding:0 12px" }, empty))));
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
      h("p", { class: "ed-sub" }, [r.contact_name ? "申込者 " + r.contact_name : "", jpDate(r.received_at) + " 受付", ROUTE[r.route] || ""].filter(Boolean).join("・")),
      (r.mail || []).map(m => h("p", { class: "ed-sub" },
        (m.recipient === "admin" ? "運営通知" : "申込者控え") + "：" +
        ({ pending: "送信待ち", sending: "送信中", sent: "メールサーバー受付済み", failed: "送信失敗", skipped: "送信対象外" }[m.state] || "未確認"))),
      r.issues.map(i => h("div", { class: "ed-issue" + (i.type === "dup" ? " ed-issue--dup" : "") },
        h("b", {}, i.title), h("br"), i.detail,
        i.type === "mail" ? h("div", {}, h("button", { class: "ed-btn", type: "button", onclick: (e) => resend(r, i, e.currentTarget) }, "このメールを再送")) : null)),
      eventGroups(r),
      h("div", { class: "ed-btns" },
        h("button", { class: "ed-btn ed-btn--main", type: "button", onclick: () => { closeSheet(); app().openSubmissionEdit(t, r.submission_id, reload); } }, "内容を直す"),
        live.length ? h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => cancelNow(r, live) }, "この申込を取り消す") : null,
        live.length ? h("button", { class: "ed-btn", type: "button",
          onclick: () => app().openAuthedHtmlWindow("/api/tournaments/" + t.id + "/receipt-print.html?team=" + encodeURIComponent(r.team_name || ""), "領収書_" + (r.team_name || "")) }, "この団体の領収書を印刷") : null),
      live.length
        ? h("div", { class: "ed-danger" }, h("p", { class: "ed-sub" }, "取り消しは出場を数から外すだけで、あとで元に戻せます。申込そのものを台帳から消す削除は、取り消した申込だけできます。"))
        : h("div", { class: "ed-danger" },
          h("p", { class: "ed-sub" }, "この申込は取り消し済みです。台帳から消すときは削除します（削除前の内容は控えに残り、あとで戻せます）。"),
          h("button", { class: "ed-btn ed-btn--danger", type: "button", onclick: () => deleteAsk(r) }, "この申込を削除")),
    ];
  }

  // 元に戻せない操作だけ、対象の名前を入れた確認を出す。戻せる操作(取り消し・保存)は確認なしで行い、画面下に「元に戻す」を数秒出す。
  function confirmSheet(title, text, okLabel, onOk, danger) {
    const go = h("button", { class: "ed-btn" + (danger ? " ed-btn--danger" : " ed-btn--main"), type: "button" }, okLabel);
    sheet(title, [
      h("p", { class: "ed-sub", style: "margin:8px 0 14px" }, text),
      h("div", { class: "ed-btns" }, go, h("button", { class: "ed-btn ed-btn--quiet", type: "button", onclick: () => closeSheet() }, "やめる")),
    ]);
    go.addEventListener("click", async () => { go.disabled = true; const ok = await onOk(); if (ok === false) go.disabled = false; });
  }
  // 画面下の「◯◯しました [元に戻す]」。数秒で消える
  let undoBox = null, undoTimer = null;
  function undoToast(msg, onUndo) {
    if (undoBox) { undoBox.remove(); clearTimeout(undoTimer); }
    const b = h("button", { class: "ed-btn ed-btn--quiet", type: "button" }, "元に戻す");
    undoBox = h("div", { class: "ed-undo", role: "status" }, h("span", {}, msg), b);
    doc.body.append(undoBox);
    const close = () => { if (undoBox) { undoBox.remove(); undoBox = null; } clearTimeout(undoTimer); };
    b.addEventListener("click", async () => { b.disabled = true; const ok = await onUndo(); close(); if (ok !== false) toast("元に戻しました", "ok"); });
    undoTimer = root.setTimeout(close, 9000);
  }

  async function resend(r, i, btn) {
    confirmSheet("メールを再送します", (r.team_name || "(団体名なし)") + " の" + (i.recipient === "admin" ? "運営通知" : "申込者控え") + "メールを、もう一度送ります。送ったメールは取り消せません。", "再送する", async () => {
      btn.disabled = true;
      const url = "/api/submissions/" + r.submission_id + "/mail-resend";
      let res = null;
      try { res = await api().post(url, { recipient: i.recipient }); } catch (_) {}
      if (!res || res.error) { btn.disabled = false; toast((res && res.error) || "送れませんでした", "err"); return false; }
      toast("メールの再送を予約しました", "ok");
      closeSheet();
      reload();
    });
  }

  // 取り消し: 戻せる操作なので確認は出さず、すぐ取り消して「元に戻す」を出す。全出場を1つの変更として取り消す
  async function cancelNow(r, live) {
    const name = r.team_name || "(団体名なし)";
    const ids = live.map(p => p.entrant_id);
    let res = null;
    try { res = await api().put("/api/submissions/" + r.submission_id, { entries: ids.map(id => ({ entrant_id: id, cancel: true })), reason: "運営が取り消し" }); } catch (_) {}
    if (!res || res.error) return toast((res && res.error) || "取り消せませんでした", "err");
    closeDrawer(true);
    await reload();
    undoToast(name + " の申込を取り消しました", async () => {
      let r2 = null;
      try { r2 = await api().put("/api/submissions/" + r.submission_id, { entries: ids.map(id => ({ entrant_id: id, restore: true })), reason: "取り消しを元に戻した" }); } catch (_) {}
      if (!r2 || r2.error) { toast((r2 && r2.error) || "戻せませんでした", "err"); return false; }
      reload();
    });
  }

  // 削除: 元に戻せない操作として、対象名入りの確認を出す(削除前の中身は控えに残り「削除した申込」から戻せる)
  function deleteAsk(r) {
    const name = r.team_name || "(団体名なし)";
    confirmSheet(name + " の申込を削除します", "出場 " + r.players.length + " 件を台帳から削除します。削除前の内容は控えに残り、「削除した申込」から元に戻せます。", "削除する", async () => {
      let res = null;
      try { res = await api().post("/api/submissions/" + r.submission_id + "/delete", { reason: "運営が削除" }); } catch (_) {}
      if (!res || res.error) { toast((res && res.error) || "削除できませんでした", "err"); return false; }
      toast("削除しました。「削除した申込」から戻せます", "ok");
      closeSheet(); closeDrawer(true);
      reload();
    }, true);
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
    if (isFull()) {
      // 大会運営モード(ベータ版): 大会のページだけここで持つ。進行・選手DB・監督は既存の画面へ進む
      if ((type === "t" || type === "desk" || type === "tournament") && id) { showFullTournament(decodeURIComponent(id)); return true; }
      if (type === "more") { showMore(); return true; }
      hide(type);
      return false;
    }
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

  root.EntryDesk = { route, hide, refresh: () => (S.view === "desk" ? reload() : S.view === "list" ? showList() : S.view === "tour" ? showFullTournament(S.tid) : null), shortEventName };
})(typeof window !== "undefined" ? window : globalThis);
