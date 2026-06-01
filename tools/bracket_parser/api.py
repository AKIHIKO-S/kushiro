"""
api.py — 公開API。grid→entries→emit を束ね、種目(シート)ごとに
seed-list-v1 を生成する。罫線(topology)は構造検証・番号無し表の
フォールバックとして併走させる。

主系統(番号アンカー)は実測で VICTAS 4種目 474/474 一致。
罫線は番号の妥当性検証(物理的な上下順)に用い、番号が無い表では
罫線順でリーフを並べてシードを推定する。
"""

from __future__ import annotations
import re
from .grid import load_grid, sheet_names
from . import entries as E
from . import emit as M
from . import topology as TP


class ParseError(Exception):
    pass


# 対戦表ではない管理用シート(審判・役員・タイムテーブル等)はスキップ。
_NON_BRACKET_SHEET = re.compile(
    r"(審判|役員|係|担当|タイム|ﾀｲﾑ|日程|進行表|コート割|ｺｰﾄ|会場|要項|名簿|集計|"
    r"申込|受付|口座|振込|テンプレ|template|sheet\d*$|^sheet$)",
    re.IGNORECASE,
)


def _is_non_bracket_name(name):
    return bool(name and _NON_BRACKET_SHEET.search(str(name).strip()))


def parse_sheet(path_or_grid, sheet=None, event_hint=None, format_hint=None):
    """単一シート → イベント辞書(players は取込契約形)。リーフ0なら None。"""
    grid = path_or_grid if hasattr(path_or_grid, "value") else load_grid(path_or_grid, sheet)
    leaves, meta = E.extract_leaves(grid)
    if not leaves:
        return None
    ev = M.build_event(leaves, event_hint or getattr(grid, "sheet_name", "") or sheet, format_hint)
    ev["_meta"] = {
        "used_columns": meta.get("used_columns"),
        "is_master_list": meta.get("is_master_list"),
        "layouts": [m["layout"] for m in meta.get("number_columns", {}).values()],
        "line_verify": TP.verify_lines(grid, leaves),
    }
    return ev


def parse_workbook(path, sheet=None, event_hint=None, format_hint=None,
                   all_sheets=True, include_meta=False):
    """ワークブック全体(or 単一シート)→ seed-list-v1。

    返り値: {format:'tabletennis-seed-list-v1', source, events:[...]}
    include_meta=False のとき各イベントの _meta は除去する(取込用にクリーン)。
    """
    names = [sheet] if sheet else (sheet_names(path) if all_sheets else [None])
    events = []
    for sn in names:
        # 全シート走査時のみ、明らかな非対戦シート(審判/名簿/集計等)を除外。
        # シート明示指定時は利用者の意図を尊重しスキップしない。
        if not sheet and _is_non_bracket_name(sn):
            continue
        try:
            grid = load_grid(path, sn)
        except Exception as e:
            raise ParseError(f"シート読込失敗 {sn!r}: {e}") from e
        ev = parse_sheet(grid, sheet=sn,
                         event_hint=(event_hint if (sheet and event_hint) else None),
                         format_hint=(format_hint if sheet else None))
        if ev and len(ev.get("players", [])) >= 2:
            events.append(ev)
    out = M.build_seedlist(events)
    if not include_meta:
        for ev in out["events"]:
            ev.pop("_meta", None)
    return out
