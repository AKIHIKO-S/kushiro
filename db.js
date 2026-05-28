// ═══════════════════════════════════════════════════════
// 卓球大会DB - SQLite layer (標準形式 match records)
// ═══════════════════════════════════════════════════════
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "tournament.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const uid = () => crypto.randomUUID();

// ── スキーマ ────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    furigana TEXT DEFAULT '',
    team TEXT DEFAULT '',
    branch TEXT DEFAULT '',
    gender TEXT DEFAULT 'male',
    category TEXT DEFAULT 'general',
    note TEXT DEFAULT '',
    appearances INTEGER DEFAULT 0,
    rating INTEGER DEFAULT 1500,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    event TEXT NOT NULL,
    tournament TEXT DEFAULT '',
    place INTEGER NOT NULL,
    type TEXT DEFAULT 'シングルス',
    year INTEGER NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tournaments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    date TEXT DEFAULT '',
    venue TEXT DEFAULT '',
    court_count INTEGER DEFAULT 4,
    status TEXT DEFAULT 'scheduled',
    description TEXT DEFAULT '',
    state_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    event TEXT NOT NULL DEFAULT '',
    round TEXT NOT NULL DEFAULT '',
    round_order INTEGER DEFAULT 99,
    match_no INTEGER DEFAULT 0,
    winner_id TEXT,
    loser_id TEXT,
    winner_name TEXT DEFAULT '',
    loser_name TEXT DEFAULT '',
    winner_team TEXT DEFAULT '',
    loser_team TEXT DEFAULT '',
    sets_json TEXT DEFAULT '[]',
    winner_sets INTEGER DEFAULT 0,
    loser_sets INTEGER DEFAULT 0,
    played_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (winner_id) REFERENCES players(id) ON DELETE SET NULL,
    FOREIGN KEY (loser_id) REFERENCES players(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS tournament_players (
    tournament_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    event TEXT DEFAULT '',
    seed INTEGER DEFAULT 0,
    PRIMARY KEY (tournament_id, player_id, event),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  -- entrants: 大会参加選手 (マスタDB players とは完全に独立)
  -- entrant は大会・種目別の参加エントリ。player_id で任意にマスタにリンク可能。
  CREATE TABLE IF NOT EXISTS entrants (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    event TEXT NOT NULL DEFAULT '',
    seed INTEGER DEFAULT 0,
    is_doubles INTEGER DEFAULT 0,

    -- 計算済み表示 (UIで頻用)
    display_name TEXT NOT NULL DEFAULT '',
    display_short TEXT NOT NULL DEFAULT '',

    -- メンバー1
    name TEXT NOT NULL DEFAULT '',
    surname TEXT DEFAULT '',
    given_name TEXT DEFAULT '',
    furigana TEXT DEFAULT '',
    team TEXT DEFAULT '',

    -- メンバー2 (ダブルスのみ使用)
    partner_name TEXT DEFAULT '',
    partner_surname TEXT DEFAULT '',
    partner_given_name TEXT DEFAULT '',
    partner_furigana TEXT DEFAULT '',
    partner_team TEXT DEFAULT '',

    -- 属性
    category TEXT DEFAULT 'general',
    gender TEXT DEFAULT 'male',
    age_group TEXT DEFAULT '',
    region TEXT DEFAULT '',

    -- 任意リンク: マスタDB players へ
    player_id TEXT,
    partner_player_id TEXT,

    status TEXT DEFAULT 'confirmed',
    note TEXT DEFAULT '',

    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),

    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
    FOREIGN KEY (partner_player_id) REFERENCES players(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entrants_tournament ON entrants(tournament_id);
  CREATE INDEX IF NOT EXISTS idx_entrants_event ON entrants(tournament_id, event);
  CREATE INDEX IF NOT EXISTS idx_entrants_name ON entrants(name);
  CREATE INDEX IF NOT EXISTS idx_entrants_surname ON entrants(surname);
  CREATE INDEX IF NOT EXISTS idx_entrants_player ON entrants(player_id);

  CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
  CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
  CREATE INDEX IF NOT EXISTS idx_players_furigana ON players(furigana);
  CREATE INDEX IF NOT EXISTS idx_achievements_player ON achievements(player_id);
  CREATE INDEX IF NOT EXISTS idx_matches_tournament ON matches(tournament_id);
  CREATE INDEX IF NOT EXISTS idx_matches_winner ON matches(winner_id);
  CREATE INDEX IF NOT EXISTS idx_matches_loser ON matches(loser_id);
  CREATE INDEX IF NOT EXISTS idx_tp_tournament ON tournament_players(tournament_id);
`);

// 既存DBにカラムがない場合は追加
try {
  const pcols = sqlite.prepare("PRAGMA table_info(players)").all();
  if (!pcols.find(c => c.name === "rating")) {
    sqlite.exec("ALTER TABLE players ADD COLUMN rating INTEGER DEFAULT 1500");
  }
  if (!pcols.find(c => c.name === "branch")) {
    sqlite.exec("ALTER TABLE players ADD COLUMN branch TEXT DEFAULT ''");
  }
  const tcols = sqlite.prepare("PRAGMA table_info(tournaments)").all();
  if (!tcols.find(c => c.name === "status")) {
    sqlite.exec("ALTER TABLE tournaments ADD COLUMN status TEXT DEFAULT 'scheduled'");
  }
  if (!tcols.find(c => c.name === "description")) {
    sqlite.exec("ALTER TABLE tournaments ADD COLUMN description TEXT DEFAULT ''");
  }
  // 進行管理用カラム (court layout)
  const addTCol = (col, def) => {
    if (!tcols.find(c => c.name === col)) {
      sqlite.exec(`ALTER TABLE tournaments ADD COLUMN ${col} ${def}`);
    }
  };
  addTCol("court_rows", "INTEGER DEFAULT 4");
  addTCol("court_cols", "INTEGER DEFAULT 11");
  addTCol("hq_position", "TEXT DEFAULT 'bottom'");
  addTCol("min_rest_matches", "INTEGER DEFAULT 1");
  addTCol("enforce_referee_rule", "INTEGER DEFAULT 1"); // 1=敗者審判ルール適用、0=任意
  // 台番号の振り方: 'bottom-right' = 本部右下から1番、左へ進み2段目折返し (卓球協会 標準)
  addTCol("numbering_origin", "TEXT DEFAULT 'bottom-right'");
  // テンプレート由来の大会識別子 (任意)
  addTCol("template_id", "TEXT DEFAULT ''");
  // 申込管理用カラム
  addTCol("entries_open", "INTEGER DEFAULT 0");
  addTCol("entry_deadline", "TEXT DEFAULT ''");
  addTCol("entry_events", "TEXT DEFAULT ''"); // JSON配列: ["男子シングルス","女子シングルス",...]
  addTCol("event_config", "TEXT DEFAULT ''"); // JSON配列: 詳細 [{name, fee, type, per_team, note}]
  addTCol("entry_gas_url", "TEXT DEFAULT ''"); // GAS Web App URL (申込先 スプレッドシート)
  addTCol("category", "TEXT DEFAULT 'general'"); // 公式戦/オープン/練習試合 等
  addTCol("organizer", "TEXT DEFAULT ''");
  // 大会レベル: 'district'(地区) | 'hokkaido'(全道) | 'national'(全国) | 'other'
  addTCol("level", "TEXT DEFAULT 'district'");

  // tournament_players 申込ステータス
  const tpcols = sqlite.prepare("PRAGMA table_info(tournament_players)").all();
  const addTPCol = (col, def) => {
    if (!tpcols.find(c => c.name === col)) {
      sqlite.exec(`ALTER TABLE tournament_players ADD COLUMN ${col} ${def}`);
    }
  };
  addTPCol("status", "TEXT DEFAULT 'confirmed'"); // pending/confirmed/rejected
  addTPCol("applied_at", "TEXT DEFAULT ''");
  addTPCol("entry_note", "TEXT DEFAULT ''");

  // 進行管理用カラム (matches)
  const mcols = sqlite.prepare("PRAGMA table_info(matches)").all();
  const addMCol = (col, def) => {
    if (!mcols.find(c => c.name === col)) {
      sqlite.exec(`ALTER TABLE matches ADD COLUMN ${col} ${def}`);
    }
  };
  addMCol("status", "TEXT DEFAULT 'completed'"); // 'waiting'|'pending'|'on_table'|'completed'
  addMCol("table_no", "INTEGER DEFAULT 0");
  addMCol("referee_id", "TEXT");
  addMCol("referee_name", "TEXT DEFAULT ''");
  addMCol("player1_id", "TEXT");
  addMCol("player2_id", "TEXT");
  addMCol("player1_name", "TEXT DEFAULT ''");
  addMCol("player2_name", "TEXT DEFAULT ''");
  addMCol("player1_team", "TEXT DEFAULT ''");
  addMCol("player2_team", "TEXT DEFAULT ''");
  addMCol("next_match_id", "TEXT");
  addMCol("next_slot", "INTEGER DEFAULT 1");
  addMCol("called_at", "TEXT DEFAULT ''");
  addMCol("started_at", "TEXT DEFAULT ''");
  addMCol("finished_at", "TEXT DEFAULT ''");
  addMCol("bracket_pos", "INTEGER DEFAULT 0");
  addMCol("bracket_round", "INTEGER DEFAULT 0");
  addMCol("referee_required", "INTEGER DEFAULT 1"); // 0=審判不要としてマーク
  // entrant への参照 (大会参加選手と完全分離した運用に必要)
  addMCol("player1_entrant_id", "TEXT");
  addMCol("player2_entrant_id", "TEXT");
  addMCol("referee_entrant_id", "TEXT");
  // 団体戦の追加台 (2台同時使用): カンマ区切り "5,6" 等
  addMCol("extra_tables", "TEXT DEFAULT ''");
  // 再コール回数 (1=初回,2=再コール1回目=注意,3=再コール2回目=警告,4+ = 最終警告)
  addMCol("call_count", "INTEGER DEFAULT 0");  // 互換用 (累計)
  addMCol("call_count_p1", "INTEGER DEFAULT 0");  // 選手1の再コール回数
  addMCol("call_count_p2", "INTEGER DEFAULT 0");  // 選手2の再コール回数
  addMCol("match_label", "TEXT DEFAULT ''");  // "1-1", "2-1" 形式の試合番号 (R-N)
  // entrants にブロック情報・大会固有番号追加
  const ecols = sqlite.prepare("PRAGMA table_info(entrants)").all();
  if (ecols.length && !ecols.find(c => c.name === "block")) {
    sqlite.exec("ALTER TABLE entrants ADD COLUMN block TEXT DEFAULT ''");
  }
  if (ecols.length && !ecols.find(c => c.name === "bracket_number")) {
    sqlite.exec("ALTER TABLE entrants ADD COLUMN bracket_number INTEGER DEFAULT 0");
  }
  if (ecols.length && !ecols.find(c => c.name === "bracket_side")) {
    sqlite.exec("ALTER TABLE entrants ADD COLUMN bracket_side TEXT DEFAULT ''");
  }
} catch (e) { console.error("migration error:", e.message); }

// ── ふりがな辞書 ────────────────────────────────────────
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
  "上田":"うえだ","森田":"もりた","柴田":"しばた","酒井":"さかい","工藤":"くどう",
  "横山":"よこやま","宮崎":"みやざき","宮本":"みやもと","内田":"うちだ","高木":"たかぎ",
  "安藤":"あんどう","谷口":"たにぐち","大野":"おおの","丸山":"まるやま","今井":"いまい",
  "藤本":"ふじもと","武田":"たけだ","杉山":"すぎやま","増田":"ますだ","平野":"ひらの",
  "久保":"くぼ","松井":"まつい","千葉":"ちば","岩崎":"いわさき","桜井":"さくらい",
  "木下":"きのした","松尾":"まつお","野村":"のむら","新井":"あらい","渡部":"わたなべ",
  "佐野":"さの","杉本":"すぎもと","山下":"やました","永井":"ながい","北村":"きたむら",
  "本田":"ほんだ","飯田":"いいだ","秋山":"あきやま","市川":"いちかわ","小松":"こまつ",
  "黒田":"くろだ","水野":"みずの","菊池":"きくち","片山":"かたやま","大久保":"おおくぼ",
  "川崎":"かわさき","小池":"こいけ","五十嵐":"いがらし","青木":"あおき","福島":"ふくしま",
  "白石":"しらいし","浅野":"あさの","安田":"やすだ","広瀬":"ひろせ","石原":"いしはら",
  "小島":"こじま","上原":"うえはら","青山":"あおやま","大谷":"おおたに","高野":"たかの",
  "成田":"なりた","栗原":"くりはら","北川":"きたがわ"
};

// ═══════════════════════════════════════════════════════
// 名前正規化 (Japanese name handling)
// ═══════════════════════════════════════════════════════
// 全角空白・連続空白を半角単一空白に正規化
function normalizeName(s) {
  if (!s) return "";
  return String(s).trim().replace(/[\s　 ]+/g, " ");
}

// "山田 太郎" → { surname: "山田", given_name: "太郎", full: "山田 太郎" }
// "山田太郎" (空白なし) → { surname: "山田太郎", given_name: "", full: "山田太郎" }
// "山田" (苗字のみ・ダブルス由来) → { surname: "山田", given_name: "", full: "山田" }
function parsePersonName(s) {
  const n = normalizeName(s);
  if (!n) return { surname: "", given_name: "", full: "" };
  const parts = n.split(" ");
  if (parts.length === 1) return { surname: parts[0], given_name: "", full: parts[0] };
  return { surname: parts[0], given_name: parts.slice(1).join(" "), full: n };
}

// 苗字 + 名 → "山田 太郎" (空白1個。どちらか欠落時は片方のみ返す)
function joinPersonName(surname, given_name) {
  const s = (surname || "").trim();
  const g = (given_name || "").trim();
  if (s && g) return s + " " + g;
  return s || g;
}

// 入力データから entrant の名前関連フィールド一式を計算
// 受付ける入力例:
//   シングル: { name: "山田 太郎", team: "..." }
//   シングル(分離): { surname: "山田", given_name: "太郎", team: "..." }
//   ダブルス(フル): { name: "山田 太郎", partner_name: "鈴木 一郎" }
//   ダブルス(苗字のみ): { surname: "山田", partner_surname: "鈴木" }
function buildEntrantNames(data) {
  // メンバー1
  let p1;
  if (data.surname !== undefined || data.given_name !== undefined) {
    p1 = { surname: data.surname || "", given_name: data.given_name || "" };
    p1.full = joinPersonName(p1.surname, p1.given_name);
  } else {
    p1 = parsePersonName(data.name);
  }
  p1.furigana = data.furigana || "";

  // メンバー2
  let p2 = null;
  const hasP2 = data.partner_name || data.partner_surname || data.partner_given_name;
  if (hasP2) {
    if (data.partner_surname !== undefined || data.partner_given_name !== undefined) {
      p2 = { surname: data.partner_surname || "", given_name: data.partner_given_name || "" };
      p2.full = joinPersonName(p2.surname, p2.given_name);
    } else {
      p2 = parsePersonName(data.partner_name);
    }
    p2.furigana = data.partner_furigana || "";
  }

  const is_doubles = data.is_doubles !== undefined
    ? !!data.is_doubles
    : !!p2 || /ダブルス|団体/.test(data.event || "");

  // 表示用
  let display_name, display_short;
  if (is_doubles && p2) {
    display_name = (p1.full && p2.full) ? `${p1.full} / ${p2.full}` : (p1.full || p2.full);
    // 苗字のみのコンパクト表示。苗字なければ名前で代用
    const s1 = p1.surname || p1.full;
    const s2 = p2.surname || p2.full;
    display_short = (s1 && s2) ? `${s1}/${s2}` : (s1 || s2);
  } else {
    display_name = p1.full;
    display_short = p1.surname || p1.full;
  }

  return {
    is_doubles: is_doubles ? 1 : 0,
    name: p1.full,
    surname: p1.surname,
    given_name: p1.given_name,
    furigana: p1.furigana,
    partner_name: p2 ? p2.full : "",
    partner_surname: p2 ? p2.surname : "",
    partner_given_name: p2 ? p2.given_name : "",
    partner_furigana: p2 ? p2.furigana : "",
    display_name,
    display_short,
  };
}

function lookupFurigana(name) {
  if (!name) return "";
  const n = String(name).replace(/\s+/g, "");
  if (FD[n]) return FD[n];
  for (let len = Math.min(4, n.length); len >= 1; len--) {
    const prefix = n.substring(0, len);
    if (FD[prefix]) return FD[prefix];
  }
  return "";
}

// ── ラウンド順序 ────────────────────────────────────────
const ROUND_ORDER = {
  "決勝":1, "準決勝":2, "準々決勝":3,
  "ベスト8":3, "ベスト16":4, "ベスト32":5, "ベスト64":6,
  "6回戦":4, "5回戦":5, "4回戦":6, "3回戦":7, "2回戦":8, "1回戦":9,
  "予選":10, "予選リーグ":10, "本戦":8, "その他":99
};
function getRoundOrder(round) {
  if (!round) return 99;
  if (ROUND_ORDER[round] != null) return ROUND_ORDER[round];
  const m = String(round).match(/(\d+)回戦/);
  if (m) return 15 - parseInt(m[1]);
  return 99;
}

// ── Elo レーティング ───────────────────────────────────
function calcElo(rWin, rLose, K = 32) {
  const rW = rWin || 1500, rL = rLose || 1500;
  const expW = 1 / (1 + Math.pow(10, (rL - rW) / 400));
  return {
    newWin:  Math.round(rW + K * (1 - expW)),
    newLose: Math.round(rL + K * (0 - (1 - expW))),
  };
}

// ── プリペアドステートメント ───────────────────────────
const stmts = {
  getPlayers: sqlite.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=1) AS wins_ach,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=2) AS seconds,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=3) AS thirds,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id) AS total_achievements,
      (SELECT COUNT(*) FROM matches m WHERE m.winner_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_wins,
      (SELECT COUNT(*) FROM matches m WHERE m.loser_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_losses
    FROM players p
  `),
  getPlayer: sqlite.prepare(`SELECT * FROM players WHERE id = ?`),
  getAchievements: sqlite.prepare(`SELECT * FROM achievements WHERE player_id = ? ORDER BY year DESC`),
  insertPlayer: sqlite.prepare(`
    INSERT INTO players (id, name, furigana, team, branch, gender, category, note, appearances, rating)
    VALUES (@id, @name, @furigana, @team, @branch, @gender, @category, @note, @appearances, @rating)
  `),
  updatePlayer: sqlite.prepare(`
    UPDATE players SET name=@name, furigana=@furigana, team=@team, branch=@branch,
      gender=@gender, category=@category, note=@note,
      appearances=@appearances, rating=@rating,
      updated_at=datetime('now','localtime') WHERE id=@id
  `),
  updateRating: sqlite.prepare(`UPDATE players SET rating=?, updated_at=datetime('now','localtime') WHERE id=?`),
  deletePlayer: sqlite.prepare(`DELETE FROM players WHERE id = ?`),
  deleteAllPlayers: sqlite.prepare(`DELETE FROM players`),

  insertAchievement: sqlite.prepare(`
    INSERT INTO achievements (id, player_id, event, tournament, place, type, year)
    VALUES (@id, @player_id, @event, @tournament, @place, @type, @year)
  `),
  deleteAchievement: sqlite.prepare(`DELETE FROM achievements WHERE id = ?`),

  getTournaments: sqlite.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id) AS match_count,
      (SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id AND m.status='completed') AS completed_count,
      (SELECT COUNT(DISTINCT player_id) FROM tournament_players tp WHERE tp.tournament_id=t.id) AS player_count
    FROM tournaments t
    ORDER BY
      CASE COALESCE(status,'scheduled')
        WHEN 'ongoing'     THEN 0
        WHEN 'preparation' THEN 1
        WHEN 'scheduled'   THEN 2
        WHEN 'completed'   THEN 3
        WHEN 'cancelled'   THEN 4
        ELSE 5
      END ASC,
      date DESC,
      created_at DESC
  `),
  getTournament: sqlite.prepare(`SELECT * FROM tournaments WHERE id = ?`),
  insertTournament: sqlite.prepare(`
    INSERT INTO tournaments (id, name, date, venue, court_count, status, description, state_json)
    VALUES (@id, @name, @date, @venue, @court_count, @status, @description, @state_json)
  `),
  updateTournament: sqlite.prepare(`
    UPDATE tournaments SET name=@name, date=@date, venue=@venue, court_count=@court_count,
      status=@status, description=@description, state_json=@state_json,
      updated_at=datetime('now','localtime') WHERE id=@id
  `),
  deleteTournament: sqlite.prepare(`DELETE FROM tournaments WHERE id = ?`),

  // 試合
  getMatchesByTournament: sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id = ? ORDER BY round_order ASC, match_no ASC, created_at ASC
  `),
  getMatch: sqlite.prepare(`SELECT * FROM matches WHERE id = ?`),
  getMatchesByPlayer: sqlite.prepare(`
    SELECT m.*, t.name AS tournament_name, t.date AS tournament_date
    FROM matches m LEFT JOIN tournaments t ON m.tournament_id = t.id
    WHERE (m.winner_id = ? OR m.loser_id = ?)
      AND m.loser_name != 'BYE' AND m.winner_name != 'BYE'
    ORDER BY t.date DESC, m.round_order ASC, m.match_no ASC
  `),
  insertMatch: sqlite.prepare(`
    INSERT INTO matches (id, tournament_id, event, round, round_order, match_no,
      winner_id, loser_id, winner_name, loser_name, winner_team, loser_team,
      sets_json, winner_sets, loser_sets, played_at, note)
    VALUES (@id, @tournament_id, @event, @round, @round_order, @match_no,
      @winner_id, @loser_id, @winner_name, @loser_name, @winner_team, @loser_team,
      @sets_json, @winner_sets, @loser_sets, @played_at, @note)
  `),
  updateMatch: sqlite.prepare(`
    UPDATE matches SET event=@event, round=@round, round_order=@round_order, match_no=@match_no,
      winner_id=@winner_id, loser_id=@loser_id, winner_name=@winner_name, loser_name=@loser_name,
      winner_team=@winner_team, loser_team=@loser_team, sets_json=@sets_json,
      winner_sets=@winner_sets, loser_sets=@loser_sets, played_at=@played_at, note=@note
    WHERE id=@id
  `),
  deleteMatch: sqlite.prepare(`DELETE FROM matches WHERE id = ?`),
  deleteMatchesByTournament: sqlite.prepare(`DELETE FROM matches WHERE tournament_id = ?`),

  // 出場選手
  getTournamentPlayers: sqlite.prepare(`
    SELECT p.*, tp.event AS entry_event, tp.seed
    FROM tournament_players tp
    JOIN players p ON tp.player_id = p.id
    WHERE tp.tournament_id = ?
    ORDER BY tp.seed ASC, p.furigana ASC
  `),
  insertTournamentPlayer: sqlite.prepare(`
    INSERT OR IGNORE INTO tournament_players (tournament_id, player_id, event, seed)
    VALUES (@tournament_id, @player_id, @event, @seed)
  `),
  deleteTournamentPlayer: sqlite.prepare(`
    DELETE FROM tournament_players WHERE tournament_id=? AND player_id=?
  `),
  clearTournamentPlayers: sqlite.prepare(`DELETE FROM tournament_players WHERE tournament_id=?`),

  // 統計
  countPlayers: sqlite.prepare(`SELECT COUNT(*) AS count FROM players`),
  countTeams: sqlite.prepare(`SELECT COUNT(DISTINCT team) AS count FROM players WHERE team != ''`),
  countAchievements: sqlite.prepare(`SELECT COUNT(*) AS count FROM achievements`),
  countMatches: sqlite.prepare(`SELECT COUNT(*) AS count FROM matches`),
  countTournaments: sqlite.prepare(`SELECT COUNT(*) AS count FROM tournaments`),
  topPlayers: sqlite.prepare(`
    SELECT p.id, p.name, p.team, p.rating,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=1) AS wins,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=2) AS seconds,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id AND a.place=3) AS thirds,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id) AS total,
      (SELECT COUNT(*) FROM matches m WHERE m.winner_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_wins,
      (SELECT COUNT(*) FROM matches m WHERE m.loser_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_losses
    FROM players p
    WHERE (SELECT COUNT(*) FROM achievements a WHERE a.player_id=p.id) > 0
       OR (SELECT COUNT(*) FROM matches m WHERE m.winner_id=p.id OR m.loser_id=p.id) > 0
    ORDER BY total DESC, match_wins DESC
    LIMIT 20
  `),
  ratingRanking: sqlite.prepare(`
    SELECT p.id, p.name, p.team, p.rating, p.gender, p.category,
      (SELECT COUNT(*) FROM matches m WHERE m.winner_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_wins,
      (SELECT COUNT(*) FROM matches m WHERE m.loser_id=p.id AND m.loser_name!='BYE' AND m.winner_name!='BYE') AS match_losses
    FROM players p
    WHERE (SELECT COUNT(*) FROM matches m WHERE m.winner_id=p.id OR m.loser_id=p.id) > 0
    ORDER BY rating DESC LIMIT 50
  `),
};

