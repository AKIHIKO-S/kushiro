// テスト共通セットアップ (NODE_OPTIONS='--require ./test/_setup.js' で各テストプロセスへ注入)。
// 目的: 各テストの空DB(/tmp/ktta_*_PID.db)のスナップショット既定先が dirname(DB_PATH)/snapshots
//       = /tmp/snapshots で全テスト共有のため、db.js 起動時の自動復旧(_looksEmptyButHasSnapshots)が
//       他テスト由来の古いスナップショットを拾い「空DBのはずが古データで起動」してしまう。
//       db.js ロード前に SNAPSHOT_DIR をプロセス固有の(存在しない)一時ディレクトリへ向け、隔離する。
// 注意: SNAPSHOT_DIR が既に設定済みのときは尊重する(db-selfheal*/restore-safety-abort は
//       子サーバの env で明示 SNAPSHOT_DIR を渡して復旧自体をテストするため、上書きしない)。
const path = require("path");
const os = require("os");
if (!process.env.SNAPSHOT_DIR) {
  process.env.SNAPSHOT_DIR = path.join(os.tmpdir(), "ktta-test-snap-" + process.pid);
}
// 既定は申込集計モードだが、既存の回帰テストは全機能を対象にする。モード自体の検査は app-mode.test.js が子サーバの env で指定する。
if (!process.env.KTTA_APP_MODE) process.env.KTTA_APP_MODE = "full";
