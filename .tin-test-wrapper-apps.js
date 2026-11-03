// TiN 隔離テスト wrapper — TiN の窓 2 つに、いろいろなアプリ (端末・VS Code・Chrome・Office) を snap して運ぶ実機確認。
// 別 userData で main.js を起動し (インストール版と共存)、ws1 と ws2 を同じデスクトップに置いて
// ws1 右へ → ws2 右へ → ws1 左へ → ws2 左へ。毎回、動かした側だけが動き、もう片方と関係ない窓は
// そのまま、snap も外れないことを確かめる。
// TIN_TEST_WNS: ws1 に snap / TIN_TEST_WNS2: ws2 に snap / TIN_TEST_UNRELATED: どこにも snap しない (動いてはいけない)
// 呼び手: scratchpad の appe2e.js (検証用デスクトップを足して窓を用意し、終わったら片付ける)。
const path = require('path');
const { app, BrowserWindow, Menu } = require('electron');
app.setPath('userData', process.env.TIN_TEST_USERDATA || path.join(__dirname, '.tin-test-userdata-apps'));
const ax = require(path.join(__dirname, 'build', 'Release', 'ax_helper.node'));
const { planCarry } = require(path.join(__dirname, 'lib', 'space-carry'));
const list = (k) => (process.env[k] || '').split(',').map(Number).filter(n => n > 0);
const WNS1 = list('TIN_TEST_WNS'), WNS2 = list('TIN_TEST_WNS2'), UNRELATED = list('TIN_TEST_UNRELATED');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond }); console.log(`[SCENARIO] ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`); }
const wsWins = () => BrowserWindow.getAllWindows().filter(w => { try { return !w.isDestroyed() && (w.webContents.getURL() || '').includes('workspace.html'); } catch { return false; } });
const invokeOn = (win, channel, argsObj) => win.webContents.executeJavaScript(`ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(argsObj)})`, true);
const spaceOf = (wn) => Number((ax.getSpaceForWindows([wn])[0] || {}).spaceId || 0);
const widOf = (w) => { try { return ax.getWindowIdFromHandle(w.getNativeWindowHandle().readBigUInt64LE(0)); } catch { return 0; } };
const appOf = new Map();
const desc = (wns) => wns.map(wn => `${wn}:${(appOf.get(wn) || '?').replace('Microsoft ', '')}@${spaceOf(wn)}`).join(' ');

async function snapAll(win, wns, label) {
  const cols = Math.min(4, Math.max(1, wns.length)), rows = Math.ceil(wns.length / cols);
  await invokeOn(win, 'set-grid-size', { cols, rows });
  await sleep(800);
  for (const wn of wns) {
    const w = ax.listWindows().find(x => x.windowNumber === wn);
    if (!w) { check(`${label}: 窓 ${wn} (${appOf.get(wn)}) が見える`, false); continue; }
    const r = await invokeOn(win, 'snap-external', { windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title || '',
      x: w.x, y: w.y, width: w.width, height: w.height, windowIndex: w.windowIndex || 0 });
    check(`${label}: ${w.app} ${wn} を snap`, r && r.ok, JSON.stringify(r && { slot: r.slot, reason: r.reason }));
    await sleep(400);
  }
}
const extCount = async (win) => { const g = await invokeOn(win, 'get-grid-state', {}); return (g && g.slots || []).filter(x => x && x.type === 'ext').length; };

// mover を direction へ。where: { ws1, ws2 } = それぞれの居るべきデスクトップ (動かしたあと)
async function move(label, mover, direction, where, ws1, ws2) {
  const t0 = Date.now();
  const r = await invokeOn(mover, 'push-to-space', { direction });
  console.log(`[SCENARIO] ${label} result: ok=${r && r.ok} target=${r && r.target} moved=${r && r.moved && r.moved.length} failed=${JSON.stringify(r && r.failed)} (${Date.now() - t0}ms)`);
  await sleep(1500);
  check(`${label}: ok`, r && r.ok, r && (r.message || JSON.stringify(r.failed)));
  check(`${label}: 今のデスクトップが行き先`, r && ax.getActiveSpaceId() === r.target, `active=${ax.getActiveSpaceId()} target=${r && r.target}`);
  for (const [name, win, wns, sp] of [['ws1', ws1, WNS1, where.ws1], ['ws2', ws2, WNS2, where.ws2]]) {
    const off = wns.filter(wn => spaceOf(wn) !== sp);
    check(`${label}: ${name} の ${wns.length} 枚が ${sp}`, !off.length, desc(off));
    check(`${label}: ${name} の TiN が ${sp}`, spaceOf(widOf(win)) === sp, `@${spaceOf(widOf(win))}`);
    const n = await extCount(win);
    check(`${label}: ${name} の snap が外れていない (${n}/${wns.length})`, n === wns.length, '');
  }
  const moved = UNRELATED.filter(wn => spaceOf(wn) !== where.home);
  check(`${label}: 関係ない窓は元のデスクトップのまま`, !moved.length, desc(moved));
  return r;
}

