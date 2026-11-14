#!/usr/bin/env node
// 選手登録台帳(registry.json)を運営アプリの選手DBへ取り込む。
//   node tools/import_player_registry.js <registry.json>            … 書き込まずに件数だけ確認
//   node tools/import_player_registry.js <registry.json> --apply    … 取り込む
// 対象DBは環境変数 DB_PATH。本番DBに使う前に、必ずオーナーの確認を取ること。
// 台帳は実名簿なので git に入れない(data/ は .gitignore 済み)。出力には氏名を出さない件数中心。
"use strict";
const fs = require("fs");
const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error("使い方: node tools/import_player_registry.js <registry.json> [--apply]"); process.exit(2); }
const reg = JSON.parse(fs.readFileSync(file, "utf8"));
const db = require("../db");
const r = db.importPlayerRegistry(reg, { apply });
console.log(JSON.stringify({ ...r, skipped: r.skipped.length, skipped_reasons: r.skipped.reduce((m, x) => (m[x.reason] = (m[x.reason] || 0) + 1, m), {}) }, null, 2));
if (r.skipped.length && process.argv.includes("--list")) r.skipped.forEach(x => console.log(x.no, x.name || "", x.reason));
