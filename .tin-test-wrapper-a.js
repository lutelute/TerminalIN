// TiN 隔離テスト wrapper — シナリオA: evictOverflowSnapped の PTY 占有考慮 (方針C)
// 別 userData で main.js を起動し (インストール版と共存可能)、workspace renderer 経由で
// IPC を叩いてグリッド縮小時の shift/evict が PTY slot を踏まないことを検証する。
// リポジトリ直下に置く理由: loadFile('workspace.html') が app path (エントリの dir) 基準のため。
// ダミー外部窓: 'tin-test-w*' フォルダを開いた Finder 窓 (タイトルで自分の窓だけを識別)。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TESTDATA = process.env.TIN_TEST_USERDATA || path.join(__dirname, '.tin-test-userdata-a');
app.setPath('userData', TESTDATA);

const axHelper = require(path.join(__dirname, 'build', 'Release', 'ax_helper.node'));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`[SCENARIO] ${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

function wsWin() {
  return BrowserWindow.getAllWindows().find(w => {
    try { return (w.webContents.getURL() || '').includes('workspace.html'); } catch { return false; }
  });
}
async function evalWS(js) {
  const w = wsWin();
  if (!w) throw new Error('workspace window not found');
  return w.webContents.executeJavaScript(js, true);
}
const invoke = (channel, argsObj) =>
  evalWS(`ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(argsObj)})`);

const dummyWindows = () =>
  axHelper.listWindows().filter(w => w.app === 'Finder' && /^tin-test-w/.test(w.title || ''));

const slotTypes = (gs) => gs.slots.map(s => (s ? s.type : null)).join(',');

async function run() {
  await sleep(6000); // workspace 起動 + 初回 poll 待ち

  await invoke('set-grid-size', { cols: 4, rows: 1 });
  await sleep(800);

  // 1) PTY 端末 → slot 0
  await invoke('add-grid-terminal', {});
  await sleep(1500);
  let gs = await invoke('get-grid-state', {});
  check('PTY が slot0 を占有', gs.slots[0] && gs.slots[0].type === 'grid', slotTypes(gs));

  // 2) ダミー Finder 窓 3 つを snap → slot 1,2,3
  const tw = dummyWindows();
  check('ダミー窓が3つ見える', tw.length >= 3, `found=${tw.length}: ${tw.map(w => w.title).join('/')}`);
  for (const w of tw.slice(0, 3)) {
    const r = await invoke('snap-external', {
      windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title || '',
      x: w.x, y: w.y, width: w.width, height: w.height, windowIndex: w.windowIndex || 0,
    });
    console.log('[SCENARIO] snap →', JSON.stringify(r && { ok: r.ok, slot: r.slot, reason: r.reason }));
    await sleep(400);
  }
  gs = await invoke('get-grid-state', {});
  check('snap後: slot1..3 が ext',
    gs.slots[1]?.type === 'ext' && gs.slots[2]?.type === 'ext' && gs.slots[3]?.type === 'ext', slotTypes(gs));

  // 3) 2x1 に縮小 → overflow ext(slot2,3) は PTY slot0 に shift せず evict されるべき
  //    (旧コード: usedSlots が外部窓のみ → slot0 を空きと誤認して shift → PTY と二重占有)
  await invoke('set-grid-size', { cols: 2, rows: 1 });
  await sleep(1500);
  gs = await invoke('get-grid-state', {});
  check('縮小後: slot0 は PTY のまま (ext が踏んでいない)', gs.slots[0]?.type === 'grid', slotTypes(gs));
  check('縮小後: slot1 は ext', gs.slots[1]?.type === 'ext', slotTypes(gs));

  // 4) 満杯グリッドで targetSlot=0 (PTY 占有) を指定した snap → slot0 に入らないこと
  const evicted = dummyWindows()[0]; // どのダミー窓でもよい (snap 済みでも main 側の占有判定を通る)
  const r4 = await invoke('snap-external', {
    windowNumber: evicted.windowNumber, pid: evicted.pid, app: evicted.app, title: evicted.title || '',
    x: evicted.x, y: evicted.y, width: evicted.width, height: evicted.height, windowIndex: evicted.windowIndex || 0,
    targetSlot: 0,
  });
  check('targetSlot=0(PTY占有) snap が slot0 に入らない', !(r4 && r4.ok && r4.slot === 0),
    JSON.stringify(r4 && { ok: r4.ok, slot: r4.slot, reason: r4.reason }));

  // 5) 掃除: PTY 削除 (共有 ptyd 上の自セッションを kill)
  await invoke('remove-grid-terminal', { slot: 0 });
  await sleep(500);

  const fails = results.filter(r => !r.ok).length;
  console.log(`[SCENARIO] DONE: ${results.length - fails}/${results.length} pass`);
  setTimeout(() => app.quit(), 300);
}

app.whenReady().then(() => {
  run().catch(e => { console.error('[SCENARIO] ERROR:', e && (e.stack || e.message || e)); setTimeout(() => app.quit(), 300); });
});

require(path.join(__dirname, 'main.js'));
