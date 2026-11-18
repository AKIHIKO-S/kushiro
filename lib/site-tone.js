// 協会サイト調の共通トークン(--st-*)を、単体HTML(申込フォーム・申込者の画面)へ埋め込むための部品。
// 値の正本は public/shared/site-tokens.css の1か所だけ。ここではそのファイルから --st-* の宣言を
// 読み出して :root に置き直すだけで、色や書体の値をこのファイルに書かない(二重管理を避けるため)。
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "public", "shared", "site-tokens.css");
let cache = null;

// site-tokens.css から「--st-名前: 値;」を取り出す(同名は最初の1つ)
function tokenDecls() {
  if (cache) return cache;
  let css = "";
  try { css = fs.readFileSync(SRC, "utf8"); } catch (_) { css = ""; }
  const out = [];
  for (const m of css.matchAll(/(--st-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!out.some(d => d[0] === m[1])) out.push([m[1], m[2].trim()]);
  }
  cache = out;
  return out;
}

// :root{--st-…} と、書体ファイルの @font-face(配信元のURLを絶対パスで)
function rootCss(origin) {
  const base = String(origin || "").replace(/\/+$/, "");
  const decls = tokenDecls().map(([k, v]) => `${k}:${v}`).join(";");
  const face = (w) => `@font-face{font-family:"Roboto Condensed";src:url("${base}/shared/fonts/roboto-condensed-latin-${w}-normal.woff2") format("woff2");font-weight:${w};font-display:swap}`;
  return face(700) + face(800) + `:root{${decls}}`;
}

module.exports = { rootCss, tokenDecls };
