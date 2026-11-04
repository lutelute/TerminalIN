// TiN 隔離テスト wrapper — TiN ごと端末を別デスクトップへ運ぶ (lib/space-carry.js) の実機確認。
// 別 userData で main.js を起動し (インストール版と共存可能)、workspace renderer 経由で
// push-to-space を叩いて、右のデスクトップへ運び → 左へ戻す。
// 外部の端末: TIN_TEST_WNS (カンマ区切りの windowNumber) — scripts/test-space-carry.sh が用意する。
// 画面が実際に切り替わる。終わるまでマウスとキーボードに触らないこと。
const path = require('path');
const { app, BrowserWindow } = require('electron');

const TESTDATA = process.env.TIN_TEST_USERDATA || path.join(__dirname, '.tin-test-userdata-space');
app.setPath('userData', TESTDATA);

const ax = require(path.join(__dirname, 'build', 'Release', 'ax_helper.node'));
const ALL_WNS = (process.env.TIN_TEST_WNS || '').split(',').map(Number).filter(n => n > 0);
const WNS = ALL_WNS.slice(0, 2);       // ワークスペース 1 に繋ぐ
const WN_WS2 = ALL_WNS[2] || 0;        // ワークスペース 2 に繋ぐ (通し試験)
let W3_HOME = 0;                        // 端末 3 の最初のデスクトップ (ws1 を運ぶ間は関係ない窓)

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
const invokeOn = (win, channel, argsObj) => win.webContents.executeJavaScript(
  `ipcRenderer.invoke(${JSON.stringify(channel)}, ${JSON.stringify(argsObj)})`, true);
const invoke = (channel, argsObj) => invokeOn(wsWin(), channel, argsObj);
const inside = (b, f) => b && f && b.x >= f.x - 2 && b.y >= f.y - 2 && b.x + b.width <= f.x + f.width + 2 && b.y + b.height <= f.y + f.height + 2;
const boundsOf = (wn) => (ax.getWindowBounds([wn]) || [])[0];
// TiN 窓の緑ボタン。Electron の透明な窓は AX の窓一覧に出ないことがあるので、画面上の位置へ
// 合成クリックして本当に押す (trafficLightPosition {x:12,y:12} → 緑は左から 3 つ目、中心 +59,+20)。
// press=false のときは「全画面になれる窓か」だけを返す。
async function greenButton(win, press) {
  if (!press) return win.isFullScreenable() ? 'fullscreenable' : 'zoom';
  const b = win.getBounds();
  const p = { x: b.x + 59, y: b.y + 20 };
  const wid = ax.getWindowIdFromHandle(win.getNativeWindowHandle().readBigUInt64LE(0));
  const cur = ax.getCursorPosition();
  // 先にカーソルを乗せる。TiN は透明な部分ではクリックを素通しにしていて、上部バーに
  // マウスが来て初めて受け取る側へ戻す (人が押すときと同じ順番にする)。
  ax.postMouse('move', p.x, p.y); await sleep(300);
  const hit = ax.hitTestPoint(p.x, p.y);
  if (!hit || hit.wn !== wid) { ax.warpCursor(cur.x, cur.y); return 'covered:' + JSON.stringify(hit); }
  ax.postMouse('down', p.x, p.y); await sleep(60);
  ax.postMouse('up', p.x, p.y); await sleep(60);
  ax.warpCursor(cur.x, cur.y);
  return 'clicked';
}
const spaceOf = (wn) => Number((ax.getSpaceForWindows([wn])[0] || {}).spaceId || 0);
// Terminal の窓が最小化されたままか (運ぶ間だけ一時的にしまう窓が、ちゃんと戻ったか)
const minimizedNow = (wn) => {
  try { return require('child_process').execSync(`osascript -e 'tell application "Terminal" to get miniaturized of window id ${wn}'`).toString().trim() === 'true'; }
  catch { return null; }
};
const ownIds = () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && w.isVisible()).map(w => {
  try { return ax.getWindowIdFromHandle(w.getNativeWindowHandle().readBigUInt64LE(0)); } catch { return 0; }
}).filter(n => n > 0);

async function runMove(label, direction, expectTarget) {
  const t0 = Date.now();
  const r = await invoke('push-to-space', { direction });
  console.log(`[SCENARIO] ${label} result: ${JSON.stringify(r)} (${Date.now() - t0}ms)`);
  await sleep(800);
  const target = expectTarget ?? r.target;
  check(`${label}: ok`, r && r.ok, r && (r.message || JSON.stringify(r.failed)));
  check(`${label}: 今のデスクトップが行き先`, ax.getActiveSpaceId() === target, `active=${ax.getActiveSpaceId()} target=${target}`);
  for (const wn of WNS) check(`${label}: 端末 ${wn} が行き先`, spaceOf(wn) === target, `space=${spaceOf(wn)}`);
  for (const id of ownIds()) check(`${label}: TiN の窓 ${id} が行き先`, spaceOf(id) === target, `space=${spaceOf(id)}`);
  // 端末 1 と同じ題名の関係ない窓 (端末 3) は運ぶ間だけしまわれる。元のデスクトップに残り、しまわれたままでないこと
  if (WN_WS2 && W3_HOME) check(`${label}: 関係ない窓 ${WN_WS2} は元の所に残り、しまわれたままでない`, spaceOf(WN_WS2) === W3_HOME && minimizedNow(WN_WS2) === false,
    `space=${spaceOf(WN_WS2)} minimized=${minimizedNow(WN_WS2)}`);
  return r;
}

