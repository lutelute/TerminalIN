#!/usr/bin/env node
'use strict';
// dev 起動前に既存の TiN プロセスを終了する(多重起動防止)。OS ごとに手段が異なる。
//   macOS : osascript で quit → pkill で念押し
//   Windows: taskkill /IM TiN.exe
// いずれも失敗は無視(起動していないのが正常ケース)。最後に少しだけ同期待機して
// プロセス終了とポート解放を待つ(cross-platform: Atomics.wait)。
const { execSync } = require('child_process');

function quiet(cmd) {
  try { execSync(cmd, { stdio: 'ignore' }); } catch { /* not running — ok */ }
}

if (process.platform === 'darwin') {
  quiet(`osascript -e 'tell application "TiN" to quit'`);
  quiet(`pkill -f 'TiN.app/Contents/MacOS/TiN'`);
} else if (process.platform === 'win32') {
  quiet('taskkill /IM TiN.exe /F');
}

// 同期 sleep(~800ms): 子プロセス終了とポート(REST/DevTools)解放を待つ。
try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800); } catch { /* ignore */ }
