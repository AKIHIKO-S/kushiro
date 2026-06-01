"""
entries.py — ブラケットの「リーフ(出場者)」を番号アンカーから抽出する層。

実データのトーナメント表は左右二分割で、番号(ドロー位置)と氏名の
位置関係が左右で鏡像になる:
    左半分(L): [番号][氏名][所属…]   氏名は番号の右
    右半分(R): […所属][氏名][番号]   氏名は番号の左

ダブルスのペア配置は表により2通り:
    隣接列(adjacent): 同一行に [氏名1][氏名2]      (男子D マスター表)
    上下段(stacked):   2行に跨り 氏名1 / 次行=氏名2 (女子D)

さらに大規模種目(男子D)は、各ブロックがローカル番号 1..n を持ち、
別途「マスター一覧列」が通し番号 1..N(全組)を持つ。GTはマスターを採用。
ここでは番号列の連番構造から「マスター列の有無」を判定し、
あればマスールのみ、無ければ各ブロック列(通し番号・重複なし)を統合する。

番号が一切無いブラケットは topology 側(罫線リーフ端)で補完する。
"""

from __future__ import annotations
from dataclasses import dataclass, field
from collections import defaultdict, Counter
from . import tokens as T


@dataclass
class Leaf:
    number: int | None          # ドロー位置/シード(あれば)
    name: str                   # 氏名(ダブルスは "A / B")
    team: str                   # 所属(ダブルスは "A / B" or 単一)
    side: str                   # "L" / "R"
    row: int                    # 氏名の代表行
    name_col: int               # 氏名セル列
    num_col: int | None = None  # 番号セル列
    members: list = field(default_factory=list)   # ["氏名1","氏名2"]
    member_teams: list = field(default_factory=list)  # ["所属1","所属2"]
    layout: str = "single"      # single / adjacent / stacked


# ──────────────────────────────────────────────────────────
# 番号列の発見
# ──────────────────────────────────────────────────────────
def find_number_columns(grid, min_count=5):
    """整数が縦に並ぶ列を番号列候補として返す。
    返り値: {col: [(row, n), ...] (row昇順, 重複行除去済)}"""
    colnums = defaultdict(list)
    for r, c, v in grid.iter_values():
        n = T.to_int(v)
        if n is not None and 1 <= n <= 600:
            colnums[c].append((r, n))
    out = {}
    for c, rows in colnums.items():
        rows.sort()
        seen = set(); uniq = []
        for r, n in rows:
            if r in seen:
                continue
            seen.add(r); uniq.append((r, n))
        if len(uniq) >= min_count:
            out[c] = uniq
    return out


def _num_set(rows):
    return set(n for _, n in rows)


def _is_consec_from_1(rows):
    s = sorted(_num_set(rows))
    return bool(s) and s[0] == 1 and s[-1] == len(s)


def _ranges_overlap(a_rows, b_rows):
    a = _num_set(a_rows); b = _num_set(b_rows)
    amin, amax = min(a), max(a); bmin, bmax = min(b), max(b)
    return not (amax < bmin or bmax < amin)


def select_seed_columns(numcols):
    """番号列群から「シード一覧として使う列」を選ぶ。
    - マスター列(単独で 1..N 連番、かつ他列と範囲が重なる=二重採番)があれば
      最大Nのマスール1本のみを使う(男子D: 通し番号列)。
    - 無ければ全列を統合(男S/女S/女D: 各列が重複しない通し番号)。
    返り値: (使用する列のリスト, is_master: bool)
    """
    cols = sorted(numcols.keys())
    masters = []
    for c in cols:
        if _is_consec_from_1(numcols[c]):
            overlapped = any(c2 != c and _ranges_overlap(numcols[c], numcols[c2])
                             for c2 in cols)
            if overlapped:
                masters.append(c)
    if masters:
        m = max(masters, key=lambda c: len(numcols[c]))
        return [m], True
    return cols, False


# ──────────────────────────────────────────────────────────
# 列ごとの向き(L/R)と段組(single/adjacent/stacked)推定
# ──────────────────────────────────────────────────────────
def _name_at(grid, row, col):
    v = grid.value(row, col)
    return v if (v and T.looks_like_name(v)) else None


def _same_merge(grid, r1, c1, r2, c2):
    rng = grid.merge_range(r1, c1)
    return rng is not None and rng == grid.merge_range(r2, c2)


def _detect_orientation(grid, num_col, rows):
    """氏名が番号の右(L)か左(R)か。返り値: (side, name_col)。
    L: name=num+1。R: name=num-2(右半分は […所属][氏名][番号] なので氏名=num-2)。"""
    right = left = 0
    for r, _ in rows:
        if _name_at(grid, r, num_col + 1):
            right += 1
        if _name_at(grid, r, num_col - 2) or _name_at(grid, r, num_col - 1):
            left += 1
    if right >= left:
        return "L", num_col + 1
    return "R", num_col - 2


def _leaf_spacing(rows):
    if len(rows) < 2:
        return 1
    gaps = [rows[i + 1][0] - rows[i][0] for i in range(len(rows) - 1)]
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return 1
    return Counter(gaps).most_common(1)[0][0]