async function run() {
  await sleep(6000);   // workspace 起動 + 初回 poll 待ち
  const wb = wsWin().getBounds();
  console.log(`[SCENARIO] TiN bounds ${JSON.stringify(wb)} wns=${WNS}`);
  await invoke('set-grid-size', { cols: 3, rows: 1 });
  await sleep(600);
  await invoke('add-grid-terminal', {});   // 内蔵端末 (自分の窓) → slot 0
  await sleep(1500);
  for (const wn of WNS) {
    const w = ax.listWindows().find(x => x.windowNumber === wn);
    if (!w) { check(`端末 ${wn} が見える`, false); continue; }
    const r = await invoke('snap-external', {
      windowNumber: w.windowNumber, pid: w.pid, app: w.app, title: w.title || '',
      x: w.x, y: w.y, width: w.width, height: w.height, windowIndex: w.windowIndex || 0,
    });
    check(`端末 ${wn} を snap`, r && r.ok, JSON.stringify(r && { slot: r.slot, reason: r.reason }));
    await sleep(500);
  }
  await sleep(1200);
  const source = ax.getActiveSpaceId();
  W3_HOME = WN_WS2 ? spaceOf(WN_WS2) : 0;
  const r1 = await runMove('右へ', +1);
  if (r1 && r1.ok) await runMove('左へ戻す', -1, source);

  // 追従: ユーザーが TiN の窓だけを別デスクトップへ動かした状況を作る
  // (TiN 本体を自分で送り、画面も行き先へ切り替える)。poll が気づいて端末を呼び寄せるのを待つ。
  if (r1 && r1.ok) {
    const target = r1.target;
    const main = ax.getWindowIdFromHandle(wsWin().getNativeWindowHandle().readBigUInt64LE(0));
    ax.moveWindowsToSpaceId([main], target);
    const hk = ax.getSpaceHotkeys().right;
    ax.postHotkey(hk.keyCode, hk.modifiers);
    const t0 = Date.now();
    let arrived = false;
    while (Date.now() - t0 < 20000) {
      await sleep(500);
      // 端末が着いたあとに画面が戻ってくる (関係ない窓をしまったときは切替キーで戻る) まで待つ
      if (WNS.every(wn => spaceOf(wn) === target) && ownIds().every(id => spaceOf(id) === target) && ax.getActiveSpaceId() === target) { arrived = true; break; }
    }
    console.log(`[SCENARIO] 追従: ${Date.now() - t0}ms`);
    await sleep(800);
    check('追従: TiN だけ動かすと端末がついてくる', arrived, WNS.map(wn => `${wn}@${spaceOf(wn)}`).join(' '));
    check('追従: 今のデスクトップが TiN の居る所', ax.getActiveSpaceId() === target, `active=${ax.getActiveSpaceId()}`);
    if (arrived) await runMove('追従のあと左へ戻す', -1, source);
  }

  // ── 通し試験: ワークスペースごとに画面いっぱいの TiN を別のデスクトップへ ──
  if (r1 && r1.ok && WN_WS2) await visionScenario(source, r1.target);

  await invoke('remove-grid-terminal', { slot: 0 });   // 共有 ptyd 上の自セッションを片付ける
  await sleep(500);
  const fails = results.filter(r => !r.ok).length;
  console.log(`[SCENARIO] DONE: ${results.length - fails}/${results.length} pass`);
  setTimeout(() => app.quit(), 300);
}

