#!/usr/bin/env node
// dev 起動前に既存の TiN インスタンスを終了する (クロスプラットフォーム)。
const { execSync } = require('child_process');

function run(cmd) {
  try { execSync(cmd, { stdio: 'ignore', timeout: 5000 }); } catch { /* 存在しなければ無視 */ }
}

if (process.platform === 'darwin') {
  run(`osascript -e 'tell application "TiN" to quit'`);
  run(`pkill -f 'TiN.app/Contents/MacOS/TiN'`);
} else if (process.platform === 'win32') {
  // ソースから起動した electron と、インストール版 TiN.exe の両方を対象に
  run('taskkill /F /IM TiN.exe /T');
  // 開発中の electron.exe は誤って他プロジェクトのものを巻き込むため kill しない
} else {
  run("pkill -f 'TiN'");
}
process.exit(0);
