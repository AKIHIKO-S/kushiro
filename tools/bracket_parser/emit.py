"""
emit.py — 抽出した Leaf 群を、プラットフォームの取込契約に合わせて整形する層。

db.importBracket(seed-list) が消費する選手レコード形:
  シングルス: { seed, name, team }
  ダブルス  : { seed, name, partner_name, team, partner_team, is_doubles: true }

イベント包み:
  { event, format: "singles"|"doubles", players: [...], regenerate: true }
全体:
  { format: "tabletennis-seed-list-v1", source: "bracket_excel_py", events: [...] }
"""

from __future__ import annotations
from . import tokens as T


def leaf_to_player(leaf, seed):
    """Leaf → 取込用選手レコード。seed は 1始まりの通し順位。"""
    members = leaf.members or [leaf.name]
    teams = leaf.member_teams or []
    name = T.normalize_name(members[0]) if members else ""
    team = T.clean_team(teams[0]) if teams else ""
    rec = {"seed": seed, "name": name, "team": team}
    if len(members) >= 2 and members[1]:
        rec["partner_name"] = T.normalize_name(members[1])
        # 相方所属: 元データに2つ目の所属セルがあるときのみ設定。
        # 同一所属が1セル(縦結合)なら空のままにし、表示は単一所属に畳まれる
        # (女子D 同一クラブ="スマイルクラブ" / 男子D 2セル="AMATAKU / 個人")。
        rec["partner_team"] = T.clean_team(teams[1]) if (len(teams) >= 2 and teams[1]) else ""
        rec["is_doubles"] = True
    return rec


def detect_format(leaves):
    """ダブルス(2名)を1つでも含めば doubles、それ以外 singles。"""
    for L in leaves:
        if len(L.members or []) >= 2:
            return "doubles"
    return "singles"


def build_event(leaves, event_name, format_hint=None):
    """Leaf 群 → イベント辞書。seed は number 昇順(無番は後ろ)で連番再付与。
    取込契約に合わせ、表示結合("A / B")ではなく name/partner_name を分離保持する。"""
    ordered = sorted(leaves, key=lambda L: (L.number if L.number is not None else 10**9, L.row))
    players = []
    for i, L in enumerate(ordered):
        # seed は元の番号を優先(通し番号として妥当)。無ければ連番。
        seed = L.number if L.number is not None else (i + 1)
        players.append(leaf_to_player(L, seed))
    # seed 重複や欠番があっても db 側は seed 昇順で配置するため、ここでは番号を尊重。
    fmt = format_hint or detect_format(ordered)
    return {
        "event": (event_name or "").strip(),
        "format": fmt,
        "players": players,
        "regenerate": True,
    }


def build_seedlist(events):
    """イベント配列 → seed-list-v1 全体。空(<2人)イベントは除外。"""
    evs = [e for e in events if len(e.get("players", [])) >= 2]
    return {
        "format": "tabletennis-seed-list-v1",
        "source": "bracket_excel_py",
        "events": evs,
    }


# 検証用: 取込形(分離)→ GT エクスポート形(結合)に畳む
def player_display(rec):
    """{name,partner_name,team,partner_team} → 表示用 (name="A / B", team="A / B")。
    GT JSON(エクスポート形)との突合に使う。"""
    name = rec.get("name", "")
    team = T.clean_team(rec.get("team", ""))
    if rec.get("partner_name"):
        name = T.join_pair(rec["name"], rec["partner_name"])
        teams = [t for t in [T.clean_team(rec.get("team", "")),
                             T.clean_team(rec.get("partner_team", ""))] if t]
        team = " / ".join(teams)
    return {"seed": rec.get("seed"), "name": name, "team": team}