// ── 選手 ────────────────────────────────────────────────
function getPlayers({ search, gender, category, team, sort } = {}) {
  let rows = stmts.getPlayers.all();
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(r =>
      (r.name || "").toLowerCase().includes(q) ||
      (r.furigana || "").includes(q) ||
      (r.team || "").toLowerCase().includes(q)
    );
  }
  if (gender && gender !== "all") rows = rows.filter(r => r.gender === gender);
  if (category && category !== "all") rows = rows.filter(r => r.category === category);
  if (team && team !== "all") rows = rows.filter(r => r.team === team);

  switch (sort) {
    case "furigana": rows.sort((a, b) => (a.furigana || "").localeCompare(b.furigana || "", "ja")); break;
    case "team": rows.sort((a, b) => (a.team || "").localeCompare(b.team || "", "ja")); break;
    case "appearances": rows.sort((a, b) => (b.appearances || 0) - (a.appearances || 0)); break;
    case "rating": rows.sort((a, b) => (b.rating || 1500) - (a.rating || 1500)); break;
    case "wins": rows.sort((a, b) => (b.match_wins || 0) - (a.match_wins || 0)); break;
    case "achievements": rows.sort((a, b) => (b.total_achievements || 0) - (a.total_achievements || 0)); break;
    case "name": rows.sort((a, b) => a.name.localeCompare(b.name, "ja")); break;
    default: rows.sort((a, b) => (a.furigana || a.name).localeCompare(b.furigana || b.name, "ja"));
  }
  return rows;
}

function getPlayer(id) {
  const player = stmts.getPlayer.get(id);
  if (!player) return null;
  player.achievements = stmts.getAchievements.all(id);
  player.matches = stmts.getMatchesByPlayer.all(id, id).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
  // 大会レベル別の勝敗内訳 (全道/全国の戦績を別記録)
  player.level_stats = getPlayerLevelStats(id);
  return player;
}

// 選手の勝敗を大会レベル(地区/全道/全国)別に集計
function getPlayerLevelStats(playerId) {
  const rows = sqlite.prepare(`
    SELECT COALESCE(t.level,'district') AS level,
      SUM(CASE WHEN m.winner_id = ? THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN m.loser_id = ? THEN 1 ELSE 0 END) AS losses
    FROM matches m
    JOIN tournaments t ON t.id = m.tournament_id
    WHERE (m.winner_id = ? OR m.loser_id = ?)
      AND m.status='completed'
      AND m.winner_name != 'BYE' AND m.loser_name != 'BYE'
    GROUP BY COALESCE(t.level,'district')
  `).all(playerId, playerId, playerId, playerId);
  const out = {};
  rows.forEach(r => { out[r.level] = { wins: r.wins || 0, losses: r.losses || 0 }; });
  return out;
}

// 個人名らしいかをチェック (チーム名・学校名・地名と区別)
// チーム名と判定された場合 false を返す
function looksLikeValidPlayerName(name) {
  if (!name) return { ok: false, reason: "氏名が空です" };
  const s = String(name).trim();
  if (s.length < 1) return { ok: false, reason: "氏名が空です" };
  if (s.length > 24) return { ok: false, reason: "氏名が長すぎます (24文字超)" };
  // チーム・学校・組織名の末尾パターン
  const TEAM_SUFFIX = /(大学|高校|高等学校|中学校?|小学校?|クラブ|協会|アリーナ|体育館|スタジオ|TTC|プラザ|スポーツ|店|社|塾|教室|チーム|ジム|市役所|町役場|区役所|村役場|庁舎?|商店|会社|株式会社|有限会社|病院|医院|クリニック|連盟|連合|館|院|寺|神社|工業|商業|職業|銀行|信用|信金|営業所|支店|本店|事業所)$/;
  if (TEAM_SUFFIX.test(s)) {
    return { ok: false, reason: `「${s}」はチーム名/団体名と判定されました。個人氏名を入力してください。` };
  }
  // ラベル系
  const LABELS = ["氏名", "名前", "選手", "代表者", "出場チーム", "団体名",
    "学校名", "監督", "コーチ", "顧問", "申込責任者", "金額", "備考", "BYE"];
  if (LABELS.includes(s)) {
    return { ok: false, reason: `「${s}」は項目名と判定されました。個人氏名を入力してください。` };
  }
  // 文字種チェック: 日本語/英字を含むこと (数字や記号のみは NG)
  if (!/[ぁ-んァ-ヶー一-龯A-Za-z]/.test(s)) {
    return { ok: false, reason: "氏名に日本語または英字を含めてください" };
  }
  // 数値のみ
  if (/^\d+$/.test(s)) {
    return { ok: false, reason: "数値のみは氏名として無効です" };
  }
  return { ok: true };
}

function createPlayer(data) {
  // 名前バリデーション (チーム名や項目名が誤って登録されるのを防ぐ)
  const v = looksLikeValidPlayerName(data.name);
  if (!v.ok) {
    if (data._allowAnyName) {
      // 強制作成フラグ (テスト用)
    } else {
      const err = new Error(v.reason || "選手名が無効です");
      err.code = "INVALID_NAME";
      err.invalidName = data.name;
      throw err;
    }
  }
  const id = uid();
  const furigana = data.furigana || lookupFurigana(data.name);
  stmts.insertPlayer.run({
    id,
    name: data.name || "",
    furigana,
    team: data.team || "",
    branch: data.branch || "",
    gender: data.gender || "male",
    category: data.category || "general",
    note: data.note || "",
    appearances: data.appearances || 0,
    rating: data.rating || 1500,
  });
  if (data.achievements) {
    for (const a of data.achievements) {
      stmts.insertAchievement.run({
        id: uid(),
        player_id: id,
        event: a.event,
        tournament: a.tournament || "",
        place: a.place,
        type: a.type || "シングルス",
        year: a.year || new Date().getFullYear(),
      });
    }
  }
  return getPlayer(id);
}

function updatePlayer(id, data) {
  const existing = stmts.getPlayer.get(id);
  if (!existing) return null;
  stmts.updatePlayer.run({
    id,
    name: data.name ?? existing.name,
    furigana: data.furigana ?? existing.furigana,
    team: data.team ?? existing.team,
    branch: data.branch ?? existing.branch ?? "",
    gender: data.gender ?? existing.gender,
    category: data.category ?? existing.category,
    note: data.note ?? existing.note,
    appearances: data.appearances ?? existing.appearances,
    rating: data.rating ?? existing.rating ?? 1500,
  });
  return getPlayer(id);
}

function deletePlayer(id) { stmts.deletePlayer.run(id); }
function deleteAllPlayers() { stmts.deleteAllPlayers.run(); }

function addAchievement(playerId, data) {
  const id = uid();
  stmts.insertAchievement.run({
    id,
    player_id: playerId,
    event: data.event,
    tournament: data.tournament || "",
    place: data.place,
    type: data.type || "シングルス",
    year: data.year || new Date().getFullYear(),
  });
  return { id, ...data };
}

function deleteAchievement(id) { stmts.deleteAchievement.run(id); }

// 名前から選手を検索（厳密一致のみ）
// includes での部分一致はシングル選手とダブル選手の誤リンクを起こすので使わない。
// 緩い検索は明示的に opts.fuzzy=true で有効化（外部アプリ連動など限られた用途向け）
function findPlayerByName(name, team, opts) {
  if (!name) return null;
  const norm = String(name).replace(/\s+/g, "");
  const all = stmts.getPlayers.all();
  // 1. 完全一致 (name + team)
  let hit = all.find(p =>
    p.name.replace(/\s+/g, "") === norm &&
    (!team || p.team === team));
  if (hit) return hit;
  // 2. 完全一致 (name のみ)
  hit = all.find(p => p.name.replace(/\s+/g, "") === norm);
  if (hit) return hit;
  // 3. fuzzy オプション時のみ includes
  if (opts && opts.fuzzy) {
    hit = all.find(p => p.name.replace(/\s+/g, "").includes(norm) && norm.length >= 2);
    return hit || null;
  }
  return null;
}

// ── 大会 ────────────────────────────────────────────────
// 手動戦績用の隠し大会 (個別の試合記録の受け皿)
const MANUAL_TID = "__manual_records__";
function getOrCreateManualTournament() {
  let t = stmts.getTournament.get(MANUAL_TID);
  if (!t) {
    sqlite.prepare(`INSERT INTO tournaments (id, name, date, status, level)
      VALUES (?, ?, ?, ?, ?)`).run(MANUAL_TID, "（個別記録）", "", "archived", "other");
    t = stmts.getTournament.get(MANUAL_TID);
  }
  return t;
}

function getTournaments() {
  // 隠し大会 (個別記録) は一覧から除外
  return stmts.getTournaments.all().filter(t => t.id !== MANUAL_TID);
}

// 選手に個別の試合戦績を手動追加
function createManualMatch(playerId, data) {
  const player = stmts.getPlayer.get(playerId);
  if (!player) return { error: "選手が見つかりません" };
  getOrCreateManualTournament();
  const won = !!data.won;
  const oppName = String(data.opponent_name || "").trim().slice(0, 80) || "相手不明";
  const oppTeam = String(data.opponent_team || "").trim().slice(0, 80);
  let myScore = parseInt(data.my_score); if (isNaN(myScore)) myScore = won ? 3 : 0;
  let oppScore = parseInt(data.opp_score); if (isNaN(oppScore)) oppScore = won ? 0 : 3;
  const ws = won ? myScore : oppScore;
  const ls = won ? oppScore : myScore;
  const rec = {
    id: uid(),
    tournament_id: MANUAL_TID,
    event: String(data.event || data.tournament_name || "個別記録").slice(0, 100),
    round: String(data.round || "").slice(0, 40),
    round_order: 99, match_no: 0,
    winner_id: won ? playerId : null,
    loser_id: won ? null : playerId,
    winner_name: won ? player.name : oppName,
    loser_name: won ? oppName : player.name,
    winner_team: won ? (player.team || "") : oppTeam,
    loser_team: won ? oppTeam : (player.team || ""),
    sets_json: "[]",
    winner_sets: ws, loser_sets: ls,
    played_at: data.date || "",
    note: "manual",
  };
  stmts.insertMatch.run(rec);
  // 大会日付に手動戦績の日付を反映 (一覧ソート用・任意)
  return { ok: true, id: rec.id };
}

// 選手の試合一覧 (手動戦績の編集用)
function getPlayerMatchesForEdit(playerId) {
  return stmts.getMatchesByPlayer.all(playerId, playerId).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]"),
    is_manual: m.tournament_id === MANUAL_TID,
  }));
}

function getTournament(id) {
  const t = stmts.getTournament.get(id);
  if (!t) return null;
  t.state = JSON.parse(t.state_json || "{}");
  t.matches = stmts.getMatchesByTournament.all(id).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
  t.players = stmts.getTournamentPlayers.all(id);
  return t;
}

