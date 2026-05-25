// ═══════════════════════════════════════════════════════
// 釧路卓球協会 公式大会テンプレート
// ・年度依存の要素 (第X回, (夏), 年度) は名前から除外
// ・どの年度でも繰り返し使える「形式テンプレ」として運用
// ・大会名は短く / 日付・回数は作成時に手動入力
// ═══════════════════════════════════════════════════════
(function (global) {
  'use strict';

  const DEFAULT_VENUE = "ウインドヒルくしろスーパーアリーナ";
  const SUB_VENUE = "ウインドヒルくしろスーパーアリーナ (サブアリーナ)";
  const DEFAULT_ORGANIZER = "釧路卓球協会";
  const DEFAULT_COURT = { court_rows: 4, court_cols: 11, hq_position: "bottom", numbering_origin: "bottom-right" };
  const SUB_COURT = { court_rows: 3, court_cols: 8, hq_position: "bottom", numbering_origin: "bottom-right" };
  const SMALL_COURT = { court_rows: 2, court_cols: 4, hq_position: "bottom", numbering_origin: "bottom-right" };

  const RULE_STD = {
    points: 11, games: 5,
    referee_rule: "loser",
    referee_first_round: "designated",
    timeout: false,
    ball: "ニッタク 40mm ホワイト 3スター",
    enforce_referee_rule: true,
  };
  const RULE_TEAM_LEAGUE = {
    points: 11, games: 3,
    referee_rule: "mutual",
    timeout: false,
    ball: "ニッタク 40mm ホワイト 3スター",
    enforce_referee_rule: false,
  };
  const RULE_LARGE_BALL = {
    points: 11, games: 3,
    referee_rule: "mutual_then_loser",
    ball: "ニッタク 3スタークリーン",
    enforce_referee_rule: true,
  };

  const TEMPLATES = [
    {
      id: "kaicho_hai",
      name: "会長杯 / 高校釧根支部オープン",
      season: "春",
      reference_date: "05-03",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["高体連釧根支部", "釧路地区中体連"],
      description: "会長杯 / 高校釧根支部オープン。一般・高校・中学の団体戦＋一般・高校・中学・小学のシングルス。",
      eligibility: "釧路卓球協会の登録会員 (準会員含む)。高校の部は釧根オープン。",
      events: [
        { name: "一般 団体戦", category: "general", type: "team", per_team: 4, fee: 3000, note: "1複4単 (4人以上)" },
        { name: "高校 団体戦", category: "high",    type: "team", per_team: 4, fee: 2000 },
        { name: "中学 団体戦", category: "middle",  type: "team", per_team: 6, fee: 2000, note: "6〜8人" },
        { name: "男子シングルス 一般",    category: "general",   gender: "male",   type: "singles", fee: 700 },
        { name: "女子シングルス 一般",    category: "general",   gender: "female", type: "singles", fee: 700 },
        { name: "男子シングルス 高校",    category: "high",      gender: "male",   type: "singles", fee: 500 },
        { name: "女子シングルス 高校",    category: "high",      gender: "female", type: "singles", fee: 500 },
        { name: "男子シングルス 中学",    category: "middle",    gender: "male",   type: "singles", fee: 500 },
        { name: "女子シングルス 中学",    category: "middle",    gender: "female", type: "singles", fee: 500 },
        { name: "男子シングルス 小学",    category: "elementary",gender: "male",   type: "singles", fee: 500 },
        { name: "女子シングルス 小学",    category: "elementary",gender: "female", type: "singles", fee: 500 },
      ],
      rules: { ...RULE_STD, referee_first_round: "mutual", note: "2回戦から敗者審判" },
      court: DEFAULT_COURT,
    },
    {
      id: "kokutai_youth",
      name: "国スポ (少年の部) 釧路地区予選",
      season: "春",
      reference_date: "05-06",
      venue: SUB_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "国スポ(少年の部)予選。高校生と中学3年生対象。全道大会出場意思のある選手のみ。",
      eligibility: "釧路卓球協会登録会員。高校生・中3。全道出場意思のある選手のみ。",
      events: [
        { name: "国体予選 男子シングルス", category: "high", gender: "male",   type: "singles", fee: 500, reps_seats: 16 },
        { name: "国体予選 女子シングルス", category: "high", gender: "female", type: "singles", fee: 500, reps_seats: 16 },
      ],
      rules: { ...RULE_STD, note: "1回戦相互審判、2回戦以降敗者審判" },
      court: SUB_COURT,
    },
    {
      id: "yasaka_hai",
      name: "ヤサカ杯",
      season: "春",
      reference_date: "06-01",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["株式会社ヤサカ"],
      description: "ヤサカ杯。一般社会人マスターズの支部予選会。",
      eligibility: "釧路卓球協会の登録会員 (準会員含む)。",
      events: [
        { name: "男子シングルス 一般",    category: "general", gender: "male",   type: "singles", fee: 700 },
        { name: "女子シングルス 一般",    category: "general", gender: "female", type: "singles", fee: 700 },
        { name: "男子シングルス 高校",    category: "high",    gender: "male",   type: "singles", fee: 500 },
        { name: "女子シングルス 高校",    category: "high",    gender: "female", type: "singles", fee: 500 },
        { name: "男子シングルス 中学",    category: "middle",  gender: "male",   type: "singles", fee: 500 },
        { name: "女子シングルス 中学",    category: "middle",  gender: "female", type: "singles", fee: 500 },
        { name: "男子ダブルス 一般",     category: "general", gender: "male",   type: "doubles", fee: 1000 },
        { name: "女子ダブルス 一般",     category: "general", gender: "female", type: "doubles", fee: 1000 },
        { name: "男子ダブルス 高校",     category: "high",    gender: "male",   type: "doubles", fee: 800 },
        { name: "女子ダブルス 高校",     category: "high",    gender: "female", type: "doubles", fee: 800 },
        { name: "男子ダブルス 中学",     category: "middle",  gender: "male",   type: "doubles", fee: 800 },
        { name: "女子ダブルス 中学",     category: "middle",  gender: "female", type: "doubles", fee: 800 },
        { name: "混合ダブルス",          category: "general", gender: "mixed",  type: "doubles", fee: 1000 },
      ],
      rules: { ...RULE_STD, ball: "ヤサカ 40mm ホワイト" },
      court: DEFAULT_COURT,
    },
    {
      id: "kushiro_league_summer",
      name: "くしろリーグ団体選手権",
      season: "夏季",
      reference_date: "07-19",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      co_organizer: "東北海道スポーツコミッション (EHSC)",
      description: "くしろリーグ団体選手権 (夏季開催)。5チームずつの部別リーグ戦。",
      eligibility: "釧路卓球協会登録団体。1団体何チームでも参加可能。",
      events: [
        { name: "団体戦 小学・中学・高校", category: "youth", type: "team", per_team: 4, fee: 3000, format: "league" },
        { name: "団体戦 一般",           category: "general",type: "team", per_team: 4, fee: 4000, format: "league" },
      ],
      rules: { ...RULE_TEAM_LEAGUE, structure: "1部/2部/3部 別 5チームリーグ" },
      court: DEFAULT_COURT,
    },
    {
      id: "kushiro_senshuken",
      name: "釧路選手権 (Nittaku杯)",
      season: "夏",
      reference_date: "07-26",
      venue: DEFAULT_VENUE,
      organizer: "釧路市 / " + DEFAULT_ORGANIZER,
      sponsors: ["株式会社ニッタク"],
      description: "釧路支部No.1を決める大会。北海道選手権の地区予選も兼ねる。",
      eligibility: "釧路卓球協会登録会員 (準会員は除く)。",
      events: [
        { name: "男子シングルス",  gender: "male",   type: "singles", fee: 700, reps_seats: 16 },
        { name: "女子シングルス",  gender: "female", type: "singles", fee: 700, reps_seats: 16 },
        { name: "男子ダブルス",    gender: "male",   type: "doubles", fee: 1000, reps_seats: 8 },
        { name: "女子ダブルス",    gender: "female", type: "doubles", fee: 1000, reps_seats: 8 },
        { name: "混合ダブルス",    gender: "mixed",  type: "doubles", fee: 1000, reps_seats: 8 },
      ],
      rules: { ...RULE_STD },
      court: DEFAULT_COURT,
    },
    {
      id: "cadet_yosen",
      name: "北海道選手権 カデットの部 地区予選",
      season: "夏",
      reference_date: "07-28",
      venue: SUB_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "カデットの部地区予選 (全道予選)。全道出場意思のある選手のみ。",
      eligibility: "釧路卓球協会登録会員。全道出場意思のある選手のみ。",
      events: [
        { name: "男子シングルス 13歳以下", category: "middle", gender: "male",   type: "singles", fee: 500, reps_seats: 21, age_group: "U13" },
        { name: "女子シングルス 13歳以下", category: "middle", gender: "female", type: "singles", fee: 500, reps_seats: 21, age_group: "U13" },
        { name: "男子シングルス 14歳以下", category: "middle", gender: "male",   type: "singles", fee: 500, reps_seats: 21, age_group: "U14" },
        { name: "女子シングルス 14歳以下", category: "middle", gender: "female", type: "singles", fee: 500, reps_seats: 21, age_group: "U14" },
        { name: "男子ダブルス 中2以下", category: "middle", gender: "male",   type: "doubles", fee: 800, reps_seats: 6, age_group: "U14" },
        { name: "女子ダブルス 中2以下", category: "middle", gender: "female", type: "doubles", fee: 800, reps_seats: 6, age_group: "U14" },
      ],
      rules: { ...RULE_STD, referee_first_round: "loser" },
      court: SUB_COURT,
    },
    {
      id: "junior_senshuken",
      name: "釧路ジュニア選手権",
      season: "夏",
      reference_date: "08-09",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "釧路ジュニアチャンピオンと全道代表枠を決める大会。北海道選手権地区予選兼。",
      eligibility: "釧路卓球協会登録会員。高校2年生以下。",
      events: [
        { name: "ジュニア 男子シングルス", category: "junior", gender: "male",   type: "singles", fee: 500, reps_seats: 16, age_group: "U17" },
        { name: "ジュニア 女子シングルス", category: "junior", gender: "female", type: "singles", fee: 500, reps_seats: 16, age_group: "U17" },
      ],
      rules: { ...RULE_STD, note: "トーナメントは敗者審判、リーグ戦は相互審判" },
      court: DEFAULT_COURT,
    },
    {
      id: "nagoyakatei_kushiro_open",
      name: "なごやか亭杯 くしろオープン",
      season: "秋",
      reference_date: "09-27",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["株式会社三ッ星レストランシステム"],
      description: "オープン大会。学生・一般を問わない。午後はPMシニアオープン。",
      eligibility: "オープン (学生・一般問わず)。",
      events: [
        { name: "男子シングルス 小・中・高",   gender: "male",   category: "youth",   type: "singles", fee: 500 },
        { name: "女子シングルス 小・中・高",   gender: "female", category: "youth",   type: "singles", fee: 500 },
        { name: "男子シングルス 一般",        gender: "male",   category: "general", type: "singles", fee: 700 },
        { name: "女子シングルス 一般",        gender: "female", category: "general", type: "singles", fee: 700 },
        { name: "男子ダブルス 小・中・高",    gender: "male",   category: "youth",   type: "doubles", fee: 800 },
        { name: "女子ダブルス 小・中・高",    gender: "female", category: "youth",   type: "doubles", fee: 800 },
        { name: "男子ダブルス 一般",         gender: "male",   category: "general", type: "doubles", fee: 1000 },
        { name: "女子ダブルス 一般",         gender: "female", category: "general", type: "doubles", fee: 1000 },
        { name: "PMシニア 男子シングルス", gender: "male",   category: "senior", type: "singles", fee: 700, age_group: "50+" },
        { name: "PMシニア 女子シングルス", gender: "female", category: "senior", type: "singles", fee: 700, age_group: "50+" },
      ],
      rules: { ...RULE_STD, super_seed: true, note: "スーパーシードあり。PMシニアは3Gマッチ予選L+決勝T" },
      court: DEFAULT_COURT,
    },
    {
      id: "tancho_open_large",
      name: "Nittaku杯タンチョウオープン (ラージボール)",
      season: "秋",
      reference_date: "10-18",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["日本卓球株式会社 (ニッタク)", "株式会社三ッ星レストランシステム", "北海まりも製菓", "温泉民宿山口"],
      description: "全国オープン ラージボール大会。年代別。",
      eligibility: "ラージボールを楽しめる方。日本卓球協会登録の有無は問わない。",
      events: [
        { name: "混合ダブルス 一般",  gender: "mixed",  type: "doubles", fee: 2000, age_group: "U120", category: "large" },
        { name: "混合ダブルス 120才代", gender: "mixed",  type: "doubles", fee: 2000, age_group: "120s", category: "large" },
        { name: "混合ダブルス 130才代", gender: "mixed",  type: "doubles", fee: 2000, age_group: "130s", category: "large" },
        { name: "混合ダブルス 140才代", gender: "mixed",  type: "doubles", fee: 2000, age_group: "140s", category: "large" },
        { name: "混合ダブルス 150才代", gender: "mixed",  type: "doubles", fee: 2000, age_group: "150s", category: "large" },
        { name: "混合ダブルス 160才代", gender: "mixed",  type: "doubles", fee: 2000, age_group: "160s", category: "large" },
        { name: "男子ダブルス 一般",  gender: "male",   type: "doubles", fee: 2000, age_group: "U120", category: "large" },
        { name: "男子ダブルス シニア", gender: "male",   type: "doubles", fee: 2000, category: "large" },
        { name: "女子ダブルス 一般",  gender: "female", type: "doubles", fee: 2000, age_group: "U120", category: "large" },
        { name: "女子ダブルス シニア", gender: "female", type: "doubles", fee: 2000, category: "large" },
        { name: "男子シングルス 一般", gender: "male",   type: "singles", fee: 1000, age_group: "U50",  category: "large" },
        { name: "男子シングルス 50才代", gender: "male",   type: "singles", fee: 1000, age_group: "50s",  category: "large" },
        { name: "男子シングルス 60才代", gender: "male",   type: "singles", fee: 1000, age_group: "60s",  category: "large" },
        { name: "男子シングルス 70才代", gender: "male",   type: "singles", fee: 1000, age_group: "70s",  category: "large" },
        { name: "男子シングルス 80才代", gender: "male",   type: "singles", fee: 1000, age_group: "80s",  category: "large" },
        { name: "女子シングルス 一般", gender: "female", type: "singles", fee: 1000, age_group: "U50",  category: "large" },
        { name: "女子シングルス 50才代", gender: "female", type: "singles", fee: 1000, age_group: "50s",  category: "large" },
        { name: "女子シングルス シニア", gender: "female", type: "singles", fee: 1000, category: "large" },
      ],
      rules: { ...RULE_LARGE_BALL, format: "3-team league + decisive tournament" },
      court: DEFAULT_COURT,
    },
    {
      id: "chugaku_senbatsu_dantai",
      name: "道新杯 北海道中学選抜卓球大会 (団体戦) 地区予選",
      season: "秋",
      reference_date: "11-01",
      venue: SUB_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "中学団体戦の地区予選。4単1複の5試合制。",
      eligibility: "中1〜中2 (3年生は不可)。チーム編成は学校単位。",
      events: [
        { name: "男子団体", gender: "male",   category: "middle", type: "team", per_team: 6, fee: 2000, format: "4S+1D, 5試合", reps_seats: 2 },
        { name: "女子団体", gender: "female", category: "middle", type: "team", per_team: 6, fee: 2000, format: "4S+1D, 5試合", reps_seats: 2 },
      ],
      rules: { ...RULE_STD, referee_rule: "mutual", note: "予選L+決勝T (7チーム以下は決勝Lのみ)" },
      court: SUB_COURT,
    },
    {
      id: "chugaku_shinjin",
      name: "釧路地区中学卓球新人戦",
      season: "秋",
      reference_date: "11-24",
      venue: SUB_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "中学新人戦。中1〜中2のシングルス男女別。",
      eligibility: "中1〜中2 (3年生は不可)。",
      events: [
        { name: "男子シングルス", gender: "male",   category: "middle", type: "singles", fee: 500 },
        { name: "女子シングルス", gender: "female", category: "middle", type: "singles", fee: 500 },
      ],
      rules: { ...RULE_STD },
      court: SUB_COURT,
    },
    {
      id: "kushiro_league_winter",
      name: "くしろリーグ団体選手権",
      season: "冬季",
      reference_date: "01-12",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "くしろリーグ団体選手権 (冬季開催)。5チームずつの部別リーグ戦。",
      eligibility: "釧路卓球協会登録団体。",
      events: [
        { name: "団体戦 小学・中学・高校", category: "youth",  type: "team", per_team: 4, fee: 3000, format: "league" },
        { name: "団体戦 一般",          category: "general",type: "team", per_team: 4, fee: 4000, format: "league" },
      ],
      rules: { ...RULE_TEAM_LEAGUE },
      court: DEFAULT_COURT,
    },
    {
      id: "shitsugen_no_kaze",
      name: "VICTAS杯 湿原の風オープン選手権",
      season: "冬",
      reference_date: "02-11",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["株式会社VICTAS"],
      description: "オープン大会。学生・一般問わず。午後はPMシニアオープン。",
      eligibility: "オープン (学生・一般問わず)。",
      events: [
        { name: "男子シングルス 小・中・高",   gender: "male",   category: "youth",   type: "singles", fee: 500 },
        { name: "女子シングルス 小・中・高",   gender: "female", category: "youth",   type: "singles", fee: 500 },
        { name: "男子シングルス 一般",        gender: "male",   category: "general", type: "singles", fee: 700 },
        { name: "女子シングルス 一般",        gender: "female", category: "general", type: "singles", fee: 700 },
        { name: "男子ダブルス 小・中・高",    gender: "male",   category: "youth",   type: "doubles", fee: 800 },
        { name: "女子ダブルス 小・中・高",    gender: "female", category: "youth",   type: "doubles", fee: 800 },
        { name: "男子ダブルス 一般",         gender: "male",   category: "general", type: "doubles", fee: 1000 },
        { name: "女子ダブルス 一般",         gender: "female", category: "general", type: "doubles", fee: 1000 },
        { name: "PMシニア 男子シングルス", gender: "male",   category: "senior", type: "singles", fee: 700, age_group: "50+" },
        { name: "PMシニア 女子シングルス", gender: "female", category: "senior", type: "singles", fee: 700, age_group: "50+" },
      ],
      rules: { ...RULE_STD, super_seed: true, ball: "VICTAS 40mm ホワイト" },
      court: DEFAULT_COURT,
    },
    {
      id: "butterfly_doubles_cup",
      name: "バタフライ ダブルスチームカップ (タマス杯)",
      season: "春",
      reference_date: "03-20",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["株式会社タマス"],
      description: "オープン大会。ダブルスチーム戦 (D×3) + 年代別シングルス。",
      eligibility: "オープン。",
      events: [
        { name: "ダブルスチームカップ (D×3)", type: "team", per_team: 5, fee: 2000, format: "D×3 2点先取" },
        { name: "男子シングルス 一般",  gender: "male",   category: "general",   type: "singles", fee: 700, age_group: "U30" },
        { name: "女子シングルス 一般",  gender: "female", category: "general",   type: "singles", fee: 700, age_group: "U30" },
        { name: "男子シングルス 高2",   gender: "male",   category: "high",      type: "singles", fee: 500, age_group: "high-2" },
        { name: "女子シングルス 高2",   gender: "female", category: "high",      type: "singles", fee: 500, age_group: "high-2" },
        { name: "男子シングルス 高1",   gender: "male",   category: "high",      type: "singles", fee: 500, age_group: "high-1" },
        { name: "女子シングルス 高1",   gender: "female", category: "high",      type: "singles", fee: 500, age_group: "high-1" },
        { name: "男子シングルス 中2",   gender: "male",   category: "middle",    type: "singles", fee: 500, age_group: "middle-2" },
        { name: "女子シングルス 中2",   gender: "female", category: "middle",    type: "singles", fee: 500, age_group: "middle-2" },
        { name: "男子シングルス 中1",   gender: "male",   category: "middle",    type: "singles", fee: 500, age_group: "middle-1" },
        { name: "女子シングルス 中1",   gender: "female", category: "middle",    type: "singles", fee: 500, age_group: "middle-1" },
        { name: "男子シングルス 小学", gender: "male",   category: "elementary",type: "singles", fee: 500 },
        { name: "女子シングルス 小学", gender: "female", category: "elementary",type: "singles", fee: 500 },
      ],
      rules: { ...RULE_STD, ball: "バタフライ 40mm ホワイト", note: "団体は3Gの2点先取、個人は5G" },
      court: DEFAULT_COURT,
    },
    {
      id: "hopes_cub_bambi",
      name: "ホープス・カブ・バンビ地区予選",
      season: "春",
      reference_date: "03-29",
      venue: "コアかがやき",
      organizer: DEFAULT_ORGANIZER,
      description: "ホープス/カブ/バンビ地区予選 (全道予選)。",
      eligibility: "新小学生以下。",
      events: [
        { name: "ホープス 男子シングルス", gender: "male",   category: "elementary", type: "singles", fee: 500, age_group: "hopes" },
        { name: "ホープス 女子シングルス", gender: "female", category: "elementary", type: "singles", fee: 500, age_group: "hopes" },
        { name: "カブ 男子シングルス",    gender: "male",   category: "elementary", type: "singles", fee: 500, age_group: "cub" },
        { name: "カブ 女子シングルス",    gender: "female", category: "elementary", type: "singles", fee: 500, age_group: "cub" },
        { name: "バンビ 男子シングルス",  gender: "male",   category: "elementary", type: "singles", fee: 500, age_group: "bambi" },
        { name: "バンビ 女子シングルス",  gender: "female", category: "elementary", type: "singles", fee: 500, age_group: "bambi" },
        { name: "ホープス男子団体", gender: "male",   category: "elementary", type: "team", per_team: 3, fee: 2000, age_group: "hopes" },
        { name: "ホープス女子団体", gender: "female", category: "elementary", type: "team", per_team: 3, fee: 2000, age_group: "hopes" },
      ],
      rules: { ...RULE_STD, note: "団体相互審判、個人敗者審判 (リーグは相互)" },
      court: SMALL_COURT,
    },
    {
      id: "marimo_open_akan",
      name: "まりもオープン in Akan (ラージボール)",
      season: "春",
      reference_date: "04-05",
      venue: "阿寒湖まりむ館 多目的ホール",
      organizer: "NPO法人阿寒観光協会まちづくり推進機構 / " + DEFAULT_ORGANIZER,
      sponsors: ["阿寒湖温泉旅館組合", "北海まりも製菓", "三ツ星レストランシステム", "温泉民宿山口"],
      description: "阿寒湖温泉での2日間開催のラージボール大会。1日目団体戦、2日目個人戦。",
      eligibility: "ラージボール愛好者。先着100名。",
      events: [
        { name: "団体戦 (男女混合)", type: "team", per_team: 4, fee: 1000, category: "large", format: "D×3、4ブロック24チーム" },
        { name: "男子ダブルス",     gender: "male",   type: "doubles", fee: 1000, category: "large" },
        { name: "女子ダブルス",     gender: "female", type: "doubles", fee: 1000, category: "large" },
        { name: "男子シングルス",   gender: "male",   type: "singles", fee: 700,  category: "large" },
        { name: "女子シングルス",   gender: "female", type: "singles", fee: 700,  category: "large" },
      ],
      rules: { ...RULE_LARGE_BALL, ball: "ニッタク 44mm オレンジ抗菌", note: "3Gマッチ (ファイナル6:6スタート、9pチェンジ)" },
      court: SMALL_COURT,
    },
  ];

  global.TT_TEMPLATES = TEMPLATES;

  // テンプレ → 大会作成データ。年度依存の数値(回数)は含まない。
  // 大会名には季節ラベルだけ任意で付加可能 (例: "くしろリーグ団体選手権 (夏季)")
  global.TT_buildTournamentFromTemplate = function (templateId, opts) {
    opts = opts || {};
    const tpl = TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return null;
    const today = new Date();
    const year = today.getFullYear();
    let date = opts.date;
    if (!date && tpl.reference_date && tpl.reference_date.match(/^\d{2}-\d{2}$/)) {
      // 該当月日が今年の過去なら来年へ
      const [mm, dd] = tpl.reference_date.split("-");
      const candidate = new Date(year, parseInt(mm) - 1, parseInt(dd));
      date = (candidate < today)
        ? `${year + 1}-${tpl.reference_date}`
        : `${year}-${tpl.reference_date}`;
    }
    // 季節違いの同名テンプレを区別したい場合は名前に追加
    const useSeasonLabel = opts.with_season_label !== false &&
      (tpl.id.endsWith("_summer") || tpl.id.endsWith("_winter"));
    const displayName = useSeasonLabel && tpl.season
      ? `${tpl.name} (${tpl.season})`
      : tpl.name;
    return {
      template_id: tpl.id,
      name: displayName,
      date,
      venue: tpl.venue,
      organizer: tpl.organizer,
      description: tpl.description + (tpl.eligibility ? "\n対象: " + tpl.eligibility : ""),
      status: "scheduled",
      court_rows: tpl.court?.court_rows || 4,
      court_cols: tpl.court?.court_cols || 11,
      hq_position: tpl.court?.hq_position || "bottom",
      numbering_origin: tpl.court?.numbering_origin || "bottom-right",
      enforce_referee_rule: tpl.rules?.enforce_referee_rule !== false ? 1 : 0,
      _events: tpl.events,
      _rules: tpl.rules,
      _sponsors: tpl.sponsors,
      _season: tpl.season,
    };
  };
})(window);
