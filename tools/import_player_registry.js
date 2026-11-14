#!/usr/bin/env node
// 選手登録台帳(registry.json)と運営アプリの選手DBを統合する(台帳を優先・削除しない)。
//   node tools/import_player_registry.js <registry.json>                 … 書き込まずに件数だけ確認(dry run)
//   node tools/import_player_registry.js <registry.json> --list          … 保留の一覧も出す(氏名が出るので画面だけで見る)
//   node tools/import_player_registry.js <registry.json> --apply         … 統合する
// 対象DBは環境変数 DB_PATH。本番DBに使う前に、必ずバックアップを取り、オーナーの確認を取ること。
// 台帳は実名簿なので git に入れない(data/ は .gitignore 済み)。
"use strict";
const fs = require("fs");
const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error("使い方: node tools/import_player_registry.js <registry.json> [--list] [--apply]"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(file, "utf8"));
const db = require("../db");
const r = db.syncPlayerRegistry(reg, { apply, operator: "registry" });
const reasons = {};
r.plan.hold.forEach(h => h.candidates.forEach(c => { reasons[c.reason] = (reasons[c.reason] || 0) + 1; }));
const { plan, ...counts } = r;
console.log(JSON.stringify({ ...counts, hold_reasons: reasons }, null, 2));
console.log(`件数: 統合${r.merged_pairs}件(${r.merge_groups}人分)・更新${r.updated}件・新規${r.created}件・本番にのみ${r.prod_only}件・保留${r.hold}件(本番側${r.held_prod_rows}人)`);
if (process.argv.includes("--list")) r.plan.hold.forEach(h => {
  console.log(`[保留] 台帳${h.no} ${h.name}(${h.furigana || "読みなし"})/${h.team || "所属なし"}`);
  h.candidates.forEach(c => console.log(`    本番 ${c.name}(${c.furigana || "読みなし"})/${c.team || "所属なし"} … ${c.reason}`));
});