function createTournament(data) {
  const id = uid();
  stmts.insertTournament.run({
    id,
    name: data.name || "",
    date: data.date || new Date().toISOString().split("T")[0],
    venue: data.venue || "",
    court_count: data.court_count || 4,
    status: data.status || "scheduled",
    description: data.description || "",
    state_json: JSON.stringify(data.state || {}),
  });
  // テンプレ由来の付随設定を反映 (court layout / referee rule / template_id)
  const extra = [];
  const vals = [];
  if (data.template_id !== undefined) { extra.push("template_id = ?"); vals.push(data.template_id || ""); }
  if (data.court_rows !== undefined) { extra.push("court_rows = ?"); vals.push(parseInt(data.court_rows) || 4); }
  if (data.court_cols !== undefined) { extra.push("court_cols = ?"); vals.push(parseInt(data.court_cols) || 11); }
  if (data.hq_position !== undefined) { extra.push("hq_position = ?"); vals.push(data.hq_position || "bottom"); }
  if (data.numbering_origin !== undefined) { extra.push("numbering_origin = ?"); vals.push(data.numbering_origin || "bottom-right"); }
  if (data.enforce_referee_rule !== undefined) {
    extra.push("enforce_referee_rule = ?"); vals.push(data.enforce_referee_rule ? 1 : 0);
  }
  if (extra.length) {
    vals.push(id);
    sqlite.prepare(`UPDATE tournaments SET ${extra.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getTournament(id);
}

function updateTournament(id, data) {
  const existing = stmts.getTournament.get(id);
  if (!existing) return null;
  stmts.updateTournament.run({
    id,
    name: data.name ?? existing.name,
    date: data.date ?? existing.date,
    venue: data.venue ?? existing.venue,
    court_count: data.court_count ?? existing.court_count,
    status: data.status ?? existing.status ?? "scheduled",
    description: data.description ?? existing.description ?? "",
    state_json: data.state ? JSON.stringify(data.state) : existing.state_json,
  });
  // 大会レベル (district/hokkaido/national/other) を個別更新
  if (data.level !== undefined) {
    sqlite.prepare("UPDATE tournaments SET level = ? WHERE id = ?")
      .run(data.level || "district", id);
  }
  return getTournament(id);
}

function deleteTournament(id) { stmts.deleteTournament.run(id); }

// ── 試合 ────────────────────────────────────────────────
function buildMatchRecord(data) {
  const id = data.id || uid();
  let winner_name = data.winner_name || "";
  let loser_name = data.loser_name || "";
  let winner_team = data.winner_team || "";
  let loser_team = data.loser_team || "";

  if (data.winner_id) {
    const p = stmts.getPlayer.get(data.winner_id);
    if (p) { winner_name = winner_name || p.name; winner_team = winner_team || p.team; }
  }
  if (data.loser_id) {
    const p = stmts.getPlayer.get(data.loser_id);
    if (p) { loser_name = loser_name || p.name; loser_team = loser_team || p.team; }
  }

  let sets = data.sets || [];
  if (typeof sets === "string") { try { sets = JSON.parse(sets); } catch { sets = []; } }
  let winner_sets = data.winner_sets, loser_sets = data.loser_sets;
  if (winner_sets == null || loser_sets == null) {
    let w = 0, l = 0;
    for (const s of sets) {
      if (Array.isArray(s) && s.length === 2) {
        if (s[0] > s[1]) w++; else if (s[1] > s[0]) l++;
      }
    }
    winner_sets = winner_sets ?? w;
    loser_sets = loser_sets ?? l;
  }

  return {
    id,
    tournament_id: data.tournament_id,
    event: data.event || "",
    round: data.round || "",
    round_order: data.round_order ?? getRoundOrder(data.round),
    match_no: data.match_no || 0,
    winner_id: data.winner_id || null,
    loser_id: data.loser_id || null,
    winner_name,
    loser_name,
    winner_team,
    loser_team,
    sets_json: JSON.stringify(sets),
    winner_sets: winner_sets || 0,
    loser_sets: loser_sets || 0,
    played_at: data.played_at || "",
    note: data.note || "",
  };
}

function createMatch(data) {
  const rec = buildMatchRecord(data);
  stmts.insertMatch.run(rec);
  if (rec.winner_id && rec.loser_id) {
    const w = stmts.getPlayer.get(rec.winner_id);
    const l = stmts.getPlayer.get(rec.loser_id);
    if (w && l) {
      const { newWin, newLose } = calcElo(w.rating, l.rating);
      stmts.updateRating.run(newWin, w.id);
      stmts.updateRating.run(newLose, l.id);
    }
  }
  return { ...rec, sets: JSON.parse(rec.sets_json) };
}

function updateMatch(id, data) {
  const existing = stmts.getMatch.get(id);
  if (!existing) return null;
  const rec = buildMatchRecord({ ...existing, ...data, id });
  stmts.updateMatch.run(rec);
  return { ...rec, sets: JSON.parse(rec.sets_json) };
}

function deleteMatch(id) { stmts.deleteMatch.run(id); }

function getMatch(id) {
  const m = stmts.getMatch.get(id);
  if (!m) return null;
  m.sets = JSON.parse(m.sets_json || "[]");
  return m;
}

function getMatchesByTournament(tournamentId) {
  return stmts.getMatchesByTournament.all(tournamentId).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
}

// ── 出場選手 ────────────────────────────────────────────
function addTournamentPlayer(tournamentId, playerId, event = "", seed = 0) {
  stmts.insertTournamentPlayer.run({
    tournament_id: tournamentId, player_id: playerId, event, seed
  });
}

function removeTournamentPlayer(tournamentId, playerId) {
  stmts.deleteTournamentPlayer.run(tournamentId, playerId);
}

function getTournamentPlayers(tournamentId) {
  return stmts.getTournamentPlayers.all(tournamentId);
}

// ── 大会運営アプリ連動: バルクインポート ───────────────
const bulkImportMatchesTxn = sqlite.transaction((tournamentId, matches) => {
  let created = 0, updated = 0;
  for (const m of matches) {
    let winner_id = m.winner_id;
    let loser_id = m.loser_id;
    if (!winner_id && m.winner_name) {
      const p = findPlayerByName(m.winner_name, m.winner_team);
      if (p) winner_id = p.id;
    }
    if (!loser_id && m.loser_name) {
      const p = findPlayerByName(m.loser_name, m.loser_team);
      if (p) loser_id = p.id;
    }
    const existing = m.id ? stmts.getMatch.get(m.id) : null;
    if (existing) {
      const rec = buildMatchRecord({ ...m, tournament_id: tournamentId, winner_id, loser_id, id: existing.id });
      stmts.updateMatch.run(rec); updated++;
    } else {
      const rec = buildMatchRecord({ ...m, tournament_id: tournamentId, winner_id, loser_id });
      stmts.insertMatch.run(rec);
      if (rec.winner_id && rec.loser_id) {
        const w = stmts.getPlayer.get(rec.winner_id);
        const l = stmts.getPlayer.get(rec.loser_id);
        if (w && l) {
          const { newWin, newLose } = calcElo(w.rating, l.rating);
          stmts.updateRating.run(newWin, w.id);
          stmts.updateRating.run(newLose, l.id);
        }
      }
      created++;
    }
  }
  return { created, updated };
});

function bulkImportMatches(tournamentId, matches) {
  return bulkImportMatchesTxn(tournamentId, matches || []);
}

// ── 選手バルクインポート ───────────────────────────────
const importPlayersTxn = sqlite.transaction((players) => {
  let added = 0, merged = 0;
  for (const p of players) {
    const existing = stmts.getPlayers.all().find(
      e => e.name === p.name && e.team === (p.team || "")
    );
    if (existing) {
      stmts.updatePlayer.run({
        id: existing.id,
        name: existing.name,
        furigana: p.furigana || existing.furigana,
        team: existing.team,
        branch: p.branch || existing.branch || "",
        gender: p.gender || existing.gender,
        category: p.category || existing.category,
        note: p.note || existing.note,
        appearances: Math.max(existing.appearances || 0, p.appearances || 0),
        rating: p.rating || existing.rating || 1500,
      });
      merged++;
    } else {
      const id = uid();
      stmts.insertPlayer.run({
        id,
        name: p.name || "",
        furigana: p.furigana || lookupFurigana(p.name),
        team: p.team || "",
        branch: p.branch || "",
        gender: p.gender || "male",
        category: p.category || "general",
        note: p.note || "",
        appearances: p.appearances || 0,
        rating: p.rating || 1500,
      });
      if (p.achievements) {
        for (const a of p.achievements) {
          stmts.insertAchievement.run({
            id: uid(),
            player_id: id,
            event: a.event,
            tournament: a.tournament || "",
            place: a.place,
            type: a.type || "シングルス",
            year: a.year || new Date().getFullYear(),
          });
        }
      }
      added++;
    }
  }
  return { added, merged };
});

function importPlayers(players) { return importPlayersTxn(players); }

// ── エクスポート ────────────────────────────────────────
function exportAllData() {
  const players = stmts.getPlayers.all().map(p => ({
    ...p,
    achievements: stmts.getAchievements.all(p.id),
  }));
  const tournaments = stmts.getTournaments.all().map(t => ({
    ...t,
    state: JSON.parse(t.state_json || "{}"),
    matches: getMatchesByTournament(t.id),
    players: stmts.getTournamentPlayers.all(t.id),
  }));
  return { players, tournaments, exportedAt: new Date().toISOString() };
}

// ── 統計 ────────────────────────────────────────────────
function getStats() {
  return {
    playerCount: stmts.countPlayers.get().count,
    teamCount: stmts.countTeams.get().count,
    achievementCount: stmts.countAchievements.get().count,
    matchCount: stmts.countMatches.get().count,
    tournamentCount: stmts.countTournaments.get().count,
    topPlayers: stmts.topPlayers.all(),
    ratingRanking: stmts.ratingRanking.all(),
  };
}

function getLastUpdated() {
  const p = sqlite.prepare("SELECT MAX(updated_at) AS t FROM players").get().t;
  const t = sqlite.prepare("SELECT MAX(updated_at) AS t FROM tournaments").get().t;
  const m = sqlite.prepare("SELECT MAX(created_at) AS t FROM matches").get().t;
  return [p, t, m].filter(Boolean).sort().reverse()[0] || new Date().toISOString();
}

// ═══════════════════════════════════════════════════════
// Entrants (大会参加選手 - マスタDBと完全分離)
// ═══════════════════════════════════════════════════════
const entrantStmts = {
  insert: sqlite.prepare(`
    INSERT INTO entrants (
      id, tournament_id, event, seed, block, is_doubles,
      display_name, display_short,
      name, surname, given_name, furigana, team,
      partner_name, partner_surname, partner_given_name, partner_furigana, partner_team,
      category, gender, age_group, region,
      player_id, partner_player_id,
      status, note
    ) VALUES (
      @id, @tournament_id, @event, @seed, @block, @is_doubles,
      @display_name, @display_short,
      @name, @surname, @given_name, @furigana, @team,
      @partner_name, @partner_surname, @partner_given_name, @partner_furigana, @partner_team,
      @category, @gender, @age_group, @region,
      @player_id, @partner_player_id,
      @status, @note
    )
  `),
  update: sqlite.prepare(`
    UPDATE entrants SET
      event=@event, seed=@seed, block=@block, is_doubles=@is_doubles,
      display_name=@display_name, display_short=@display_short,
      name=@name, surname=@surname, given_name=@given_name, furigana=@furigana, team=@team,
      partner_name=@partner_name, partner_surname=@partner_surname,
      partner_given_name=@partner_given_name, partner_furigana=@partner_furigana,
      partner_team=@partner_team,
      category=@category, gender=@gender, age_group=@age_group, region=@region,
      player_id=@player_id, partner_player_id=@partner_player_id,
      status=@status, note=@note,
      updated_at = datetime('now','localtime')
    WHERE id=@id
  `),
  get: sqlite.prepare(`SELECT * FROM entrants WHERE id = ?`),
  delete: sqlite.prepare(`DELETE FROM entrants WHERE id = ?`),
  listByTournament: sqlite.prepare(`
    SELECT * FROM entrants WHERE tournament_id = ? ORDER BY event, seed, surname
  `),
  listByEvent: sqlite.prepare(`
    SELECT * FROM entrants WHERE tournament_id = ? AND event = ? ORDER BY seed, surname
  `),
  setPlayerLink: sqlite.prepare(`
    UPDATE entrants SET player_id = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `),
  setPartnerPlayerLink: sqlite.prepare(`
    UPDATE entrants SET partner_player_id = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `),
  setBracketNumber: sqlite.prepare(`
    UPDATE entrants SET bracket_number = ?, bracket_side = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `),
};

function createEntrant(data) {
  const names = buildEntrantNames(data);
  const id = data.id || uid();
  const rec = {
    id,
    tournament_id: data.tournament_id,
    event: data.event || "",
    seed: parseInt(data.seed) || 0,
    block: data.block || "",
    is_doubles: names.is_doubles,
    display_name: names.display_name,
    display_short: names.display_short,
    name: names.name,
    surname: names.surname,
    given_name: names.given_name,
    furigana: names.furigana || lookupFurigana(names.surname),
    team: normalizeName(data.team),
    partner_name: names.partner_name,
    partner_surname: names.partner_surname,
    partner_given_name: names.partner_given_name,
    partner_furigana: names.partner_furigana,
    partner_team: normalizeName(data.partner_team),
    category: data.category || "general",
    gender: data.gender || "male",
    age_group: data.age_group || "",
    region: normalizeName(data.region),
    player_id: data.player_id || null,
    partner_player_id: data.partner_player_id || null,
    status: data.status || "confirmed",
    note: data.note || "",
  };
  entrantStmts.insert.run(rec);
  return entrantStmts.get.get(id);
}

function updateEntrant(id, data) {
  const existing = entrantStmts.get.get(id);
  if (!existing) return null;
  // 入力に応じて名前再計算 (片方だけ来た時も既存と合成)
  const merged = {
    ...existing,
    ...data,
    is_doubles: data.is_doubles !== undefined ? data.is_doubles : existing.is_doubles,
  };
  const names = buildEntrantNames(merged);
  entrantStmts.update.run({
    id,
    event: data.event !== undefined ? data.event : existing.event,
    seed: data.seed !== undefined ? parseInt(data.seed) || 0 : existing.seed,
    block: data.block !== undefined ? data.block : (existing.block || ""),
    is_doubles: names.is_doubles,
    display_name: names.display_name,
    display_short: names.display_short,
    name: names.name,
    surname: names.surname,
    given_name: names.given_name,
    furigana: names.furigana || existing.furigana,
    team: data.team !== undefined ? normalizeName(data.team) : existing.team,
    partner_name: names.partner_name,
    partner_surname: names.partner_surname,
    partner_given_name: names.partner_given_name,
    partner_furigana: names.partner_furigana || existing.partner_furigana,
    partner_team: data.partner_team !== undefined ? normalizeName(data.partner_team) : existing.partner_team,
    category: data.category !== undefined ? data.category : existing.category,
    gender: data.gender !== undefined ? data.gender : existing.gender,
    age_group: data.age_group !== undefined ? data.age_group : existing.age_group,
    region: data.region !== undefined ? normalizeName(data.region) : existing.region,
    player_id: data.player_id !== undefined ? data.player_id : existing.player_id,
    partner_player_id: data.partner_player_id !== undefined ? data.partner_player_id : existing.partner_player_id,
    status: data.status !== undefined ? data.status : existing.status,
    note: data.note !== undefined ? data.note : existing.note,
  });
  return entrantStmts.get.get(id);
}

// エントラントのバリデーション (重複・空フィールド検出)
function validateEntrants(tournamentId, event) {
  const all = event
    ? entrantStmts.listByEvent.all(tournamentId, event)
    : entrantStmts.listByTournament.all(tournamentId);

  const errors = [];
  const warnings = [];

  // 重複検出 (同 event 内で name+team 同じ)
  const byKey = new Map();
  all.forEach(e => {
    const key = `${e.event}::${e.name}::${e.team}::${e.partner_name || ""}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  });
  byKey.forEach((group, key) => {
    if (group.length > 1) {
      errors.push({
        type: "duplicate",
        message: `重複: ${group[0].display_name}${group[0].team ? " ("+group[0].team+")" : ""} が ${group.length} 件`,
        entrant_ids: group.map(e => e.id),
      });
    }
  });

  // seed# 重複検出 (同 event 内)
  const seedMap = new Map();
  all.forEach(e => {
    if (!e.seed) return;
    const k = `${e.event}::${e.seed}`;
    if (!seedMap.has(k)) seedMap.set(k, []);
    seedMap.get(k).push(e);
  });
  seedMap.forEach((group, k) => {
    if (group.length > 1) {
      warnings.push({
        type: "seed_duplicate",
        message: `seed#${group[0].seed} が ${group.length} 件 (event=${group[0].event})`,
        entrant_ids: group.map(e => e.id),
      });
    }
  });

  // 必須フィールド欠落
  all.forEach(e => {
    if (!e.name) {
      errors.push({
        type: "missing_name",
        message: `氏名未入力: entrant ${e.id}`,
        entrant_ids: [e.id],
      });
    }
    if (e.is_doubles && !e.partner_name) {
      warnings.push({
        type: "missing_partner",
        message: `ダブルス相方未入力: ${e.name}`,
        entrant_ids: [e.id],
      });
    }
  });

  // ブロック未割当の警告は廃止 (ブロック指定は任意のため)
  // 旧 no_block 警告で大量に出ていたが、運用上は不要

  return {
    total: all.length,
    errors,
    warnings,
    error_count: errors.length,
    warning_count: warnings.length,
  };
}

// イベント内 entrant 統計 (admin UI 用)
function getEntrantStats(tournamentId) {
  const all = entrantStmts.listByTournament.all(tournamentId);
  const byEvent = {};
  all.forEach(e => {
    const ev = e.event || "(未分類)";
    if (!byEvent[ev]) byEvent[ev] = { total: 0, blocks: {}, linked: 0, doubles: 0 };
    byEvent[ev].total++;
    const b = e.block || "(未割当)";
    byEvent[ev].blocks[b] = (byEvent[ev].blocks[b] || 0) + 1;
    if (e.player_id) byEvent[ev].linked++;
    if (e.is_doubles) byEvent[ev].doubles++;
  });
  return byEvent;
}

function deleteEntrant(id) {
  // matches 側の entrant 参照をクリア
  sqlite.prepare(`UPDATE matches SET player1_entrant_id = NULL WHERE player1_entrant_id = ?`).run(id);
  sqlite.prepare(`UPDATE matches SET player2_entrant_id = NULL WHERE player2_entrant_id = ?`).run(id);
  sqlite.prepare(`UPDATE matches SET referee_entrant_id = NULL WHERE referee_entrant_id = ?`).run(id);
  entrantStmts.delete.run(id);
}

function getEntrant(id) { return entrantStmts.get.get(id); }
function getEntrants(tournamentId, event) {
  return event
    ? entrantStmts.listByEvent.all(tournamentId, event)
    : entrantStmts.listByTournament.all(tournamentId);
}

// entrant → master player リンク (任意)
function linkEntrantToPlayer(entrantId, playerId, isPartner) {
  if (isPartner) entrantStmts.setPartnerPlayerLink.run(playerId || null, entrantId);
  else entrantStmts.setPlayerLink.run(playerId || null, entrantId);
  return entrantStmts.get.get(entrantId);
}

// ─── 抽選番号 (No.) 自動付与 ───────────────────────────
// 申込締切後、種目別に 1, 2, 3, ... を一括割当。
// シード(seed > 0)が設定されている entrant は seed 順を尊重し小さい番号を割当。
// opts: { event?: string, mode?: 'shuffle'|'submitted'|'surname', force?: boolean }
//   mode=shuffle (default): ランダム
//   mode=submitted        : 申込順
//   mode=surname          : 苗字50音順
//   force=true            : 既存の bracket_number も上書き (default: 既存維持して未割当のみ)
function autoAssignDrawNumbers(tournamentId, opts) {
  opts = opts || {};
  const mode = opts.mode || "shuffle";
  const force = !!opts.force;
  // 種目リスト
  let events;
  if (opts.event) {
    events = [opts.event];
  } else {
    const rows = sqlite.prepare(`
      SELECT DISTINCT event FROM entrants WHERE tournament_id = ? AND event != ''
    `).all(tournamentId);
    events = rows.map(r => r.event);
  }

  const summary = [];
  const updateNumberStmt = sqlite.prepare(`
    UPDATE entrants SET bracket_number = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `);

  const txn = sqlite.transaction(() => {
    for (const ev of events) {
      const list = entrantStmts.listByEvent.all(tournamentId, ev);
      if (!list.length) continue;

      // シード付き選手 (seed > 0) は予約番号 1〜N に配置 (seed昇順)
      const seeded = list.filter(e => e.seed > 0).sort((a, b) => a.seed - b.seed);
      const unseeded = list.filter(e => !(e.seed > 0));

      // unseeded を mode で並べ替え
      if (mode === "shuffle") {
        // Fisher-Yates
        for (let i = unseeded.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [unseeded[i], unseeded[j]] = [unseeded[j], unseeded[i]];
        }
      } else if (mode === "submitted") {
        unseeded.sort((a, b) => String(a.created_at || "").localeCompare(b.created_at || ""));
      } else if (mode === "surname") {
        unseeded.sort((a, b) => String(a.furigana || a.surname || "").localeCompare(b.furigana || b.surname || ""));
      }

      const all = [...seeded, ...unseeded];
      let n = 0;
      let assigned = 0;
      for (const e of all) {
        n++;
        if (!force && e.bracket_number && e.bracket_number > 0) continue; // 既存維持
        updateNumberStmt.run(n, e.id);
        assigned++;
      }
      summary.push({ event: ev, total: all.length, assigned });
    }
  });
  txn();

  return { ok: true, events: summary };
}

// ─── 名簿 (Roster) データ生成 ─────────────────────────
// ニッタク杯形式の重複管理表用データを返す。
// 戻り値:
//   {
//     tournament: { id, name, date, venue },
//     events: [
//       { name, type:'single'|'double'|'team', count,
//         entrants: [{ no, name, team, partner_name, partner_team, doubles, status, dups }]
//       }, ...
//     ],
//     duplicates: [   // 同一選手が複数種目に出ているケース
//       { key, name, team, events: ['男子S','男子D','混合D'] }
//     ]
//   }
function buildRosterData(tournamentId) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  const all = entrantStmts.listByTournament.all(tournamentId);

  // 種目別にまとめる (entrants table の event 順に出現)
  const byEvent = new Map();
  for (const e of all) {
    const ev = e.event || "(種目未設定)";
    if (!byEvent.has(ev)) byEvent.set(ev, []);
    byEvent.get(ev).push(e);
  }

  // 重複検出キー (name + team)
  // 同じ key の entrant が 2つ以上の event に登場 → duplicate
  const dupMap = new Map(); // key -> { name, team, events: Set }
  const memberKey = (name, team) => `${(name || "").replace(/\s+/g, "")}::${(team || "").replace(/\s+/g, "")}`;

  for (const [ev, list] of byEvent.entries()) {
    for (const e of list) {
      const k1 = memberKey(e.name, e.team);
      if (k1) {
        if (!dupMap.has(k1)) dupMap.set(k1, { key: k1, name: e.name, team: e.team, events: new Set() });
        dupMap.get(k1).events.add(ev);
      }
      // ダブルスのパートナーも検出対象
      if (e.partner_name) {
        const k2 = memberKey(e.partner_name, e.partner_team);
        if (k2 && k2 !== k1) {
          if (!dupMap.has(k2)) dupMap.set(k2, { key: k2, name: e.partner_name, team: e.partner_team, events: new Set() });
          dupMap.get(k2).events.add(ev);
        }
      }
    }
  }
  const duplicates = [];
  for (const v of dupMap.values()) {
    if (v.events.size >= 2) {
      duplicates.push({ key: v.key, name: v.name, team: v.team, events: Array.from(v.events) });
    }
  }
  duplicates.sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));

  // 各 entrant に「この選手は重複している?」フラグを付ける
  const dupKeySet = new Set(duplicates.map(d => d.key));
  const events = [];
  for (const [evName, list] of byEvent.entries()) {
    // bracket_number 順 → 0 は末尾
    const sorted = [...list].sort((a, b) => {
      const an = a.bracket_number > 0 ? a.bracket_number : 9999;
      const bn = b.bracket_number > 0 ? b.bracket_number : 9999;
      if (an !== bn) return an - bn;
      return String(a.furigana || a.surname || "").localeCompare(b.furigana || b.surname || "");
    });
    const hasDoubles = sorted.some(e => e.is_doubles);
    const type = hasDoubles ? "double" : "single";
    const entrants = sorted.map((e, i) => {
      const dups1 = dupKeySet.has(memberKey(e.name, e.team));
      const dups2 = e.partner_name ? dupKeySet.has(memberKey(e.partner_name, e.partner_team)) : false;
      return {
        id: e.id,
        no: e.bracket_number > 0 ? e.bracket_number : (i + 1),
        no_assigned: e.bracket_number > 0,
        name: e.name,
        team: e.team,
        partner_name: e.partner_name || "",
        partner_team: e.partner_team || "",
        is_doubles: !!e.is_doubles,
        status: e.status,
        seed: e.seed,
        dup_self: dups1,
        dup_partner: dups2,
      };
    });
    events.push({ name: evName, type, count: entrants.length, entrants });
  }

  return {
    tournament: {
      id: t.id, name: t.name, date: t.date, venue: t.venue,
      entry_deadline: t.entry_deadline,
    },
    events,
    duplicates,
  };
}

// 選手番号 (大会固有・左右別) を手動設定
function setEntrantBracketNumber(entrantId, number, side) {
  const e = entrantStmts.get.get(entrantId);
  if (!e) return null;
  const n = Math.max(0, Math.min(999, parseInt(number) || 0));
  const s = side === "L" || side === "R" ? side : (e.bracket_side || "");
  entrantStmts.setBracketNumber.run(n, s, entrantId);
  return entrantStmts.get.get(entrantId);
}

// 名前+所属から master player を検索 (リンク提案用)
function suggestPlayerForEntrant(name, team) {
  return findPlayerByName(name, team); // 厳密一致のみ
}

// マスタ player 作成して entrant にリンク
function createPlayerFromEntrant(entrantId, isPartner) {
  const e = entrantStmts.get.get(entrantId);
  if (!e) return null;
  const name = isPartner ? e.partner_name : e.name;
  const team = isPartner ? e.partner_team : e.team;
  if (!name) return null;
  let player = findPlayerByName(name, team);
  if (!player) {
    player = createPlayer({
      name, team,
      gender: e.gender, category: e.category,
      furigana: isPartner ? e.partner_furigana : e.furigana,
    });
  }
  linkEntrantToPlayer(entrantId, player.id, isPartner);
  return player;
}

// ═══════════════════════════════════════════════════════
// 進行管理 (Operations): トーナメント生成・台割・審判・進行
// ═══════════════════════════════════════════════════════

