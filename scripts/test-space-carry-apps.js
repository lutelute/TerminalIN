#!/usr/bin/env node
// 実機テスト: いろいろなアプリの窓を TiN に snap して、別のデスクトップへ運ぶ / 置き方を確かめる。
// 利用者の窓を巻き込まないよう、検証用のデスクトップを足してその間だけで試し、終わったら消して元へ戻る。
//
//   node scripts/test-space-carry-apps.js                     TiN の窓 2 つ (ws1 8 枚 / ws2 6 枚 + 関係ない窓) を交互に運ぶ
//   TIN_TEST_MODE=placement node scripts/test-space-carry-apps.js   4×2 の格子に 1 枚ずつ置き、下限の「↔」・左上合わせ・ドラッグ追従
//   APPS=terminal,finder,vscode,chrome,office (既定は finder 以外) で使うアプリを選ぶ
//
// 使う窓: ターミナル (do script)、Finder (一時フォルダ)、VS Code と Chrome (別のデータフォルダで起動した試験専用のもの)、
// Office (新しい空の文書。前後の名前の差で作ったものだけ保存せずに閉じる)。TiN 側は .tin-test-wrapper-apps.js。
// 画面が実際に何度も切り替わる。終わるまでマウスとキーボードに触らないこと。
const path = require('path');
const os = require('os');
const REPO = path.join(__dirname, '..');
const ax = require(path.join(REPO, 'build', 'Release', 'ax_helper.node'));
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 作業用の一時フォルダ (Finder で開くフォルダ・Chrome のプロファイル・VS Code の拡張フォルダ)
const SP = fs.mkdtempSync(path.join(os.tmpdir(), 'tin-apps-'));
const osa = (lines) => { try { return execSync('osascript ' + lines.map(l => `-e '${l}'`).join(' '), { timeout: 30000 }).toString().trim(); } catch (e) { return 'ERR ' + String(e.stderr || e.message).trim().slice(0, 200); } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const MC_SCRIPT = `on run argv
  set mode to item 1 of argv
  set pos to (item 2 of argv) as integer
  do shell script "open -a 'Mission Control'"
  delay 0.9
  tell application "System Events"
    tell process "Dock"
      try
        if mode is "add" then
          repeat with b in (every button of group 2 of group 1 of group 1)
            try
              if description of b contains "追加" or description of b contains "add" then click b
            end try
          end repeat
        else if pos > 0 then
          perform action "AXRemoveDesktop" of button pos of list 1 of group 2 of group 1 of group 1
        end if
      end try
    end tell
    delay 0.6
    key code 53
  end tell
end run`;
fs.writeFileSync(SP + '/mc-desktop.applescript', MC_SCRIPT);
const mcDesktop = (mode, pos = 0) => { try { execSync(`osascript ${SP}/mc-desktop.applescript ${mode} ${pos}`, { timeout: 20000 }); } catch {} };
const sameDisplay = () => { const l = ax.getSpacesList(); const cur = l.find(s => s.isCurrent) || l[0]; return l.filter(s => s.display === cur.display); };
const addDesktop = async () => { const b = new Set(ax.getSpacesList().map(s => s.id)); mcDesktop('add'); await sleep(1000); const n = ax.getSpacesList().find(s => !b.has(s.id)); return n ? n.id : 0; };
const removeDesktop = async (id) => { const pos = sameDisplay().findIndex(s => s.id === id) + 1; if (pos > 0) { mcDesktop('remove', pos); await sleep(1000); } };
const goTo = async (id) => {
  const hk = ax.getSpaceHotkeys();
  for (let n = 0; n < 12 && ax.getActiveSpaceId() !== id; n++) {
    const same = sameDisplay(); const d = same.findIndex(s => s.id === id) - same.findIndex(s => s.id === ax.getActiveSpaceId());
    if (!d) break;
    const k = d > 0 ? hk.right : hk.left; const from = ax.getActiveSpaceId();
    ax.postHotkey(k.keyCode, k.modifiers);
    const t = Date.now(); while (ax.getActiveSpaceId() === from && Date.now() - t < 2000) await sleep(40);
    await sleep(250);
  }
  return ax.getActiveSpaceId() === id;
};

const OFFICE = [
  { app: 'Microsoft PowerPoint', cls: 'presentation', make: 'make new presentation', n: 3 },
  { app: 'Microsoft Word', cls: 'document', make: 'make new document', n: 3 },
  { app: 'Microsoft Excel', cls: 'workbook', make: 'make new workbook', n: 2 },
];
const officeNames = (o) => { const r = osa([`tell application "${o.app}" to get name of every ${o.cls}`]); return r.startsWith('ERR') ? null : r.split(', ').filter(x => x && x !== 'missing value'); };

(async () => {
  const home = ax.getActiveSpaceId(), cursor = ax.getCursorPosition();
  let ADD1 = 0, ADD2 = 0;
  const officeBefore = new Map(OFFICE.map(o => [o.app, officeNames(o)]));
  if (OFFICE.some(o => !officeBefore.get(o.app))) { log('ABORT: could not list Office documents', JSON.stringify([...officeBefore])); return; }
  // VS Code はデータフォルダの中に通信用のソケットを作り、そのパスが 103 文字を超えると起動直後に落ちる
  // (一時フォルダの下では長すぎた)。リポジトリ内の短い場所 (.tin-test-userdata-* は git 対象外) を使う
  const vsUD = path.join(REPO, '.tin-test-userdata-vs'), vsExt = SP + '/vscode-ext', crUD = SP + '/chrome-ud';
  for (const d of ['vsA', 'vsB', 'vsX']) fs.mkdirSync(`${SP}/probe-dirs/TINPROBE-${d}`, { recursive: true });
  fs.mkdirSync(`${SP}/finderdirs/TINPROBE-FA`, { recursive: true });
  const procs = []; let termWns = [];
  try {
    ADD1 = await addDesktop(); ADD2 = await addDesktop();
    log('home', home, 'added', ADD1, ADD2, 'spaces', JSON.stringify(sameDisplay().map(s => [s.id, s.type])));
    if (!ADD1 || !ADD2) { log('ABORT: could not add desktops'); return; }
    if (!await goTo(ADD1)) { log('ABORT: could not reach ADD1, active', ax.getActiveSpaceId()); return; }
    await sleep(500);
    const before = new Set(ax.listWindowsAllSpaces().map(w => w.windowNumber));

    const APPS = (process.env.APPS || 'terminal,vscode,chrome,office').split(',');
    // VS Code (試験専用のデータフォルダ)。窓が出るまで待ち、出た先のデスクトップも記録する
    const code = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
    for (const d of APPS.includes('vscode') ? ['vsA', 'vsB', 'vsX'] : []) {
      // CLI (bin/code) 経由では本体が起動しなかった (ログも空) ので、本体を直接起動する
      const p = spawn('/Applications/Visual Studio Code.app/Contents/MacOS/Code',
        ['--user-data-dir', vsUD, '--extensions-dir', vsExt, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', `${SP}/probe-dirs/TINPROBE-${d}`],
        { detached: true, stdio: 'ignore', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_') && k !== 'VSCODE_CWD')) });
      p.unref();
      const t0 = Date.now(); let w = null; let lastActive = ax.getActiveSpaceId(); const seenNew = new Set();
      while (Date.now() - t0 < 20000) {
        const all = ax.listWindowsAllSpaces();
        for (const x of all) if (!before.has(x.windowNumber) && !seenNew.has(x.windowNumber) && /Code|Electron/.test(x.app)) {
          seenNew.add(x.windowNumber);
          log(`  new ${x.app} wn=${x.windowNumber} title="${(x.title || '').slice(0, 60)}" space=${(ax.getSpaceForWindows([x.windowNumber])[0] || {}).spaceId} at ${Date.now() - t0}ms`);
        }
        const a = ax.getActiveSpaceId(); if (a !== lastActive) { log(`  active ${lastActive}→${a} at ${Date.now() - t0}ms`); lastActive = a; }
        w = all.find(x => !before.has(x.windowNumber) && /TINPROBE-/.test(x.title || '') && (x.title || '').includes(d));
        if (w) break;
        await sleep(200);
      }
      log('VS Code', d, w ? `wn=${w.windowNumber} app=${w.app} title=${w.title} space=${(ax.getSpaceForWindows([w.windowNumber])[0] || {}).spaceId} in ${Date.now() - t0}ms` : 'no window in 20s');
      await sleep(800);
      if (ax.getActiveSpaceId() !== ADD1) { log('VS Code moved us to', ax.getActiveSpaceId(), '— back'); await goTo(ADD1); }
    }
    // Chrome (試験専用のプロファイル)
    for (const t of APPS.includes('chrome') ? ['CA', 'CB', 'CX'] : []) {
      const p = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        [`--user-data-dir=${crUD}`, '--no-first-run', '--no-default-browser-check', '--new-window', `data:text/html,<title>TINPROBE-${t}</title><h1>${t}</h1>`],
        { detached: true, stdio: 'ignore' });
      p.unref(); procs.push(p);
      await sleep(t === 'CA' ? 4000 : 1500);
      if (ax.getActiveSpaceId() !== ADD1) { log('Chrome moved us to', ax.getActiveSpaceId(), '— back'); await goTo(ADD1); }
    }
    // Finder (1 枚)
    if (APPS.includes('finder')) {
      osa(['tell application "Finder"', `set w to make new Finder window to (POSIX file "${SP}/finderdirs/TINPROBE-FA" as alias)`, 'end tell']);
      await sleep(1200);
      if (ax.getActiveSpaceId() !== ADD1) { log('Finder moved us to', ax.getActiveSpaceId(), '— back'); await goTo(ADD1); }
    }
    // ターミナル (3 枚、題名を付ける)
    if (APPS.includes('terminal')) {
      const tb = new Set(ax.listWindowsAllSpaces().map(w => w.windowNumber));
      osa(['tell application "Terminal"', 'do script "echo TINPROBE-T1"', 'do script "echo TINPROBE-T2"', 'do script "echo TINPROBE-T3"', 'end tell']);
      await sleep(1500);
      termWns = ax.listWindowsAllSpaces().filter(w => !tb.has(w.windowNumber) && /Terminal|ターミナル/.test(w.app)).map(w => w.windowNumber).sort((a, b) => a - b);
      termWns.forEach((wn, i) => osa(['tell application "Terminal"', `set title displays custom title of selected tab of window id ${wn} to true`, `set custom title of selected tab of window id ${wn} to "TINPROBE-T${i + 1}"`, 'end tell']));
      await sleep(500);
      if (ax.getActiveSpaceId() !== ADD1) { log('Terminal moved us to', ax.getActiveSpaceId(), '— back'); await goTo(ADD1); }
    }
    // Office (新しい空の文書)
    for (const o of APPS.includes('office') ? OFFICE : []) {
      for (let i = 0; i < o.n; i++) {
        const r = osa([`tell application "${o.app}" to ${o.make}`]);
        if (r.startsWith('ERR')) log(o.app, 'make:', r);
        await sleep(1500);
        if (ax.getActiveSpaceId() !== ADD1) { log(o.app, 'moved us to', ax.getActiveSpaceId(), '— back'); await goTo(ADD1); }
      }
    }
    await sleep(1500);
    const fresh = ax.listWindows().filter(w => !before.has(w.windowNumber));
    log('fresh on ADD1', JSON.stringify(fresh.map(w => [w.windowNumber, w.app, (w.title || '').slice(0, 40)])));
    const byApp = new Map();
    for (const w of fresh) { if (!byApp.has(w.app)) byApp.set(w.app, []); byApp.get(w.app).push(w); }
    // 振り分け: 各アプリ 1 枚目 (と PowerPoint・ターミナルの 2 枚目) → ws1、次の 1 枚 → ws2、
    // 題名に X の付く窓 (VS Code・Chrome) と Word の 3 枚目 → どこにも snap しない
    const ws1 = [], ws2 = [], unrelated = [];
    for (const [app, ws] of byApp) {
      const sorted = [...ws].sort((p, q) => String(p.title).localeCompare(String(q.title), 'ja', { numeric: true }));
      const un = sorted.filter(w => /TINPROBE-(vsX|CX)/.test(w.title || '') || (/Word/.test(app) && sorted.indexOf(w) === 2));
      const rest = sorted.filter(w => !un.includes(w));
      const n1 = /PowerPoint|Terminal|ターミナル/.test(app) ? 2 : 1;
      ws1.push(...rest.slice(0, n1)); ws2.push(...rest.slice(n1, n1 + 1)); unrelated.push(...un, ...rest.slice(n1 + 1));
    }
    if (process.env.TIN_TEST_MODE === 'placement') {
      // 配置の確かめ: アプリごとに 1 枚だけ ws1 へ。ほかは使わない
      ws1.length = 0; ws2.length = 0; unrelated.length = 0;
      for (const [, ws] of byApp) ws1.push(ws[0]);
    }
    const ours = [...ws1, ...ws2];
    log('ws1', ws1.map(w => `${w.windowNumber}:${w.app}:${(w.title || '').slice(0, 14)}`).join(' '));
    log('ws2', ws2.map(w => `${w.windowNumber}:${w.app}:${(w.title || '').slice(0, 14)}`).join(' '));
    log('unrelated', unrelated.map(w => `${w.windowNumber}:${w.app}:${(w.title || '').slice(0, 14)}`).join(' '));

    execSync(`rm -rf "${REPO}/.tin-test-userdata-apps"`);
    log('launch TiN (isolated) with', ours.length, 'windows to snap');
    const out = execSync(`npx electron .tin-test-wrapper-apps.js 2>&1 | grep -E "\\[SCENARIO\\]|space-carry|placement" || true`,
      { cwd: REPO, env: { ...process.env, TIN_TEST_WNS: ws1.map(w => w.windowNumber).join(','), TIN_TEST_WNS2: ws2.map(w => w.windowNumber).join(','), TIN_TEST_UNRELATED: unrelated.map(w => w.windowNumber).join(',') }, timeout: 420000, maxBuffer: 1 << 24 }).toString();
    for (const line of out.split('\n')) if (line && !/OK \(group/.test(line)) console.log(line.slice(0, 260));
    execSync(`rm -rf "${REPO}/.tin-test-userdata-apps"`);
  } catch (e) {
    log('ERROR', e && (e.stack || e.message));
  } finally {
    if (ax.mcSnapshot()) { ax.mcToggle(); await sleep(800); }
    // 片付け: Office は増えた名前の文書だけ保存せずに閉じる
    for (const o of OFFICE) {
      const b = new Set(officeBefore.get(o.app) || []);
      const now = officeNames(o) || [];
      for (const name of now.filter(n => !b.has(n))) log('close', o.app, name, osa([`tell application "${o.app}" to close ${o.cls} "${name}" saving no`]) || 'ok');
    }
    for (const wn of termWns) osa(['tell application "Terminal"', `close window id ${wn}`, 'end tell']);
    osa(['tell application "Finder"', 'repeat while (exists Finder window "TINPROBE-FA")', 'close Finder window "TINPROBE-FA"', 'end repeat', 'end tell']);
    try { execSync(`pkill -f -- "--user-data-dir=${crUD}"`); } catch {}
    for (let k = 0; k < 6; k++) {
      try { execSync(`pkill ${k >= 3 ? '-9 ' : ''}-f "tin-test-userdata-vs"`); } catch {}
      await sleep(700);
      try { execSync('pgrep -f "tin-test-userdata-vs"'); } catch { break; }   // 見つからなければ終わり
    }
    setTimeout(() => { try { execSync(`rm -rf "${vsUD}"`); } catch {} }, 3000);
    await sleep(1500);
    await goTo(home);
    for (const id of [ADD2, ADD1]) if (id) await removeDesktop(id);
    await goTo(home);
    ax.warpCursor(cursor.x, cursor.y);
    const left = ax.listWindowsAllSpaces().filter(w => /TINPROBE-(vs|C|T\d)/.test(w.title || '') && w.app !== 'Finder');
    log('finder probe windows open (AppleScript)', osa(['tell application "Finder" to get name of every Finder window whose name starts with "TINPROBE"']));
    try { fs.rmSync(SP, { recursive: true, force: true }); } catch {}
    log('end active', ax.getActiveSpaceId(), 'home', home, 'mc', !!ax.mcSnapshot(), 'leftover probe windows', left.length, 'spaces', JSON.stringify(sameDisplay().map(s => s.id)));
  }
})();
