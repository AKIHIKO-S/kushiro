"""
bracket_parser — トーナメント表(組合せ表)Excel の罫線解析パーサー
====================================================================
卓球協会形式のブラケット Excel を「罫線(セル境界線)」から構造解析し、
出場者リスト/対戦ツリーを抽出する。本体(server.js/db.js)からは
subprocess(`python3 -m bracket_parser FILE.xlsx ...`)で疎結合に呼ぶ前提。

設計方針:
  - 依存は openpyxl のみ(軽量・将来改修容易)。
  - モジュール分割: grid(セル/罫線モデル) / tokens(文字種別) /
    topology(罫線→対戦ツリー) / emit(出力) / cli(入口)。
  - 罫線を主信号、ドロー番号/氏名を補助・相互検証に用いるハイブリッド。

公開 API:
  parse_workbook(path, **opts) -> dict   # 全種目/単一シートをまとめて返す
"""

__all__ = ["parse_workbook", "parse_sheet", "ParseError"]
__version__ = "1.0.0"

# api は topology/emit に依存するため遅延 import(grid/tokens 単体利用を妨げない)。
def __getattr__(name):
    if name in ("parse_workbook", "parse_sheet", "ParseError"):
        from . import api
        return getattr(api, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