// 進行管理用プリペアドステートメント
const opStmts = {
  insertFullMatch: sqlite.prepare(`
    INSERT INTO matches (
      id, tournament_id, event, round, round_order, match_no, match_label,
      winner_id, loser_id, winner_name, loser_name, winner_team, loser_team,
      sets_json, winner_sets, loser_sets, played_at, note,
      status, table_no, referee_id, referee_name,
      player1_id, player2_id, player1_name, player2_name, player1_team, player2_team,
      next_match_id, next_slot, called_at, started_at, finished_at,
      bracket_pos, bracket_round,
      player1_entrant_id, player2_entrant_id
    ) VALUES (
      @id, @tournament_id, @event, @round, @round_order, @match_no, @match_label,
      @winner_id, @loser_id, @winner_name, @loser_name, @winner_team, @loser_team,
      @sets_json, @winner_sets, @loser_sets, @played_at, @note,
      @status, @table_no, @referee_id, @referee_name,
      @player1_id, @player2_id, @player1_name, @player2_name, @player1_team, @player2_team,
      @next_match_id, @next_slot, @called_at, @started_at, @finished_at,
      @bracket_pos, @bracket_round,
      @player1_entrant_id, @player2_entrant_id
    )
  `),
  setSlot1: sqlite.prepare(`
    UPDATE matches SET player1_id=?, player1_name=?, player1_team=?,
      status = CASE WHEN player2_name != '' AND ? != '' THEN 'pending' ELSE status END
      WHERE id = ?
  `),
  setSlot2: sqlite.prepare(`
    UPDATE matches SET player2_id=?, player2_name=?, player2_team=?,
      status = CASE WHEN player1_name != '' AND ? != '' THEN 'pending' ELSE status END
      WHERE id = ?
  `),
  setStatus: sqlite.prepare(`UPDATE matches SET status=? WHERE id=?`),
  setTable: sqlite.prepare(`
    UPDATE matches SET table_no=?, status='on_table', called_at=datetime('now','localtime'),
      started_at=datetime('now','localtime'),
      call_count = COALESCE(call_count,0) + 1 WHERE id=?
  `),
  clearTable: sqlite.prepare(`UPDATE matches SET table_no=0, status='pending' WHERE id=?`),
  setCallCount: sqlite.prepare(`UPDATE matches SET call_count=? WHERE id=?`),
  bumpCallCount: sqlite.prepare(`UPDATE matches SET call_count = COALESCE(call_count,0) + 1 WHERE id=?`),
  resetCallCount: sqlite.prepare(`
    UPDATE matches SET call_count=0, call_count_p1=0, call_count_p2=0 WHERE id=?
  `),
  // 選手別 再コール
  bumpCallCountP1: sqlite.prepare(`
    UPDATE matches SET call_count_p1 = COALESCE(call_count_p1,0) + 1,
                       call_count = COALESCE(call_count,0) + 1 WHERE id=?
  `),
  bumpCallCountP2: sqlite.prepare(`
    UPDATE matches SET call_count_p2 = COALESCE(call_count_p2,0) + 1,
                       call_count = COALESCE(call_count,0) + 1 WHERE id=?
  `),
  setCallCountP1: sqlite.prepare(`UPDATE matches SET call_count_p1=? WHERE id=?`),
  setCallCountP2: sqlite.prepare(`UPDATE matches SET call_count_p2=? WHERE id=?`),
  setReferee: sqlite.prepare(`UPDATE matches SET referee_id=?, referee_name=? WHERE id=?`),
  setResult: sqlite.prepare(`
    UPDATE matches SET
      winner_id=@winner_id, loser_id=@loser_id,
      winner_name=@winner_name, loser_name=@loser_name,
      winner_team=@winner_team, loser_team=@loser_team,
      sets_json=@sets_json, winner_sets=@winner_sets, loser_sets=@loser_sets,
      status='completed',
      finished_at=datetime('now','localtime'),
      played_at=COALESCE(NULLIF(played_at,''), datetime('now','localtime'))
    WHERE id=@id
  `),
  getBracketMatches: sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id=? AND event=?
    ORDER BY bracket_round ASC, bracket_pos ASC, match_no ASC
  `),
  deleteEventMatches: sqlite.prepare(`DELETE FROM matches WHERE tournament_id=? AND event=?`),
  getOnTableMatches: sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id=? AND status='on_table'
    ORDER BY table_no ASC
  `),
  getPendingMatches: sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id=? AND status='pending'
    ORDER BY bracket_round ASC, bracket_pos ASC, match_no ASC
  `),
  getRecentFinished: sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id=? AND status='completed' AND finished_at != ''
    ORDER BY finished_at DESC LIMIT ?
  `),
  getRefereeFor: sqlite.prepare(`SELECT * FROM matches WHERE referee_id=? AND status IN ('pending','on_table') LIMIT 1`),
};

// ── 標準シーディング順序を生成 ──────────────────────
// 例: bracketPositions(8) = [1,8,4,5,2,7,3,6]
//     隣接ペアが1回戦の対戦カード
function bracketPositions(size) {
  let arr = [1];
  while (arr.length < size) {
    const next = [];
    const len = arr.length * 2;
    for (const v of arr) {
      next.push(v);
      next.push(len + 1 - v);
    }
    arr = next;
  }
  return arr;
}

// ラウンド名生成 (卓球協会慣習)
// ・残り 2人  = 決勝
// ・残り 4人  = 準決勝
// ・残り 8人  = 準々決勝
// ・残り 16人 = ベスト16
// ・それより前 = N回戦 (1回戦から開始)
function roundNameForBracket(roundNumber, totalRounds) {
  const remaining = totalRounds - roundNumber + 1; // この round 開始時点で残ってる試合数
  if (remaining === 1) return "決勝";
  if (remaining === 2) return "準決勝";
  if (remaining === 3) return "準々決勝";
  if (remaining === 4) return "ベスト16";
  // ベスト32以前は「N回戦」表示
  return `${roundNumber}回戦`;
}

// ── トーナメント生成 (entrants ベース) ──────────
function generateBracket(tournamentId, event, options) {
  options = options || {};
  // ① entrants から取得 (entrant_ids 指定時はそれ、なければ event 全件)
  let entrants;
  if (options.entrant_ids && options.entrant_ids.length) {
    const ids = new Set(options.entrant_ids);
    entrants = entrantStmts.listByTournament.all(tournamentId).filter(e => ids.has(e.id));
  } else if (event) {
    entrants = entrantStmts.listByEvent.all(tournamentId, event);
  } else {
    entrants = entrantStmts.listByTournament.all(tournamentId);
  }

  // ② レガシー互換: entrants が空の場合は tournament_players から自動移行
  if (!entrants.length && event) {
    const legacyPlayers = stmts.getTournamentPlayers.all(tournamentId)
      .filter(p => !p.entry_event || p.entry_event === event || p.entry_event === "");
    if (options.player_ids) {
      const ids = new Set(options.player_ids);
      legacyPlayers.filter(p => ids.has(p.id)).forEach(p => {
        const e = createEntrant({
          tournament_id: tournamentId,
          event,
          seed: p.seed || 0,
          name: p.name,
          team: p.team,
          gender: p.gender,
          category: p.category,
          player_id: p.id,
        });
        entrants.push(e);
      });
    } else {
      legacyPlayers.forEach(p => {
        const e = createEntrant({
          tournament_id: tournamentId,
          event,
          seed: p.seed || 0,
          name: p.name,
          team: p.team,
          gender: p.gender,
          category: p.category,
          player_id: p.id,
        });
        entrants.push(e);
      });
    }
  }

  if (!entrants || entrants.length < 2) {
    return { error: "出場選手が2人未満です", count: entrants.length };
  }

  // シード順ソート（seed昇順 → 苗字ふりがな昇順）
  const sorted = [...entrants].sort((a, b) => {
    const sa = a.seed || 9999, sb = b.seed || 9999;
    if (sa !== sb) return sa - sb;
    return (a.furigana || a.surname || a.name).localeCompare(
      b.furigana || b.surname || b.name, "ja");
  });

  const N = sorted.length;
  // placement: "as_drawn" = 選手番号(seed=通し番号)をそのまま位置に固定配置 (取込表通り)
  //            それ以外 = 標準シード配置 (1 vs N, 2 vs N-1 …)
  const asDrawn = options.placement === "as_drawn";

  // as_drawn: ブロックがまたがり通し番号が途中(例:79)から始まる場合に対応するため
  //           最小番号を 0 番スロットに正規化する (番号の相対位置=描画位置)
  let minSeed = 1;
  if (asDrawn) {
    const seeds = sorted.map(p => parseInt(p.seed) || 0).filter(s => s >= 1);
    minSeed = seeds.length ? Math.min(...seeds) : 1;
  }

  let bracketSize, totalRounds;
  if (asDrawn) {
    const seeds = sorted.map(p => parseInt(p.seed) || 0).filter(s => s >= 1);
    const maxSeed = seeds.length ? Math.max(...seeds) : N;
    const span = maxSeed - minSeed + 1;            // ブロック内の番号スパン
    bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(2, span, N))));
  } else {
    bracketSize = Math.pow(2, Math.ceil(Math.log2(N)));
  }
  totalRounds = Math.log2(bracketSize);
  const positions = bracketPositions(bracketSize);

  // seed番号→選手 (標準配置用: ふりがな順の順位)
  const playerBySeed = {};
  sorted.forEach((p, i) => { playerBySeed[i + 1] = p; });
  // 相対スロット(0始まり)→選手 (as_drawn 用: 番号-最小番号 = 線形スロット位置)
  const playerByDrawNo = {};
  if (asDrawn) {
    sorted.forEach(p => {
      const s = parseInt(p.seed) || 0;
      if (s < 1) return;
      const rel = s - minSeed;                     // 0 始まりの線形スロット
      if (rel >= 0 && rel < bracketSize) playerByDrawNo[rel] = p;
    });
  }

  // 既存の同event試合を削除（regen）
  if (options.regenerate) {
    opStmts.deleteEventMatches.run(tournamentId, event);
  }

  // 全round/全matchを構築
  const matchesByRound = [];
  // round 1
  const round1 = [];
  for (let i = 0; i < bracketSize; i += 2) {
    let p1, p2;
    if (asDrawn) {
      // 相対スロット i が player1、i+1 が player2 (上→下の並びそのまま)
      p1 = playerByDrawNo[i] || null;
      p2 = playerByDrawNo[i + 1] || null;
    } else {
      p1 = playerBySeed[positions[i]] || null;
      p2 = playerBySeed[positions[i + 1]] || null;
    }
    round1.push({
      id: uid(),
      bracket_pos: i / 2,
      match_no: i / 2 + 1,
      player1: p1, // null = BYE
      player2: p2,
    });
  }
  matchesByRound.push(round1);

  // round 2..totalRounds (空の matches)
  for (let r = 2; r <= totalRounds; r++) {
    const numMatches = bracketSize / Math.pow(2, r);
    const rnd = [];
    for (let i = 0; i < numMatches; i++) {
      rnd.push({ id: uid(), bracket_pos: i, match_no: i + 1, player1: null, player2: null });
    }
    matchesByRound.push(rnd);
  }

  // next_match_id をリンク
  for (let r = 0; r < totalRounds - 1; r++) {
    matchesByRound[r].forEach((m, i) => {
      const next = matchesByRound[r + 1][Math.floor(i / 2)];
      m.next_match_id = next.id;
      m.next_slot = (i % 2) + 1;
    });
  }

  // SQLite トランザクションで一括挿入 (小さい山=round1 から順に挿入)
  const txn = sqlite.transaction(() => {
    matchesByRound.forEach((rnd, r) => {
      const roundName = roundNameForBracket(r + 1, totalRounds);
      const roundIdx = r + 1;  // 1=1回戦, 2=2回戦, ...
      rnd.forEach(m => {
        const isFirstRound = r === 0;
        // entrant の display_name (ダブルスは "山田 太郎 / 鈴木 一郎" / シングルは "山田 太郎")
        const p1Name = m.player1 ? m.player1.display_name : (isFirstRound ? "BYE" : "");
        const p2Name = m.player2 ? m.player2.display_name : (isFirstRound ? "BYE" : "");
        const bothReady = m.player1 && m.player2;
        // match_label: 「R-N」形式 (例: "1-1", "1-2", "2-1", ..., "決-1")
        const matchLabel = roundIdx + "-" + m.match_no;
        opStmts.insertFullMatch.run({
          id: m.id,
          tournament_id: tournamentId,
          event: event || "",
          round: roundName,
          round_order: getRoundOrder(roundName),
          match_no: m.match_no,
          match_label: matchLabel,
          winner_id: null, loser_id: null,
          winner_name: "", loser_name: "", winner_team: "", loser_team: "",
          sets_json: "[]", winner_sets: 0, loser_sets: 0,
          played_at: "", note: "",
          status: bothReady ? "pending" : "waiting",
          table_no: 0,
          referee_id: null, referee_name: "",
          // player_id は entrant.player_id (リンク先) を使う。リンクなしなら NULL
          player1_id: m.player1?.player_id || null,
          player2_id: m.player2?.player_id || null,
          player1_name: p1Name,
          player2_name: p2Name,
          player1_team: m.player1?.team || "",
          player2_team: m.player2?.team || "",
          // entrant 参照 (大会参加選手と完全分離)
          player1_entrant_id: m.player1?.id || null,
          player2_entrant_id: m.player2?.id || null,
          next_match_id: m.next_match_id || null,
          next_slot: m.next_slot || 1,
          called_at: "", started_at: "", finished_at: "",
          bracket_pos: m.bracket_pos,
          bracket_round: r + 1,
        });
      });
    });

    // round1 のBYE試合を自動完了 → 勝者を次へ進める
    matchesByRound[0].forEach(m => {
      if (!m.player1 || !m.player2) {
        const winner = m.player1 || m.player2;
        if (!winner) return;
        opStmts.setResult.run({
          id: m.id,
          winner_id: winner.player_id || null,
          loser_id: null,
          winner_name: winner.display_name,
          loser_name: "BYE",
          winner_team: winner.team || "",
          loser_team: "",
          sets_json: "[]",
          winner_sets: 0,
          loser_sets: 0,
        });
        if (m.next_match_id) {
          advanceWinnerInline(m.next_match_id, m.next_slot,
            { id: winner.player_id || null, entrant_id: winner.id,
              name: winner.display_name, team: winner.team });
        }
      }
    });
  });
  txn();

  // ─── 選手番号 (大会固有・左右別) を割り当て ───
  // 左半分: 上から 1, 2, 3, ...
  // 右半分: 上から 1, 2, 3, ... (別カウント)
  const numberTxn = sqlite.transaction(() => {
    const halfSize = bracketSize / 2;
    matchesByRound[0].forEach((m, i) => {
      // round1 における順序: bracket_pos = i (= 0, 1, 2, ...)
      // 各試合の player1/2 にそれぞれ番号
      const slot1 = i * 2;     // 0, 2, 4, ...
      const slot2 = i * 2 + 1; // 1, 3, 5, ...
      // 左半分かどうか
      const isLeft1 = slot1 < halfSize;
      const isLeft2 = slot2 < halfSize;
      // as_drawn: 取り込んだ通し番号(seed)をそのまま表示番号に。それ以外は位置から左右別番号。
      const num1 = asDrawn ? (parseInt(m.player1?.seed) || (slot1 + 1))
                           : (isLeft1 ? (slot1 + 1) : (slot1 - halfSize + 1));
      const num2 = asDrawn ? (parseInt(m.player2?.seed) || (slot2 + 1))
                           : (isLeft2 ? (slot2 + 1) : (slot2 - halfSize + 1));
      const side1 = isLeft1 ? "L" : "R";
      const side2 = isLeft2 ? "L" : "R";
      if (m.player1 && m.player1.id) {
        entrantStmts.setBracketNumber.run(num1, side1, m.player1.id);
      }
      if (m.player2 && m.player2.id) {
        entrantStmts.setBracketNumber.run(num2, side2, m.player2.id);
      }
    });
  });
  try { numberTxn(); } catch (e) { console.error("bracket_number assignment error:", e); }

  return {
    success: true,
    tournament_id: tournamentId,
    event,
    bracket_size: bracketSize,
    total_rounds: totalRounds,
    total_matches: matchesByRound.flat().length,
    player_count: N,
    bye_count: bracketSize - N,
  };
}

// 次の試合へ勝者をセット（次の試合の player1 or player2 を埋める）
function advanceWinnerInline(nextMatchId, slot, player) {
  const nm = stmts.getMatch.get(nextMatchId);
  if (!nm) return;
  const pid = player.id || player.winner_id || null;
  const pname = player.name || player.winner_name || "";
  const pteam = player.team || player.winner_team || "";
  const pentrant = player.entrant_id || player.player1_entrant_id || player.player2_entrant_id || null;
  if (slot === 1) {
    opStmts.setSlot1.run(pid, pname, pteam, nm.player2_name || "", nextMatchId);
    if (pentrant) sqlite.prepare(`UPDATE matches SET player1_entrant_id=? WHERE id=?`).run(pentrant, nextMatchId);
  } else {
    opStmts.setSlot2.run(pid, pname, pteam, nm.player1_name || "", nextMatchId);
    if (pentrant) sqlite.prepare(`UPDATE matches SET player2_entrant_id=? WHERE id=?`).run(pentrant, nextMatchId);
  }
  // 両者揃ったか確認
  const updated = stmts.getMatch.get(nextMatchId);
  if (updated.player1_name && updated.player2_name &&
      updated.player1_name !== "BYE" && updated.player2_name !== "BYE" &&
      updated.status === "waiting") {
    opStmts.setStatus.run("pending", nextMatchId);
  }
  // 片方BYEの場合は自動進行
  if (updated.player1_name === "BYE" && updated.player2_name && updated.player2_name !== "BYE") {
    finishMatchInternal(nextMatchId, { winner_slot: 2, sets: [], auto: true });
  } else if (updated.player2_name === "BYE" && updated.player1_name && updated.player1_name !== "BYE") {
    finishMatchInternal(nextMatchId, { winner_slot: 1, sets: [], auto: true });
  }
}

// 内部用: 試合終了処理＋勝者を次へ進める＋敗者を審判プールへ
function finishMatchInternal(matchId, data) {
  const m = stmts.getMatch.get(matchId);
  if (!m) return null;
  // entrant_id も携えて勝者・敗者を構築
  const p1 = { id: m.player1_id, entrant_id: m.player1_entrant_id, name: m.player1_name, team: m.player1_team };
  const p2 = { id: m.player2_id, entrant_id: m.player2_entrant_id, name: m.player2_name, team: m.player2_team };
  let winner, loser;
  if (data.winner_slot === 1) { winner = p1; loser = p2; }
  else if (data.winner_slot === 2) { winner = p2; loser = p1; }
  else if (data.winner_id) {
    if (m.player1_id === data.winner_id) { winner = p1; loser = p2; }
    else { winner = p2; loser = p1; }
  } else return null;

  // セットスコア集計
  const sets = data.sets || [];
  let ws = 0, ls = 0;
  sets.forEach(s => {
    if (Array.isArray(s) && s.length === 2) {
      if (data.winner_slot === 1 || (m.player1_id === winner.id)) {
        if (s[0] > s[1]) ws++; else if (s[1] > s[0]) ls++;
      } else {
        if (s[1] > s[0]) ws++; else if (s[0] > s[1]) ls++;
      }
    }
  });

  opStmts.setResult.run({
    id: matchId,
    winner_id: winner.id || null,
    loser_id: loser.id || null,
    winner_name: winner.name || "",
    loser_name: loser.name || "",
    winner_team: winner.team || "",
    loser_team: loser.team || "",
    sets_json: JSON.stringify(sets),
    winner_sets: data.winner_sets ?? ws,
    loser_sets: data.loser_sets ?? ls,
  });

  // Elo 更新
  if (winner.id && loser.id) {
    const wp = stmts.getPlayer.get(winner.id);
    const lp = stmts.getPlayer.get(loser.id);
    if (wp && lp) {
      const { newWin, newLose } = calcElo(wp.rating, lp.rating);
      stmts.updateRating.run(newWin, wp.id);
      stmts.updateRating.run(newLose, lp.id);
    }
  }

  // 勝者を次の試合へ
  if (m.next_match_id) {
    advanceWinnerInline(m.next_match_id, m.next_slot, winner);
  }

  return stmts.getMatch.get(matchId);
}

// ─── 試合結果の修正 (完了済み試合を再編集) ────
// 完了済み試合の勝者を反転 or セット数を修正
// 次の試合に既に進出済みなら自動でその進出を取り消し → 新勝者で再進出
// 次の試合が既に進行中/完了の場合は警告して中止
function correctResult(matchId, data) {
  const m = stmts.getMatch.get(matchId);
  if (!m) return { error: "試合が見つかりません" };

  // 完了済みかどうかチェック
  const wasCompleted = m.status === "completed";
  if (wasCompleted && m.next_match_id) {
    const nm = stmts.getMatch.get(m.next_match_id);
    if (nm && nm.status === "completed") {
      return {
        error: "次の試合 (" + (nm.match_label || nm.match_no) + " " +
          (nm.round || "") + ") が既に完了しています。" +
          "先に次の試合の結果を取り消してから修正してください。",
        next_match_id: nm.id,
        next_match_label: nm.match_label || nm.match_no,
      };
    }
    if (nm && nm.status === "on_table") {
      return {
        error: "次の試合 (" + (nm.match_label || nm.match_no) + ") が進行中です。" +
          "進行中の試合は先に台から戻してから修正してください。",
        next_match_id: nm.id,
        next_match_label: nm.match_label || nm.match_no,
      };
    }
    // 次の試合の対応する slot をクリア (前の勝者を取り除く)
    if (nm) {
      const oldWinnerEntrant = m.winner_id === m.player1_id ? m.player1_entrant_id : m.player2_entrant_id;
      // m.next_slot = 1 なら slot1 をクリア
      if (m.next_slot === 1) {
        opStmts.setSlot1.run(null, "", "", nm.player2_name || "", nm.id);
        sqlite.prepare(`UPDATE matches SET player1_entrant_id=NULL WHERE id=?`).run(nm.id);
      } else {
        opStmts.setSlot2.run(null, "", "", nm.player1_name || "", nm.id);
        sqlite.prepare(`UPDATE matches SET player2_entrant_id=NULL WHERE id=?`).run(nm.id);
      }
      // 次の試合は再度 "waiting" に
      opStmts.setStatus.run("waiting", nm.id);
    }
  }

  // 元の試合をリセット (winner_id, loser_id等をクリア)
  opStmts.setResult.run({
    id: matchId,
    winner_id: null, loser_id: null,
    winner_name: "", loser_name: "",
    winner_team: "", loser_team: "",
    sets_json: "[]", winner_sets: 0, loser_sets: 0,
  });
  // 元の rating 変更も巻き戻し (簡易: 元勝者/敗者の rating を反映前に戻す)
  if (wasCompleted && m.winner_id && m.loser_id) {
    const wp = stmts.getPlayer.get(m.winner_id);
    const lp = stmts.getPlayer.get(m.loser_id);
    if (wp && lp) {
      const { newWin, newLose } = calcElo(wp.rating, lp.rating);
      // newWin が現在の wp.rating より大きい場合、wp.rating - (newWin - wp.rating) で巻戻
      stmts.updateRating.run(wp.rating * 2 - newWin, wp.id);
      stmts.updateRating.run(lp.rating * 2 - newLose, lp.id);
    }
  }
  // 試合ステータスを pending or on_table に
  opStmts.setStatus.run(m.table_no > 0 ? "on_table" : "pending", matchId);

  // 新しい結果を適用
  return finishMatchInternal(matchId, data);
}

