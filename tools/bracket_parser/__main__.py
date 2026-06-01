"""
CLI 入口 — server.js から subprocess で疎結合に呼ぶ。

  python3 -m bracket_parser FILE.xlsx                 # 全シート → seed-list-v1 JSON
  python3 -m bracket_parser FILE.xlsx --sheet 男子S    # 単一シート
  python3 -m bracket_parser FILE.xlsx --event 男子シングルス --sheet Sheet1
  python3 -m bracket_parser FILE.xlsx --format doubles --sheet ...
  python3 -m bracket_parser FILE.xlsx --meta          # 解析メタ込み(デバッグ)
  python3 -m bracket_parser FILE.xlsx --sheets        # シート名一覧のみ

stdout に JSON を出力。エラーは {"error": "..."} を出し非0終了。
本体(server.js)は値を一切持たず、この JSON だけを取り込む(疎結合)。
"""

from __future__ import annotations
import sys
import json
import argparse
from . import api
from .grid import sheet_names


def main(argv=None):
    ap = argparse.ArgumentParser(prog="bracket_parser", add_help=True)
    ap.add_argument("file", help="組合せ表 .xlsx パス")
    ap.add_argument("--sheet", default=None, help="対象シート名(省略=全シート)")
    ap.add_argument("--event", default=None, help="種目名の上書き(--sheet 指定時のみ)")
    ap.add_argument("--format", default=None, choices=["singles", "doubles", "team"],
                    help="形式の上書き(--sheet 指定時のみ)")
    ap.add_argument("--meta", action="store_true", help="解析メタ情報を含める")
    ap.add_argument("--sheets", action="store_true", help="シート名一覧のみ出力")
    ap.add_argument("--ensure-ascii", action="store_true", help="JSONをASCIIエスケープ")
    args = ap.parse_args(argv)

    try:
        if args.sheets:
            print(json.dumps({"sheets": sheet_names(args.file)},
                             ensure_ascii=args.ensure_ascii))
            return 0
        out = api.parse_workbook(
            args.file,
            sheet=args.sheet,
            event_hint=args.event,
            format_hint=args.format,
            all_sheets=(args.sheet is None),
            include_meta=args.meta,
        )
        print(json.dumps(out, ensure_ascii=args.ensure_ascii))
        return 0
    except api.ParseError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=args.ensure_ascii), file=sys.stdout)
        return 2
    except FileNotFoundError:
        print(json.dumps({"error": f"ファイルが見つかりません: {args.file}"},
                         ensure_ascii=args.ensure_ascii))
        return 2
    except Exception as e:  # 想定外も JSON で返す(本体が拾えるように)
        print(json.dumps({"error": f"{type(e).__name__}: {e}"},
                         ensure_ascii=args.ensure_ascii))
        return 1


if __name__ == "__main__":
    sys.exit(main())
