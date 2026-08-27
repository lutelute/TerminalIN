// test/updater-mac.test.js — mac 自動アップデートの判定ロジック
//
// 狙いは「実際にアプリを差し替えずに、更新すべきか / どの成果物を落とすかを検証する」こと。
// ditto や /Applications への書き込みは副作用が大きく単体テストに向かないので、
// lib/updater-mac.js は判定を純関数に切り出してある。ここではそこだけを叩く。

const { test } = require('node:test');
const assert = require('node:assert');
const { isNewer, selectMacAsset, evaluateRelease, appRootFromExecPath } = require('../lib/updater-mac');

const asset = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });

test('isNewer: 桁ごとの数値比較 — 文字列比較だと "1.10.0" < "1.9.0" になる', () => {
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('1.9.0', '1.10.0'), false);
});

test('isNewer: 同一バージョンは更新しない', () => {
  assert.equal(isNewer('1.15.0', '1.15.0'), false);
});

test('isNewer: 桁数が違っても比較できる (1.15 と 1.15.1)', () => {
  assert.equal(isNewer('1.15.1', '1.15'), true);
  assert.equal(isNewer('1.15', '1.15.1'), false);
});

test('selectMacAsset: mac zip を選ぶ', () => {
  const r = { assets: [asset('TiN-Setup-1.16.0-x64.exe'), asset('TiN-1.16.0-arm64-mac.zip')] };
  assert.equal(selectMacAsset(r).name, 'TiN-1.16.0-arm64-mac.zip');
});

test('selectMacAsset: Windows 成果物を掴まない (win zip も .zip である)', () => {
  const r = { assets: [asset('TiN-1.16.0-win.zip'), asset('TiN-Setup-1.16.0-arm64.exe')] };
  assert.equal(selectMacAsset(r), null);
});

test('selectMacAsset: blockmap を掴まない', () => {
  const r = { assets: [asset('TiN-1.16.0-arm64-mac.zip.blockmap')] };
  assert.equal(selectMacAsset(r), null);
});

test('selectMacAsset: assets が無い/壊れていても落ちない', () => {
  assert.equal(selectMacAsset({}), null);
  assert.equal(selectMacAsset(null), null);
  assert.equal(selectMacAsset({ assets: [null, {}] }), null);
});

test('evaluateRelease: 新版 + mac zip あり → downloadUrl が返る', () => {
  const r = { tag_name: 'v1.16.0', html_url: 'https://example.invalid/rel',
              assets: [asset('TiN-1.16.0-arm64-mac.zip')] };
  const out = evaluateRelease(r, '1.15.0');
  assert.equal(out.available, true);
  assert.equal(out.version, '1.16.0');
  assert.match(out.downloadUrl, /arm64-mac\.zip$/);
});

test('evaluateRelease: 新版だが mac zip が無い → available だが downloadUrl は null', () => {
  // CI の mac ジョブが成果物を出していないケース。呼び出し側はここで黙る (嘘の進捗を出さない)。
  const r = { tag_name: 'v1.16.0', assets: [asset('TiN-Setup-1.16.0-x64.exe')] };
  const out = evaluateRelease(r, '1.15.0');
  assert.equal(out.available, true);
  assert.equal(out.downloadUrl, null);
});

test('evaluateRelease: 同版・旧版は available:false', () => {
  const r = { tag_name: 'v1.15.0', assets: [asset('TiN-1.15.0-arm64-mac.zip')] };
  assert.equal(evaluateRelease(r, '1.15.0').available, false);
  assert.equal(evaluateRelease({ tag_name: 'v1.14.0' }, '1.15.0').available, false);
});

test('evaluateRelease: tag_name が無い壊れた release でも落ちない', () => {
  assert.equal(evaluateRelease({}, '1.15.0').available, false);
  assert.equal(evaluateRelease({ tag_name: '' }, '1.15.0').available, false);
});

test('evaluateRelease: tag の v 接頭辞を剥がす', () => {
  const r = { tag_name: 'v1.16.0', assets: [] };
  assert.equal(evaluateRelease(r, '1.15.0').version, '1.16.0');
});

test('selectMacAsset: 実物の v1.15.0 リリース資産から mac zip だけを選ぶ', () => {
  // 実際に GitHub に載っている資産名。win zip / blockmap / exe / feed yml が同居しており、
  // ここを取り違えると mac に Windows の成果物を落としてしまう。
  const real = [
    'latest-mac.yml', 'latest.yml',
    'TiN-1.15.0-arm64-mac.zip', 'TiN-1.15.0-arm64-mac.zip.blockmap',
    'TiN-1.15.0-arm64-win.zip', 'TiN-1.15.0-win.zip',
    'TiN-Setup-1.15.0-arm64.exe', 'TiN-Setup-1.15.0-arm64.exe.blockmap',
    'TiN-Setup-1.15.0-x64.exe', 'TiN-Setup-1.15.0-x64.exe.blockmap',
    'TiN-Setup-1.15.0.exe', 'TiN-Setup-1.15.0.exe.blockmap',
  ].map(asset);
  const picked = selectMacAsset({ assets: real });
  assert.equal(picked.name, 'TiN-1.15.0-arm64-mac.zip');
});

test('appRootFromExecPath: 実行中バイナリから .app の根を得る', () => {
  assert.equal(
    appRootFromExecPath('/Applications/TiN.app/Contents/MacOS/TiN'),
    '/Applications/TiN.app');
});

test('appRootFromExecPath: /Applications の外に置かれていてもそこを指す', () => {
  // 差し替え先を /Applications 決め打ちにすると、ここで他人の .app を壊す。
  assert.equal(
    appRootFromExecPath('/Users/me/Downloads/TiN.app/Contents/MacOS/TiN'),
    '/Users/me/Downloads/TiN.app');
});

test('appRootFromExecPath: .app の中に居なければ null (呼び出し側は中断する)', () => {
  assert.equal(appRootFromExecPath('/usr/local/bin/electron'), null);
  assert.equal(appRootFromExecPath(''), null);
  assert.equal(appRootFromExecPath(null), null);
});