function finishMatchOp(matchId, data) {
  const result = finishMatchInternal(matchId, data);
  // 同じ台で次の試合がある場合、敗者を自動審判アサイン (敗者審判ルール)
  // ※ 実運用では「次の呼出時」に同じ台で待機している敗者を referee に指定するロジックで十分
  return result;
}

// 指定の台で、直前に終了した試合の敗者情報を取得 (敗者審判 自動アサイン用)
// finishMatch 時に table_no=0 にしているので、called_at/started_at をたどる
function getRecentLoserAtTable(tournamentId, tableNo) {
  // 最近 finish した試合のうち、特定の台で行われていたものを called_at から特定
  // (現状 finishedTable が消えているので、called_at 順で最も新しい completed をその台に紐付けるのは不正確)
  // → シンプルに「敗者プール (referee_queue) の先頭」を返す
  const lock = sqlite.prepare(`
    SELECT loser_id, loser_name, loser_team
    FROM matches
    WHERE tournament_id = ? AND status = 'completed' AND loser_id IS NOT NULL
      AND finished_at != '' AND loser_name != 'BYE'
      AND NOT EXISTS (
        SELECT 1 FROM matches m2
        WHERE m2.tournament_id = matches.tournament_id
          AND m2.referee_id = matches.loser_id
          AND m2.status IN ('pending','on_table')
      )
    ORDER BY finished_at DESC LIMIT 1
  `).get(tournamentId);
  return lock || null;
}

// ═══════════════════════════════════════════════════════
// 種目優先順位ロジック (このシステムの中核)
// 団体戦 > 混合ダブルス > ダブルス > シングルス
// 上位種目で生存中(=未敗退かつ未審判完了)の選手は、
// 下位種目では呼べない (player1/player2 のどちらでも、両方でも)
// ═══════════════════════════════════════════════════════

// 種目名から優先順位を返す (小さい数値ほど優先・上位)
// 団体・ミックス・男女ダブルスは全て上位グループ、シングルスは大きく下位
function getEventPriority(eventName) {
  const n = String(eventName || "");
  if (/団体|チーム/.test(n)) return 1;
  if (/混合|ミックス|mixed/i.test(n)) return 2;
  if (/ダブルス|doubles/i.test(n)) return 3;          // 男子/女子ダブルス
  return 10;                                            // シングルス・その他 (大きくギャップ)
}

// 指定選手の、指定大会内の「全体生存状況」を取得
// 戻り値: { event_name → { state, has_active_match, has_referee_duty, has_future_match } }
function getPlayerSurvivalByEvent(playerId, tournamentId) {
  if (!playerId) return {};
  // この player が player として or 審判として関わる match を取得
  const matches = sqlite.prepare(`
    SELECT id, event, status, winner_id, loser_id, referee_id,
           player1_id, player2_id, table_no, round
    FROM matches
    WHERE tournament_id = ?
      AND (player1_id = ? OR player2_id = ? OR winner_id = ? OR loser_id = ? OR referee_id = ?)
  `).all(tournamentId, playerId, playerId, playerId, playerId, playerId);

  const byEvent = {};
  for (const m of matches) {
    const ev = m.event || "";
    if (!byEvent[ev]) {
      byEvent[ev] = {
        eliminated: false,         // この種目で既に敗退済み
        has_active_match: false,   // 現在 on_table の試合あり
        has_referee_duty: false,   // 現在 referee として担当中
        has_future_match: false,   // pending/waiting の試合あり (出場予定)
      };
    }
    const e = byEvent[ev];
    if (m.status === "completed") {
      if (m.loser_id === playerId) e.eliminated = true;
      // winner_id === playerId で次がないなら優勝 (eliminated にはしない)
    } else if (m.status === "on_table") {
      if (m.player1_id === playerId || m.player2_id === playerId) e.has_active_match = true;
      if (m.referee_id === playerId) e.has_referee_duty = true;
    } else if (m.status === "pending" || m.status === "waiting") {
      if (m.player1_id === playerId || m.player2_id === playerId) e.has_future_match = true;
      // pending で referee assigned もカウント
      if (m.referee_id === playerId && m.status === "pending") e.has_referee_duty = true;
    }
  }
  return byEvent;
}

// 「この選手は下位種目の試合に呼べる状態か?」判定
// 上位種目で:
//   - 試合中 (has_active_match)
//   - 審判担当中 (has_referee_duty)
//   - 未敗退かつ将来試合あり (!eliminated && has_future_match)
// のいずれかなら呼べない (= 上位種目決着まで待つ)
function getPriorityLockForPlayer(playerId, tournamentId, currentEventName) {
  if (!playerId) return null;
  const myPriority = getEventPriority(currentEventName);
  const byEvent = getPlayerSurvivalByEvent(playerId, tournamentId);
  for (const [ev, st] of Object.entries(byEvent)) {
    if (ev === currentEventName) continue;
    const otherPriority = getEventPriority(ev);
    if (otherPriority >= myPriority) continue; // 同位 or 下位は無視
    // 上位種目: ロック条件
    if (st.has_active_match) {
      return { event: ev, reason: "active", label: `${ev} で試合中` };
    }
    if (st.has_referee_duty) {
      return { event: ev, reason: "referee", label: `${ev} で審判担当中` };
    }
    if (!st.eliminated && st.has_future_match) {
      return { event: ev, reason: "surviving", label: `${ev} で勝ち上がり中 (未敗退)` };
    }
  }
  return null;
}

// 選手同一性判定キー: 「苗字 + 所属」
// 苗字のみのダブルス登録 (例: "山田" "鈴木") と シングルスのフルネーム ("山田 太郎") を
// 同一所属チームの場合に同じ人物として扱う。
// 同名異人 (同苗字+同所属) は仕様として同一視 (実運用では稀)
function buildPlayerKey(name, team) {
  if (!name) return null;
  const n = String(name).trim();
  if (!n || n === "BYE") return null;
  // フル氏名 "山田 太郎" → 苗字 "山田" / 苗字のみ "山田" → "山田" / "山田/鈴木" は doubles 名なので分割
  // ダブルス "山田 / 鈴木" or "山田/鈴木" の場合はキーにしない (個別の partner を別途処理)
  if (n.includes("/")) return null;
  const surname = n.split(/[\s　]/)[0] || n;
  const teamPart = (team || "").replace(/\s+/g, "");
  return surname + "|" + teamPart;
}

// match から「同一性チェック対象の player keys」一覧を取得
// player1, player2 とそれぞれの partner (ダブルス) を全部
function getPlayerKeysInMatch(match) {
  const keys = [];
  const add = (name, team) => {
    const k = buildPlayerKey(name, team);
    if (k) keys.push(k);
  };
  // player1 とその entrant 経由のパートナー
  const ent1 = match.player1_entrant_id ? entrantStmts.get.get(match.player1_entrant_id) : null;
  if (ent1) {
    // surname を優先 (苗字のみ doubles 登録対応)
    add(ent1.surname || ent1.name, ent1.team);
    if (ent1.partner_name || ent1.partner_surname) {
      add(ent1.partner_surname || ent1.partner_name, ent1.partner_team || ent1.team);
    }
  } else {
    add(match.player1_name, match.player1_team);
  }
  // player2
  const ent2 = match.player2_entrant_id ? entrantStmts.get.get(match.player2_entrant_id) : null;
  if (ent2) {
    add(ent2.surname || ent2.name, ent2.team);
    if (ent2.partner_name || ent2.partner_surname) {
      add(ent2.partner_surname || ent2.partner_name, ent2.partner_team || ent2.team);
    }
  } else {
    add(match.player2_name, match.player2_team);
  }
  return keys;
}

