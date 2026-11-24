// 選手DBの一般公開(/players)用の読み取りAPIの中身。2026-11-24 オーナー決定。
//
// 公開してよいもの(これだけを返す。画面で隠すのではなく、ここで作る項目を限定する):
//   氏名・所属(学校名)・支部・区分・年度別の大会成績・勝敗履歴(相手の氏名と所属・回戦・点数・棄権/不戦勝)
// 返さないもの: ふりがな・生年月日・連絡先・メール・内部ID(選手ID・試合ID・大会ID)・Elo・メモ・性別・選手番号
// 統合済みの選手は出さない。
//
// 選手を指す識別子は pid: 内部IDをHMACで変換した不透明な値(元のIDに戻せない・サーバーの秘密鍵が要る)。
// 一覧は固定のページ分け(1ページ PAGE_SIZE 人)で、1回の要求で全員を返さない。

const crypto = require("crypto");

const PAGE_SIZE = 50;
const SCHOOL_PAGE_SIZE = 100;
const CAT_LABEL = { elementary: "小学生", middle: "中学生", high: "高校生", university: "大学生", general: "一般", individual: "個人",
  senior: "シニア", junior: "ジュニア", youth: "ユース", large: "ラージ", student: "中高生" };
const CAT_KEYS = Object.keys(CAT_LABEL);

// 返してよい項目(テストがこの一覧と実際の応答を突き合わせる)
const LIST_TOP_KEYS = ["page", "pages", "per_page", "total", "sort", "branches", "items"];
const LIST_KEYS = ["pid", "name", "team", "branch", "category", "category_label"];
const DETAIL_KEYS = ["pid", "name", "team", "branch", "category", "category_label", "wins", "losses", "years", "tournaments", "same_school"];
const ROW_KEYS = ["round", "result", "opp_name", "opp_team", "opp_pid", "score", "sets"];

// 「個人」「○○個人」は、どこにも所属していない人を指す表記。クラブとしては扱わず、所属は「所属なし(個人)」と出す
const INDIVIDUAL_LABEL = "所属なし(個人)";
const isIndividualTeam = (t) => /個人$/.test(String(t || "").normalize("NFKC").replace(/[\s　]+/g, ""));

