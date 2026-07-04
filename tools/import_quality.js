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

// ── 名簿クロスチェック(roster crosscheck)──────────────────────────────
// ブラケット抽出結果を、同じブック内の名簿(roster_reader.extractRoster の出力)と突合し、
// 取りこぼし/過大/表記揺れを可視化する。自動補正は一切しない(最終判断は運営)。

// 厳密キー: NFKC → 空白と区切り(・,，.．)を除去。seed-list の dedup キー(nkey)と一致させる。
function strictKey(name) {
  let s = String(name || '');
  try { s = s.normalize('NFKC'); } catch (e) {}
  return s.replace(/[\s　・,，.．]/g, '');
}
// 異体字の小辞書(旧字↔新字)。**警告生成専用**であり、同一人物の確定には使わない(候補提示まで)。
const VARIANT_MAP = {
  '髙': '高', '﨑': '崎', '齊': '斉', '齋': '斎', '邊': '辺', '邉': '辺',
  '濵': '浜', '澤': '沢', '檜': '桧', '國': '国', '靑': '青', '眞': '真', '桒': '桑',
};
// 緩いキー: 厳密キー + 異体字畳み込み。表記揺れ(髙橋/高橋)を同一視して警告する用途に限る。
function looseKey(name) {
  return strictKey(name).replace(/./g, (ch) => VARIANT_MAP[ch] || ch);
}

// event 名と名簿シート基底名を突合スコープ解決用に正規化。
function normScope(s) {
  let t = String(s || '');
  try { t = t.normalize('NFKC'); } catch (e) {}
  return t.replace(/[\s　]/g, '');
}

// events(ブラケット) × roster(名簿) を種目単位で突合し、ev.notices へ警告を追記する。
//   roster: [{ name, sheetBase, ... }]  (roster_reader.extractRoster().entries)
// 種目スコープ解決: (i)完全一致 (ii)部分一致(名前包含) の順。どちらでも当たらない名簿は使わない
// (ブック全体との突合は誤警告=狼少年化を招くため、確信を持ってスコープできる時だけ警告する)。
function crossCheck(events, roster) {
  events = events || [];
  roster = roster || [];
  // 突合の基準は「専用の名簿シート(【重複管理】/検算/参加者名簿 等)」に限る。
  // ブラケット木からの収穫(source='harvest')は氏名がラウンドを跨いで多重に現れ、
  // 独立した参照にならない(自己比較で誤警告=狼少年化する)ため使わない。
  // source 未指定(直接API/テスト)の名簿はそのまま使う。
  roster = roster.filter(e => e && e.name && (!e.source || e.source === 'roster_sheet'));
  if (!roster.length) return events;

  // 名簿を sheetBase 単位に集約(distinct strictKey + loose 逆引き)。
  // distinct: 同じ名簿シートに同名が複数回出ても1名として扱う(重複管理シートは重複を含みうる)。
  const rosterBySheet = new Map();
  for (const e of roster) {
    const base = normScope(e.sheetBase || '');
    if (!rosterBySheet.has(base)) rosterBySheet.set(base, { keys: new Map(), loose: new Map(), names: new Map() });
    const g = rosterBySheet.get(base);
    const sk = strictKey(e.name); if (!sk) continue;
    g.keys.set(sk, 1);   // distinct(出現回数は数えない)
    g.names.set(sk, e.name);
    const lk = looseKey(e.name);
    if (!g.loose.has(lk)) g.loose.set(lk, new Set());
    g.loose.get(lk).add(sk);
  }

  for (const ev of events) {
    const evScope = normScope(ev.event || '');
    // この種目に対応する名簿シートを選ぶ(完全一致 → 部分一致)。複数当たれば統合。
    const matched = [];
    for (const [base, g] of rosterBySheet) {
      if (!base) continue;
      if (base === evScope || base.includes(evScope) || evScope.includes(base)) matched.push(g);
    }
    if (!matched.length) continue;   // 確信を持ってスコープできない → 警告しない

    // 名簿側の集約
    const rosterKeys = new Map();     // strictKey -> count
    const rosterLoose = new Map();    // looseKey -> Set(strictKey)
    const rosterName = new Map();     // strictKey -> 表示名
    for (const g of matched) {
      for (const [k, c] of g.keys) rosterKeys.set(k, (rosterKeys.get(k) || 0) + c);
      for (const [k, n] of g.names) rosterName.set(k, n);
      for (const [lk, set] of g.loose) {
        if (!rosterLoose.has(lk)) rosterLoose.set(lk, new Set());
        for (const sk of set) rosterLoose.get(lk).add(sk);
      }
    }

    // ブラケット側の氏名キー(ダブルスは相方も個別に展開)。
    const brKeys = new Set();
    const brLoose = new Set();
    for (const p of (ev.players || [])) {
      for (const nm of [p.name, p.partner_name]) {
        const sk = strictKey(nm); if (!sk) continue;
        brKeys.add(sk); brLoose.add(looseKey(nm));
      }
    }

    const notices = [];
    // roster_missing: 名簿にいるがブラケットに無い(取りこぼし疑い)= 最重要。
    const missing = [...rosterKeys.keys()].filter(k => !brKeys.has(k));
    // ただし異体字違いでブラケットに居るものは missing から除き variant 扱いにする。
    const trueMissing = missing.filter(k => !brLoose.has(looseKey(rosterName.get(k) || '')));
    if (trueMissing.length) {
      const names = trueMissing.map(k => rosterName.get(k)).filter(Boolean);
      notices.push({ type: 'roster_missing', count: trueMissing.length,
        detail: `名簿にいるがトーナメント表から読めていない ${trueMissing.length}名 (取りこぼし疑い): ${names.slice(0, 20).join('、')}${names.length > 20 ? '…' : ''}` });
    }
    // roster_variant: 厳密不一致だが異体字を畳むと一致(表記揺れの疑い)。
    const variants = [];
    for (const k of missing) {
      if (trueMissing.includes(k)) continue;   // 完全欠落は missing で報告済み
      variants.push(rosterName.get(k));
    }
    if (variants.length) notices.push({ type: 'roster_variant', count: variants.length,
      detail: `表記揺れの疑い ${variants.length}件 (旧字/新字など): ${variants.filter(Boolean).slice(0, 20).join('、')}` });
    // roster_extra: ブラケットにいるが名簿に無い(誤読/ノイズ混入の可能性。名簿が部分的な場合もある)。
    const extra = [...brKeys].filter(k => !rosterKeys.has(k) && !rosterLoose.has(k));
    if (extra.length) notices.push({ type: 'roster_extra', count: extra.length,
      detail: `名簿に無い名前 ${extra.length}名 (誤読/名簿の不足の可能性)` });

    if (notices.length) {
      const existing = Array.isArray(ev.notices) ? ev.notices : [];
      const have = new Set(existing.map(n => n && n.type));
      ev.notices = existing.concat(notices.filter(n => !have.has(n.type)));
    }
  }
  return events;
}

module.exports = { computeNotices, annotateEvents, nameKey, strictKey, looseKey, crossCheck };
