#!/usr/bin/env node
// クロスプラットフォーム native ビルド。
// macOS: node-gyp rebuild で ax_helper.node をビルド。
// Windows/Linux: koffi (prebuilt) を使うため native ビルド不要 → スキップ。
const { execSync } = require('child_process');

if (process.platform === 'darwin') {
  console.log('[build-native] macOS detected — building ax_helper via node-gyp');
  execSync('npx node-gyp rebuild', { stdio: 'inherit' });
} else {
  console.log(`[build-native] ${process.platform} — no native build needed (using koffi prebuilt)`);
}