// TIN_TEST_MODE=placement: ws1 の格子を 4×2 にして snap し、下限のあるアプリにだけ「はみ出し」の印 (minConstrained)
// が付き、どの窓もマスの左上に置かれていることを確かめる (2026-11-04 の再設計 2: 置いたあと確かめる)
async function placementScenario(ws1) {
  // 画面に何が届いているかを見る (main から送った snappedList の最後の 1 件を控える)
  await ws1.webContents.executeJavaScript(`ipcRenderer.on('external-windows', (_e, ...a) => { window.__lastSnappedList = a[5]; window.__ewCount = (window.__ewCount || 0) + 1; }); true`, true);
  await invokeOn(ws1, 'set-grid-size', { cols: 4, rows: 2 });
  await sleep(800);
  for (const wn of WNS1) {
    const w = ax.listWindows().find(x => x.windowNumber === wn);
    if (!w) { check(`窓 ${wn} (${appOf.get(wn)}) が見える`, false); continue; }
    const r = await invokeOn(ws1, 'snap-external', { windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title || '',
      x: w.x, y: w.y, width: w.width, height: w.height, windowIndex: w.windowIndex || 0 });
    check(`${w.app} ${wn} を snap`, r && r.ok, JSON.stringify(r && { slot: r.slot, reason: r.reason }));
    await sleep(500);
  }
  await sleep(9000);   // poll が何周か回って印の情報が画面に届くまで
  const recv = JSON.parse(await ws1.webContents.executeJavaScript('JSON.stringify({ n: window.__ewCount || 0, last: window.__lastSnappedList || null })', true));
  console.log(`[SCENARIO] renderer got external-windows ${recv.n} times; last snappedList=${JSON.stringify(recv.last).slice(0, 400)}`);
  const ents = JSON.parse(await ws1.webContents.executeJavaScript('JSON.stringify([...snappedExternals.entries()])', true));
  const slotsOf = new Map(ents.map(([wn, e]) => [Number(wn), e]));
  const lefts = new Map();
  for (const wn of WNS1) {
    const e = slotsOf.get(wn) || {};
    const app = appOf.get(wn) || '';
    const b = (ax.getWindowBounds([wn]) || [])[0] || {};
    console.log(`[SCENARIO] ${app} ${wn}: slot=${e.slot} minConstrained=${e.minConstrained} minSize=${e.minSize || ''} bounds=${b.x},${b.y} ${b.width}x${b.height}`);
    lefts.set(wn, b);
    if (/Terminal|ターミナル/.test(app)) check(`${app}: 印なし (升目の誤差は許す)`, !e.minConstrained, '');
    else if (/Chrome|Word|PowerPoint|Excel|Finder|Code/.test(app)) check(`${app}: はみ出しの印と下限`, !!e.minConstrained && !!e.minSize, e.minSize || '');
  }
  // 同じ列のマスの窓は左端がそろい、同じ行は上端がそろう (左上合わせ)
  const byCol = new Map(), byRow = new Map();
  for (const wn of WNS1) {
    const e = slotsOf.get(wn); const b = lefts.get(wn);
    if (!e || typeof e.slot !== 'number' || !b) continue;
    const col = e.slot % 4, row = Math.floor(e.slot / 4);
    if (!byCol.has(col)) byCol.set(col, []); byCol.get(col).push(b.x);
    if (!byRow.has(row)) byRow.set(row, []); byRow.get(row).push(b.y);
  }
  for (const [col, xs] of byCol) check(`列 ${col} の窓の左端がそろう`, Math.max(...xs) - Math.min(...xs) <= 3, xs.join(','));
  for (const [row, ys] of byRow) check(`行 ${row} の窓の上端がそろう`, Math.max(...ys) - Math.min(...ys) <= 3, ys.join(','));

  // ドラッグの追従: TiN の窓を 8 回に分けて (+120, +80) 動かすと、繋いだ窓も同じだけついてくる (待たない移動・最新だけ)
  const b0 = ws1.getBounds();
  const before = new Map(WNS1.map(wn => [wn, (ax.getWindowBounds([wn]) || [])[0]]));
  for (let i = 1; i <= 8; i++) { ws1.setBounds({ ...b0, x: b0.x + 15 * i, y: b0.y + 10 * i }); await sleep(40); }
  await sleep(1500);
  for (const wn of WNS1) {
    const a = (ax.getWindowBounds([wn]) || [])[0], p = before.get(wn);
    if (!a || !p) { check(`追従: ${appOf.get(wn)} ${wn}`, false, 'no bounds'); continue; }
    check(`追従: ${appOf.get(wn)} ${wn} が (+120,+80) ついてくる`, Math.abs(a.x - p.x - 120) <= 4 && Math.abs(a.y - p.y - 80) <= 4, `dx=${a.x - p.x} dy=${a.y - p.y}`);
  }
  ws1.setBounds(b0);
  await sleep(800);
  return finish();
}