def _name_diversity(values):
    """候補セル群のうち「氏名らしく」かつ「多様(≒1リーフ1人で重複が少ない)」か。
    地区名(釧路/十勝…)や所属は少数の値が繰り返されるため diversity が低く、
    本物の相方氏名列は diversity が高い。返り値: (name_ratio, distinct_ratio)。"""
    vals = [v for v in values if v]
    if not vals:
        return 0.0, 0.0
    names = [v for v in vals if T.looks_like_name(v)]
    name_ratio = len(names) / len(vals)
    distinct_ratio = (len(set(names)) / len(names)) if names else 0.0
    return name_ratio, distinct_ratio


def _detect_layout(grid, rows, name_col, side, spacing):
    """single / adjacent / stacked を推定。
    outward = 氏名が外側へ伸びる向き(L:+1 右, R:-1 左)。
    - adjacent: (row, name_col+outward) が「多様な氏名列」(地区名/所属は弾く)。
    - stacked : (row+1, name_col) が「多様な氏名列」かつ別マージ(spacing>=2)。
    全行を走査し、氏名率と多様性の両方が高い側を採用。"""
    outward = 1 if side == "L" else -1
    adj_vals, stk_vals = [], []
    for r, _ in rows:
        nm = grid.value(r, name_col)
        if not (nm and T.looks_like_name(nm)):
            continue
        ac = grid.value(r, name_col + outward)
        if ac and not _same_merge(grid, r, name_col, r, name_col + outward):
            adj_vals.append(ac)
        if not _same_merge(grid, r, name_col, r + 1, name_col):
            stk_vals.append(grid.value(r + 1, name_col))

    adj_nr, adj_dr = _name_diversity(adj_vals)
    stk_nr, stk_dr = _name_diversity(stk_vals)
    adj_ok = adj_nr >= 0.6 and adj_dr >= 0.6
    stk_ok = spacing >= 2 and stk_nr >= 0.6 and stk_dr >= 0.6
    if stk_ok and (not adj_ok or stk_dr >= adj_dr):
        return "stacked"
    if adj_ok:
        return "adjacent"
    return "single"


# ──────────────────────────────────────────────────────────
# リーフ1個分の抽出
# ──────────────────────────────────────────────────────────
def _extract_one(grid, r, n, name_col, side, layout):
    """(name表示, team表示, members[], member_teams[]) を返す。失敗時 None。

    実データで確定した配置(左右どちらの半分でも所属は氏名の右隣 name_col+1):
      single  : [氏名][所属]            所属 = name_col+1
      stacked : 氏名1=(r,name_col), 氏名2=(r+1,name_col)。所属 = 各行 name_col+1。
                同一所属はセルが縦結合され1値→重複させない(女子D)。
      adjacent: [氏名1][氏名2][所属1][所属2] 横並び(男子D マスター)。
                outward 方向に 氏名2=name+1, 所属1=name+2, 所属2=name+3。
    """
    outward = 1 if side == "L" else -1
    nm = grid.value(r, name_col)
    if not (nm and T.looks_like_name(nm)):
        return None
    members = [T.normalize_name(nm)]
    member_teams = []
    team_col = name_col + 1  # 所属は常に氏名の右隣

    if layout == "single":
        member_teams.append(grid.value(r, team_col) or "")

    elif layout == "adjacent":
        nm2 = grid.value(r, name_col + outward)
        if nm2 and T.looks_like_name(nm2):
            members.append(T.normalize_name(nm2))
        member_teams = [grid.value(r, name_col + 2 * outward) or "",
                        grid.value(r, name_col + 3 * outward) or ""]

    elif layout == "stacked":
        member_teams.append(grid.value(r, team_col) or "")
        nm2 = grid.value(r + 1, name_col)
        if nm2 and T.looks_like_name(nm2) and not T.is_label_like(nm2):
            members.append(T.normalize_name(nm2))
            # 相方所属: 親と同一の結合セル(=同一所属の1値)なら重複させない
            if not _same_merge(grid, r, team_col, r + 1, team_col):
                member_teams.append(grid.value(r + 1, team_col) or "")

    display = T.join_pair(members[0], members[1]) if len(members) == 2 else members[0]
    team = T.join_teams(member_teams)
    return display, team, members, [T.clean_team(t) for t in member_teams]


# ──────────────────────────────────────────────────────────
# 公開: リーフ抽出
# ──────────────────────────────────────────────────────────
def extract_leaves(grid):
    """番号アンカーから全リーフを抽出。
    返り値: (leaves[number昇順], meta)"""
    numcols = find_number_columns(grid)
    meta = {"number_columns": {}, "used_columns": [], "is_master_list": False}
    if not numcols:
        return [], meta

    use_cols, is_master = select_seed_columns(numcols)
    meta["is_master_list"] = is_master
    meta["used_columns"] = list(use_cols)

    leaves = []
    for num_col in use_cols:
        rows = numcols[num_col]
        side, name_col = _detect_orientation(grid, num_col, rows)
        spacing = _leaf_spacing(rows)
        layout = _detect_layout(grid, rows, name_col, side, spacing)
        meta["number_columns"][num_col] = {
            "side": side, "name_col": name_col, "spacing": spacing,
            "layout": layout, "count": len(rows),
        }
        for r, n in rows:
            got = _extract_one(grid, r, n, name_col, side, layout)
            if not got:
                continue
            display, team, members, member_teams = got
            leaves.append(Leaf(
                number=n, name=display, team=team, side=side, row=r,
                name_col=name_col, num_col=num_col, members=members,
                member_teams=member_teams, layout=layout,
            ))

    leaves.sort(key=lambda L: (L.number if L.number is not None else 9999, L.row))
    return leaves, meta
