// test/updater-mac-install.test.js — mac の .app 差し替え手順を実際に走らせる
//
// これまで install 経路は完全に未検証だった。/Applications を触らずに検証するため、
// 一時ディレクトリに偽の .app と zip を作り、そこを差し替え先にして本物の
// installFromZip (ditto / xattr / rename) を通す。
//
// カバーしているのは「成功して新版になること」「中間物 (.tin-new/.tin-old) を残さないこと」
// 「展開に失敗しても旧版が残ること」。
//
// **カバーできていないもの**: 最終コピーの途中で落ちた場合の巻き戻し。そこを踏ませるには
// ファイルシステム側の失敗注入が要る。差し替えを rename 2回にしたのは「アプリが存在しない
// 時間を数秒から一瞬に縮める」ためだが、その性質自体はここでは検証できていない。
//
// ditto / xattr は macOS 固有なので darwin 以外では skip する (CI は ubuntu)。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { installFromZip } = require('../lib/updater-mac');

const macOnly = { skip: process.platform !== 'darwin' ? 'macOS 専用 (ditto/xattr)' : false };

// marker の中身で「どちらの版か」を見分けられる最小の .app を作る
function makeApp(dir, name, marker) {
  const app = path.join(dir, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'marker.txt'), marker);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist>${marker}</plist>`);
  return app;
}

function zipApp(appPath, zipPath) {
  execSync(`ditto -c -k --sequesterRsrc --keepParent "${appPath}" "${zipPath}"`);
  return zipPath;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tin-updater-test-'));
}

function markerOf(app) {
  return fs.readFileSync(path.join(app, 'Contents', 'MacOS', 'marker.txt'), 'utf8');
}

test('installFromZip: 旧版が新版に差し替わる', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    // 配布物 (新版) を zip に固める
    const src = makeApp(path.join(root, 'src'), 'TiN.app', 'NEW');
    const zip = zipApp(src, path.join(root, 'TiN-new.zip'));
    // 差し替え先 (旧版が入っている /Applications 相当)
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = makeApp(appsDir, 'TiN.app', 'OLD');

    const r = installFromZip(zip, updates, dest);

    assert.equal(r.ok, true, r.error);
    assert.equal(markerOf(dest), 'NEW');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installFromZip: 中間物 (.tin-new / .tin-old) を残さない', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const src = makeApp(path.join(root, 'src'), 'TiN.app', 'NEW');
    const zip = zipApp(src, path.join(root, 'TiN-new.zip'));
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = makeApp(appsDir, 'TiN.app', 'OLD');

    installFromZip(zip, updates, dest);

    assert.deepEqual(fs.readdirSync(appsDir), ['TiN.app']);
    assert.equal(fs.existsSync(path.join(updates, 'extract')), false, 'extract が残っている');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installFromZip: zip が壊れていても旧版は無傷', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const zip = path.join(root, 'broken.zip');
    fs.writeFileSync(zip, 'これは zip ではない');
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = makeApp(appsDir, 'TiN.app', 'OLD');

    const r = installFromZip(zip, updates, dest);

    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(dest), true, 'アプリが消えている');
    assert.equal(markerOf(dest), 'OLD', '旧版が壊れている');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installFromZip: zip に .app が入っていなくても旧版は無傷', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const junk = path.join(root, 'junk'); fs.mkdirSync(junk);
    fs.writeFileSync(path.join(junk, 'readme.txt'), 'no app here');
    const zip = path.join(root, 'noapp.zip');
    execSync(`ditto -c -k "${junk}" "${zip}"`);
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = makeApp(appsDir, 'TiN.app', 'OLD');

    const r = installFromZip(zip, updates, dest);

    assert.equal(r.ok, false);
    assert.match(r.error, /\.app/);
    assert.equal(markerOf(dest), 'OLD');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installFromZip: 差し替え先がまだ無い (新規配置) でも成功する', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const src = makeApp(path.join(root, 'src'), 'TiN.app', 'NEW');
    const zip = zipApp(src, path.join(root, 'TiN-new.zip'));
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = path.join(appsDir, 'TiN.app');   // まだ存在しない

    const r = installFromZip(zip, updates, dest);

    assert.equal(r.ok, true, r.error);
    assert.equal(markerOf(dest), 'NEW');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installFromZip: destApp 未指定なら何もせず失敗を返す', () => {
  const r = installFromZip('/tmp/whatever.zip', '/tmp', '');
  assert.equal(r.ok, false);
  assert.match(r.error, /特定できません/);
});

test('installFromZip: 前回の残骸 (.tin-old) があっても成功する', macOnly, () => {
  const root = tmpdir();
  try {
    const updates = path.join(root, 'updates'); fs.mkdirSync(updates);
    const src = makeApp(path.join(root, 'src'), 'TiN.app', 'NEW');
    const zip = zipApp(src, path.join(root, 'TiN-new.zip'));
    const appsDir = path.join(root, 'Applications'); fs.mkdirSync(appsDir);
    const dest = makeApp(appsDir, 'TiN.app', 'OLD');
    // 前回の更新が後片付けに失敗して残った状態を作る
    makeApp(appsDir, 'TiN.app.tin-old', 'STALE');

    const r = installFromZip(zip, updates, dest);

    assert.equal(r.ok, true, r.error);
    assert.equal(markerOf(dest), 'NEW');
    assert.deepEqual(fs.readdirSync(appsDir), ['TiN.app']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
