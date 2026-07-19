// TiN 隔離テスト wrapper — シナリオB: クラッシュ復元経路 (restoreAllPending)
// 事前にクラフトした workspaces.json (PTY が slot0 / 外部窓の persisted slot が競合・無効) を
// 別 userData に置いて起動し、以下を検証する:
//   B1: persisted slot0 の外部窓が PTY(slot0) を踏まず slot1 へ再割当される
//   B2: 空きゼロの外部窓が黙って捨てられず missing(no-slot) 報告される
//   B3: (quit 後に Bash 側で) B2 のエントリが workspaces.json に書き戻されている
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TESTDATA = path.join(__dirname, '.tin-test-userdata-b');
app.setPath('userData', TESTDATA);

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
async function invoke(channel, argsObj) {
  const w = wsWin();
  if (!w) throw new Error('workspace window not found');
  return w.webContents.executeJavaScript(
    `ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(argsObj)})`, true);
}

async function run() {
  await sleep(9000); // 起動 + batch restore(1s) + move + 再試行前の安定待ち

  const gs = await invoke('get-grid-state', {});
  const types = gs.slots.map(s => (s ? s.type : null)).join(',');
  check('B1a: slot0 は PTY (復元 gridTerminal)', gs.slots[0]?.type === 'grid', types);
  check('B1b: persisted slot0 の外部窓は slot1 へ再割当', gs.slots[1]?.type === 'ext', types);

  const fails = results.filter(r => !r.ok).length;
  console.log(`[SCENARIO] RUNTIME DONE: ${results.length - fails}/${results.length} pass`);
  setTimeout(() => app.quit(), 300); // before-quit で workspaces.json 書き戻し → Bash 側で B3 を確認
}

app.whenReady().then(() => {
  run().catch(e => { console.error('[SCENARIO] ERROR:', e && (e.stack || e.message || e)); setTimeout(() => app.quit(), 300); });
});

require(path.join(__dirname, 'main.js'));
