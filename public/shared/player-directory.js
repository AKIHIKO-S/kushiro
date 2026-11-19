"use strict";

(() => {
  // 架空の表示見本。管理用選手API・本番DBには接続しない。
  const players = [
    { id: "sample-a", name: "例田 陽菜", kana: "れいだ はるな", club: "北浜卓球クラブ", records: [
      [2026, "くしろ卓球交流大会", "女子シングルス", "準優勝", "決勝", "1–3"],
      [2026, "釧路秋季卓球大会", "女子シングルス", "ベスト4", "準決勝", "2–3"],
      [2025, "釧路秋季卓球大会", "女子シングルス", "ベスト8", "準々決勝", "1–3"],
    ] },
    { id: "sample-b", name: "例野 涼", kana: "れいの りょう", club: "東町卓球クラブ", records: [
      [2026, "くしろ卓球交流大会", "男子シングルス", "優勝", "決勝", "3–1"],
    ] },
    { id: "sample-c", name: "見本 葵", kana: "みほん あおい", club: "北浜卓球クラブ", records: [
      [2026, "釧路秋季卓球大会", "女子シングルス", "ベスト8", "準々決勝", "2–3"],
    ] },
    { id: "sample-d", name: "参考 悠", kana: "さんこう ゆう", club: "東町卓球クラブ", records: [
      [2025, "釧路秋季卓球大会", "男子シングルス", "準優勝", "決勝", "0–3"],
    ] },
  ];
  players.sort((a, b) => a.kana.localeCompare(b.kana, "ja"));
  const clubs = [...new Set(players.map(p => p.club))];
  const events = [...new Set(players.flatMap(p => p.records.map(row => row[1])))];
  const filters = { name: "", club: "", event: "" };
  const content = document.getElementById("content");
  const title = document.getElementById("page-title");
  const meta = document.getElementById("player-meta");
  const normalize = value => value.normalize("NFKC").replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).replace(/\s/g, "");

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  }

  function field(label, id, values) {
    const control = values ? el("select", { id }, el("option", { value: "" }, "すべて"),
      ...values.map(value => el("option", { value }, value))) : el("input", { id, type: "search" });
    return el("div", values ? { class: "select" } : {}, el("label", { for: id }, label), control);
  }

  function directory() {
    const form = el("div", { class: "filters" }, field("氏名・ふりがな", "name"), field("クラブ", "club", clubs), field("大会", "event", events));
    const status = el("p", { role: "status" });
    const reset = el("button", { type: "button" }, "条件をクリア");
    const results = el("div");
    content.replaceChildren(el("h2", {}, "選手を探す"), form, el("div", { class: "filter-tools" }, status, reset), results);
    const controls = [...form.querySelectorAll("input, select")];
    controls.forEach(control => { control.value = filters[control.id]; });
    const update = () => {
      controls.forEach(control => { filters[control.id] = control.value; });
      const name = normalize(filters.name);
      const rows = players.filter(p => [p.name, p.kana].some(value => normalize(value).includes(name)) &&
        (!filters.club || filters.club === p.club) && (!filters.event || p.records.some(row => row[1] === filters.event)));
      status.textContent = rows.length + "名";
      reset.disabled = !Object.values(filters).some(Boolean);
      results.replaceChildren(rows.length ? el("ul", { class: "grid" }, ...rows.map(p =>
        el("li", {}, el("a", { class: "player-card", href: "#profile/" + p.id },
          el("span", {}, el("strong", {}, p.name), el("small", {}, p.kana), el("span", { class: "club-name" }, p.club)),
          el("span", { "aria-hidden": "true" }, "›"))))) : el("p", {}, "該当する選手が見つかりませんでした。"));
    };
    controls.forEach(control => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", update));
    reset.addEventListener("click", () => {
      controls.forEach(control => { control.value = ""; });
      controls[0].focus();
      update();
    });
    update();
  }

  function recordList(rows, detail) {
    return el("ul", { class: "records" }, ...rows.map(([year, event, category, place, round, score]) =>
      el("li", {}, el("span", {}, el("strong", {}, event),
        detail ? el("small", {}, category + " ・ " + round, " ・ ", el("span", { class: "game-score" }, "ゲームスコア " + score))
          : el("small", {}, year + "年度 ・ " + category)),
      el("strong", { class: "place" }, place))));
  }

  function profile(player, showRecords) {
    const summary = el("a", { href: "#profile/" + player.id }, "プロフィール");
    const records = el("a", { href: "#records/" + player.id }, "戦績");
    (showRecords ? records : summary).setAttribute("aria-current", "page");
    const nav = el("nav", { class: "profile-nav", "aria-label": "選手情報" }, summary, records);
    if (!showRecords) {
      content.replaceChildren(nav, el("h2", {}, "主な戦績"), recordList(player.records.slice(0, 2), false),
        el("a", { class: "all-records", href: "#records/" + player.id }, "年度別の戦績を見る ›"));
      return;
    }
    const years = [...new Set(player.records.map(row => row[0]))].sort((a, b) => b - a);
    const results = el("div", { "aria-live": "polite" });
    const buttons = years.map(year => el("button", { type: "button" }, year + "年度"));
    const showYear = index => {
      buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
      results.replaceChildren(recordList(player.records.filter(row => row[0] === years[index]), true));
    };
    buttons.forEach((b, index) => b.addEventListener("click", () => showYear(index)));
    content.replaceChildren(nav, el("h2", {}, "年度別戦績"),
      el("div", { class: "years", role: "group", "aria-label": "戦績の年度" }, ...buttons), results);
    showYear(0);
  }

  function render(focus = false) {
    const [mode, id] = location.hash.slice(1).split("/");
    const player = ["profile", "records"].includes(mode) && players.find(p => p.id === id);
    document.getElementById("kicker").textContent = player ? "PLAYER PROFILE" : "PLAYERS";
    title.textContent = player ? player.name : "選手名鑑";
    document.title = title.textContent + " | 釧路卓球協会";
    document.getElementById("back").hidden = !player;
    meta.hidden = !player;
    if (player) {
      meta.replaceChildren(el("small", {}, player.kana), player.club);
      profile(player, mode === "records");
    } else directory();
    if (focus) { window.scrollTo(0, 0); title.focus({ preventScroll: true }); }
  }

  window.addEventListener("hashchange", () => render(true));
  render();
})();
