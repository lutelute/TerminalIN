#!/usr/bin/env node
'use strict';
// ネイティブ addon(出力名 ax_helper.node)をビルドする。
//   macOS: native/ax-helper.mm (AXUIElement / CGS)
//   Windows: native/win-helper.cc (EnumWindows / SetWindowPos)
// どちらを使うかは binding.gyp の conditions(OS 分岐)が選ぶ。
// Linux 等は addon を持たず、main.js の `if (axHelper)` ガードで外部ウィンドウ操作が
// 自動 no-op になる。
const { execSync } = require('child_process');

if (process.platform === 'darwin' || process.platform === 'win32') {
  execSync('npx node-gyp rebuild', { stdio: 'inherit' });
} else {
  console.log(`[tin] skip node-gyp: native addon unsupported (platform=${process.platform})`);
}