async function visionScenario(source, target) {
  const ws1 = wsWin();
  const hk = ax.getSpaceHotkeys();
  const go = async (h) => {
    const before = ax.getActiveSpaceId();
    ax.postHotkey(h.keyCode, h.modifiers); await sleep(1200);
    if (ax.getActiveSpaceId() === before) { ax.postHotkey(h.keyCode, h.modifiers); await sleep(1200); }
  };
  if (ax.getActiveSpaceId() !== source) await go(hk.left);

  // V1: 緑ボタンは全画面ではなく「広げる」
  const sub = await greenButton(ws1, false);
  check('緑ボタンが全画面でなく「広げる」', sub === 'zoom', sub);
  const c1 = await greenButton(ws1, true);
  console.log(`[SCENARIO] 緑ボタン (ws1): ${c1}`);
  await sleep(1500);
  check('緑ボタンで広がる (全画面にはならない)', ws1.isMaximized() && !ws1.isFullScreen(), `max=${ws1.isMaximized()} fs=${ws1.isFullScreen()}`);
  const f1 = ws1.getBounds();
  for (const wn of WNS) check(`広げたあと 端末 ${wn} が TiN の中・同じデスクトップ`, inside(boundsOf(wn), f1) && spaceOf(wn) === source,
    `${JSON.stringify(boundsOf(wn))} in ${JSON.stringify(f1)} space=${spaceOf(wn)}`);

  // V2: ワークスペース 2 を作り、端末を 1 枚繋いで右のデスクトップへ送り、広げる
  const { Menu } = require('electron');
  const findItem = (items, label) => { for (const it of items) { if (it.label === label) return it; if (it.submenu) { const r = findItem(it.submenu.items, label); if (r) return r; } } return null; };
  findItem(Menu.getApplicationMenu().items, 'New Workspace').click();
  await sleep(5000);
  const ws2 = BrowserWindow.getAllWindows().find(w => w !== ws1 && (w.webContents.getURL() || '').includes('workspace.html'));
  check('ワークスペース 2 ができた', !!ws2);
  if (!ws2) return;
  const w3 = ax.listWindows().find(x => x.windowNumber === WN_WS2);
  const sr = w3 && await invokeOn(ws2, 'snap-external', { windowNumber: w3.windowNumber, pid: w3.pid, app: w3.app, title: w3.title || '',
    x: w3.x, y: w3.y, width: w3.width, height: w3.height, windowIndex: w3.windowIndex || 0 });
  check(`ワークスペース 2 に端末 ${WN_WS2} を snap`, sr && sr.ok, JSON.stringify(sr && { slot: sr.slot, reason: sr.reason }));
  await sleep(1000);
  const r = await invokeOn(ws2, 'push-to-space', { direction: +1 });
  console.log(`[SCENARIO] ws2 → 右: ${JSON.stringify(r)}`);
  await sleep(800);
  const ws2wid = ax.getWindowIdFromHandle(ws2.getNativeWindowHandle().readBigUInt64LE(0));
  const ws1wid = ax.getWindowIdFromHandle(ws1.getNativeWindowHandle().readBigUInt64LE(0));
  check('ws2 と端末が右のデスクトップ', r && r.ok && spaceOf(ws2wid) === target && spaceOf(WN_WS2) === target, `ws2@${spaceOf(ws2wid)} term@${spaceOf(WN_WS2)}`);
  check('ws1 と端末は元のデスクトップのまま', spaceOf(ws1wid) === source && WNS.every(wn => spaceOf(wn) === source), WNS.map(wn => `${wn}@${spaceOf(wn)}`).join(' '));
  // ws2 を運ぶ間、同じアプリの ws1 の端末は一時的にしまわれる (ws2 の端末と題名が同じものがある)。戻って最小化のままでないこと
  check('ws2 を運んだあと ws1 の端末はしまわれたままでない', WNS.every(wn => !minimizedNow(wn)), WNS.map(wn => `${wn}:${minimizedNow(wn)}`).join(' '));
  const c2 = await greenButton(ws2, true);
  console.log(`[SCENARIO] 緑ボタン (ws2): ${c2}`);
  await sleep(1500);
  check(`ws2 も広がり 端末 ${WN_WS2} が中に入る`, ws2.isMaximized() && inside(boundsOf(WN_WS2), ws2.getBounds()), JSON.stringify(boundsOf(WN_WS2)));

  // V3: デスクトップを行き来しても、それぞれ自分のデスクトップに残り、snap も外れない
  for (const [h, where] of [[hk.left, source], [hk.right, target], [hk.left, source]]) {
    await go(h);
    check(`行き来: 今 ${where}`, ax.getActiveSpaceId() === where, `active=${ax.getActiveSpaceId()}`);
  }
  await sleep(8000);   // poll の生死判定が何周か回るのを待つ
  const g1 = await invokeOn(ws1, 'get-grid-state', {});
  const g2 = await invokeOn(ws2, 'get-grid-state', {});
  const ext = (g) => (g && g.slots || []).filter(x => x && x.type === 'ext').length;
  check('行き来のあとも ws1 の端末 2 枚が繋がったまま', ext(g1) === 2, JSON.stringify(g1 && g1.slots));
  check('行き来のあとも ws2 の端末 1 枚が繋がったまま', ext(g2) === 1, JSON.stringify(g2 && g2.slots));
  check('最後まで各端末が自分のデスクトップ', WNS.every(wn => spaceOf(wn) === source) && spaceOf(WN_WS2) === target,
    [...WNS, WN_WS2].map(wn => `${wn}@${spaceOf(wn)}`).join(' '));
  // 片付け: ws2 を閉じる (端末はそのまま残る → シェル側で閉じる)
  try { ws2.close(); } catch {}
  await sleep(800);
}

app.whenReady().then(() => {
  run().catch(e => { console.error('[SCENARIO] ERROR:', e && (e.stack || e.message || e)); setTimeout(() => app.quit(), 300); });
});

require(path.join(__dirname, 'main.js'));
