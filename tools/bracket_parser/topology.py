"""
topology.py — 罫線(セル境界線)とドロー位置から対戦構造を扱う層。

設計の前提(実データで確認):
  - これらの大会表は標準的なシングルエリミネーション(山)で、
    ドロー番号 = 山の物理位置(上から下)。連番ペアが1回戦で当たる。
  - 罫線は同じ構造を「線」で冗長に符号化している。番号がある表では
    番号が主信号(VICTAS 4種目で位置 100%)、罫線は整合検証に使う。
  - 番号が無い表では罫線(リーフの水平線・物理行順)で順序を復元する。

本モジュールが提供するもの:
  1. order_leaves       : リーフをドロー位置順(番号優先, 無ければ行)に整列。
  2. single_elim_tree   : 整列済みリーフ→標準シングルエリミ木(1回戦=連番ペア)。
  3. verify_lines       : 番号順と物理行順の一致を検証(罫線健全性の指標)。
  4. vertical_segments / count_connectors : 罫線(垂直線)の素片検出ユーティリティ。

罫線の「全線追跡による対戦復元」は、実データのシード型staggered配置では
線長がシード/不戦を符号化し単純な隣接=対戦にならないため、主経路には
採らない(番号と物理順がより頑健で、プラットフォームは seed-list から
標準山を再生成して同一の対戦を得る)。本モジュールは検証と番号無し
フォールバックに罫線を用いる、という役割分担を明確にしている。

座標は grid と同じく 1 始まり。"""

from __future__ import annotations
from dataclasses import dataclass, field
from collections import defaultdict


@dataclass
class MatchNode:
    round: int                       # 1=1回戦
    pos: int                         # 同ラウンド内の位置(0始まり)
    side: str                        # "L"/"R"/""
    a: object = None                 # 子(MatchNode) or Leaf or None(BYE)
    b: object = None
    children: list = field(default_factory=list)


# ──────────────────────────────────────────────────────────
# 罫線素片(検証/フォールバック用)
# ──────────────────────────────────────────────────────────
def vertical_segments(grid, c, r_lo, r_hi):
    """列 c の rows[r_lo..r_hi] にある垂直線分(edge_right連続)を [(a,b),...]。"""
    segs = []; r = r_lo
    while r <= r_hi:
        if grid.edge_right(r, c):
            a = r
            while r <= r_hi and grid.edge_right(r, c):
                r += 1
            segs.append((a, r - 1))
        else:
            r += 1
    return segs


def count_connectors(grid, leaves):
    """リーフ範囲内の垂直線分(2行以上)の総数。健全な山では概ね葉数-1規模。"""
    if not leaves:
        return 0
    rows = [L.row for L in leaves]
    cols = [L.name_col for L in leaves]
    r0, r1 = min(rows) - 1, max(rows) + 2
    c0, c1 = min(cols) - 2, max(cols) + 60
    n = 0
    for c in range(max(1, c0), c1 + 1):
        for a, b in vertical_segments(grid, c, max(1, r0), r1):
            if b - a >= 1:
                n += 1
    return n


def has_player_line(grid, leaf):
    """リーフの氏名セルから内側へ水平線(edge_below/edge_above)が出ているか。
    番号無し表でのリーフ妥当性判定に使う。"""
    r = leaf.row
    c = leaf.name_col
    step = 1 if leaf.side != "R" else -1
    for k in range(1, 6):
        cc = c + step * k
        if grid.edge_below(r, cc) or grid.edge_above(r, cc) or grid.edge_below(r, c) :
            return True
    return False


# ──────────────────────────────────────────────────────────
# ドロー位置順の整列
# ──────────────────────────────────────────────────────────
def order_leaves(leaves, side=None):
    """リーフをドロー位置順に整列。番号があれば(番号,行)、無ければ行のみ。
    side 指定時はその半分のみ。"""
    sel = [L for L in leaves if (side is None or L.side == side)]
    have_numbers = all(L.number is not None for L in sel) and len(sel) > 0
    if have_numbers:
        return sorted(sel, key=lambda L: (L.number, L.row))
    return sorted(sel, key=lambda L: (L.row, L.name_col))


# ──────────────────────────────────────────────────────────
# 標準シングルエリミネーション木
# ──────────────────────────────────────────────────────────
def single_elim_tree(ordered_leaves, side=""):
    """整列済みリーフ(片側 or 全体)→ 1回戦=連番ペアの木。
    奇数余りは不戦勝(片側 None)。返り値: root MatchNode or None。"""
    if not ordered_leaves:
        return None
    # 1回戦ノード
    cur = []
    for i in range(0, len(ordered_leaves), 2):
        a = ordered_leaves[i]
        b = ordered_leaves[i + 1] if i + 1 < len(ordered_leaves) else None
        cur.append(MatchNode(round=1, pos=i // 2, side=side, a=a, b=b,
                             children=[a] + ([b] if b is not None else [])))
    rnd = 1
    while len(cur) > 1:
        rnd += 1
        nxt = []
        for i in range(0, len(cur), 2):
            a = cur[i]
            b = cur[i + 1] if i + 1 < len(cur) else None
            nxt.append(MatchNode(round=rnd, pos=i // 2, side=side, a=a, b=b,
                                children=[a] + ([b] if b is not None else [])))
        cur = nxt
    return cur[0]


def round1_pairs(ordered_leaves):
    """1回戦の (leafA, leafB|None) 対を返す(連番ペア)。"""
    out = []
    for i in range(0, len(ordered_leaves), 2):
        a = ordered_leaves[i]
        b = ordered_leaves[i + 1] if i + 1 < len(ordered_leaves) else None
        out.append((a, b))
    return out


# ──────────────────────────────────────────────────────────
# 罫線整合の検証
# ──────────────────────────────────────────────────────────
def verify_lines(grid, leaves):
    """番号順と物理行順の一致 + 罫線(コネクタ/水平線)の存在を検証。
    取込は止めず、信頼度の指標を返す。"""
    info = {"checked": False, "sides": {}, "connectors": 0, "leaf_lines": None}
    numbered = [L for L in leaves if L.number is not None]
    if not leaves:
        return info
    info["connectors"] = count_connectors(grid, leaves)
    # リーフの水平線存在率(罫線がリーフに繋がっているか)
    withline = sum(1 for L in leaves if has_player_line(grid, L))
    info["leaf_lines"] = {"with_line": withline, "total": len(leaves),
                          "ratio": round(withline / len(leaves), 3)}
    if len(numbered) >= 4:
        info["checked"] = True
        # 番号列ごとに「番号順==物理行順」を検証(複数ブロックが同じ行を共有
        # するため side 単位では誤検出する。列単位が正しい粒度)。
        bycol = defaultdict(list)
        for L in numbered:
            bycol[L.num_col].append(L)
        col_ok = 0
        for col, sl in bycol.items():
            if len(sl) < 2:
                col_ok += 1
                continue
            by_num = [L.number for L in sorted(sl, key=lambda L: L.number)]
            by_row = [L.number for L in sorted(sl, key=lambda L: L.row)]
            if by_num == by_row:
                col_ok += 1
        info["columns_monotonic"] = {"ok": col_ok, "total": len(bycol)}
        # 参考: side 単位の集計も残す
        for side in ("L", "R"):
            sl = [L for L in numbered if L.side == side]
            if sl:
                info["sides"][side] = {"count": len(sl)}
    return info
