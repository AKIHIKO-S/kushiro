#!/usr/bin/env node
/**
 * KTTA 取込テンプレ Excel ジェネレーター
 * ============================================
 * シード/登場ラウンド/正確な対戦組合せを明示できる
 * 理想的な取込フォーマット Excel を生成。
 *
 * 出力フォーマット:
 *  シート1「設定」: 大会名、種目、ブラケットサイズ
 *  シート2「組合せ」: 1試合=1行の対戦リスト
 *    [ラウンド | 試合# | 選手1 | 所属1 | 選手2 | 所属2 | 備考]
 *  シート3「シード表」: シード番号 → 何回戦から登場するか
 *  シート4「記入例」: サンプル
 *
 * Usage:
 *   node build_bracket_template.js [OUTPUT.xlsx]
 *   → buffer 用に require して関数呼出も可
 */
'use strict';

const XLSX = require('xlsx');
const path = require('path');

function buildTemplate(opts) {
  opts = opts || {};
  const wb = XLSX.utils.book_new();

  // ─── シート1: 設定 ───
  const settingsAOA = [
    ['取込テンプレ (KTTA Platform)'],
    [''],
    ['◆ 入力方法'],
    ['この Excel に必要事項を入力し、admin → 大会 → 「Excel/PDF 取込」からアップロードしてください。'],
    ['「組合せ」シートに、1試合=1行 で対戦を記入します。シード(上位選手)が後半ラウンドから登場する場合も対応可能です。'],
    [''],
    ['◆ 大会情報'],
    ['項目', '値'],
    ['大会名', opts.tournament_name || '釧路選手権大会 (記入例)'],
    ['種目', opts.event || '一般男子シングルス'],
    ['ブラケットサイズ', opts.bracket_size || 64],
    ['形式', 'singles  (= シングルス。 doubles / team も可)'],
    [''],
    ['◆ 注意'],
    ['・ブラケットサイズは 2 のべき乗 (4, 8, 16, 32, 64, 128, 256)'],
    ['・選手数がブラケットサイズより少ない場合、空き枠は (BYE) と書くか空白にしてください'],
    ['・スーパーシード (4回戦から登場 等) の選手は、その回戦の対戦行に名前を書き、対戦相手側は (1回戦勝者) と書く'],
  ];
  const wsSettings = XLSX.utils.aoa_to_sheet(settingsAOA);
  wsSettings['!cols'] = [{ wch: 18 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, wsSettings, '設定');

  // ─── シート2: 組合せ ───
  // 1試合=1行
  const matchesAOA = [
    [
      'ラウンド', '試合番号', '選手1 氏名', '選手1 所属', '選手2 氏名', '選手2 所属', '備考',
    ],
  ];
  // サンプル: 16人ブラケットの全試合 (1回戦 8試合 + 2回戦 4試合 + ...)
  const sampleSize = 16;
  const totalRounds = Math.log2(sampleSize);
  for (let r = 1; r <= totalRounds; r++) {
    const matchesInRound = sampleSize / Math.pow(2, r);
    for (let i = 1; i <= matchesInRound; i++) {
      let p1Name = '', p1Team = '', p2Name = '', p2Team = '', note = '';
      if (r === 1) {
        const pos1 = (i - 1) * 2 + 1;
        const pos2 = (i - 1) * 2 + 2;
        // サンプルとして 1試合目だけ記入
        if (i === 1) {
          p1Name = '山田 太郎';
          p1Team = '釧友会';
          p2Name = '佐藤 次郎';
          p2Team = 'AMATAKU';
        }
      } else {
        note = `(${r - 1}回戦の試合${(i - 1) * 2 + 1} と 試合${(i - 1) * 2 + 2} の勝者)`;
      }
      matchesAOA.push([
        r === totalRounds ? '決勝' : (r === totalRounds - 1 ? '準決勝' : `${r}回戦`),
        i,
        p1Name, p1Team, p2Name, p2Team, note,
      ]);
    }
  }
  // スーパーシードの記入例 (準々決勝から登場)
  matchesAOA.push(['', '', '', '', '', '', '']);
  matchesAOA.push(['◆ スーパーシードの記入例']);
  matchesAOA.push(['上記の試合一覧で、シード選手が後半ラウンドから登場する場合は、その対戦行に直接名前を記入してください。']);
  matchesAOA.push(['例: 準々決勝の試合1 で「鈴木 太郎 (スマイルクラブ)」がスーパーシード登場し、1回戦の試合1 と 試合2 の勝者と当たる場合']);
  matchesAOA.push(['  準々決勝, 1, 鈴木 太郎, スマイルクラブ, (1回戦の勝者), , ←この行に直接記入']);

  const wsMatches = XLSX.utils.aoa_to_sheet(matchesAOA);
  wsMatches['!cols'] = [
    { wch: 10 }, { wch: 9 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 28 },
  ];
  XLSX.utils.book_append_sheet(wb, wsMatches, '組合せ');

  // ─── シート3: シード表 (参考) ───
  const seedAOA = [
    ['シード番号', '何回戦から登場', '位置 (bracket_pos)', '備考'],
    [1, 1, 1, '第1シード (左半分の最上段)'],
    [2, 1, 16, '第2シード (右半分の最下段)'],
    [3, 1, 9, '第3シード'],
    [4, 1, 8, '第4シード'],
    [5, 1, 5, '第5シード'],
    [6, 1, 12, '第6シード'],
    [7, 1, 13, '第7シード'],
    [8, 1, 4, '第8シード'],
    [''],
    ['◆ 「シード+α」'],
    ['※ ブラケットサイズが選手数の2倍以上の場合、シード選手は2回戦/3回戦/4回戦から登場することができます'],
    ['※ その場合、上の「組合せ」シートで該当ラウンドの行に直接名前を記入してください'],
  ];
  const wsSeed = XLSX.utils.aoa_to_sheet(seedAOA);
  wsSeed['!cols'] = [
    { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 32 },
  ];
  XLSX.utils.book_append_sheet(wb, wsSeed, 'シード表');

  // ─── シート4: 記入例 (フル) ───
  const exampleAOA = [
    ['◆ 16人ブラケット (8試合 1回戦 → 決勝) の完全記入例'],
    [''],
    ['ラウンド', '試合番号', '選手1', '所属1', '選手2', '所属2', '備考'],
    ['1回戦', 1, '山田 太郎', '釧友会', '田中 一郎', 'AMATAKU', '第1シード vs 16位'],
    ['1回戦', 2, '渡辺 健', '釧路湖陵高校', '鈴木 次郎', 'TEAM大和', '8位 vs 9位'],
    ['1回戦', 3, '佐藤 翼', 'infinity', '高橋 玲奈', '個人', '5位 vs 12位'],
    ['1回戦', 4, '木村 翔', 'ワンスター', '伊藤 拓海', 'MPC', '4位 vs 13位'],
    ['1回戦', 5, '中村 大輔', '教育大釧路', '小林 雅', '釧路市役所', '3位 vs 14位'],
    ['1回戦', 6, '加藤 涼介', 'スマイルクラブ', '森 真也', 'TTA.C', '6位 vs 11位'],
    ['1回戦', 7, '清水 賢治', '幣舞中学校', '岡田 駿', '春採中学校', '7位 vs 10位'],
    ['1回戦', 8, '林 雄太', '湖陵高校', '前田 修', '釧路工業', '第2シード vs 15位'],
    ['2回戦', 1, '(試合1勝者)', '', '(試合2勝者)', '', ''],
    ['2回戦', 2, '(試合3勝者)', '', '(試合4勝者)', '', ''],
    ['2回戦', 3, '(試合5勝者)', '', '(試合6勝者)', '', ''],
    ['2回戦', 4, '(試合7勝者)', '', '(試合8勝者)', '', ''],
    ['準決勝', 1, '(2回戦1勝者)', '', '(2回戦2勝者)', '', ''],
    ['準決勝', 2, '(2回戦3勝者)', '', '(2回戦4勝者)', '', ''],
    ['決勝', 1, '(準決勝1勝者)', '', '(準決勝2勝者)', '', ''],
  ];
  const wsExample = XLSX.utils.aoa_to_sheet(exampleAOA);
  wsExample['!cols'] = [
    { wch: 10 }, { wch: 9 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, wsExample, '記入例');

  return wb;
}

function buildTemplateBuffer(opts) {
  const wb = buildTemplate(opts);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

if (require.main === module) {
  const out = process.argv[2] || './tournament_import_template.xlsx';
  const wb = buildTemplate();
  XLSX.writeFile(wb, out);
  console.log('Generated:', out);
}

module.exports = { buildTemplate, buildTemplateBuffer };
