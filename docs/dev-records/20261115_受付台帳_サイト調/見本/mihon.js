// 見本専用の架空データと小道具。氏名・団体はすべて架空で、実在の人物とは関係ない。
(function () {
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.entries(attrs || {}).forEach(function (kv) {
      var k = kv[0], v = kv[1];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    [].slice.call(arguments, 2).flat(Infinity).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
    });
    return el;
  }

  var EVENTS = [
    { key: "一般男子シングルス", short: "一般男", cap: 48, last: 41 },
    { key: "一般女子シングルス", short: "一般女", cap: 32, last: 24 },
    { key: "中学男子シングルス", short: "中学男", cap: 48, last: 39 },
    { key: "中学女子シングルス", short: "中学女", cap: 32, last: 22 },
    { key: "男子ダブルス", short: "男D", cap: 24, last: 14 },
    { key: "女子ダブルス", short: "女D", cap: 24, last: 9 },
    { key: "団体戦", short: "団体", cap: 12, last: 7 },
  ];
  var FAM = "架空 試験 見本 仮名 空想 例示 模擬 検証 標本 想定".split(" ");
  var FK = ["かくう", "しけん", "みほん", "かりな", "くうそう", "れいじ", "もぎ", "けんしょう", "ひょうほん", "そうてい"];
  var GIV = "太郎 花子 次郎 美咲 健太 陽菜 拓海 結衣 大輝 葵 蓮 凛".split(" ");
  var GK = "たろう はなこ じろう みさき けんた ひな たくみ ゆい だいき あおい れん りん".split(" ");
  var TEAMS = ["第一試験クラブ", "見本中学校", "架空スポーツ少年団", "検証卓球会", "模擬中学校", "例示クラブ", "標本高校OB会", "想定卓友会", "空想ジュニア", "仮名クラブ", "第二試験クラブ", "見本南中学校"];

  // 同じ見本が毎回同じ数字になるよう、乱数は使わず添字から作る
  var n = 0;
  function person() {
    var f = n % 10, g = (n * 7 + (n % 3)) % 12;
    n++;
    return { name: FAM[f] + " " + GIV[g], kana: FK[f] + " " + GK[g] };
  }
  var SUBS = [];
  for (var i = 0; i < 28; i++) {
    var team = TEAMS[i % TEAMS.length], entries = [];
    var count = 1 + (i * 3) % 4;
    for (var j = 0; j < count; j++) {
      var ev = EVENTS[(i * 2 + j) % 4], p = person();
      entries.push({ ev: ev.key, label: p.name, kana: p.kana });
    }
    if (i % 3 === 0) { var a = person(), b = person(); entries.push({ ev: "男子ダブルス", label: a.name + "・" + b.name, kana: a.kana + "・" + b.kana }); }
    if (i % 5 === 1) { var c = person(), d = person(); entries.push({ ev: "女子ダブルス", label: c.name + "・" + d.name, kana: c.kana + "・" + d.kana }); }
    if (i % 7 === 0) entries.push({ ev: "団体戦", label: team + "A（4名）", kana: "" });
    SUBS.push({
      id: "s" + i, team: (i >= 24 ? "西" : i >= 12 ? "東" : "") + team,
      contact: "連絡 担当" + (i + 1),
      route: i % 11 === 4 ? "Excel" : i % 19 === 7 ? "手入力" : "Web",
      at: "11月" + (2 + (i % 9)) + "日",
      entries: entries, issues: [],
    });
  }
  // 確認が要る例
  var dupName = SUBS[0].entries[0].label;
  SUBS[9].entries.unshift({ ev: SUBS[0].entries[0].ev, label: dupName, kana: SUBS[0].entries[0].kana });
  SUBS[0].issues.push({ id: "i1", type: "dup", title: "別の団体と重複の疑い", detail: dupName + " さんが " + SUBS[9].team + " からも同じ種目に申し込んでいます" });
  SUBS[9].issues.push({ id: "i2", type: "dup", title: "別の団体と重複の疑い", detail: dupName + " さんが " + SUBS[0].team + " からも同じ種目に申し込んでいます" });
  SUBS[3].issues.push({ id: "i3", type: "name", title: "所属の表記が揺れています", detail: "「検証卓球会」と「検証卓球クラブ」が同じ団体かもしれません" });
  SUBS[6].issues.push({ id: "i4", type: "kana", title: "ふりがなが空欄です", detail: SUBS[6].entries[0].label + " さんのふりがなが入っていません" });
  SUBS[13].issues.push({ id: "i5", type: "class", title: "区分と年齢が合いません", detail: SUBS[13].entries[0].label + " さんは生年月日から見ると一般の区分です" });
  SUBS[17].issues.push({ id: "i6", type: "sheet", title: "シートに届いていません", detail: "本部には保存済みです。もう一度シートへ送れます" });
  SUBS[21].issues.push({ id: "i7", type: "sheet", title: "シートに届いていません", detail: "本部には保存済みです。もう一度シートへ送れます" });

  var T = { name: "架空市民卓球大会", date: "12月6日（日）", venue: "架空市総合体育館", deadline: "11月20日（金）", left: 10 };
  function evCount(key) { return SUBS.reduce(function (s, x) { return s + x.entries.filter(function (e) { return e.ev === key; }).length; }, 0); }
  function entriesTotal() { return SUBS.reduce(function (s, x) { return s + x.entries.length; }, 0); }
  function routeCount(r) { return SUBS.filter(function (s) { return s.route === r; }).length; }
  function issues() { return SUBS.reduce(function (a, s) { return a.concat(s.issues.map(function (i) { return Object.assign({ sub: s }, i); })); }, []); }

  function toast(msg) {
    var t = h("div", { class: "toast", role: "status" }, msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  function sheet(title, body) {
    var bg = h("div", { class: "sheet-bg", onclick: close });
    var box = h("section", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("button", { class: "sheet__x", type: "button", onclick: close }, "閉じる"),
      h("h2", {}, title), body);
    function close() { bg.remove(); box.remove(); document.removeEventListener("keydown", esc); }
    function esc(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", esc);
    document.body.appendChild(bg); document.body.appendChild(box);
    box.querySelector("button").focus();
    return close;
  }
  // 申込1件の中身（3案共通の部品）
  function subDetail(s) {
    return [
      h("p", { style: "margin:4px 0 0;font-size:15px;color:var(--sub)" }, s.contact + "・" + s.at + " 受付・" + s.route),
      s.issues.map(function (i) { return h("p", { style: "margin:10px 0 0;padding:9px 11px;background:var(--amber-bg);color:var(--amber);font-size:15px;border-radius:3px" }, h("b", {}, i.title), h("br"), i.detail); }),
      h("ul", { class: "plist" }, s.entries.map(function (e) { return h("li", {}, h("b", {}, e.label), h("small", {}, e.ev + (e.kana ? "・" + e.kana : ""))); })),
      h("div", { class: "btns" }, h("button", { class: "btn btn--main", type: "button", onclick: function () { toast("修正画面へ進みます（見本）"); } }, "内容を直す"), h("button", { class: "btn btn--quiet", type: "button", onclick: function () { toast("確認の上で取り消します（見本）"); } }, "この申込を取り消す")),
    ];
  }
  // 大会の一覧（3案共通）。締切が近い順に並べ、終わった大会は下へ送る
  function listView() {
    var rows = [
      { name: T.name, meta: [T.date + "・締切 ", h("b", {}, "あと" + T.left + "日")], team: SUBS.length, entries: entriesTotal(), warn: issues().length },
      { name: "架空冬季オープン", meta: ["1月17日（日）・締切 あと45日"], team: 12, entries: 31, warn: 0 },
      { name: "架空新春大会", meta: ["2月7日（日）・受付はまだ始めていません"], team: 0, entries: 0, warn: 0 },
      { name: "架空秋季リーグ", meta: ["10月18日（日）・受付を終えました"], team: 26, entries: 74, warn: 0 },
    ];
    return h("div", {},
      h("div", { class: "head" }, h("h1", {}, "受付する大会を選ぶ"), h("div", {}, h("button", { class: "btn btn--main", type: "button", onclick: function () { toast("新しい大会の作成へ（見本）"); } }, "大会をつくる"))),
      h("div", { class: "tl" }, rows.map(function (r) {
        return h("a", { class: "tl__row", href: "#desk" },
          h("span", { class: "tl__name" }, r.name, r.warn ? " " : "", r.warn ? h("span", { class: "tag tag--warn" }, "確認 " + r.warn) : null),
          h("span", { class: "tl__meta" }, r.meta),
          h("span", { class: "tl__count num" }, h("b", {}, r.entries), "出場・" + r.team + "団体"));
      })));
  }
  // 見本ページの共通の枠
  function frame(renderDesk) {
    var root = document.getElementById("app");
    function draw() {
      var isList = location.hash === "#list";
      root.textContent = "";
      root.appendChild(h("header", { class: "top" },
        h("a", { class: "top__brand", href: "#list" },
          h("img", { class: "top__logo", src: "ktta-logo-256.png", alt: "" }),
          h("span", { class: "top__org" }, "釧路卓球協会", h("small", { lang: "en" }, "KUSHIRO TABLE TENNIS ASSOCIATION"))),
        h("span", { class: "top__sub" }, "申込の受付"),
        h("nav", { class: "top__nav", "aria-label": "主な画面" },
          h("a", { href: "#list", "aria-current": isList ? "page" : null }, "大会"),
          h("a", { href: "#desk", "aria-current": isList ? null : "page" }, "受付"),
          h("a", { href: "#", onclick: function (e) { e.preventDefault(); toast("選手の名寄せと設定へ（見本）"); } }, "その他"))));
      root.appendChild(h("main", {}, isList ? listView() : renderDesk()));
    }
    addEventListener("hashchange", draw);
    draw();
  }
  function head() {
    return h("div", { class: "head" },
      h("div", {},
        h("h1", {}, T.name, h("span", { class: "state" }, "受付中")),
        h("div", { class: "head__meta" }, T.date + "・" + T.venue + "・締切 " + T.deadline, " ", h("b", {}, "あと" + T.left + "日"))),
      h("div", { class: "btns" },
        h("button", { class: "btn", type: "button", onclick: function () { toast("申込ページのURLをコピーしました（見本）"); } }, "申込URLをコピー"),
        h("button", { class: "btn", type: "button", onclick: function () { toast("フォーム設定へ（見本）"); } }, "フォーム設定")));
  }
  function routes() {
    return h("div", { class: "routes" }, "届いた経路",
      h("span", {}, "Web ", h("b", { class: "num" }, routeCount("Web"))),
      h("span", {}, "Excel ", h("b", { class: "num" }, routeCount("Excel"))),
      h("span", {}, "手入力 ", h("b", { class: "num" }, routeCount("手入力"))));
  }
  function collect() {
    sheet("申込を追加する", [
      h("p", { style: "margin:8px 0 12px;font-size:15px;color:var(--sub)" }, "Webフォームの申込は自動で入ります。メールのExcelや紙・電話で届いた分をここから足すと、全部が同じ一覧に揃います。"),
      h("div", { style: "display:grid;gap:8px" },
        h("button", { class: "btn btn--main", type: "button", onclick: function () { toast("Excel申込書を読み込み、確認画面へ（見本）"); } }, "Excelの申込書を読み込む"),
        h("button", { class: "btn", type: "button", onclick: function () { toast("本部入力のフォームへ（見本）"); } }, "紙・電話の分を手で入力する")),
    ]);
  }
  window.M = { h: h, EVENTS: EVENTS, SUBS: SUBS, T: T, evCount: evCount, entriesTotal: entriesTotal, routeCount: routeCount, issues: issues, toast: toast, sheet: sheet, subDetail: subDetail, frame: frame, head: head, routes: routes, collect: collect };
})();
