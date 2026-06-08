"""
tokens.py — セル文字列の種別判定と正規化。

ブラケットでは「列の位置」が氏名/所属/番号の主たる手がかりになるが、
ラベル(1回戦・決勝・種目名)やBYE・日付・タイトルを除外し、番号を
取り出すための共通ルーチンをここに集約する。
"""

from __future__ import annotations
import re
import os
import json
import unicodedata

# 登録団体マスタ(正規化済み)。server が env KTTA_REGISTERED_TEAMS(JSON配列)で渡す。団体を氏名に誤判定しない。
def _norm_team(s) -> str:
    t = unicodedata.normalize("NFKC", str("" if s is None else s))
    t = re.sub(r"\s+", "", t).replace("俱", "倶").lower()
    return t

_REG_TEAMS = None
def _registered_teams() -> set:
    global _REG_TEAMS
    if _REG_TEAMS is None:
        try:
            _REG_TEAMS = set(json.loads(os.environ.get("KTTA_REGISTERED_TEAMS") or "[]"))
        except Exception:
            _REG_TEAMS = set()
    return _REG_TEAMS

def is_registered_team(v) -> bool:
    n = _norm_team(v)
    return bool(n) and (n in _registered_teams())

# 全角→半角(数字・英字・記号)。氏名の漢字/かなはそのまま。
def normalize_full_width(s: str) -> str:
    return unicodedata.normalize("NFKC", s)

def collapse_ws(s: str) -> str:
    # 改行・全角空白・連続空白を単一半角空白へ
    s = s.replace("　", " ").replace("\n", " ").replace("\r", " ").replace("\t", " ")
    return re.sub(r"\s+", " ", s).strip()

def normalize_name(s: str) -> str:
    """氏名表示用の正規化: 全角英数字→半角, 余分な空白を1つに。括弧書きは除去しない
    (氏名に括弧は通常無い。所属側で strip_parens する)。"""
    if s is None:
        return ""
    return collapse_ws(normalize_full_width(str(s)))

def strip_parens(s: str) -> str:
    """氏名の末尾に付いた所属注記 "山田 (A中)" の "(A中)" を剥がす用途。
    セル全体が "(所属)" の場合は clean_team を使うこと(こちらは末尾のみ)。"""
    s = normalize_name(s)
    s = re.sub(r"\s*[（(][^（）()]*[）)]\s*$", "", s).strip()
    return s

def clean_team(s) -> str:
    """所属セルの正規化。セル全体を包む外側の括弧のみ除去し、中身は残す。
    例: "(スマイルクラブ)" -> "スマイルクラブ"; "AST根室" -> "AST根室"。
    内部の括弧 "A中(分校)" はそのまま。"""
    if s is None:
        return ""
    s = collapse_ws(normalize_full_width(str(s)))
    m = re.match(r"^[（(]\s*(.*?)\s*[）)]$", s)
    if m:
        s = m.group(1).strip()
    return s

def join_teams(teams) -> str:
    """メンバー所属を非空のまま " / " 連結。空は除外、重複の畳み込みはしない。
    女子D の同一所属(縦結合セル)は呼び出し側で1値に集約済みのため単一表示、
    男子D の2所属列は別値→連結("AMATAKU / 個人")、同値でも両表示("AMATAKU / AMATAKU")。"""
    cleaned = [clean_team(t) for t in teams]
    cleaned = [t for t in cleaned if t]
    return " / ".join(cleaned)

# ---- 番号 ----
_INT_RE = re.compile(r"^\s*(\d{1,4})\s*[.．)]?\s*$")
def to_int(v) -> int | None:
    if v is None:
        return None
    if isinstance(v, (int,)) and not isinstance(v, bool):
        return int(v)
    if isinstance(v, float):
        return int(v) if float(v).is_integer() else None
    s = normalize_full_width(str(v)).strip()
    m = _INT_RE.match(s)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None

def is_number(v) -> bool:
    return to_int(v) is not None