function create(db) {
  let secret = null;
  function getSecret() {
    if (secret) return secret;
    let s = process.env.PUBLIC_ID_SECRET || db.kvGet("public_id_secret");
    if (!s) { s = crypto.randomBytes(32).toString("hex"); db.kvSet("public_id_secret", s); }
    secret = s;
    return s;
  }
  const pidOf = (id) => crypto.createHmac("sha256", getSecret()).update(String(id)).digest("hex").slice(0, 20);

  // 全選手(統合済みを除く)の公開用の下ごしらえ。60秒だけ持つ
  let cache = null, cacheAt = 0;
  function all() {
    const now = Date.now();
    if (cache && now - cacheAt < 60000) return cache;
    const rows = db.getPlayers({}).filter(p => String(p.name || "").trim());
    const byPid = new Map(), byId = new Map();
    const list = rows.map(p => {
      const o = { id: p.id, pid: pidOf(p.id), name: String(p.name).trim(), team: String(p.team || "").trim(), branch: String(p.branch || "").trim(),
        category: CAT_KEYS.includes(p.category) ? p.category : "general", kana: String(p.furigana || "").trim() };
      byPid.set(o.pid, o); byId.set(o.id, o);
      return o;
    });
    cache = { list, byPid, byId }; cacheAt = now;
    return cache;
  }
  const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");
  const pub = (o) => ({ pid: o.pid, name: o.name, team: isIndividualTeam(o.team) ? INDIVIDUAL_LABEL : o.team, branch: o.branch, category: o.category, category_label: CAT_LABEL[o.category] || "一般" });
  const intIn = (v, min, max, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

  // 学校・クラブの区分(所属名から)。中学校/高校/小学校/クラブ・一般
  function groupOfTeam(team, category) {
    const c = db.detectSchoolCategory ? db.detectSchoolCategory(team, "") : null;
    if (c === "middle") return "middle";
    if (c === "high") return "high";
    if (c === "elementary") return "elementary";
    if (c === "university") return "university";
    return "club";
  }

  // 選手の一覧(ページ分け・固定の1ページ人数)。q・支部・区分・学校で絞れる。並びは school(学校順) または kana(50音順)
  function listPlayers(query) {
    const q = norm(query.q);
    const school = String(query.school || "").trim();
    const branch = String(query.branch || "").trim();
    const category = String(query.category || "").trim();
    let rows = all().list;
    if (q) rows = rows.filter(p => norm(p.name).includes(q) || norm(p.team).includes(q) || (p.kana && norm(p.kana).includes(q)));
    if (school) rows = rows.filter(p => p.team === school && !isIndividualTeam(p.team));
    if (branch) rows = rows.filter(p => p.branch === branch);
    if (category && CAT_KEYS.includes(category)) rows = rows.filter(p => p.category === category);
    const sort = query.sort === "kana" ? "kana" : "school";
    const kanaKey = (p) => p.kana || p.name;
    rows = rows.slice().sort(sort === "kana"
      ? (a, b) => kanaKey(a).localeCompare(kanaKey(b), "ja") || a.name.localeCompare(b.name, "ja") || a.pid.localeCompare(b.pid)
      : (a, b) => (a.team || "￿").localeCompare(b.team || "￿", "ja") || kanaKey(a).localeCompare(kanaKey(b), "ja") || a.pid.localeCompare(b.pid));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = intIn(query.page, 1, pages, 1);
    const bm = new Map(); all().list.forEach(p => { if (p.branch) bm.set(p.branch, (bm.get(p.branch) || 0) + 1); });
    const branches = [...bm.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).map(e => e[0]);
    return { page, pages, per_page: PAGE_SIZE, total, sort, branches, items: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(pub) };
  }

  // 学校・クラブの一覧(人数つき)。group で絞る。ページ分け
  function listSchools(query) {
    const group = ["middle", "high", "elementary", "university", "club"].includes(query.group) ? query.group : "";
    const q = norm(query.q);
    const m = new Map();
    all().list.forEach(p => {
      if (!p.team || isIndividualTeam(p.team)) return;   // 個人(所属なし)はクラブとして出さない
      const g = groupOfTeam(p.team, p.category);
      if (group && g !== group) return;
      if (q && !norm(p.team).includes(q)) return;
      const e = m.get(p.team) || { team: p.team, group: g, count: 0, branches: new Map() };
      e.count++;
      if (p.branch) e.branches.set(p.branch, (e.branches.get(p.branch) || 0) + 1);
      m.set(p.team, e);
    });
    const rows = [...m.values()].map(e => {
      let br = "", bc = 0; e.branches.forEach((c, b) => { if (c > bc) { br = b; bc = c; } });
      return { team: e.team, group: e.group, count: e.count, branch: br };
    }).sort((a, b) => a.team.localeCompare(b.team, "ja"));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / SCHOOL_PAGE_SIZE));
    const page = intIn(query.page, 1, pages, 1);
    return { page, pages, per_page: SCHOOL_PAGE_SIZE, total, items: rows.slice((page - 1) * SCHOOL_PAGE_SIZE, page * SCHOOL_PAGE_SIZE) };
  }

  const fiscalYear = (date) => {
    const m = String(date || "").match(/^(\d{4})[-/.](\d{1,2})/);
    if (!m) return 0;
    const y = +m[1], mo = +m[2];
    return mo >= 4 ? y : y - 1;
  };
  const sameYearLabel = (y) => (y ? y + "年度" : "年度不明");

  function rowOf(m, selfId, byId) {
    const won = m.winner_id === selfId;
    const wo = !!m.is_walkover;
    const oppId = won ? m.loser_id : m.winner_id;
    const opp = oppId ? byId.get(oppId) : null;
    const hasScore = !wo && ((m.winner_sets || 0) + (m.loser_sets || 0) > 0);
    const sets = hasScore && Array.isArray(m.sets)
      ? m.sets.filter(s => Array.isArray(s) && s.length === 2).map(s => (won ? s[0] + "-" + s[1] : s[1] + "-" + s[0])) : [];
    return {
      round: String(m.round || ""),
      result: wo ? (won ? "walkover_win" : "withdrew") : (won ? "win" : "loss"),
      opp_name: String((won ? m.loser_name : m.winner_name) || "").trim(),
      opp_team: String(m.opp_team || "").trim() || "所属不明",
      opp_pid: opp ? opp.pid : null,
      score: hasScore ? (won ? (m.winner_sets || 0) + "-" + (m.loser_sets || 0) : (m.loser_sets || 0) + "-" + (m.winner_sets || 0)) : null,
      sets,
    };
  }

  // 選手1人のページ。pid が無い・統合済みなら null
  function playerPage(pid) {
    const { byPid, byId, list } = all();
    const me = byPid.get(String(pid || ""));
    if (!me) return null;
    const full = db.getPlayer(me.id);
    if (!full || full.merged_into) return null;
    const matches = (full.matches || []).concat(full.walkovers || []);
    // 大会ごと(同じ大会・同じ種目)にまとめる。大会の並びは日付の新しい順、中は回戦順
    const groups = new Map();
    matches.forEach(m => {
      const key = m.tournament_id + "|" + (m.event || "");
      if (!groups.has(key)) groups.set(key, { label: String(m.tournament_label || m.tournament_name || "大会"), event: String(m.event || ""), date: String(m.tournament_date || ""), tid: m.tournament_id, ms: [] });
      groups.get(key).ms.push(m);
    });
    const gl = [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || a.label.localeCompare(b.label, "ja"));
    // 回戦の若い順(1回戦→決勝)。round_order は決勝が小さい数なので大きい方から並べる
    gl.forEach(g => g.ms.sort((a, b) => (b.round_order || 0) - (a.round_order || 0) || (a.match_no || 0) - (b.match_no || 0)));
    const years = new Map();   // 年度 → { tournaments:Set, wins, losses }
    matches.forEach(m => {
      const y = fiscalYear(m.tournament_date);
      const e = years.get(y) || { tids: new Set(), wins: 0, losses: 0 };
      e.tids.add(m.tournament_id);
      if (!m.is_walkover) { if (m.winner_id === me.id) e.wins++; else if (m.loser_id === me.id) e.losses++; }
      years.set(y, e);
    });
    const yl = [...years.entries()].sort((a, b) => b[0] - a[0]).map(([y, e]) => ({ year: sameYearLabel(y), tournaments: e.tids.size, wins: e.wins, losses: e.losses }));
    const wins = yl.reduce((s, y) => s + y.wins, 0), losses = yl.reduce((s, y) => s + y.losses, 0);
    const mates = me.team && !isIndividualTeam(me.team) ? list.filter(p => p.team === me.team && p.pid !== me.pid).sort((a, b) => (a.kana || a.name).localeCompare(b.kana || b.name, "ja")).slice(0, 12).map(p => ({ pid: p.pid, name: p.name })) : [];
    const out = Object.assign(pub(me), {
      wins, losses, years: yl,
      tournaments: gl.map(g => ({ label: g.label, event: g.event, rows: g.ms.map(m => rowOf(m, me.id, byId)) })),
      same_school: mates,
    });
    return out;
  }

  // 大会の一覧(年度つき)。結果のある大会だけ。公開してよい大会かの判定は呼び出し側(isPublic)
  function listTournaments(isPublic) {
    const rows = db.getTournaments().filter(t => isPublic(t));
    const out = [];
    rows.forEach(t => {
      const label = db.tournamentLabel(t.name, t.date);
      out.push({ label, year: sameYearLabel(fiscalYear(t.date)), date: String(t.date || ""), _y: fiscalYear(t.date) });
    });
    out.sort((a, b) => b.date.localeCompare(a.date));
    return { items: out.slice(0, 200).map(o => ({ label: o.label, year: o.year, date: o.date })) };
  }

  function _reset() { cache = null; secret = null; }
  return { listPlayers, listSchools, playerPage, listTournaments, pidOf, _reset };
}

module.exports = { create, INDIVIDUAL_LABEL, isIndividualTeam, PAGE_SIZE, SCHOOL_PAGE_SIZE, LIST_TOP_KEYS, LIST_KEYS, DETAIL_KEYS, ROW_KEYS };
