// ファイルを移動する。同じディスクなら rename(一瞬・途中で壊れない)。
// 別のディスクをまたぐと rename は EXDEV で失敗する(例: 一時フォルダ /tmp から /var/data への保存)ので、
// そのときだけ「コピーして元を消す」に切り替える。ほかのエラーはそのまま投げる。
const fs = require("fs");

function moveFile(src, dest, fsImpl) {
  const f = fsImpl || fs;
  try {
    f.renameSync(src, dest);
  } catch (e) {
    if (!e || e.code !== "EXDEV") throw e;
    f.copyFileSync(src, dest);
    try { f.unlinkSync(src); } catch (_) { /* 元の一時ファイルが消せなくても、保存は成功している */ }
  }
}

module.exports = { moveFile };