# ---- BYE / 空き ----
_BYE_RE = re.compile(r"^(bye|ﾊﾞｲ|バイ|不戦|シード|seed|―+|ー+|-+|‐+|−+|空|なし)$", re.IGNORECASE)
def is_bye(v) -> bool:
    if v is None:
        return True
    s = collapse_ws(normalize_full_width(str(v)))
    if s == "":
        return True
    return bool(_BYE_RE.match(s))

# ---- ラベル/ヘッダ(対戦者ではない) ----
_ROUND_WORDS = (
    "回戦", "準々決勝", "準決勝", "決勝", "優勝", "予選", "本戦", "本選",
    "ブロック", "block", "リーグ", "順位", "位決定", "敗者", "3位", "三位",
    "トーナメント", "組合せ", "組み合わせ", "対戦表", "記録", "番号", "No",
    "ナンバー", "コート", "台",
)
_TITLE_WORDS = ("選手権", "大会", "杯", "カップ", "オープン", "ｵｰﾌﾟﾝ", "VICTAS", "協会主催")
_GENDER_EVENT = ("男子", "女子", "シングルス", "ダブルス", "ミックス", "混合", "団体", "の部", "種目")

def is_label_like(v) -> bool:
    """対戦者(氏名/所属)ではなく、見出し/ラベル/タイトルらしいか。"""
    if v is None:
        return True
    s = collapse_ws(normalize_full_width(str(v)))
    if s == "":
        return True
    if is_number(s):
        return True
    # 日付 (2026.2.11 / 2026/2/11 / 2月11日)
    if re.search(r"\d{1,4}[./年]\d{1,2}[./月]\d{0,2}", s):
        return True
    # 時刻
    if re.match(r"^\d{1,2}[:：]\d{2}$", s):
        return True
    for w in _ROUND_WORDS:
        if w in s:
            return True
    # ラウンド見出しは概ね短い。種目/性別語のみで構成される見出しも除外。
    if any(w in s for w in _GENDER_EVENT) and len(s) <= 12:
        return True
    # 1文字記号/罫線素片
    if re.match(r"^[│┃|｜─━—\-‐−ー･・.,、。\s]+$", s):
        return True
    return False

# ---- 氏名/所属の見込み ----
_KANJI = r"一-鿿㐀-䶿"
_KANA = r"぀-ゟ゠-ヿｦ-ﾟ"
_NAME_CHARS = re.compile(rf"[{_KANJI}{_KANA}A-Za-z]")
_TEAM_HINTS = (
    "学校", "中学", "高校", "高校", "高", "中", "小学", "大学", "クラブ", "倶楽部", "俱楽部",
    "協会", "スタジオ", "TTC", "TTS", "TT", "T.T", "ttc", "ジュニア", "Jr", "卓球",
    "少年団", "チーム", "team", "club", "ｸﾗﾌﾞ", "支部", "同好会", "会", "個人",
)

def looks_like_name(v) -> bool:
    """日本人氏名らしいか(ペア "A / B" も True)。所属/見出しを弾くための緩い判定。"""
    if v is None:
        return False
    if is_registered_team(v):  # 登録団体は氏名でない
        return False
    s = collapse_ws(normalize_full_width(str(v)))
    if s == "" or is_number(s) or is_label_like(s):
        return False
    if is_bye(s):
        return False
    if not _NAME_CHARS.search(s):
        return False
    # 明確な所属語を含み、かつ氏名区切り(空白)が無ければ team 寄り
    if any(h in s for h in _TEAM_HINTS) and (" " not in s) and ("/" not in s):
        return False
    if len(s) > 24:  # 氏名にしては長すぎ
        return False
    return True

def looks_like_team(v) -> bool:
    if v is None:
        return False
    s = collapse_ws(normalize_full_width(str(v)))
    if s == "" or is_number(s) or is_bye(s):
        return False
    if is_label_like(s):
        return False
    if any(h in s for h in _TEAM_HINTS):
        return True
    # カタカナ主体/英字主体は所属の可能性高い(が氏名カナもあるので緩く)
    return True  # 列分類側で名前列/所属列を決めるため、ここは緩く許可

# ---- ダブルス: 2氏名を結合/分解 ----
def join_pair(a: str, b: str) -> str:
    a = normalize_name(a); b = normalize_name(b)
    if a and b and a != b:
        return f"{a} / {b}"
    return a or b