// 指定 match について、player1/player2 が上位種目ロックにかかってないかチェック
// player_id ベース + 苗字+所属ベース 両方で判定 (苗字のみ doubles 対応)
function getMatchPriorityBlocks(match) {
  if (!match) return [];
  const myPriority = getEventPriority(match.event);
  if (myPriority === 1) return []; // 団体戦は最上位なので拘束なし
  const blocks = [];
  const seenBlockKeys = new Set(); // 重複ブロック防止

  // ① player_id ベースのチェック (既存)
  const checkPlayer = (slotLabel, playerId, displayName) => {
    if (!playerId) return;
    const lock = getPriorityLockForPlayer(playerId, match.tournament_id, match.event);
    if (lock) {
      const k = slotLabel + "|" + displayName;
      if (seenBlockKeys.has(k)) return;
      seenBlockKeys.add(k);
      blocks.push({
        slot: slotLabel, player_id: playerId, player_name: displayName,
        lock_info: lock,
        label: `${displayName}: ${lock.label}`,
      });
    }
  };
  checkPlayer("player1", match.player1_id, match.player1_name);
  checkPlayer("player2", match.player2_id, match.player2_name);
  // ダブルスの相方 (master DBリンク済)
  if (match.player1_entrant_id) {
    const ent = entrantStmts.get.get(match.player1_entrant_id);
    if (ent && ent.partner_player_id) {
      checkPlayer("player1_partner", ent.partner_player_id, ent.partner_name);
    }
  }
  if (match.player2_entrant_id) {
    const ent = entrantStmts.get.get(match.player2_entrant_id);
    if (ent && ent.partner_player_id) {
      checkPlayer("player2_partner", ent.partner_player_id, ent.partner_name);
    }
  }

  // ② 苗字+所属 ベースのチェック (DB未連携の苗字のみダブルス対応)
  // 上位種目で生存中 (active/pending/waiting で未敗退) の matches の player keys を収集
  const upperMatches = sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id = ?
      AND status IN ('on_table', 'pending', 'waiting')
      AND event != ? AND event != ''
  `).all(match.tournament_id, match.event);

  // key → {event, reason, label}
  const lockedKeys = new Map();
  for (const um of upperMatches) {
    if (getEventPriority(um.event) >= myPriority) continue;
    const umKeys = getPlayerKeysInMatch(um);
    const reason = um.status === "on_table" ? "active" : "surviving";
    const label = um.status === "on_table"
      ? `${um.event} で試合中`
      : `${um.event} で勝ち上がり中`;
    umKeys.forEach(k => {
      if (!lockedKeys.has(k)) lockedKeys.set(k, { event: um.event, reason, label });
    });
  }

  // 審判担当 (referee_name) も上位種目で active なら、その苗字+所属を locked に
  const refMatches = sqlite.prepare(`
    SELECT * FROM matches WHERE tournament_id = ?
      AND status IN ('on_table', 'pending')
      AND referee_name != '' AND event != ?
  `).all(match.tournament_id, match.event);
  for (const rm of refMatches) {
    if (getEventPriority(rm.event) >= myPriority) continue;
    // referee_name 単独 (team 不明) → 苗字のみ key
    const refK = buildPlayerKey(rm.referee_name, "");
    if (refK && !lockedKeys.has(refK)) {
      lockedKeys.set(refK, {
        event: rm.event, reason: "referee",
        label: `${rm.event} で審判担当中`,
      });
    }
  }

  // 自分の player keys が locked に含まれるかチェック
  const checkKey = (slot, displayName, key) => {
    if (!key || !lockedKeys.has(key)) return;
    const lock = lockedKeys.get(key);
    const k = slot + "|" + displayName + "|" + key;
    if (seenBlockKeys.has(k)) return;
    seenBlockKeys.add(k);
    blocks.push({
      slot, player_name: displayName,
      lock_info: lock,
      label: `${displayName}: ${lock.label}`,
    });
  };

  // entrant ベースで自分の keys を生成
  const ent1b = match.player1_entrant_id ? entrantStmts.get.get(match.player1_entrant_id) : null;
  if (ent1b) {
    checkKey("player1", ent1b.display_name || ent1b.name,
             buildPlayerKey(ent1b.surname || ent1b.name, ent1b.team));
    if (ent1b.partner_name || ent1b.partner_surname) {
      checkKey("player1_partner",
               ent1b.partner_name || ent1b.partner_surname,
               buildPlayerKey(ent1b.partner_surname || ent1b.partner_name, ent1b.partner_team || ent1b.team));
    }
  } else if (match.player1_name) {
    checkKey("player1", match.player1_name,
             buildPlayerKey(match.player1_name, match.player1_team));
  }
  const ent2b = match.player2_entrant_id ? entrantStmts.get.get(match.player2_entrant_id) : null;
  if (ent2b) {
    checkKey("player2", ent2b.display_name || ent2b.name,
             buildPlayerKey(ent2b.surname || ent2b.name, ent2b.team));
    if (ent2b.partner_name || ent2b.partner_surname) {
      checkKey("player2_partner",
               ent2b.partner_name || ent2b.partner_surname,
               buildPlayerKey(ent2b.partner_surname || ent2b.partner_name, ent2b.partner_team || ent2b.team));
    }
  } else if (match.player2_name) {
    checkKey("player2", match.player2_name,
             buildPlayerKey(match.player2_name, match.player2_team));
  }

  return blocks;
}

// 選手が現在「審判」として他の進行中/呼出中試合に拘束されているかチェック
function getPlayerRefereeLock(playerId, tournamentId, excludeMatchId) {
  if (!playerId) return null;
  const lock = sqlite.prepare(`
    SELECT id, table_no, status, event, round, player1_name, player2_name
    FROM matches
    WHERE tournament_id = ? AND referee_id = ?
      AND status IN ('pending', 'on_table')
      AND id != COALESCE(?, '')
    LIMIT 1
  `).get(tournamentId, playerId, excludeMatchId || "");
  return lock || null;
}

// 選手が現在「選手として」他の進行中試合にいるかチェック
function getPlayerPlayingLock(playerId, tournamentId, excludeMatchId) {
  if (!playerId) return null;
  const lock = sqlite.prepare(`
    SELECT id, table_no, event, round
    FROM matches
    WHERE tournament_id = ? AND status = 'on_table'
      AND (player1_id = ? OR player2_id = ?)
      AND id != COALESCE(?, '')
    LIMIT 1
  `).get(tournamentId, playerId, playerId, excludeMatchId || "");
  return lock || null;
}

// 台に呼ぶ（敗者審判ルールを enforce）
// opts:
//   force: 拘束チェックを無視
//   referee_name: DB外の任意名を審判に指定 (referee_id が指定されていない時のみ)
//   auto_assign_referee: 同台の直前敗者を自動審判アサイン (default: true)
function callMatch(matchId, tableNo, refereeId, opts) {
  opts = opts || {};
  const m = stmts.getMatch.get(matchId);
  if (!m) return { error: "試合が見つかりません" };
  if (m.status !== "pending") return { error: "呼べる状態ではありません (status=" + m.status + ")" };

  const t = stmts.getTournament.get(m.tournament_id);
  const enforce = t && t.enforce_referee_rule !== 0;

  // 同じ台に別試合がいないか
  if (tableNo > 0) {
    const conflict = sqlite.prepare(
      `SELECT id FROM matches WHERE tournament_id=? AND status='on_table' AND table_no=? AND id != ?`
    ).get(m.tournament_id, tableNo, matchId);
    if (conflict) return { error: `台${tableNo}は既に使用中です` };
  }

  // 選手の拘束チェック (同種目内の試合・審判 拘束 + 種目優先順位)
  if (enforce && !opts.force) {
    const blocks = [];
    [["player1", m.player1_id, m.player1_name],
     ["player2", m.player2_id, m.player2_name]].forEach(([slot, pid, pname]) => {
      if (!pid) return;
      const refLock = getPlayerRefereeLock(pid, m.tournament_id, matchId);
      if (refLock) {
        blocks.push({
          slot, player_name: pname, type: "referee",
          locked_by_match: refLock.id, locked_by_table: refLock.table_no,
          locked_by_label: `台${refLock.table_no} ${refLock.event} ${refLock.round} (審判担当中)`,
        });
      }
      const playLock = getPlayerPlayingLock(pid, m.tournament_id, matchId);
      if (playLock) {
        blocks.push({
          slot, player_name: pname, type: "playing",
          locked_by_match: playLock.id, locked_by_table: playLock.table_no,
          locked_by_label: `台${playLock.table_no} ${playLock.event} ${playLock.round} (試合中)`,
        });
      }
    });

    // 種目優先順位ロック (上位種目で生存中なら下位種目に呼べない)
    const priorityBlocks = getMatchPriorityBlocks(m);
    priorityBlocks.forEach(pb => {
      blocks.push({
        slot: pb.slot, player_name: pb.player_name, type: "priority",
        priority_event: pb.lock_info.event,
        priority_reason: pb.lock_info.reason,
        locked_by_label: pb.lock_info.label,
      });
    });

    if (blocks.length) {
      return {
        error: blocks.some(b => b.type === "priority")
          ? "上位種目で勝ち上がり中の選手がいるため呼べません"
          : "選手が他の試合に拘束されています",
        blocked: blocks,
        hint: "force=true を付けると強制的に呼べます",
      };
    }
  }

  // 審判 (DB 選手) の拘束チェック
  if (refereeId && enforce && !opts.force) {
    const refLock = getPlayerRefereeLock(refereeId, m.tournament_id, matchId);
    const playLock = getPlayerPlayingLock(refereeId, m.tournament_id, matchId);
    if (refLock || playLock) {
      return {
        error: "審判候補の選手が他の試合に拘束されています",
        referee_blocked: refLock || playLock,
      };
    }
  }

  opStmts.setTable.run(tableNo, matchId);

  // 団体戦の追加台 (extra_tables)
  if (opts.extra_tables && Array.isArray(opts.extra_tables) && opts.extra_tables.length) {
    // 同じ台に別試合がいないかチェック
    for (const et of opts.extra_tables) {
      const etNo = parseInt(et);
      if (!etNo || etNo === tableNo) continue;
      const conflict = sqlite.prepare(
        `SELECT id FROM matches WHERE tournament_id=? AND status='on_table' AND
          (table_no=? OR ','||extra_tables||',' LIKE '%,'||?||',%')
         AND id != ?`
      ).get(m.tournament_id, etNo, String(etNo), matchId);
      if (conflict) {
        // ロールバック (簡易): table_no をクリア
        opStmts.clearTable.run(matchId);
        return { error: `追加台${etNo}は既に使用中です` };
      }
    }
    const extras = opts.extra_tables
      .map(n => parseInt(n)).filter(n => n > 0 && n !== tableNo)
      .join(",");
    sqlite.prepare(`UPDATE matches SET extra_tables = ? WHERE id = ?`).run(extras, matchId);
  }

  // 審判アサイン
  if (refereeId) {
    // DB 選手指定
    const ref = stmts.getPlayer.get(refereeId);
    if (ref) {
      opStmts.setReferee.run(refereeId, ref.name, matchId);
    }
  } else if (opts.referee_name) {
    // 手動入力の氏名 (DB 外でも OK)
    opStmts.setReferee.run(null, String(opts.referee_name).trim(), matchId);
  } else if (opts.auto_assign_referee !== false && tableNo > 0) {
    // 自動: 同じ台で直前に試合終了した敗者を審判に
    const prev = sqlite.prepare(`
      SELECT loser_id, loser_name FROM matches
      WHERE tournament_id = ? AND table_no = ? AND status = 'completed'
        AND loser_name != '' AND loser_name != 'BYE'
      ORDER BY finished_at DESC LIMIT 1
    `).get(m.tournament_id, tableNo);
    // ※ finish 時に table_no=0 にしているので、上のクエリは即座にはマッチしない。
    //   代替: 「called_at が最も新しい completed」を referee_queue から取る
    if (!prev) {
      const recent = sqlite.prepare(`
        SELECT loser_id, loser_name FROM matches
        WHERE tournament_id = ? AND status = 'completed' AND finished_at != ''
          AND loser_name != '' AND loser_name != 'BYE'
          AND NOT EXISTS (
            SELECT 1 FROM matches m2 WHERE m2.referee_id = matches.loser_id
              AND m2.status IN ('pending','on_table'))
        ORDER BY finished_at DESC LIMIT 1
      `).get(m.tournament_id);
      if (recent && recent.loser_name) {
        opStmts.setReferee.run(recent.loser_id || null, recent.loser_name, matchId);
      }
    } else {
      opStmts.setReferee.run(prev.loser_id || null, prev.loser_name, matchId);
    }
  }

  return stmts.getMatch.get(matchId);
}

// 試合の「審判要否」を切り替え
function setRefereeRequired(matchId, required) {
  sqlite.prepare(`UPDATE matches SET referee_required = ? WHERE id = ?`)
    .run(required ? 1 : 0, matchId);
  // 不要にする場合、現在の審判を解除
  if (!required) {
    opStmts.setReferee.run(null, "", matchId);
  }
  return stmts.getMatch.get(matchId);
}

// 再コール回数を設定 (manual override)
// slot 引数で選手別: 1=選手1, 2=選手2, 'both'=両方リセット
function setCallCount(matchId, count, slot) {
  const c = Math.max(0, Math.min(99, parseInt(count) || 0));
  if (slot === 1) {
    opStmts.setCallCountP1.run(c, matchId);
  } else if (slot === 2) {
    opStmts.setCallCountP2.run(c, matchId);
  } else {
    // 全体リセット (互換性: count=0 でクリア)
    opStmts.setCallCount.run(c, matchId);
    if (c === 0) {
      opStmts.setCallCountP1.run(0, matchId);
      opStmts.setCallCountP2.run(0, matchId);
    }
  }
  return stmts.getMatch.get(matchId);
}

// 再コール +1 (slot で選手指定: 1=選手1, 2=選手2)
function bumpCallCount(matchId, slot) {
  if (slot === 2) {
    opStmts.bumpCallCountP2.run(matchId);
  } else if (slot === 1) {
    opStmts.bumpCallCountP1.run(matchId);
  } else {
    // slot 未指定 (互換性): 両方+1
    opStmts.bumpCallCount.run(matchId);
  }
  return stmts.getMatch.get(matchId);
}

// 任意の選手を審判に割り当て (敗者プール外でもOK)
// opts.referee_name でDB外の氏名指定可能 (refereeId 未指定時)
function assignAnyReferee(matchId, refereeId, opts) {
  opts = opts || {};
  // 名前のみ指定 (DB外の手動氏名)
  if (!refereeId && opts.referee_name) {
    opStmts.setReferee.run(null, String(opts.referee_name).trim(), matchId);
    return stmts.getMatch.get(matchId);
  }
  if (!refereeId) {
    opStmts.setReferee.run(null, "", matchId);
    return stmts.getMatch.get(matchId);
  }
  const m = stmts.getMatch.get(matchId);
  if (!m) return { error: "試合が見つかりません" };
  const ref = stmts.getPlayer.get(refereeId);
  if (!ref) return { error: "選手が見つかりません" };

  // 拘束チェック (force=true で skip)
  const t = stmts.getTournament.get(m.tournament_id);
  const enforce = t && t.enforce_referee_rule !== 0;
  if (enforce && !opts.force) {
    const refLock = getPlayerRefereeLock(refereeId, m.tournament_id, matchId);
    const playLock = getPlayerPlayingLock(refereeId, m.tournament_id, matchId);
    if (refLock || playLock) {
      return {
        error: `${ref.name} は他の試合に拘束されています`,
        locked_by: refLock || playLock,
      };
    }
    // この選手が player1/player2 として callable な試合があれば警告
    const conflict = sqlite.prepare(`
      SELECT id, event, round, table_no FROM matches
      WHERE tournament_id = ? AND status IN ('pending')
        AND (player1_id = ? OR player2_id = ?)
        AND id != ?
      LIMIT 1
    `).get(m.tournament_id, refereeId, refereeId, matchId);
    // pending は warning だが許容（審判後に呼ばれる）
  }
  opStmts.setReferee.run(refereeId, ref.name, matchId);
  return stmts.getMatch.get(matchId);
}

// 台から戻す（キャンセル）
function uncallMatch(matchId) {
  opStmts.clearTable.run(matchId);
  return stmts.getMatch.get(matchId);
}

// 審判を割り当て
function assignReferee(matchId, refereeId) {
  if (refereeId) {
    const ref = stmts.getPlayer.get(refereeId);
    if (ref) opStmts.setReferee.run(refereeId, ref.name, matchId);
  } else {
    opStmts.setReferee.run(null, "", matchId);
  }
  return stmts.getMatch.get(matchId);
}

// 呼べる試合一覧
function getCallableMatches(tournamentId) {
  return opStmts.getPendingMatches.all(tournamentId).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
}

// 進行中の試合（台割込み）
function getOnTableMatches(tournamentId) {
  return opStmts.getOnTableMatches.all(tournamentId).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
}

// 敗者→審判候補 (直近敗者で、まだ審判アサインされていない選手)
// ※ 一度審判を担当した選手は履歴から外し、再アサインしない
function getRefereeQueue(tournamentId, event) {
  const finished = sqlite.prepare(`
    SELECT m.loser_id, m.loser_name, m.loser_team, m.event, m.finished_at, m.id AS match_id
    FROM matches m
    WHERE m.tournament_id=? AND m.status='completed' AND m.loser_id IS NOT NULL
      AND m.loser_name != 'BYE' AND m.finished_at != ''
    ORDER BY m.finished_at DESC
    LIMIT 30
  `).all(tournamentId);

  // 同大会内で 過去に審判を担当 (現在 進行中 or 完了 を含む) 選手の id 集合
  const referedIds = new Set(sqlite.prepare(`
    SELECT DISTINCT referee_id FROM matches
    WHERE tournament_id=? AND referee_id IS NOT NULL
  `).all(tournamentId).map(r => r.referee_id));
  // 苗字+所属での同一性判定 (player_id が null の場合用)
  const referedKeys = new Set(sqlite.prepare(`
    SELECT DISTINCT referee_name FROM matches
    WHERE tournament_id=? AND referee_name IS NOT NULL AND referee_name != ''
  `).all(tournamentId).map(r => (r.referee_name || "").trim()));

  return finished.filter(f => {
    if (event && f.event !== event) return false;
    // 現在審判アサイン中?
    const assigned = opStmts.getRefereeFor.get(f.loser_id);
    if (assigned) return false;
    // 過去に審判済?
    if (f.loser_id && referedIds.has(f.loser_id)) return false;
    if (f.loser_name && referedKeys.has(f.loser_name.trim())) return false;
    return true;
  });
}

// 進行状況サマリ
function getOperationState(tournamentId) {
  const tournament = getTournament(tournamentId);
  if (!tournament) return null;

  // entrants から bracket_number / bracket_side を join (LEFT JOIN なので未登録選手も問題なし)
  const allMatches = sqlite.prepare(`
    SELECT m.*,
      e1.bracket_number AS player1_bracket_number,
      e1.bracket_side AS player1_bracket_side,
      e1.furigana AS player1_furigana,
      e1.partner_furigana AS player1_partner_furigana,
      e2.bracket_number AS player2_bracket_number,
      e2.bracket_side AS player2_bracket_side,
      e2.furigana AS player2_furigana,
      e2.partner_furigana AS player2_partner_furigana
    FROM matches m
    LEFT JOIN entrants e1 ON e1.id = m.player1_entrant_id
    LEFT JOIN entrants e2 ON e2.id = m.player2_entrant_id
    WHERE m.tournament_id=?
    ORDER BY m.bracket_round ASC, m.bracket_pos ASC, m.match_no ASC
  `).all(tournamentId).map(m => ({ ...m, sets: JSON.parse(m.sets_json || "[]") }));

  const onTable = allMatches.filter(m => m.status === "on_table");
  const callableRaw = allMatches.filter(m => m.status === "pending");
  const waiting = allMatches.filter(m => m.status === "waiting");
  const finished = allMatches.filter(m => m.status === "completed");
  // 直近結果: BYE (シード繰り上がり) は実試合ではないため除外
  const recent = finished
    .filter(m => m.finished_at && m.winner_name !== "BYE" && m.loser_name !== "BYE")
    .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""))
    .slice(0, 10);

  // callable に拘束情報を付与 (バッチクエリで高速化)
  const enforce = tournament.enforce_referee_rule !== 0;
  let refereeLockByPlayer = new Map();  // player_id -> { match_id, table_no }
  let playingLockByPlayer = new Map();
  if (enforce) {
    // すべての active 試合の referee と players を1クエリで取得
    const activeMatches = sqlite.prepare(`
      SELECT id, table_no, status, event, round, referee_id, player1_id, player2_id
      FROM matches
      WHERE tournament_id=? AND status IN ('pending', 'on_table')
    `).all(tournamentId);
    activeMatches.forEach(am => {
      if (am.referee_id) {
        refereeLockByPlayer.set(am.referee_id, { id: am.id, table_no: am.table_no });
      }
      if (am.status === "on_table") {
        if (am.player1_id) playingLockByPlayer.set(am.player1_id, { id: am.id, table_no: am.table_no });
        if (am.player2_id) playingLockByPlayer.set(am.player2_id, { id: am.id, table_no: am.table_no });
      }
    });
  }
  const callable = callableRaw.map(m => {
    const blocks = [];
    if (enforce) {
      [["player1", m.player1_id, m.player1_name],
       ["player2", m.player2_id, m.player2_name]].forEach(([slot, pid, pname]) => {
        if (!pid) return;
        const refLock = refereeLockByPlayer.get(pid);
        if (refLock && refLock.id !== m.id) blocks.push({
          slot, player_name: pname, type: "referee",
          label: `台${refLock.table_no} で審判担当中`,
          locked_by_match: refLock.id,
        });
        const playLock = playingLockByPlayer.get(pid);
        if (playLock && playLock.id !== m.id) blocks.push({
          slot, player_name: pname, type: "playing",
          label: `台${playLock.table_no} で試合中`,
          locked_by_match: playLock.id,
        });
      });
      // 種目優先順位ロック
      const pBlocks = getMatchPriorityBlocks(m);
      pBlocks.forEach(pb => {
        blocks.push({
          slot: pb.slot, player_name: pb.player_name, type: "priority",
          label: pb.lock_info.label,
          priority_event: pb.lock_info.event,
          priority_reason: pb.lock_info.reason,
        });
      });
    }
    return { ...m, blocks, is_blocked: blocks.length > 0,
             event_priority: getEventPriority(m.event) };
  });
  // 優先度順ソート: 団体 → 混合D → ダブルス → シングルス
  // ロックなし > ロック有り の順、さらに同 priority ではラウンド順 (deep round → 早く)
  callable.sort((a, b) => {
    // ロック有りは末尾へ
    if (a.is_blocked !== b.is_blocked) return a.is_blocked ? 1 : -1;
    // 優先度 (小さいほど上位)
    if (a.event_priority !== b.event_priority) return a.event_priority - b.event_priority;
    // ラウンド (round_order 小さい = 決勝に近い = 優先)
    return (a.round_order || 99) - (b.round_order || 99);
  });

  // 台ごとに割り当て (numbering_origin に応じてdisplay順とtable_noを対応付け)
  const rows = tournament.court_rows || 4;
  const cols = tournament.court_cols || 11;
  const origin = tournament.numbering_origin || "bottom-right";
  const tables = [];
  // display_row=1..rows (top→bottom), display_col=1..cols (left→right) で描画される順に table_no を計算
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      let table_no;
      switch (origin) {
        case "bottom-right": // 右下=1, 左に増加、上に折返し (卓球協会 標準)
          table_no = (rows - r) * cols + (cols - c + 1);
          break;
        case "bottom-left":
          table_no = (rows - r) * cols + c;
          break;
        case "top-right":
          table_no = (r - 1) * cols + (cols - c + 1);
          break;
        case "top-left":
        default:
          table_no = (r - 1) * cols + c;
      }
      // 主台 or 追加台 (extra_tables) のいずれかに該当する試合を表示
      let match = onTable.find(m => m.table_no === table_no) || null;
      let isExtra = false;
      if (!match) {
        // extra_tables の文字列 "5,6" を split して該当チェック
        match = onTable.find(m => {
          if (!m.extra_tables) return false;
          return m.extra_tables.split(",").map(s => parseInt(s.trim()))
            .includes(table_no);
        });
        if (match) isExtra = true;
      }
      tables.push({ table_no, display_row: r, display_col: c, match,
                    is_extra: isExtra });
    }
  }

  // イベント別 統計
  const eventStats = {};
  allMatches.forEach(m => {
    const e = m.event || "(未分類)";
    if (!eventStats[e]) eventStats[e] = { total: 0, completed: 0, on_table: 0, pending: 0, waiting: 0 };
    eventStats[e].total++;
    eventStats[e][m.status] = (eventStats[e][m.status] || 0) + 1;
  });

  return {
    tournament: {
      id: tournament.id, name: tournament.name, date: tournament.date,
      venue: tournament.venue, status: tournament.status,
      court_rows: rows, court_cols: cols, hq_position: tournament.hq_position || "bottom",
    },
    tables,
    on_table: onTable,
    callable,
    waiting: waiting.length,
    recent_finished: recent,
    referee_queue: getRefereeQueue(tournamentId),
    event_stats: eventStats,
    total_matches: allMatches.length,
  };
}

// 選手個人の試合状況 (マイ番号ポータル用)
// 進行中の試合・次の試合・直近結果を返す
function getPlayerLiveStatus(playerId, tournamentId) {
  const player = stmts.getPlayer.get(playerId);
  if (!player) return null;

  // tournamentId が指定されていない場合、その選手が出場している ongoing 大会を自動選択
  let activeTournamentId = tournamentId;
  if (!activeTournamentId) {
    const ongoing = sqlite.prepare(`
      SELECT DISTINCT t.id, t.name, t.date FROM tournaments t
      JOIN tournament_players tp ON tp.tournament_id = t.id
      WHERE tp.player_id = ? AND t.status IN ('ongoing','scheduled')
      ORDER BY t.date DESC LIMIT 1
    `).get(playerId);
    if (ongoing) activeTournamentId = ongoing.id;
  }

  if (!activeTournamentId) {
    return {
      player: { id: player.id, name: player.name, team: player.team, rating: player.rating },
      tournament: null,
      current: null, next: null, recent: [],
      message: "出場中の大会がありません",
    };
  }

  const tournament = stmts.getTournament.get(activeTournamentId);

  // 該当選手が player1/player2/referee として関わる試合を取得
  const allMine = sqlite.prepare(`
    SELECT * FROM matches
    WHERE tournament_id = ?
      AND (player1_id = ? OR player2_id = ? OR referee_id = ?)
    ORDER BY bracket_round ASC, bracket_pos ASC, match_no ASC
  `).all(activeTournamentId, playerId, playerId, playerId)
    .map(m => ({ ...m, sets: JSON.parse(m.sets_json || "[]") }));

  // 現在 on_table の試合 (自分が選手 or 審判)
  const current = allMine.find(m => m.status === "on_table" &&
    (m.player1_id === playerId || m.player2_id === playerId)) || null;

  // 自分が審判担当中の試合
  const refereeing = allMine.find(m => m.status === "on_table" &&
    m.referee_id === playerId) || null;

  // 次に呼ばれる試合 (pending 状態で自分が選手)
  const nextCallable = allMine.find(m => m.status === "pending" &&
    (m.player1_id === playerId || m.player2_id === playerId)) || null;

  // それも無ければ waiting で自分が居る試合 (待機中)
  const nextWaiting = allMine.find(m => m.status === "waiting" &&
    (m.player1_id === playerId || m.player2_id === playerId)) || null;

  // 直近終了の自分の試合 (勝敗結果表示用)
  const recent = allMine
    .filter(m => m.status === "completed" &&
      (m.winner_id === playerId || m.loser_id === playerId))
    .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""))
    .slice(0, 5);

  // 自分の状況判定 (画面表示用 enum)
  let myState;
  if (current) myState = "playing";        // 進行中
  else if (refereeing) myState = "refereeing"; // 審判中
  else if (nextCallable) myState = "callable"; // 呼出可能
  else if (nextWaiting) myState = "waiting";   // 待機
  else if (recent.length && allMine.every(m => m.status === "completed"))
    myState = "finished";                  // 大会終了 (全試合終了)
  else myState = "idle";

  return {
    player: { id: player.id, name: player.name, team: player.team,
              rating: player.rating, furigana: player.furigana },
    tournament: {
      id: tournament.id, name: tournament.name, date: tournament.date,
      venue: tournament.venue, status: tournament.status,
      court_rows: tournament.court_rows, court_cols: tournament.court_cols,
      hq_position: tournament.hq_position,
      numbering_origin: tournament.numbering_origin,
    },
    my_state: myState,
    current,            // 進行中試合 (自分が選手)
    refereeing,         // 審判担当中試合
    next: nextCallable || nextWaiting,  // 次の試合
    next_status: nextCallable ? "pending" : (nextWaiting ? "waiting" : null),
    recent,             // 直近結果
    // タイムスタンプ (変化検知用 - クライアントが diff してnotify)
    last_event_at: [
      current?.called_at, current?.started_at,
      nextCallable?.called_at,
      ...recent.map(r => r.finished_at)
    ].filter(Boolean).sort().reverse()[0] || tournament.updated_at,
  };
}

// イベント別ブラケット
function getBracket(tournamentId, event) {
  const matches = opStmts.getBracketMatches.all(tournamentId, event).map(m => ({
    ...m, sets: JSON.parse(m.sets_json || "[]")
  }));
  // round別にグループ化
  const byRound = {};
  matches.forEach(m => {
    const r = m.bracket_round || 0;
    (byRound[r] = byRound[r] || []).push(m);
  });
  return {
    event,
    rounds: Object.entries(byRound)
      .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
      .map(([r, ms]) => ({ round_number: parseInt(r), round_name: ms[0]?.round || "", matches: ms })),
  };
}

// イベントの全試合を削除（ブラケット再生成用）
function deleteEventMatches(tournamentId, event) {
  opStmts.deleteEventMatches.run(tournamentId, event);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
// 試合検索 (試合結果DB)
// ═══════════════════════════════════════════════════════
function searchMatches(filters) {
  filters = filters || {};
  let sql = `
    SELECT m.*, t.name AS tournament_name, t.date AS tournament_date,
           t.venue AS tournament_venue, t.category AS tournament_category
    FROM matches m
    LEFT JOIN tournaments t ON m.tournament_id = t.id
    WHERE m.status = 'completed' AND m.winner_name != ''
      AND m.loser_name != 'BYE' AND m.winner_name != 'BYE'
  `;
  const params = [];

  if (filters.tournament_id) {
    sql += ` AND m.tournament_id = ?`;
    params.push(filters.tournament_id);
  }
  if (filters.year) {
    sql += ` AND (substr(COALESCE(NULLIF(t.date,''), m.played_at), 1, 4) = ?)`;
    params.push(String(filters.year));
  }
  if (filters.event) {
    sql += ` AND m.event LIKE ?`;
    params.push("%" + filters.event + "%");
  }
  if (filters.round) {
    sql += ` AND m.round = ?`;
    params.push(filters.round);
  }
  if (filters.category) {
    sql += ` AND t.category = ?`;
    params.push(filters.category);
  }
  if (filters.player_id) {
    sql += ` AND (m.winner_id = ? OR m.loser_id = ?)`;
    params.push(filters.player_id, filters.player_id);
  }
  if (filters.player_name) {
    sql += ` AND (m.winner_name LIKE ? OR m.loser_name LIKE ?)`;
    const q = "%" + filters.player_name + "%";
    params.push(q, q);
  }
  if (filters.team) {
    sql += ` AND (m.winner_team LIKE ? OR m.loser_team LIKE ?)`;
    const q = "%" + filters.team + "%";
    params.push(q, q);
  }
  if (filters.opponent_name) {
    // 選手指定がある時のみ意味あり: 対戦相手で絞り込み
    sql += ` AND (m.winner_name LIKE ? OR m.loser_name LIKE ?)`;
    const q = "%" + filters.opponent_name + "%";
    params.push(q, q);
  }
  if (filters.min_total_sets != null) {
    sql += ` AND (m.winner_sets + m.loser_sets) >= ?`;
    params.push(parseInt(filters.min_total_sets));
  }
  if (filters.max_total_sets != null) {
    sql += ` AND (m.winner_sets + m.loser_sets) <= ?`;
    params.push(parseInt(filters.max_total_sets));
  }

  sql += ` ORDER BY t.date DESC, m.round_order ASC, m.match_no ASC`;
  const limit = Math.min(parseInt(filters.limit) || 50, 500);
  const offset = parseInt(filters.offset) || 0;
  sql += ` LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = sqlite.prepare(sql).all(...params);
  return rows.map(m => ({ ...m, sets: JSON.parse(m.sets_json || "[]") }));
}

function countMatchesForSearch(filters) {
  filters = filters || {};
  let sql = `
    SELECT COUNT(*) AS c FROM matches m
    LEFT JOIN tournaments t ON m.tournament_id = t.id
    WHERE m.status = 'completed' AND m.winner_name != ''
      AND m.loser_name != 'BYE' AND m.winner_name != 'BYE'
  `;
  const params = [];
  if (filters.tournament_id) { sql += ` AND m.tournament_id = ?`; params.push(filters.tournament_id); }
  if (filters.year) {
    sql += ` AND (substr(COALESCE(NULLIF(t.date,''), m.played_at), 1, 4) = ?)`;
    params.push(String(filters.year));
  }
  if (filters.event) { sql += ` AND m.event LIKE ?`; params.push("%" + filters.event + "%"); }
  if (filters.round) { sql += ` AND m.round = ?`; params.push(filters.round); }
  if (filters.category) { sql += ` AND t.category = ?`; params.push(filters.category); }
  if (filters.player_id) {
    sql += ` AND (m.winner_id = ? OR m.loser_id = ?)`;
    params.push(filters.player_id, filters.player_id);
  }
  if (filters.player_name) {
    sql += ` AND (m.winner_name LIKE ? OR m.loser_name LIKE ?)`;
    const q = "%" + filters.player_name + "%";
    params.push(q, q);
  }
  if (filters.team) {
    sql += ` AND (m.winner_team LIKE ? OR m.loser_team LIKE ?)`;
    const q = "%" + filters.team + "%";
    params.push(q, q);
  }
  return sqlite.prepare(sql).get(...params).c;
}

// 検索フィルターオプション(プルダウン用)
function getSearchFilters() {
  return {
    tournaments: sqlite.prepare(`
      SELECT id, name, date, category FROM tournaments
      ORDER BY date DESC LIMIT 200
    `).all(),
    years: sqlite.prepare(`
      SELECT DISTINCT substr(date, 1, 4) AS year FROM tournaments
      WHERE date != '' ORDER BY year DESC
    `).all().map(r => r.year).filter(Boolean),
    events: sqlite.prepare(`
      SELECT DISTINCT event FROM matches WHERE event != '' ORDER BY event
    `).all().map(r => r.event),
    rounds: sqlite.prepare(`
      SELECT DISTINCT round, round_order FROM matches WHERE round != ''
      ORDER BY round_order ASC
    `).all().map(r => r.round),
    categories: sqlite.prepare(`
      SELECT DISTINCT category FROM tournaments WHERE category != '' ORDER BY category
    `).all().map(r => r.category),
  };
}

