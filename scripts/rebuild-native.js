#!/usr/bin/env node
'use strict';
// ax_helper(native/ax-helper.mm) は macOS 専用(AXUIElement / CGS)。
// macOS のみ node-gyp rebuild を実行する。Windows / Linux では addon を持たず、
// main.js の `if (axHelper)` ガードにより外部ウィンドウ操作が自動 no-op になる。
// 第2マイルストーンで Win32 native addon(native/win-helper.cc)を追加する際は
// ここに win 分岐を足す。
const { execSync } = require('child_process');

if (process.platform === 'darwin') {
  execSync('npx node-gyp rebuild', { stdio: 'inherit' });
} else {
  console.log(`[tin] skip node-gyp: ax_helper is macOS-only (platform=${process.platform})`);
}
