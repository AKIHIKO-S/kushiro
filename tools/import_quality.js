'use strict';
// 取込プレビューの品質ゲート(notices)を計算する共通モジュール。
//
// 従来 notices(組番号欠番/氏名重複/相方欠落)は JS seed-list パーサ内部だけで計算しており、
// 主系統(Python 罫線パーサ)や PDF 経路の取込では警告が一切出ないという逆転があった。
// 計算をここへ集約し、server 側でどの経路の結果にも同じ品質警告を後付けできるようにする。
// 方針: 警告は「取込前に人が確認すべき点の可視化」であり、自動補正は一切しない。

// 氏名の正規化キー(半角/全角スペースを除去)。dup 判定は seed-list 実装(パーサ)と完全一致させる。
function nameKey(name) {
  return String(name || '').replace(/[\s　]/g, '');
}

// notices を計算する。
//   players : [{ name, seed, partner_name, ... }]
//   opts.format   : 'singles' | 'doubles' | 'team' など(pair_missing 判定に使う)
//   opts.rawSeeds : 振り直し前の生の組番号配列(あれば seed_gap はこれを使う)。
//                   無ければ players[].seed(>=1)から算出する。
function computeNotices(players, opts) {
  players = players || [];
  opts = opts || {};
  const notices = [];

  // ── 組番号の欠番(取りこぼし/欠場の可能性)──
  const rawSeeds = (opts.rawSeeds && opts.rawSeeds.length)
    ? opts.rawSeeds.filter(s => s >= 1)
    : players.map(p => p.seed).filter(s => typeof s === 'number' && s >= 1);
  if (rawSeeds.length) {
    const mn = Math.min(...rawSeeds), mx = Math.max(...rawSeeds), present = new Set(rawSeeds);
    const gaps = []; for (let s = mn; s <= mx; s++) if (!present.has(s)) gaps.push(s);
    if (gaps.length) notices.push({ type: 'seed_gap', count: gaps.length,
      detail: `組番号の欠番 ${gaps.length}件 (取りこぼし/欠場の可能性): ${gaps.slice(0, 20).join(',')}${gaps.length > 20 ? '…' : ''}` });
  }

  // ── 氏名重複(同一人物の二重 or 同姓同名)──
  const nameCount = {};
  players.forEach(p => { const k = nameKey(p.name); if (k) nameCount[k] = (nameCount[k] || 0) + 1; });
  const dups = Object.entries(nameCount).filter(([, c]) => c > 1);
  if (dups.length) notices.push({ type: 'dup_name', count: dups.length,
    detail: `氏名重複 ${dups.length}種 (同一人物の二重 or 同姓同名): ${dups.slice(0, 10).map(([k, c]) => k + '×' + c).join(', ')}` });

  // ── ダブルスの相方欠落 ──
  if (opts.format === 'doubles') {
    const missing = players.filter(p => !p.partner_name).length;
    if (missing) notices.push({ type: 'pair_missing', count: missing, detail: `相方欠落の可能性 ${missing}組` });
  }

  return notices;
}

// events(各 { event, format, players, notices? })に品質 notices を後付けする。
// 既に存在する type は上書き・追加しない(パーサが提供した notices を優先=二重計上の構造的防止)。
// 計算結果が空で既存 notices も無ければ ev.notices は作らない(「notices があるときだけ持つ」形状を保つ)。
function annotateEvents(events) {
  (events || []).forEach(ev => {
    if (!ev || typeof ev !== 'object') return;
    const computed = computeNotices(ev.players || [], { format: ev.format });
    if (!computed.length) return;
    const existing = Array.isArray(ev.notices) ? ev.notices : [];
    const haveTypes = new Set(existing.map(n => n && n.type));
    const merged = existing.concat(computed.filter(n => !haveTypes.has(n.type)));
    if (merged.length) ev.notices = merged;
  });
  return events;
}

module.exports = { computeNotices, annotateEvents, nameKey };