// ═══════════════════════════════════════════════════════
// 対戦相手別戦績 (Head-to-Head)
// ═══════════════════════════════════════════════════════
function getPlayerOpponents(playerId) {
  const wins = sqlite.prepare(`
    SELECT loser_id AS opp_id, loser_name AS opp_name, loser_team AS opp_team,
      COUNT(*) AS count
    FROM matches WHERE winner_id = ? AND loser_id IS NOT NULL
      AND status = 'completed' AND loser_name != 'BYE'
    GROUP BY loser_id
  `).all(playerId);
  const losses = sqlite.prepare(`
    SELECT winner_id AS opp_id, winner_name AS opp_name, winner_team AS opp_team,
      COUNT(*) AS count
    FROM matches WHERE loser_id = ? AND winner_id IS NOT NULL
      AND status = 'completed' AND winner_name != 'BYE'
    GROUP BY winner_id
  `).all(playerId);
  const map = {};
  wins.forEach(w => {
    if (!w.opp_id) return;
    map[w.opp_id] = { opp_id: w.opp_id, name: w.opp_name, team: w.opp_team, wins: w.count, losses: 0 };
  });
  losses.forEach(l => {
    if (!l.opp_id) return;
    if (!map[l.opp_id]) map[l.opp_id] = { opp_id: l.opp_id, name: l.opp_name, team: l.opp_team, wins: 0, losses: 0 };
    map[l.opp_id].losses = l.count;
  });
  return Object.values(map).map(o => ({
    ...o, total: o.wins + o.losses,
    win_rate: o.wins + o.losses === 0 ? 0 : Math.round(o.wins / (o.wins + o.losses) * 100),
  })).sort((a, b) => b.total - a.total);
}

function getHeadToHead(p1Id, p2Id) {
  const matches = sqlite.prepare(`
    SELECT m.*, t.name AS tournament_name, t.date AS tournament_date
    FROM matches m LEFT JOIN tournaments t ON m.tournament_id = t.id
    WHERE m.status = 'completed' AND
      ((m.winner_id = ? AND m.loser_id = ?) OR (m.winner_id = ? AND m.loser_id = ?))
    ORDER BY t.date DESC, m.created_at DESC
  `).all(p1Id, p2Id, p2Id, p1Id).map(m => ({ ...m, sets: JSON.parse(m.sets_json || "[]") }));
  const p1Wins = matches.filter(m => m.winner_id === p1Id).length;
  const p2Wins = matches.filter(m => m.winner_id === p2Id).length;
  return { p1_id: p1Id, p2_id: p2Id, p1_wins: p1Wins, p2_wins: p2Wins, total: matches.length, matches };
}

// 選手の種目別統計
function getPlayerEventStats(playerId) {
  const stats = sqlite.prepare(`
    SELECT event,
      SUM(CASE WHEN winner_id = ? THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN loser_id = ? THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN winner_id = ? THEN winner_sets WHEN loser_id = ? THEN loser_sets ELSE 0 END) AS sets_won,
      SUM(CASE WHEN winner_id = ? THEN loser_sets WHEN loser_id = ? THEN winner_sets ELSE 0 END) AS sets_lost
    FROM matches WHERE (winner_id = ? OR loser_id = ?)
      AND status = 'completed' AND event != ''
      AND loser_name != 'BYE' AND winner_name != 'BYE'
    GROUP BY event
    ORDER BY (wins + losses) DESC
  `).all(playerId, playerId, playerId, playerId, playerId, playerId, playerId, playerId);
  return stats;
}

// ═══════════════════════════════════════════════════════
// 大会申込 (Entry / Application)
// ═══════════════════════════════════════════════════════
const entryStmts = {
  insertOrUpdateEntry: sqlite.prepare(`
    INSERT INTO tournament_players (tournament_id, player_id, event, seed, status, applied_at, entry_note)
    VALUES (@tournament_id, @player_id, @event, @seed, @status, @applied_at, @entry_note)
    ON CONFLICT(tournament_id, player_id, event) DO UPDATE SET
      status = excluded.status,
      applied_at = COALESCE(NULLIF(tournament_players.applied_at, ''), excluded.applied_at),
      entry_note = excluded.entry_note
  `),
  setEntryStatus: sqlite.prepare(`
    UPDATE tournament_players SET status = ?
    WHERE tournament_id = ? AND player_id = ?
  `),
  setEntryStatusForEvent: sqlite.prepare(`
    UPDATE tournament_players SET status = ?
    WHERE tournament_id = ? AND player_id = ? AND event = ?
  `),
  setEntrySeed: sqlite.prepare(`
    UPDATE tournament_players SET seed = ?
    WHERE tournament_id = ? AND player_id = ? AND event = ?
  `),
};

function createEntry(tournamentId, data) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return { error: "大会が見つかりません" };
  // 申込締切チェック（オプション）
  if (!t.entries_open) return { error: "現在この大会は申込を受け付けていません" };
  if (t.entry_deadline) {
    const today = new Date().toISOString().split("T")[0];
    if (today > t.entry_deadline) {
      return { error: `申込締切（${t.entry_deadline}）を過ぎています` };
    }
  }

  if (!data.name || !data.name.trim()) return { error: "氏名は必須です" };
  const events = Array.isArray(data.events) ? data.events.filter(Boolean) : (data.events ? [data.events] : []);
  if (!events.length) return { error: "出場種目を1つ以上選択してください" };

  // 既存選手検索 → なければ新規作成
  let player = findPlayerByName(data.name, data.team);
  let isNewPlayer = false;
  if (!player) {
    player = createPlayer({
      name: data.name.trim(),
      furigana: data.furigana || "",
      team: data.team || "",
      gender: data.gender || "male",
      category: data.category || "general",
      note: data.note || "",
    });
    isNewPlayer = true;
  } else {
    // 不足情報を補完（ふりがな等）
    if (data.furigana && !player.furigana) {
      updatePlayer(player.id, { ...player, furigana: data.furigana });
    }
  }

  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const status = data.auto_confirm ? "confirmed" : "pending";
  events.forEach(ev => {
    entryStmts.insertOrUpdateEntry.run({
      tournament_id: tournamentId,
      player_id: player.id,
      event: ev,
      seed: 0,
      status,
      applied_at: now,
      entry_note: data.note || "",
    });
  });
  return { ok: true, player_id: player.id, player_name: player.name, events, status, new_player: isNewPlayer };
}

// ── チーム/個人混在のフォーム送信を受け取って entrants + tournament_players 両方に記録
// formData は entry_form.js の gatherFormData() が出すシェイプ:
//   { tournament_id, team_name, contact_name, contact_tel, contact_email,
//     supervisor, coach, note, submitted_at, total_amount,
//     entries: [
//       { event, type:"singles", fee, name, team },
//       { event, type:"doubles", fee, name1, name2, team },
//       { event, type:"team", fee, team_name, members:[...] },
//       { event, type:"custom", fee, name, team },
//     ] }
function createTeamEntry(tournamentId, formData) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return { error: "大会が見つかりません" };

  // 申込受付チェック
  if (!t.entries_open) return { error: "現在この大会は申込を受け付けていません" };
  if (t.entry_deadline) {
    const today = new Date().toISOString().split("T")[0];
    if (today > t.entry_deadline) {
      return { error: `申込締切（${t.entry_deadline}）を過ぎています` };
    }
  }

  const entries = Array.isArray(formData.entries) ? formData.entries : [];
  if (!entries.length) return { error: "出場種目を1つ以上選択してください" };

  // ── 入力制限 (DoS / スパム / 巨大データ投入 対策) ──
  if (entries.length > 100) {
    return { error: "1回の申込は100件までです" };
  }
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
  // 各文字列フィールドを安全な長さに切り詰め (200字)
  for (const ent of entries) {
    if (ent.event) ent.event = clip(ent.event, 100);
    if (ent.name) ent.name = clip(ent.name, 200);
    if (ent.name1) ent.name1 = clip(ent.name1, 200);
    if (ent.name2) ent.name2 = clip(ent.name2, 200);
    if (ent.team) ent.team = clip(ent.team, 200);
    if (ent.team1) ent.team1 = clip(ent.team1, 200);
    if (ent.team2) ent.team2 = clip(ent.team2, 200);
    if (ent.team_name) ent.team_name = clip(ent.team_name, 200);
    if (Array.isArray(ent.members)) {
      ent.members = ent.members.slice(0, 30).map(m => clip(m, 200));
    }
  }
  // 連絡先・備考も制限
  formData.team_name = clip(formData.team_name, 200);
  formData.contact_name = clip(formData.contact_name, 100);
  formData.contact_email = clip(formData.contact_email, 200);
  formData.contact_tel = clip(formData.contact_tel, 50);
  formData.note = clip(formData.note, 2000);

  const submittedAt = (formData.submitted_at
    ? new Date(formData.submitted_at)
    : new Date()).toISOString().slice(0, 19).replace("T", " ");

  const status = "pending"; // 全申込は受付確認待ち
  const noteBase = String(formData.note || "").trim();
  const contactInfo = [
    formData.contact_name ? `担当: ${formData.contact_name}` : "",
    formData.contact_email ? `${formData.contact_email}` : "",
    formData.contact_tel ? `TEL: ${formData.contact_tel}` : "",
  ].filter(Boolean).join(" / ");

  const createdEntrants = [];
  const tpEntries = []; // for tournament_players (status tracking)

  for (const ent of entries) {
    const evName = String(ent.event || "").trim();
    if (!evName) continue;
    const type = ent.type || "singles";

    if (type === "team") {
      // 団体戦: 1チーム=1 entrant。members は note に保持
      const tn = String(ent.team_name || formData.team_name || "").trim();
      const members = Array.isArray(ent.members) ? ent.members.filter(Boolean) : [];
      if (!tn && members.length === 0) continue;
      const e = createEntrant({
        tournament_id: tournamentId,
        event: evName,
        name: tn || (members[0] || ""),
        team: tn,
        category: ent.category || "general",
        gender: ent.gender || "",
        status,
        note: [
          `[団体] メンバー: ${members.join("、")}`,
          contactInfo,
          noteBase,
        ].filter(Boolean).join(" | "),
      });
      createdEntrants.push(e);
    } else if (type === "doubles") {
      const n1 = String(ent.name1 || "").trim();
      const n2 = String(ent.name2 || "").trim();
      const team1 = String(ent.team1 || ent.team || "").trim();
      const team2 = String(ent.team2 || ent.team1 || ent.team || "").trim();
      if (!n1 && !n2) continue;
      const e = createEntrant({
        tournament_id: tournamentId,
        event: evName,
        name: n1,
        team: team1,
        partner_name: n2,
        partner_team: team2,
        is_doubles: true,
        category: ent.category || "general",
        gender: ent.gender || "",
        status,
        note: [contactInfo, noteBase].filter(Boolean).join(" | "),
      });
      createdEntrants.push(e);
      // tournament_players はマスタDB に該当する選手がいる場合のみ追加 (重複管理用)
      for (const n of [n1, n2]) {
        if (!n) continue;
        const p = findPlayerByName(n, team1);
        if (p) tpEntries.push({ player_id: p.id, event: evName });
      }
    } else {
      // singles / custom
      const name = String(ent.name || "").trim();
      const team = String(ent.team || "").trim();
      if (!name) continue;
      const e = createEntrant({
        tournament_id: tournamentId,
        event: evName,
        name,
        team,
        category: ent.category || "general",
        gender: ent.gender || "",
        status,
        note: [contactInfo, noteBase].filter(Boolean).join(" | "),
      });
      createdEntrants.push(e);
      const p = findPlayerByName(name, team);
      if (p) tpEntries.push({ player_id: p.id, event: evName });
    }
  }

  // tournament_players へ status:pending で記録 (重複は ON CONFLICT で更新)
  for (const tp of tpEntries) {
    try {
      entryStmts.insertOrUpdateEntry.run({
        tournament_id: tournamentId,
        player_id: tp.player_id,
        event: tp.event,
        seed: 0,
        status,
        applied_at: submittedAt,
        entry_note: noteBase,
      });
    } catch (_) { /* ignore duplicate-key races */ }
  }

  return {
    ok: true,
    entry_count: createdEntrants.length,
    total_amount: parseInt(formData.total_amount) || 0,
    entrant_ids: createdEntrants.map(e => e.id),
    contact: {
      name: formData.contact_name || "",
      email: formData.contact_email || "",
      tel: formData.contact_tel || "",
    },
  };
}

function getEntries(tournamentId, statusFilter) {
  let sql = `
    SELECT p.id, p.name, p.furigana, p.team, p.gender, p.category, p.rating,
      tp.event AS entry_event, tp.seed, tp.status AS entry_status,
      tp.applied_at, tp.entry_note
    FROM tournament_players tp
    JOIN players p ON tp.player_id = p.id
    WHERE tp.tournament_id = ?
  `;
  const params = [tournamentId];
  if (statusFilter) { sql += ` AND tp.status = ?`; params.push(statusFilter); }
  sql += ` ORDER BY tp.status ASC, tp.applied_at DESC, p.furigana ASC`;
  return sqlite.prepare(sql).all(...params);
}

function setEntryStatus(tournamentId, playerId, event, status) {
  if (event) {
    entryStmts.setEntryStatusForEvent.run(status, tournamentId, playerId, event);
  } else {
    entryStmts.setEntryStatus.run(status, tournamentId, playerId);
  }
  return { ok: true };
}

function setEntrySeed(tournamentId, playerId, event, seed) {
  entryStmts.setEntrySeed.run(parseInt(seed) || 0, tournamentId, playerId, event);
  return { ok: true };
}

