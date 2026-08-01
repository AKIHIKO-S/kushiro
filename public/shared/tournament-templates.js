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

  // ── 申込プリセット(大会の性格ごとに「聞くこと」が決まっている) ──
  // 大会を作った時点で申込フォームの項目まで決まるようにする。
  // 生年月日は種目側の age_check(年代別クラスの資格判定)で出すため、ここには入れない。
  // 締切時刻17:00は要項の慣例。定員は会場ごとに違うので既定を置かない(0=上限なし)。
  const ENTRY_STUDENT = {          // 中学・高校・小学生の大会
    field_config: { fields: { furigana: "required", grade: "required", player_team: "required", supervisor: "optional", advisor: "optional" } },
    entry_deadline_time: "17:00",
  };
  const ENTRY_GENERAL = {          // 一般・オープン(学生が一般の部に出ることがある)
    field_config: { fields: { furigana: "required", grade: "optional", player_team: "required" } },
    entry_deadline_time: "17:00",
  };
  const ENTRY_AGE_CLASS = {        // ラージボール等の年代別(生年月日は種目のage_checkで聞く)
    field_config: { fields: { furigana: "required", grade: "hidden", player_team: "required" } },
    entry_deadline_time: "17:00",
  };
  const ENTRY_TEAM = {             // 団体戦(申込は監督・責任者が代表して出す)
    field_config: { fields: { furigana: "required", player_team: "optional", supervisor: "required", coach: "optional" } },
    entry_deadline_time: "17:00",
  };
  const ENTRY_TEAM_STUDENT = {     // 中学の団体戦(学年が出場資格に効くので必ず聞く)
    field_config: { fields: { furigana: "required", grade: "required", player_team: "optional", supervisor: "required", advisor: "optional" } },
    entry_deadline_time: "17:00",
  };
  // 上部団体(道連)の大会を支部で取りまとめるとき。団体戦の監督を聞き、学年は無い(成年の大会)。
  // 生年月日は種目側の age_check(年代別区分の資格判定)で聞くのでここには入れない。
  const ENTRY_FEDERATION = {
    // 紙の申込用紙(2026プリンセス大会申込書.xls)に合わせる。
    // 用紙が聞いているのは 氏名・年齢・所属・戦型 と、申込側の 支部名・責任者名・住所・電話。
    // ふりがなは用紙に無いので聞かない(用紙と違うものを聞くと転記のたびに食い違う)。
    // 成年の大会なので「引率顧問・コーチ」ではなく「監督」を聞く(学生大会の語彙を持ち込まない)。
    field_config: {
      fields: { furigana: "hidden", grade: "hidden", player_team: "required",
        supervisor: "optional", advisor: "hidden", coach: "hidden" },
      field_meta: {
        supervisor: { label: "監督", help: "団体戦に申し込む場合は監督を記入してください（選手との兼任可）" },
        player_team: { label: "所属" },
      },
      // 用紙の「支部名」は聞かない。釧路卓球協会が取りまとめる以上、申込者は全員が釧路支部で
      // 値が変わらないため、書かせても手間が増えるだけ(本部が用紙へ転記するときに「釧路」と入れる)。
      custom: [
        { key: "address", label: "住所", type: "text", scope: "submission",
          help: "申込用紙の「住所」欄です（団体戦の責任者）" },
        { key: "style", label: "戦型", type: "text", scope: "player",
          help: "カット主戦の方のみ「カット」とご記入ください（用紙の注記どおり）" },
      ],
    },
    entry_deadline_time: "17:00",
    // 上部団体の大会は支部がまとめて送金するので、既定の「当日受付でお支払い」は誤案内になる。
    payment_note: "参加料は釧路卓球協会（釧路支部）が取りまとめて主催団体へ送金します。"
      + "個人・チームから直接お振込みされないようお願いします。支部への納入方法は別途ご連絡します。",
  };

  const TEMPLATES = [
    {
      id: "kaicho_hai",
      entry_preset: ENTRY_GENERAL,
      name: "会長杯 / 高校釧根支部オープン",
      season: "春",
      reference_date: "05-03",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["高体連釧根支部", "釧路地区中体連"],
      description: "会長杯 / 高校釧根支部オープン。一般・高校・中学の団体戦＋一般・高校・中学・小学のシングルス。",
      eligibility: "釧路卓球協会の登録会員 (準会員含む)。高校の部は釧根オープン。",
      events: [
        { name: "一般 団体戦", category: "general", type: "team", per_team: 4, per_team_min: 4, fee: 3000, note: "1複4単 (4人以上)", tie_format: "D,S,S,S,S" },
        { name: "高校 団体戦", category: "high",    type: "team", per_team: 4, fee: 2000, tie_format: "D,S,S,S,S" },
        { name: "中学 団体戦", category: "middle",  type: "team", per_team: 8, per_team_min: 6, fee: 2000, note: "6〜8人", tie_format: "S,S,D,S,S" },
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
      entry_preset: ENTRY_STUDENT,
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
      entry_preset: ENTRY_GENERAL,
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
      entry_preset: ENTRY_TEAM,
      name: "くしろリーグ団体選手権",
      season: "夏季",
      reference_date: "07-19",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      co_organizer: "東北海道スポーツコミッション (EHSC)",
      description: "くしろリーグ団体選手権 (夏季開催)。5チームずつの部別リーグ戦。",
      eligibility: "釧路卓球協会登録団体。1団体何チームでも参加可能。",
      events: [
        { name: "団体戦 小学・中学・高校", category: "youth", type: "team", per_team: 4, per_team_min: 4, fee: 3000, format: "league" },
        { name: "団体戦 一般",           category: "general",type: "team", per_team: 4, per_team_min: 4, fee: 4000, format: "league" },
      ],
      rules: { ...RULE_TEAM_LEAGUE, structure: "1部/2部/3部 別 5チームリーグ" },
      court: DEFAULT_COURT,
    },
    {
      id: "team_only",
      entry_preset: ENTRY_TEAM,
      name: "団体戦専用大会",
      season: "通年",
      reference_date: "10-10",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "団体戦のみの大会。各対戦は種目ごとの対戦形式(tie_format)で構成し、進行管理の結果入力で各試合の勝者→団体スコアを記録します。",
      eligibility: "釧路卓球協会登録団体。",
      events: [
        // tie_format: S=シングルス D=ダブルス をカンマ区切り。過半数で団体勝利。空欄ならチームスコア直接入力。
        { name: "一般男子 団体戦", category: "general", gender: "male",   type: "team", per_team: 5, fee: 4000, tie_format: "S,S,D,S,S" },
        { name: "一般女子 団体戦", category: "general", gender: "female", type: "team", per_team: 5, fee: 4000, tie_format: "S,S,D,S,S" },
        { name: "高校男子 団体戦", category: "high",    gender: "male",   type: "team", per_team: 5, fee: 3000, tie_format: "S,S,D,S,S" },
        { name: "高校女子 団体戦", category: "high",    gender: "female", type: "team", per_team: 5, fee: 3000, tie_format: "S,S,D,S,S" },
        { name: "中学男子 団体戦", category: "middle",  gender: "male",   type: "team", per_team: 5, fee: 3000, tie_format: "S,S,D,S,S" },
        { name: "中学女子 団体戦", category: "middle",  gender: "female", type: "team", per_team: 5, fee: 3000, tie_format: "S,S,D,S,S" },
      ],
      rules: { ...RULE_TEAM_LEAGUE, structure: "トーナメント (各対戦は S,S,D,S,S = 5試合3勝先取)" },
      court: DEFAULT_COURT,
    },
    {
      id: "kushiro_senshuken",
      entry_preset: ENTRY_GENERAL,
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
      entry_preset: ENTRY_STUDENT,
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
      entry_preset: ENTRY_STUDENT,
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
      entry_preset: ENTRY_GENERAL,
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
      entry_preset: ENTRY_AGE_CLASS,
      name: "Nittaku杯タンチョウオープン (ラージボール)",
      season: "秋",
      reference_date: "10-18",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["日本卓球株式会社 (ニッタク)", "株式会社三ッ星レストランシステム", "北海まりも製菓", "温泉民宿山口"],
      description: "全国オープン ラージボール大会。年代別。",
      eligibility: "ラージボールを楽しめる方。日本卓球協会登録の有無は問わない。",
      // 要項「一人最大3種目(混合ダブルス、ダブルス、シングルス)にエントリーできます」
      entry_max_events: 3,
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
      entry_preset: ENTRY_TEAM_STUDENT,
      name: "道新杯 北海道中学選抜卓球大会 (団体戦) 地区予選",
      season: "秋",
      reference_date: "11-01",
      venue: SUB_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "中学団体戦の地区予選。4単1複の5試合制。",
      eligibility: "中1〜中2 (3年生は不可)。チーム編成は学校単位。",
      events: [
        { name: "男子団体", gender: "male",   category: "middle", type: "team", per_team: 8, per_team_min: 6, fee: 2000, format: "4S+1D, 5試合", reps_seats: 2 },
        { name: "女子団体", gender: "female", category: "middle", type: "team", per_team: 8, per_team_min: 6, fee: 2000, format: "4S+1D, 5試合", reps_seats: 2 },
      ],
      rules: { ...RULE_STD, referee_rule: "mutual", note: "予選L+決勝T (7チーム以下は決勝Lのみ)" },
      court: SUB_COURT,
    },
    {
      id: "chugaku_shinjin",
      entry_preset: ENTRY_STUDENT,
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
      entry_preset: ENTRY_TEAM,
      name: "くしろリーグ団体選手権",
      season: "冬季",
      reference_date: "01-12",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      description: "くしろリーグ団体選手権 (冬季開催)。5チームずつの部別リーグ戦。",
      eligibility: "釧路卓球協会登録団体。",
      events: [
        { name: "団体戦 小学・中学・高校", category: "youth",  type: "team", per_team: 4, per_team_min: 4, fee: 3000, format: "league" },
        { name: "団体戦 一般",          category: "general",type: "team", per_team: 4, per_team_min: 4, fee: 4000, format: "league" },
      ],
      rules: { ...RULE_TEAM_LEAGUE },
      court: DEFAULT_COURT,
    },
    {
      id: "shitsugen_no_kaze",
      entry_preset: ENTRY_GENERAL,
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
      entry_preset: ENTRY_GENERAL,
      name: "バタフライ ダブルスチームカップ (タマス杯)",
      season: "春",
      reference_date: "03-20",
      venue: DEFAULT_VENUE,
      organizer: DEFAULT_ORGANIZER,
      sponsors: ["株式会社タマス"],
      description: "オープン大会。ダブルスチーム戦 (D×3) + 年代別シングルス。",
      eligibility: "オープン。",
      events: [
        { name: "ダブルスチームカップ (D×3)", type: "team", per_team: 6, per_team_min: 4, fee: 2000, format: "D×3 2点先取" },
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
      entry_preset: ENTRY_STUDENT,
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
        { name: "ホープス男子団体", gender: "male",   category: "elementary", type: "team", per_team: 4, per_team_min: 3, fee: 2000, age_group: "hopes" },
        { name: "ホープス女子団体", gender: "female", category: "elementary", type: "team", per_team: 4, per_team_min: 3, fee: 2000, age_group: "hopes" },
      ],
      rules: { ...RULE_STD, note: "団体相互審判、個人敗者審判 (リーグは相互)" },
      court: SMALL_COURT,
    },
    {
      id: "marimo_open_akan",
      entry_preset: ENTRY_AGE_CLASS,
      name: "まりもオープン in Akan (ラージボール)",
      season: "春",
      reference_date: "04-05",
      venue: "阿寒湖まりむ館 多目的ホール",
      organizer: "NPO法人阿寒観光協会まちづくり推進機構 / " + DEFAULT_ORGANIZER,
      sponsors: ["阿寒湖温泉旅館組合", "北海まりも製菓", "三ツ星レストランシステム", "温泉民宿山口"],
      description: "阿寒湖温泉での2日間開催のラージボール大会。1日目団体戦、2日目個人戦。",
      eligibility: "ラージボール愛好者。先着100名。",
      events: [
        // 要項は「1人 1,000円」(1チーム4人・ダブルス3試合)。1チームいくらではなく人数分を請求する
        { name: "団体戦 (男女混合)", type: "team", per_team: 4, per_team_min: 4, fee: 1000, fee_unit: "person", capacity: 24,
          category: "large", format: "D×3、4ブロック24チーム", note: "1人1,000円・1チーム4人" },
        { name: "男子ダブルス",     gender: "male",   type: "doubles", fee: 1000, category: "large" },
        { name: "女子ダブルス",     gender: "female", type: "doubles", fee: 1000, category: "large" },
        { name: "男子シングルス",   gender: "male",   type: "singles", fee: 700,  category: "large" },
        { name: "女子シングルス",   gender: "female", type: "singles", fee: 700,  category: "large" },
      ],
      rules: { ...RULE_LARGE_BALL, ball: "ニッタク 44mm オレンジ抗菌", note: "3Gマッチ (ファイナル6:6スタート、9pチェンジ)" },
      court: SMALL_COURT,
    },
    {
      // 北海道卓球連盟の主催大会。釧路卓球協会は「釧路支部」として支部内の申込を取りまとめ、
      // 道連事務局へまとめて提出・送金する立場になる(要項15「必ず各支部事務局が取りまとめて
      // 行うものとする」)。したがってこのフォームは**支部内の締切**で締める必要があり、
      // 道連必着日そのものを締切にしてはいけない(取りまとめの時間が無くなる)。
      id: "princess_hokkaido",
      entry_preset: ENTRY_FEDERATION,
      name: "北海道プリンセス卓球大会",
      season: "秋",
      reference_date: "09-26",
      // 支部内の申込締切。道連事務局への必着(第55回は8月28日)より前に締めて、
      // 取りまとめ・提出の時間を確保する。8月25日はオーナー確定値(2026-08-01)。
      reference_deadline: "08-25",
      deadline_note: "道連事務局への必着日より前に支部で締めます（第55回は道連必着8月28日）。",
      venue: "よつ葉アリーナ十勝 (帯広市大通北1丁目1番地)",
      organizer: "北海道卓球連盟",
      co_organizer: "十勝卓球協会 (北海道卓球連盟 十勝支部) 主管",
      description: "北海道卓球連盟主催の女子大会。1日目に団体戦(複・単・複)、2日目に個人戦シングルス(年代別7部門)。"
        + "釧路卓球協会は釧路支部として支部内の申込を取りまとめ、道連事務局へ提出する。",
      eligibility: "当該年度の一般選手登録を済ませた成年女性(既婚歴不問・日学連登録者は不可)。大会年度の翌4月1日時点で満18歳以上。",
      events: [
        // 団体戦: 監督1名(選手兼可)+ 選手4〜7人で登録。試合は 複・単・複 の3本で2点先取。
        // 1・2番は異なる3名、3番は出ていない選手か 1・2番のうち1人だけ重複可。
        { name: "団体戦", gender: "female", type: "team", fee: 7000,
          per_team: 7, per_team_min: 4, tie_format: "D,S,D", category: "general",
          // 用紙の団体表は「氏名・年齢・支部・所属チーム」。年齢欄があるので選手ごとに聞く。
          // 区分が無いので資格判定はせず、記入してもらうだけ(集計シートの年齢列に入る)。
          age_check: { mode: "age", as_of: "" },
          note: "監督1名(選手兼可)+選手4〜7人。複・単・複の2点先取。当日3名ならオープン参加、2名は不可" },
        // 個人戦シングルス: 年代別・卓球歴別の7部門。**この内1種目のみ出場可**なので、
        // 種目を7つに割らず1種目の中の「区分」にする(フォームでは択一になり、二重申込が構造的に起きない)。
        // 年齢は大会年度の翌4月1日現在で判定する(要項8「年齢の算出基準は翌年4月1日現在」)。
        // ③〜⑦は下の年代にも出場できるため、上限は設けず下限(min_age)だけを効かせる。
        { name: "個人戦 シングルス", gender: "female", type: "singles", fee: 2000, category: "general",
          // 用紙は「年齢」欄。生年月日は聞かず、用紙と同じ年齢を書いてもらう。
          // 基準日(翌年4月1日)は入力の目安として画面に出す。
          age_check: { mode: "age", as_of: "" },
          entry_categories: [
            { value: "beginner", label: "ビギナーの部", short: "ビギナー", min_age: 18,
              note: "年齢に関係なく出場可。過去にビギナーの部で優勝した方は出場できません" },
            { value: "under30",  label: "サーティ以下", short: "サーティ以下", min_age: 18 },
            { value: "forty",    label: "フォーティ",   short: "フォーティ",   min_age: 40 },
            { value: "fifty",    label: "フィフティ",   short: "フィフティ",   min_age: 50 },
            { value: "sixty",    label: "シックスティ", short: "シックスティ", min_age: 60 },
            { value: "seventy",  label: "セブンティ",   short: "セブンティ",   min_age: 70 },
            { value: "eighty",   label: "エイティ",     short: "エイティ",     min_age: 80 },
          ],
          note: "7部門のうち1部門のみ出場可。全部門とも3名以上で成立" },
      ],
      rules: {
        points: 11, games: 3,
        referee_rule: "mutual_then_loser",
        ball: "JTTA公認プラスチック球 40mm ホワイト",
        enforce_referee_rule: true,
        note: "団体は複・単・複の2点先取。リーグ戦からトーナメント戦へ移行。ゼッケンは当該年度の日本卓球協会指定のもの",
      },
      court: DEFAULT_COURT,
    },
  ];

  global.TT_TEMPLATES = TEMPLATES;

  // 年代別区分の基準日(age_check.as_of)を、大会日付から「その年度の翌4月1日」に解決する。
  // 例: 2026-09-26 の大会 → 年度は2026年度(4月〜翌3月) → 基準日は 2027-04-01。
  // テンプレ側は as_of を空にしておき、ここで年を埋める。既に入っている値は尊重する。
  function _fiscalNextApril1(dateStr) {
    const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
    const fiscalYear = mo >= 4 ? y : y - 1;     // 1〜3月は前年度
    return (fiscalYear + 1) + "-04-01";
  }
  // 申込締切(月日)を、確定した大会日付と同じ年で解決する。
  // 締切が開催日より後になる組み合わせ(例: 1月開催で締切12月)は前年に送る。
  function _resolveDeadline(refMMDD, dateStr) {
    if (!refMMDD || !/^\d{2}-\d{2}$/.test(String(refMMDD))) return "";
    const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return "";
    const y = parseInt(m[1], 10);
    const same = y + "-" + refMMDD;
    return same < dateStr ? same : (y - 1) + "-" + refMMDD;
  }
  function _resolveAgeAsOf(events, dateStr) {
    if (!Array.isArray(events)) return events;
    const asOf = _fiscalNextApril1(dateStr);
    return events.map(function (e) {
      // birthdate は判定に使い、age は「何歳時点で書くか」の目安として画面に出す。どちらも埋める。
      if (!e || !e.age_check) return e;
      if (e.age_check.mode !== "birthdate" && e.age_check.mode !== "age") return e;
      if (e.age_check.as_of) return e;          // 明示指定があればそのまま
      if (!asOf) return e;                      // 日付未定なら空のまま(サーバ側が年度4/1へフォールバック)
      return { ...e, age_check: { ...e.age_check, as_of: asOf } };
    });
  }

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
      // 要項の「一人最大N種目」。申込設定に引き継ぐ(0/未設定なら制限なし)。
      entry_max_events: tpl.entry_max_events || 0,
      // 申込プリセット(この大会で聞くこと)。大会作成時にそのまま申込設定へ流す。
      _entry_preset: tpl.entry_preset || null,
      // 申込締切。テンプレは月日だけを持ち、確定した大会日付から年を決める
      // (締切が開催日より後にならないよう、月日が開催日を過ぎていれば前年にする)。
      entry_deadline: _resolveDeadline(tpl.reference_deadline, date),
      _deadline_note: tpl.deadline_note || "",
      // 年代別の資格判定は「大会年度の翌4月1日現在の年齢」で行うのが要項の慣例。
      // テンプレは年を持てないので、確定した大会日付からここで解決する
      // (未解決のまま渡すと年齢判定が大会日基準になり、境界の1年がずれる)。
      _events: _resolveAgeAsOf(tpl.events, date),
      _rules: tpl.rules,
      _sponsors: tpl.sponsors,
      _season: tpl.season,
    };
  };
})(window);