async function run() {
  await sleep(6000);
  for (const w of ax.listWindowsAllSpaces()) appOf.set(w.windowNumber, w.app);
  const ws1 = wsWins()[0];
  if (process.env.TIN_TEST_MODE === 'placement') return placementScenario(ws1);
  await snapAll(ws1, WNS1, 'ws1');
  // ワークスペース 2 を同じデスクトップに作る
  const findItem = (items, label) => { for (const it of items) { if (it.label === label) return it; if (it.submenu) { const r = findItem(it.submenu.items, label); if (r) return r; } } return null; };
  findItem(Menu.getApplicationMenu().items, 'New Workspace').click();
  await sleep(5000);
  const ws2 = wsWins().find(w => w !== ws1);
  check('ワークスペース 2 ができた', !!ws2);
  if (!ws2) return finish();
  await snapAll(ws2, WNS2, 'ws2');
  await sleep(2500);
  const home = ax.getActiveSpaceId();
  const plan = planCarry(ax.getSpacesList(), home, { direction: +1 });
  if (!plan.ok) { check('右隣に通常のデスクトップがある', false, plan.reason); return finish(); }
  const target = plan.target;
  await move('ws1 を右へ', ws1, +1, { ws1: target, ws2: home, home }, ws1, ws2);
  await goTo(home);
  await move('ws2 を右へ', ws2, +1, { ws1: target, ws2: target, home }, ws1, ws2);
  await move('ws1 を左へ', ws1, -1, { ws1: home, ws2: target, home }, ws1, ws2);
  await goTo(target);
  await move('ws2 を左へ', ws2, -1, { ws1: home, ws2: home, home }, ws1, ws2);
  // 最後にしばらく置いても snap が外れない (生死判定が何周か回る)
  await sleep(8000);
  check(`最後: ws1 の snap ${await extCount(ws1)}/${WNS1.length}`, (await extCount(ws1)) === WNS1.length, '');
  check(`最後: ws2 の snap ${await extCount(ws2)}/${WNS2.length}`, (await extCount(ws2)) === WNS2.length, '');
  try { ws2.close(); } catch {}
  return finish();
}
async function goTo(id) {
  const hk = ax.getSpaceHotkeys();
  for (let n = 0; n < 6 && ax.getActiveSpaceId() !== id; n++) {
    const l = ax.getSpacesList(); const cur = l.find(s => s.isCurrent); const same = l.filter(s => s.display === cur.display);
    const d = same.findIndex(s => s.id === id) - same.indexOf(cur);
    if (!d) break;
    const k = d > 0 ? hk.right : hk.left; const from = ax.getActiveSpaceId();
    ax.postHotkey(k.keyCode, k.modifiers);
    const t = Date.now(); while (ax.getActiveSpaceId() === from && Date.now() - t < 2000) await sleep(40);
    await sleep(600);
  }
}
function finish() {
  const fails = results.filter(r => !r.ok).length;
  console.log(`[SCENARIO] DONE: ${results.length - fails}/${results.length} pass`);
  setTimeout(() => app.quit(), 300);
}
app.whenReady().then(() => {
  run().catch(e => { console.error('[SCENARIO] ERROR:', e && (e.stack || e.message || e)); finish(); });
});

require(path.join(__dirname, 'main.js'));