function updateEntrySettings(tournamentId, settings) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  // event_config を更新 (フォーム生成のフル種目データ)
  const evCfg = settings.event_config !== undefined
    ? settings.event_config
    : (t.event_config || "");
  sqlite.prepare(`
    UPDATE tournaments SET
      entries_open = ?,
      entry_deadline = ?,
      entry_events = ?,
      event_config = ?,
      category = ?,
      organizer = ?,
      entry_gas_url = ?,
      updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    settings.entries_open ? 1 : 0,
    settings.entry_deadline || "",
    JSON.stringify(settings.entry_events || []),
    typeof evCfg === "string" ? evCfg : JSON.stringify(evCfg || []),
    settings.category || t.category || "general",
    settings.organizer || t.organizer || "",
    settings.entry_gas_url !== undefined ? settings.entry_gas_url : (t.entry_gas_url || ""),
    tournamentId
  );
  return stmts.getTournament.get(tournamentId);
}

// 公開向け: 申込受付中の大会一覧
function getOpenTournaments() {
  return sqlite.prepare(`
    SELECT * FROM tournaments
    WHERE entries_open = 1
      AND (entry_deadline = '' OR entry_deadline >= date('now','localtime'))
    ORDER BY date ASC, created_at DESC
  `).all().map(t => ({
    ...t,
    entry_events: t.entry_events ? safeJSON(t.entry_events, []) : [],
  }));
}

function safeJSON(s, def) {
  try { return JSON.parse(s); } catch { return def; }
}

// ═══════════════════════════════════════════════════════
// ブラケット JSON エクスポート / インポート
// ═══════════════════════════════════════════════════════
function exportBracket(tournamentId, event) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  const matches = opStmts.getBracketMatches.all(tournamentId, event);
  if (!matches.length) return null;

  const round1 = matches.filter(m => m.bracket_round === 1);
  const bracketSize = round1.length * 2;

  return {
    format: "tabletennis-bracket-v1",
    exported_at: new Date().toISOString(),
    tournament: {
      name: t.name, date: t.date, venue: t.venue,
      category: t.category || "", organizer: t.organizer || "",
    },
    event,
    bracket_size: bracketSize,
    total_rounds: bracketSize ? Math.log2(bracketSize) : 0,
    matches: matches.map(m => ({
      bracket_round: m.bracket_round,
      bracket_pos: m.bracket_pos,
      round: m.round,
      match_no: m.match_no,
      player1_name: m.player1_name || "",
      player1_team: m.player1_team || "",
      player2_name: m.player2_name || "",
      player2_team: m.player2_team || "",
      status: m.status,
      result: m.status === "completed" && m.winner_name ? {
        winner_name: m.winner_name,
        loser_name: m.loser_name,
        winner_team: m.winner_team,
        loser_team: m.loser_team,
        winner_sets: m.winner_sets,
        loser_sets: m.loser_sets,
        sets: JSON.parse(m.sets_json || "[]"),
      } : null,
    })),
  };
}

// 全ブラケット書き出し（複数event対応）
function exportAllBrackets(tournamentId) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  // イベント一覧
  const events = sqlite.prepare(
    `SELECT DISTINCT event FROM matches WHERE tournament_id=? AND event!=''`
  ).all(tournamentId).map(r => r.event);
  return {
    format: "tabletennis-tournament-v1",
    exported_at: new Date().toISOString(),
    tournament: {
      name: t.name, date: t.date, venue: t.venue,
      category: t.category || "", organizer: t.organizer || "",
      court_rows: t.court_rows, court_cols: t.court_cols,
    },
    brackets: events.map(ev => exportBracket(tournamentId, ev)).filter(Boolean),
  };
}

// ドラッグ&ドロップ: 1回戦の2スロット(選手位置)を入れ替え
// a/b = { pos: bracket_pos(整数), slot: 1|2 }。進行中/終了済を含む場合は拒否。
function swapBracketSlots(tournamentId, event, a, b) {
  if (!event) return { error: "event が必要です" };
  const posA = parseInt(a && a.pos), posB = parseInt(b && b.pos);
  const slotA = (parseInt(a && a.slot) === 2) ? 2 : 1;
  const slotB = (parseInt(b && b.slot) === 2) ? 2 : 1;
  if (!Number.isInteger(posA) || !Number.isInteger(posB)) return { error: "位置が不正です" };
  if (posA === posB && slotA === slotB) return { error: "同じ位置です" };

  const round1 = sqlite.prepare(
    `SELECT * FROM matches WHERE tournament_id=? AND event=? AND bracket_round=1`
  ).all(tournamentId, event);
  const mA = round1.find(m => (m.bracket_pos || 0) === posA);
  const mB = round1.find(m => (m.bracket_pos || 0) === posB);
  if (!mA || !mB) return { error: "対象の試合が見つかりません" };

  for (const m of (mA.id === mB.id ? [mA] : [mA, mB])) {
    if (m.status === "completed" || m.status === "on_table" || m.winner_name) {
      return { error: "進行中または終了した試合は入れ替えできません" };
    }
  }

  const getSlot = (m, slot) => ({
    id: m[`player${slot}_id`], name: m[`player${slot}_name`] || "", team: m[`player${slot}_team`] || "",
  });
  const sA = getSlot(mA, slotA), sB = getSlot(mB, slotB);
  const setSlot = sqlite.transaction(() => {
    const upd = (matchId, slot, s) => sqlite.prepare(
      `UPDATE matches SET player${slot}_id=@pid, player${slot}_name=@pname, player${slot}_team=@pteam WHERE id=@id`
    ).run({ pid: s.id || null, pname: s.name || "", pteam: s.team || "", id: matchId });
    upd(mA.id, slotA, sB);
    upd(mB.id, slotB, sA);
    // 両スロット確定で pending、未確定で waiting に再計算
    [mA.id, mB.id].forEach(id => {
      const mm = sqlite.prepare(`SELECT player1_name, player2_name FROM matches WHERE id=?`).get(id);
      const ready = mm.player1_name && mm.player2_name && mm.player1_name !== "BYE" && mm.player2_name !== "BYE";
      sqlite.prepare(`UPDATE matches SET status=? WHERE id=?`).run(ready ? "pending" : "waiting", id);
    });
  });
  setSlot();
  return { success: true };
}

// インポート: 形式自動判別
function importBracket(tournamentId, data) {
  if (!data) return { error: "データが空です" };

  // ── 全大会形式 (複数ブラケット) ──
  if (data.format === "tabletennis-tournament-v1" || Array.isArray(data.brackets)) {
    const results = [];
    for (const b of (data.brackets || [])) {
      // 親の auto_link_to_players / regenerate / auto_create_players を子に伝播
      const merged = {
        ...b,
        auto_link_to_players: data.auto_link_to_players !== undefined
          ? data.auto_link_to_players : b.auto_link_to_players,
        regenerate: data.regenerate !== undefined ? data.regenerate : b.regenerate,
        auto_create_players: data.auto_create_players !== undefined
          ? data.auto_create_players : b.auto_create_players,
        placement: data.placement !== undefined ? data.placement : b.placement,
      };
      const r = importBracket(tournamentId, merged);
      results.push({ event: b.event, ...r });
    }
    return { success: true, imported: results };
  }

  // ── シード選手リスト形式 ──
  if (data.format === "tabletennis-seed-list-v1" ||
      (Array.isArray(data.players) && !data.matches)) {
    return importFromSeedList(tournamentId, data);
  }

  // ── 完全ブラケット形式 ──
  if (data.format === "tabletennis-bracket-v1" || Array.isArray(data.matches)) {
    return importFromMatches(tournamentId, data);
  }

  return { error: "不明な形式です。'format' フィールドが必要です（tabletennis-bracket-v1 / tabletennis-seed-list-v1）" };
}

// シードリスト → entrant 生成 + standard seeding でブラケット
// マスタDBへのリンクは「auto_link_to_players: true」指定時のみ
function importFromSeedList(tournamentId, data) {
  if (!data.event) return { error: "event が必要です" };
  if (!Array.isArray(data.players) || data.players.length < 2) {
    return { error: "players が2人以上必要です" };
  }

  // 既存 entrants 削除 (同 event, regenerate デフォルト true)
  if (data.regenerate !== false) {
    sqlite.prepare(`DELETE FROM entrants WHERE tournament_id=? AND event=?`)
      .run(tournamentId, data.event);
  }

  const entrantIds = [];
  const linkedPlayers = [];
  // 自動DB連携: デフォルト ON。「氏名+所属」の完全一致でリンク。
  // false 明示時のみ無効化。
  const autoLink = data.auto_link_to_players !== false;

  data.players.forEach(p => {
    // 入力データから名前構造を構築
    const entrantData = {
      tournament_id: tournamentId,
      event: data.event,
      seed: parseInt(p.seed) || 0,
      block: p.block || "",
      name: p.name,
      surname: p.surname,
      given_name: p.given_name,
      furigana: p.furigana,
      team: p.team,
      partner_name: p.partner_name,
      partner_surname: p.partner_surname,
      partner_given_name: p.partner_given_name,
      partner_furigana: p.partner_furigana,
      partner_team: p.partner_team,
      gender: p.gender || "male",
      category: p.category || "general",
      age_group: p.age_group || "",
      region: p.region || "",
      is_doubles: p.is_doubles,
    };
    // 入力時点で名前未指定なら skip
    const names = buildEntrantNames(entrantData);
    if (!names.name && !names.partner_name) return;

    // 氏名一致 → マスタDB 自動連携 (auto_link デフォルト ON)
    // ※ 取込時は妥当な選手のみマスタに登録/連携 (チーム名と判定された名前は弾く)
    if (autoLink) {
      let linked = findPlayerByName(names.name, entrantData.team);
      // マスタに無ければ自動作成 (バリデーションで弾かれたらスキップ)
      if (!linked && names.name && !names.is_doubles) {
        try {
          linked = createPlayer({
            name: names.name,
            team: entrantData.team || "",
            gender: entrantData.gender,
            category: entrantData.category,
            furigana: names.furigana || lookupFurigana(names.surname || names.name),
          });
        } catch (e) {
          // INVALID_NAME: チーム名/ラベル等の場合はマスタ作成スキップ (entrant のみ作成)
          if (e.code !== "INVALID_NAME") throw e;
        }
      }
      if (linked) {
        entrantData.player_id = linked.id;
        linkedPlayers.push(linked.id);
      }
      // ダブルスのパートナーも自動連携
      if (names.partner_name) {
        let linkedP = findPlayerByName(names.partner_name, entrantData.partner_team || entrantData.team);
        if (!linkedP) {
          try {
            linkedP = createPlayer({
              name: names.partner_name,
              team: entrantData.partner_team || entrantData.team || "",
              gender: entrantData.gender,
              category: entrantData.category,
              furigana: names.partner_furigana || lookupFurigana(names.partner_surname || names.partner_name),
            });
          } catch (e) {
            if (e.code !== "INVALID_NAME") throw e;
          }
        }
        if (linkedP) {
          entrantData.partner_player_id = linkedP.id;
          linkedPlayers.push(linkedP.id);
        }
      }
    }

    const e = createEntrant(entrantData);
    entrantIds.push(e.id);
  });

  const r = generateBracket(tournamentId, data.event, {
    entrant_ids: entrantIds,
    regenerate: false, // 既に entrants は再生成済み (matches だけ regen)
    placement: data.placement,
  });

  // matches だけ消す必要があるので generateBracket 内の regenerate を改めて呼ぶ
  if (data.regenerate !== false) {
    sqlite.prepare(`DELETE FROM matches WHERE tournament_id=? AND event=?`)
      .run(tournamentId, data.event);
    // 再呼出
    const r2 = generateBracket(tournamentId, data.event, { entrant_ids: entrantIds, placement: data.placement });
    return { ...r2, entrants_created: entrantIds.length, linked_to_players: linkedPlayers.length };
  }

  return { ...r, entrants_created: entrantIds.length, linked_to_players: linkedPlayers.length };
}

// 完全ブラケット形式 → 各試合を直接挿入＋next_match_id 自動リンク
function importFromMatches(tournamentId, data) {
  if (!data.event) return { error: "event が必要です" };
  if (!Array.isArray(data.matches) || !data.matches.length) {
    return { error: "matches が必要です" };
  }

  // 既存削除（再生成）
  if (data.regenerate !== false) {
    opStmts.deleteEventMatches.run(tournamentId, data.event);
  }

  // bracket_size / total_rounds 推定
  const round1Matches = data.matches.filter(m => (m.bracket_round || 0) === 1);
  let bracketSize = data.bracket_size;
  if (!bracketSize && round1Matches.length) bracketSize = round1Matches.length * 2;
  if (!bracketSize) {
    const maxRound = Math.max(...data.matches.map(m => m.bracket_round || 1));
    bracketSize = Math.pow(2, maxRound);
  }
  const totalRounds = Math.log2(bracketSize);

  // (round, pos) → id マップ
  const idByPos = {};
  data.matches.forEach(m => {
    idByPos[`${m.bracket_round || 1}-${m.bracket_pos || 0}`] = uid();
  });

  let newPlayers = 0;
  let withResult = 0;
  let entrantsCreated = 0;

  // 既存 entrants 削除 (同 event, regenerate デフォルト true)
  if (data.regenerate !== false) {
    sqlite.prepare(`DELETE FROM entrants WHERE tournament_id=? AND event=?`)
      .run(tournamentId, data.event);
  }

  // 取込済 entrant 重複防止のキャッシュ (氏名+所属 → entrant_id)
  const entrantByKey = new Map();
  const ensureEntrant = (name, team, playerId) => {
    if (!name || name === "BYE") return null;
    const key = name + "|" + (team || "");
    if (entrantByKey.has(key)) return entrantByKey.get(key);
    const e = createEntrant({
      tournament_id: tournamentId,
      event: data.event,
      name, team: team || "",
      player_id: playerId || null,
    });
    entrantByKey.set(key, e.id);
    entrantsCreated++;
    return e.id;
  };

  const txn = sqlite.transaction(() => {
    // 全試合 insert
    data.matches.forEach(m => {
      const r = m.bracket_round || 1;
      const p = m.bracket_pos || 0;
      const id = idByPos[`${r}-${p}`];
      // 次の試合
      const nextRound = r + 1;
      const nextPos = Math.floor(p / 2);
      const nextSlot = (p % 2) + 1;
      const nextId = idByPos[`${nextRound}-${nextPos}`] || null;

      // 選手リンク（名前で検索、新規はDBに作る）
      const p1Name = m.player1_name || "";
      const p2Name = m.player2_name || "";
      const p1Team = m.player1_team || "";
      const p2Team = m.player2_team || "";
      let p1Id = null, p2Id = null;
      if (p1Name && p1Name !== "BYE") {
        let pp = findPlayerByName(p1Name, p1Team);
        if (!pp && data.auto_create_players !== false) {
          try {
            pp = createPlayer({ name: p1Name, team: p1Team, gender: m.player1_gender || "male" });
            newPlayers++;
          } catch (e) {
            if (e.code !== "INVALID_NAME") throw e;
          }
        }
        if (pp) p1Id = pp.id;
      }
      if (p2Name && p2Name !== "BYE") {
        let pp = findPlayerByName(p2Name, p2Team);
        if (!pp && data.auto_create_players !== false) {
          try {
            pp = createPlayer({ name: p2Name, team: p2Team, gender: m.player2_gender || "male" });
            newPlayers++;
          } catch (e) {
            if (e.code !== "INVALID_NAME") throw e;
          }
        }
        if (pp) p2Id = pp.id;
      }

      const bothReady = p1Name && p2Name && p1Name !== "BYE" && p2Name !== "BYE";
      const roundName = m.round || roundNameForBracket(r, totalRounds);

      const matchNoNum = m.match_no || (p + 1);
      opStmts.insertFullMatch.run({
        id, tournament_id: tournamentId,
        event: data.event,
        round: roundName,
        round_order: getRoundOrder(roundName),
        match_no: matchNoNum,
        match_label: (m.bracket_round || r) + "-" + matchNoNum,
        winner_id: null, loser_id: null,
        winner_name: "", loser_name: "",
        winner_team: "", loser_team: "",
        sets_json: "[]", winner_sets: 0, loser_sets: 0,
        played_at: "", note: "",
        status: m.status === "completed" ? "pending" : (bothReady ? "pending" : "waiting"),
        table_no: 0,
        referee_id: null, referee_name: "",
        player1_id: p1Id, player2_id: p2Id,
        player1_name: p1Name, player2_name: p2Name,
        player1_team: p1Team, player2_team: p2Team,
        next_match_id: nextId, next_slot: nextSlot,
        called_at: "", started_at: "", finished_at: "",
        bracket_pos: p, bracket_round: r,
        // entrants も自動作成 (取込された全選手をマスタDB+entrants に登録)
        player1_entrant_id: ensureEntrant(p1Name, p1Team, p1Id),
        player2_entrant_id: ensureEntrant(p2Name, p2Team, p2Id),
      });
    });

    // round1 BYEを自動進行
    round1Matches.forEach(m => {
      const id = idByPos[`1-${m.bracket_pos || 0}`];
      const p1IsBye = !m.player1_name || m.player1_name === "BYE";
      const p2IsBye = !m.player2_name || m.player2_name === "BYE";
      if (p1IsBye && !p2IsBye) {
        finishMatchInternal(id, { winner_slot: 2, sets: [] });
      } else if (p2IsBye && !p1IsBye) {
        finishMatchInternal(id, { winner_slot: 1, sets: [] });
      }
    });

    // 結果ありの試合を反映（finish→自動advance）
    data.matches.forEach(m => {
      if (!m.result || !m.result.winner_name) return;
      const id = idByPos[`${m.bracket_round || 1}-${m.bracket_pos || 0}`];
      // 勝者がどちらか判定 (名前で)
      const winnerIsP1 = m.result.winner_name === m.player1_name;
      finishMatchInternal(id, {
        winner_slot: winnerIsP1 ? 1 : 2,
        sets: Array.isArray(m.result.sets) ? m.result.sets : [],
        winner_sets: m.result.winner_sets,
        loser_sets: m.result.loser_sets,
      });
      withResult++;
    });
  });
  txn();

  // 選手番号 (大会固有・左右別) を自動付与
  // round1 の bracket_pos から slot を逆算し、左半分=1..N/2、右半分=1..N/2 で番号付け
  try {
    const numberTxn = sqlite.transaction(() => {
      const halfSize = bracketSize / 2;
      round1Matches.forEach(m => {
        const p = m.bracket_pos || 0;
        const slot1 = p * 2;
        const slot2 = p * 2 + 1;
        const isLeft1 = slot1 < halfSize;
        const isLeft2 = slot2 < halfSize;
        const num1 = isLeft1 ? (slot1 + 1) : (slot1 - halfSize + 1);
        const num2 = isLeft2 ? (slot2 + 1) : (slot2 - halfSize + 1);
        const side1 = isLeft1 ? "L" : "R";
        const side2 = isLeft2 ? "L" : "R";
        // ensureEntrant したキー(name+team)で entrant_id を探して付与
        const k1 = (m.player1_name || "") + "|" + (m.player1_team || "");
        const k2 = (m.player2_name || "") + "|" + (m.player2_team || "");
        const eid1 = entrantByKey.get(k1);
        const eid2 = entrantByKey.get(k2);
        if (eid1) entrantStmts.setBracketNumber.run(num1, side1, eid1);
        if (eid2) entrantStmts.setBracketNumber.run(num2, side2, eid2);
      });
    });
    numberTxn();
  } catch (e) { console.error("bracket_number assignment error (import):", e); }

  return {
    success: true,
    event: data.event,
    bracket_size: bracketSize,
    total_rounds: totalRounds,
    total_matches: data.matches.length,
    new_players: newPlayers,
    matches_with_results: withResult,
  };
}

// ── 試合の手動編集 (任意のフィールドを書き換え) ──
// 進行管理データ含む全フィールドを編集可能
function editMatch(matchId, data) {
  const m = stmts.getMatch.get(matchId);
  if (!m) return null;

  // 部分更新で undefined は触らない
  const set = (k, v) => v != null ? v : m[k];

  // 選手解決 (id/name/team)
  function resolve(prefix, dataKey) {
    let id = data[`${dataKey}_id`];
    let name = data[`${dataKey}_name`];
    let team = data[`${dataKey}_team`];
    if (id !== undefined) {
      // id が明示されたら lookup して name/team も更新 (上書き指定が無ければ)
      const p = id ? stmts.getPlayer.get(id) : null;
      if (p) {
        name = name !== undefined ? name : p.name;
        team = team !== undefined ? team : p.team;
      } else if (id === null || id === "") {
        id = null;
      }
    }
    return {
      id: id !== undefined ? id : m[`${prefix}_id`],
      name: name !== undefined ? name : m[`${prefix}_name`],
      team: team !== undefined ? team : m[`${prefix}_team`],
    };
  }
  const p1 = resolve("player1", "player1");
  const p2 = resolve("player2", "player2");
  const ref = data.referee_id !== undefined
    ? (data.referee_id ? stmts.getPlayer.get(data.referee_id) : null)
    : null;

  const round = set("round", data.round);
  const newStatus = data.status || m.status;
  const sets = data.sets !== undefined ? (Array.isArray(data.sets) ? data.sets : []) : null;

  // 直接SQL更新 (全フィールド対応)
  sqlite.prepare(`
    UPDATE matches SET
      event = ?, round = ?, round_order = ?, match_no = ?,
      player1_id = ?, player1_name = ?, player1_team = ?,
      player2_id = ?, player2_name = ?, player2_team = ?,
      referee_id = ?, referee_name = ?, referee_required = ?,
      table_no = ?, status = ?,
      note = ?
    WHERE id = ?
  `).run(
    set("event", data.event),
    round,
    data.round !== undefined ? getRoundOrder(round) : m.round_order,
    set("match_no", data.match_no),
    p1.id, p1.name || "", p1.team || "",
    p2.id, p2.name || "", p2.team || "",
    data.referee_id !== undefined ? (data.referee_id || null) : m.referee_id,
    data.referee_id !== undefined ? (ref ? ref.name : "") : m.referee_name,
    data.referee_required !== undefined ? (data.referee_required ? 1 : 0) : m.referee_required,
    data.table_no !== undefined ? parseInt(data.table_no) || 0 : m.table_no,
    newStatus,
    set("note", data.note),
    matchId,
  );

  // 結果情報も指定されていれば更新
  if (data.winner_slot || data.winner_id || sets !== null ||
      data.winner_sets !== undefined || data.loser_sets !== undefined) {
    const m2 = stmts.getMatch.get(matchId);
    let winner, loser;
    if (data.winner_slot === 1 || data.winner_id === m2.player1_id) {
      winner = { id: m2.player1_id, name: m2.player1_name, team: m2.player1_team };
      loser = { id: m2.player2_id, name: m2.player2_name, team: m2.player2_team };
    } else if (data.winner_slot === 2 || data.winner_id === m2.player2_id) {
      winner = { id: m2.player2_id, name: m2.player2_name, team: m2.player2_team };
      loser = { id: m2.player1_id, name: m2.player1_name, team: m2.player1_team };
    }
    if (winner) {
      const useSets = sets !== null ? sets : JSON.parse(m2.sets_json || "[]");
      let ws = 0, ls = 0;
      useSets.forEach(s => {
        if (Array.isArray(s) && s.length === 2) {
          // m2の player1 視点
          const winnerIsP1 = winner.id === m2.player1_id;
          if (winnerIsP1) {
            if (s[0] > s[1]) ws++; else if (s[1] > s[0]) ls++;
          } else {
            if (s[1] > s[0]) ws++; else if (s[0] > s[1]) ls++;
          }
        }
      });
      sqlite.prepare(`
        UPDATE matches SET
          winner_id = ?, loser_id = ?,
          winner_name = ?, loser_name = ?,
          winner_team = ?, loser_team = ?,
          sets_json = ?, winner_sets = ?, loser_sets = ?,
          status = 'completed', finished_at = COALESCE(NULLIF(finished_at,''), datetime('now','localtime'))
        WHERE id = ?
      `).run(
        winner.id, loser.id,
        winner.name, loser.name,
        winner.team, loser.team,
        JSON.stringify(useSets),
        data.winner_sets !== undefined ? data.winner_sets : ws,
        data.loser_sets !== undefined ? data.loser_sets : ls,
        matchId,
      );
    }
  }

  return stmts.getMatch.get(matchId);
}

// 運営ルール設定を更新（敗者審判ルール等）
function setOperationSettings(tournamentId, settings) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  const enforce = settings.enforce_referee_rule == null
    ? t.enforce_referee_rule
    : (settings.enforce_referee_rule ? 1 : 0);
  sqlite.prepare(`
    UPDATE tournaments SET enforce_referee_rule = ?,
      updated_at = datetime('now','localtime') WHERE id = ?
  `).run(enforce, tournamentId);
  return stmts.getTournament.get(tournamentId);
}

// 台レイアウトを更新
function setCourtLayout(tournamentId, layout) {
  const t = stmts.getTournament.get(tournamentId);
  if (!t) return null;
  const rows = parseInt(layout.court_rows) || t.court_rows || 4;
  const cols = parseInt(layout.court_cols) || t.court_cols || 11;
  const hq = layout.hq_position || t.hq_position || "bottom";
  const origin = layout.numbering_origin || t.numbering_origin || "bottom-right";
  sqlite.prepare(`
    UPDATE tournaments SET court_rows=?, court_cols=?, hq_position=?,
      numbering_origin=?, updated_at=datetime('now','localtime') WHERE id=?
  `).run(rows, cols, hq, origin, tournamentId);
  return stmts.getTournament.get(tournamentId);
}

// 既存DBのチーム名混入クリーンアップ
// players テーブルから looksLikeValidPlayerName で NG と判定される行を削除
function cleanupInvalidPlayers() {
  const all = sqlite.prepare("SELECT id, name FROM players").all();
  const ids = [];
  for (const p of all) {
    const v = looksLikeValidPlayerName(p.name);
    if (!v.ok) ids.push({ id: p.id, name: p.name, reason: v.reason });
  }
  // entrants からのリンク解除のみ (削除はせず player_id=null)
  const delStmt = sqlite.prepare("DELETE FROM players WHERE id = ?");
  const unlinkE = sqlite.prepare(
    "UPDATE entrants SET player_id=NULL WHERE player_id = ?");
  const unlinkM1 = sqlite.prepare(
    "UPDATE matches SET player1_id=NULL WHERE player1_id = ?");
  const unlinkM2 = sqlite.prepare(
    "UPDATE matches SET player2_id=NULL WHERE player2_id = ?");
  const unlinkM3 = sqlite.prepare(
    "UPDATE matches SET referee_id=NULL WHERE referee_id = ?");
  const unlinkM4 = sqlite.prepare(
    "UPDATE matches SET winner_id=NULL WHERE winner_id = ?");
  const unlinkM5 = sqlite.prepare(
    "UPDATE matches SET loser_id=NULL WHERE loser_id = ?");
  const txn = sqlite.transaction(() => {
    for (const { id } of ids) {
      unlinkE.run(id); unlinkM1.run(id); unlinkM2.run(id);
      unlinkM3.run(id); unlinkM4.run(id); unlinkM5.run(id);
      delStmt.run(id);
    }
  });
  txn();
  return { removed: ids.length, details: ids };
}

module.exports = {
  getPlayers, getPlayer, createPlayer, updatePlayer, deletePlayer, deleteAllPlayers,
  findPlayerByName, looksLikeValidPlayerName, cleanupInvalidPlayers,
  addAchievement, deleteAchievement,
  getTournaments, getTournament, createTournament, updateTournament, deleteTournament,
  createMatch, updateMatch, deleteMatch, getMatch, getMatchesByTournament,
  bulkImportMatches,
  addTournamentPlayer, removeTournamentPlayer, getTournamentPlayers,
  exportAllData, importPlayers, getStats, getLastUpdated,
  lookupFurigana, calcElo, getRoundOrder,
  // 進行管理
  generateBracket, finishMatchOp, correctResult, callMatch, uncallMatch, assignReferee,
  assignAnyReferee, setRefereeRequired, setOperationSettings, editMatch,
  setCallCount, bumpCallCount,
  getPlayerRefereeLock, getPlayerPlayingLock,
  getEventPriority, getPlayerSurvivalByEvent,
  getPriorityLockForPlayer, getMatchPriorityBlocks,
  getCallableMatches, getOnTableMatches, getRefereeQueue,
  getOperationState, getPlayerLiveStatus,
  getBracket, deleteEventMatches, setCourtLayout,
  // 試合検索 / H2H / 選手統計
  searchMatches, countMatchesForSearch, getSearchFilters,
  getPlayerOpponents, getHeadToHead, getPlayerEventStats,
  // 個別戦績 (手動)
  createManualMatch, getPlayerMatchesForEdit,
  // 申込
  createEntry, createTeamEntry, getEntries, setEntryStatus, setEntrySeed,
  updateEntrySettings, getOpenTournaments,
  // ブラケット JSON I/O
  exportBracket, exportAllBrackets, importBracket, swapBracketSlots,
  // Entrants (大会参加選手) - マスタDBと分離
  createEntrant, updateEntrant, deleteEntrant, getEntrant, getEntrants,
  setEntrantBracketNumber, autoAssignDrawNumbers, buildRosterData,
  linkEntrantToPlayer, suggestPlayerForEntrant, createPlayerFromEntrant,
  validateEntrants, getEntrantStats,
  // 名前ユーティリティ
  normalizeName, parsePersonName, joinPersonName, buildEntrantNames,
};
