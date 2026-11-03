// test/space-carry.test.js — TiN ごと端末を別デスクトップへ運ぶ手順 (lib/space-carry.js)
//
// 実機の要点 (2026-11-03 実測) をそのまま偽の ax で再現して、手順の組み立てを確かめる:
//   - 切替キーは隣のデスクトップへ 1 つずつ。フルスクリーンも 1 つと数える
//   - タイトルバーを掴んだまま切り替えた窓だけが付いてくる
//   - 掴む点に別の窓が被っていたら押さない
// 実行: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const { planCarry, grabCandidates, carryToSpace, chooseMcGrab, chooseMcGroupGrab, mcClusters, mcIconPoint, pickMcDisplay, mcTitleKey } = require('../lib/space-carry');

const D = 'disp-1';
const SPACES = [
  { id: 3, index: 1, type: 0, display: D },
  { id: 10, index: 2, type: 0, display: D },
  { id: 375, index: 3, type: 4, display: D },   // フルスクリーンのアプリ
  { id: 20, index: 4, type: 0, display: D },
  { id: 99, index: 5, type: 0, display: 'disp-2' },
];

// ────────────────────────── planCarry ──────────────────────────

test('planCarry: 右隣のデスクトップへ 1 つ', () => {
  assert.deepStrictEqual(planCarry(SPACES, 3, { direction: 1 }),
    { ok: true, source: 3, target: 10, steps: 1, path: [3, 10], barIndex: 1, barCount: 4 });
});

test('planCarry: 方向指定はフルスクリーンを飛ばして次の通常デスクトップへ (通過は数える)', () => {
  assert.deepStrictEqual(planCarry(SPACES, 10, { direction: 1 }),
    { ok: true, source: 10, target: 20, steps: 2, path: [10, 375, 20], barIndex: 3, barCount: 4 });
});

test('planCarry: 左へも同じ', () => {
  assert.deepStrictEqual(planCarry(SPACES, 20, { direction: -1 }),
    { ok: true, source: 20, target: 10, steps: -2, path: [20, 375, 10], barIndex: 1, barCount: 4 });
});

test('planCarry: 端では折り返さない', () => {
  assert.strictEqual(planCarry(SPACES, 3, { direction: -1 }).reason, 'edge');
  assert.strictEqual(planCarry(SPACES, 20, { direction: 1 }).reason, 'edge');
});

test('planCarry: 行き先指定 — 離れたデスクトップは path に途中を全部含む', () => {
  assert.deepStrictEqual(planCarry(SPACES, 3, { targetSpaceId: 20 }),
    { ok: true, source: 3, target: 20, steps: 3, path: [3, 10, 375, 20], barIndex: 3, barCount: 4 });
});

test('planCarry: 行き先にフルスクリーン・今のデスクトップ・別ディスプレイは選べない', () => {
  assert.strictEqual(planCarry(SPACES, 3, { targetSpaceId: 375 }).reason, 'fullscreen-target');
  assert.strictEqual(planCarry(SPACES, 3, { targetSpaceId: 3 }).reason, 'same-space');
  assert.strictEqual(planCarry(SPACES, 3, { targetSpaceId: 99 }).reason, 'other-display');
  assert.strictEqual(planCarry(SPACES, 3, { targetSpaceId: 12345 }).reason, 'no-target');
  assert.strictEqual(planCarry(SPACES, 777, { direction: 1 }).reason, 'no-active-space');
});

// ────────────────────────── grabCandidates ──────────────────────────

test('grabCandidates: タイトルバーの高さで、信号機ボタンと右端を避ける', () => {
  const f = { x: 100, y: 200, width: 600, height: 400 };
  const pts = grabCandidates(f);
  assert.ok(pts.length >= 3);
  for (const p of pts) {
    assert.strictEqual(p.y, 210);
    assert.ok(p.x >= f.x + 78 && p.x <= f.x + f.width - 16, `x=${p.x}`);
  }
});

test('grabCandidates: 29 桁の狭い端末 (240px) でも候補が残る', () => {
  const pts = grabCandidates({ x: 259, y: 73, width: 240, height: 441 });
  assert.ok(pts.length >= 2, JSON.stringify(pts));
});

test('grabCandidates: 幅が取れない窓は候補なし', () => {
  assert.deepStrictEqual(grabCandidates(null), []);
  assert.deepStrictEqual(grabCandidates({ x: 0, y: 0, width: 0, height: 0 }), []);
});

// ────────────────────────── carryToSpace (偽の ax) ──────────────────────────

// 窓: { wn, pid, space, frame, carryable } / tin: 自分の窓 (SLS で送れる)
function fakeAx({ spaces = SPACES, active = 3, windows = [], own = [], covers = [], dropHotkeys = 0 } = {}) {
  const st = { active, held: null, mouseDown: false, cursor: { x: 5, y: 5 }, log: [] };
  const byWn = new Map(windows.map(w => [w.wn, { ...w }]));
  const ownSpace = new Map(own.map(w => [w, active]));
  const order = spaces.filter(s => s.display === D).map(s => s.id);
  const inFrame = (f, x, y) => x >= f.x && x < f.x + f.width && y >= f.y && y < f.y + f.height;
  let front = null;   // 最後に raise された窓
  const ax = {
    getActiveSpaceId: () => st.active,
    getSpaceForWindows: (wns) => wns.map(wn => ({ wn, spaceId: byWn.has(wn) ? byWn.get(wn).space : (ownSpace.get(wn) || 0) })),
    getWindowBounds: (wns) => wns.filter(wn => byWn.has(wn)).map(wn => ({ wn, ...byWn.get(wn).frame })),
    raiseWindows: (cmds) => { front = cmds[0].windowNumber; st.log.push(`raise ${front}`); return 1; },
    activateApp: () => true,
    hitTestPoint: (x, y) => {
      for (const c of covers) if (c.space === st.active && inFrame(c.frame, x, y)) return { wn: c.wn };
      const here = [...byWn.values()].filter(w => w.space === st.active && inFrame(w.frame, x, y));
      here.sort((a, b) => (b.wn === front) - (a.wn === front));
      return here[0] ? { wn: here[0].wn } : null;
    },
    postMouse: (kind, x, y) => {
      st.cursor = { x, y };
      if (kind === 'down') {
        st.mouseDown = true;
        const hit = ax.hitTestPoint(x, y);
        const w = hit && byWn.get(hit.wn);
        st.held = w && w.carryable !== false ? w.wn : null;
      }
      if (kind === 'up') { st.mouseDown = false; st.held = null; }
    },
    postHotkey: (keyCode) => {
      if (dropHotkeys > 0) { dropHotkeys--; st.log.push('dropped'); return; }   // 押下の取りこぼし
      const i = order.indexOf(st.active);
      const j = keyCode === 124 ? i + 1 : i - 1;
      if (j < 0 || j >= order.length) return;
      st.active = order[j];
      st.log.push(`switch ${st.active}`);
      if (st.held) byWn.get(st.held).space = st.active;
    },
    getCursorPosition: () => ({ ...st.cursor }),
    warpCursor: (x, y) => { st.cursor = { x, y }; st.log.push('warp'); },
    moveWindowsToSpaceId: (wns, sid) => { for (const w of wns) if (ownSpace.has(w)) ownSpace.set(w, sid); return wns.length; },
    isMouseButtonDown: () => st.mouseDown,
  };
  return { ax, st, byWn, ownSpace };
}
const HK = { left: { keyCode: 123, modifiers: 0x840000 }, right: { keyCode: 124, modifiers: 0x840000 } };
const deps = (ax) => ({ ax, sleep: async () => {}, log: () => {} });
const term = (wn, x, extra = {}) => ({ wn, pid: 500 + wn, space: 3, frame: { x, y: 100, width: 300, height: 300 }, ...extra });
const ext = (w) => ({ wn: w.wn, pid: w.pid, app: 'Terminal', title: `t${w.wn}` });

test('carryToSpace: 端末 2 枚 + TiN を右隣へ。途中で 1 回だけ戻り、最後は行き先に居る', async () => {
  const wins = [term(1, 0), term(2, 400)];
  const { ax, st, byWn, ownSpace } = fakeAx({ windows: wins, own: [900, 901] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace(deps(ax), { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900, 901] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.moved, [1, 2]);
  assert.strictEqual(byWn.get(1).space, 10);
  assert.strictEqual(byWn.get(2).space, 10);
  assert.strictEqual(ownSpace.get(900), 10);
  assert.strictEqual(r.endedOn, 10);
  // 行き(1) → 戻り → 行き(2) の 3 回だけ切り替える
  assert.deepStrictEqual(st.log.filter(l => l.startsWith('switch')), ['switch 10', 'switch 3', 'switch 10']);
  assert.strictEqual(st.log[st.log.length - 1], 'warp');   // カーソルは元の位置へ
  assert.deepStrictEqual(st.cursor, { x: 5, y: 5 });
});

test('carryToSpace: フルスクリーンを挟んだ行き先でも、掴んだまま通過して着く', async () => {
  const wins = [term(1, 0, { space: 10 })];
  const { ax, byWn } = fakeAx({ active: 10, windows: wins, own: [900] });
  const plan = planCarry(SPACES, 10, { direction: 1 });
  const r = await carryToSpace(deps(ax), { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(byWn.get(1).space, 20);
  assert.strictEqual(r.endedOn, 20);
});

test('carryToSpace: 掴む点が別の窓に隠れていたら押さずに失敗として返す (他の窓は運ぶ)', async () => {
  const wins = [term(1, 0), term(2, 400)];
  // 端末 1 のタイトルバー全体を覆う、クリックを受け取る窓
  const covers = [{ wn: 77, space: 3, frame: { x: 0, y: 90, width: 320, height: 40 } }];
  const { ax, byWn } = fakeAx({ windows: wins, own: [900], covers });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace(deps(ax), { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.failed.map(f => [f.wn, f.reason]), [[1, 'covered']]);
  assert.strictEqual(byWn.get(1).space, 3);
  assert.strictEqual(byWn.get(2).space, 10);
  assert.strictEqual(r.endedOn, 10);
});

test('carryToSpace: 掴めない窓 (タイトルバー無し) は not-carried、最後は行き先へ移って終わる', async () => {
  const wins = [term(1, 0, { carryable: false })];
  const { ax, ownSpace } = fakeAx({ windows: wins, own: [900] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace(deps(ax), { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.deepStrictEqual(r.failed.map(f => f.reason), ['not-carried']);
  assert.strictEqual(ownSpace.get(900), 10);
  assert.strictEqual(r.endedOn, 10);
});

test('carryToSpace: 既に行き先に居る窓はそのまま成功扱い、元にも行き先にも無い窓は触らない', async () => {
  const wins = [term(1, 0, { space: 10 }), term(2, 400, { space: 20 })];
  const { ax, st } = fakeAx({ windows: wins, own: [900] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace(deps(ax), { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.deepStrictEqual(r.moved, [1]);
  assert.deepStrictEqual(r.failed.map(f => [f.wn, f.reason]), [[2, 'not-on-source']]);
  assert.ok(!st.log.some(l => l.startsWith('raise')), '触らない窓を raise していない');
});

test('carryToSpace: 切替キーの押下が落ちても、元の所に留まっていれば 1 回だけ押し直して運ぶ', async () => {
  const wins = [term(1, 0)];
  const { ax, st, byWn } = fakeAx({ windows: wins, own: [900], dropHotkeys: 1 });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const realSleep = { ax, sleep: async () => {}, log: () => {} };
  // waitActive は実時間で待つので、偽の時計を進めずに済むよう Date.now を早送りする
  const now0 = Date.now; let t = now0();
  Date.now = () => (t += 200);
  try {
    const r = await carryToSpace(realSleep, { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(byWn.get(1).space, 10);
    assert.deepStrictEqual(st.log.filter(l => l === 'dropped' || l.startsWith('switch')), ['dropped', 'switch 10']);
  } finally { Date.now = now0; }
});

// ────────────────────────── Mission Control でまとめて運ぶ ──────────────────────────
// 偽の Mission Control: 今のデスクトップの窓を縮小表示 (手前から奥) で出し、スペースバーは上端に
// カーソルが来ると広がる。縮小表示を押して、広がったスペースバーのデスクトップで離すとその窓が移る。
// デスクトップを押すと Mission Control が閉じてそこへ切り替わる。
function fakeMc(opts = {}) {
  const f = fakeAx(opts);
  const { ax, st, byWn } = f;
  const order = SPACES.filter(s => s.display === D).map(s => s.id);
  const mc = { open: false, expanded: false, held: null, toggles: 0, overlays: opts.overlays || [] };
  // thumbs: wn → 縮小表示の枠 (指定が無ければ横に並べる)。z は小さいほど手前
  const thumbOf = (w, i) => (opts.thumbs && opts.thumbs[w.wn]) || { x: 100 + i * 200, y: 300, w: 180, h: 120 };
  const barBtn = (k) => mc.expanded ? { x: 300 + k * 170, y: 46, w: 139, h: 90 } : { x: 500 + k * 120, y: -32, w: 88, h: 24 };
  const thumbs = () => [...byWn.values()].filter(w => w.space === st.active)
    .map((w, i) => ({ wn: w.wn, title: w.title || `t${w.wn}`, z: w.z || 0, ...thumbOf(w, i) }))
    .sort((a, b) => a.z - b.z);
  const inR = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  ax.mcToggle = () => { mc.open = !mc.open; mc.expanded = false; mc.toggles++; st.log.push(mc.open ? 'mc open' : 'mc close'); return true; };
  ax.mcSnapshot = () => mc.open ? [{ x: 0, y: 0, w: 1512, h: 982,
    windows: thumbs().map(({ title, x, y, w, h }) => ({ title, x, y, w, h })),
    spaces: order.map((id, k) => ({ title: `d${k + 1}`, ...barBtn(k) })) }] : null;
  ax.mcPressSpace = (di, k) => {
    if (!mc.open || di !== 0) return false;
    mc.open = false; st.active = order[k]; st.log.push(`press ${order[k]}`); return true;
  };
  const baseHit = ax.hitTestPoint;
  ax.hitTestPoint = (x, y) => {
    if (!mc.open) return baseHit(x, y);
    for (const o of mc.overlays) if (inR(o, x, y)) return { wn: 91, app: 'KeyCastr', layer: 1000 };
    return { wn: 20, app: 'Dock', layer: 20 };
  };
  const basePost = ax.postMouse;
  ax.postMouse = (kind, x, y) => {
    if (!mc.open) return basePost(kind, x, y);
    st.cursor = { x, y };
    if (kind === 'down') {
      // 山 (重なった縮小表示) の下端中央のアイコンを押すと山ごと掴む
      const ts = thumbs();
      const cl = mcClusters(ts).find(c => { const p = mcIconPoint(c); return Math.abs(p.x - x) <= 18 && Math.abs(p.y - y) <= 18; });
      if (cl) { mc.held = cl.map(t => t.wn); st.log.push(`grab group ${mc.held.join('+')}`); }
      else { const t = ts.find(t => inR(t, x, y)); mc.held = t ? [t.wn] : null; st.log.push(`grab ${t ? t.wn : null}`); }
    }
    if (kind === 'drag' && y < 20) mc.expanded = true;
    if (kind === 'up') {
      const k = order.findIndex((_, i) => inR(barBtn(i), x, y));
      if (mc.held && k >= 0 && SPACES.find(s => s.id === order[k]).type === 0) for (const wn of mc.held) byWn.get(wn).space = order[k];
      mc.held = null;
    }
  };
  return { ...f, mc };
}
const liveFrom = (byWn) => () => new Map([...byWn.values()].map(w => [w.wn, w.title || `t${w.wn}`]));
// 元のデスクトップで今見えている窓 (main の axHelper.listWindows に相当)
const visibleFrom = (byWn, st) => () => [...byWn.values()].filter(w => w.space === st.active).map(w => ({ windowNumber: w.wn, app: w.app || 'Terminal', title: w.title || `t${w.wn}` }));
const STACK = { 1: { x: 400, y: 200, w: 130, h: 120 }, 2: { x: 404, y: 204, w: 130, h: 120 }, 3: { x: 408, y: 208, w: 130, h: 120 } };

test('Mission Control: 3 枚を画面を切り替えずに運び、TiN を送ってから行き先を押して終わる', async () => {
  const wins = [term(1, 0), term(2, 400), term(3, 800)];
  const { ax, st, byWn, ownSpace, mc } = fakeMc({ windows: wins, own: [900] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([1, 2, 3].map(w => byWn.get(w).space), [10, 10, 10]);
  assert.strictEqual(ownSpace.get(900), 10);
  assert.strictEqual(st.active, 10);
  assert.ok(!st.log.some(l => l.startsWith('switch')), '切替キーを使っていない: ' + st.log.join(','));
  assert.deepStrictEqual(st.log.filter(l => l.startsWith('mc') || l.startsWith('press')), ['mc open', 'press 10']);
  assert.strictEqual(mc.open, false);
});

test('Mission Control: 関係ない窓と同じ題名の端末は運ばず、切替キーの方式に回す (関係ない窓は動かない)', async () => {
  const wins = [term(1, 0, { title: '-zsh' }), term(2, 400, { title: 'mine' }), term(7, 800, { title: '-zsh' })];   // 7 は TiN に繋いでいない
  const { ax, st, byWn } = fakeMc({ windows: wins, own: [900] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const exts = [{ wn: 1, pid: 501, app: 'Terminal', title: '-zsh' }, { wn: 2, pid: 502, app: 'Terminal', title: 'mine' }];
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: exts, ownWns: [900] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(byWn.get(1).space, 10);
  assert.strictEqual(byWn.get(2).space, 10);
  assert.strictEqual(byWn.get(7).space, 3, '同名の関係ない窓は元のまま');
  assert.ok(st.log.includes('mc close'), 'Mission Control を閉じてから切替キーで運んだ');
  assert.ok(st.log.some(l => l.startsWith('switch')));
});

test('Mission Control: 重なった縮小表示は、運ぶ端末だけが重なる点を掴む', async () => {
  // 7 (関係ない窓) が手前で 1 と半分重なる。1 の右半分は 7 に掛からない
  const wins = [term(1, 0), term(7, 400, { z: -1 })];
  const thumbs = { 1: { x: 100, y: 300, w: 180, h: 120 }, 7: { x: 20, y: 300, w: 170, h: 120 } };
  const { ax, st, byWn } = fakeMc({ windows: wins, own: [], thumbs });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: [ext(wins[0])], ownWns: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(byWn.get(1).space, 10);
  assert.strictEqual(byWn.get(7).space, 3);
  assert.ok(!st.log.includes('grab 7'), st.log.join(','));
});

test('Mission Control: KeyCastr などの浮いた窓が被った点は避ける', async () => {
  const wins = [term(1, 0)];
  const { ax, byWn } = fakeMc({ windows: wins, own: [], overlays: [{ x: 100, y: 300, w: 120, h: 120 }] });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: [ext(wins[0])], ownWns: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(byWn.get(1).space, 10);
});

test('Mission Control: 開いたまま残っていたら閉じてから運ぶ', async () => {
  const wins = [term(1, 0)];
  const { ax, st, byWn, mc } = fakeMc({ windows: wins, own: [] });
  mc.open = true;
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: [ext(wins[0])], ownWns: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(st.log.filter(l => l.startsWith('mc')), ['mc close', 'mc open']);
  assert.strictEqual(mc.open, false);
});

test('Mission Control: 行き先を押しても閉じなかったら閉じる', async () => {
  const wins = [term(1, 0)];
  const { ax, st, byWn, mc } = fakeMc({ windows: wins, own: [] });
  const press = ax.mcPressSpace;
  ax.mcPressSpace = (di, k) => { const ok = press(di, k); mc.open = true; return ok; };   // 切り替わったが開いたまま
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const now0 = Date.now; let t = now0();
  Date.now = () => (t += 100);
  try {
    const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn) }, { plan, hotkeys: HK, externals: [ext(wins[0])], ownWns: [] });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  } finally { Date.now = now0; }
  assert.strictEqual(mc.open, false, st.log.join(','));
  assert.strictEqual(st.active, 10);
});

test('chooseMcGrab: 運ぶ端末でない縮小表示に掛かる点は選ばない・候補が無ければ null', () => {
  const thumbs = [{ title: 'other', x: 0, y: 0, w: 100, h: 100 }, { title: 'mine', x: 0, y: 0, w: 100, h: 100 }];
  assert.strictEqual(chooseMcGrab(thumbs, [{ wn: 1, title: 'mine' }]), null, '完全に覆われていたら掴まない');
  const p = chooseMcGrab([{ title: 'mine', x: 0, y: 0, w: 100, h: 100 }, { title: 'other', x: 60, y: 0, w: 100, h: 100 }], [{ wn: 1, title: 'mine' }]);
  assert.ok(p && p.x < 60, JSON.stringify(p));
});

test('pickMcDisplay: 1 画面ならそれ、複数なら frame、無ければスペースバーの数で選ぶ', () => {
  const a = { x: 0, y: 0, w: 1512, h: 982, spaces: [1, 2, 3] }, b = { x: 1512, y: 0, w: 1920, h: 1080, spaces: [1, 2] };
  assert.strictEqual(pickMcDisplay([a], null, 9), a);
  assert.strictEqual(pickMcDisplay([a, b], { x: 1512, y: 0, width: 1920, height: 1080 }, 3), b);
  assert.strictEqual(pickMcDisplay([a, b], null, 2), b);
  assert.strictEqual(pickMcDisplay([a, b], null, 5), null);
  assert.strictEqual(pickMcDisplay(null, null, 2), null);
});

test('mcTitleKey: claude の印と前面の処理名の入れ替わりを無視する', () => {
  const a = 'proj-a — ◑ some task — caffeinate ◂ claude — 43×33';
  const b = 'proj-a — ✳ some task — node ◂ claude — 43×33';
  assert.strictEqual(mcTitleKey(a), mcTitleKey(b));
  assert.notStrictEqual(mcTitleKey(a), mcTitleKey('proj-b — ✳ other task — node ◂ claude — 43×33'));
  assert.strictEqual(mcTitleKey('⠂ build — -zsh'), mcTitleKey('⠐ build — -zsh'));
});

test('chooseMcGrab: 題名の印が変わっていても運ぶ端末と分かる・重なりの細い縁でも掴める', () => {
  const thumbs = [
    { title: 'other — -zsh', x: 0, y: 0, w: 100, h: 100 },                       // 手前の関係ない窓
    { title: 'proj — ◑ task — caffeinate ◂ claude', x: 3, y: 3, w: 100, h: 100 },  // 右と下に 3px だけ覗く
  ];
  const p = chooseMcGrab(thumbs, [{ wn: 1, title: 'proj — ✳ task — node ◂ claude' }]);
  assert.ok(p && (p.x > 100 || p.y > 100), JSON.stringify(p));
  assert.strictEqual(p.thumb, thumbs[1]);
});

test('Mission Control: 山の窓が全部 TiN の端末なら、アイコンを掴んで山ごと 1 回で運ぶ', async () => {
  const wins = [term(1, 0), term(2, 400), term(3, 800)];
  const { ax, st, byWn, ownSpace } = fakeMc({ windows: wins, own: [900], thumbs: STACK });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn), sourceWindows: visibleFrom(byWn, st) },
    { plan, hotkeys: HK, externals: wins.map(ext), ownWns: [900] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual([1, 2, 3].map(w => byWn.get(w).space), [10, 10, 10]);
  assert.strictEqual(ownSpace.get(900), 10);
  assert.deepStrictEqual(st.log.filter(l => l.startsWith('grab')), ['grab group 1+2+3'], st.log.join(','));
});

test('Mission Control: 山に TiN に繋いでいない窓があれば山ごとは使わず、アイコンも掴まない (関係ない窓は動かない)', async () => {
  const wins = [term(1, 0), term(2, 400), term(7, 800, { title: 'not-mine' })];
  const thumbs = { 1: STACK[1], 2: STACK[2], 7: STACK[3] };
  const { ax, st, byWn } = fakeMc({ windows: wins, own: [], thumbs });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn), sourceWindows: visibleFrom(byWn, st) },
    { plan, hotkeys: HK, externals: [ext(wins[0]), ext(wins[1])], ownWns: [] });
  assert.strictEqual(byWn.get(7).space, 3, '関係ない窓は元のまま: ' + st.log.join(','));
  assert.ok(!st.log.some(l => l.startsWith('grab group')), st.log.join(','));
  assert.ok(!r.failed.some(f => f.reason === 'stray'));
});

test('Mission Control: 同じアプリの見えている窓に関係ない窓があれば (山が別でも) 山ごとは使わない', async () => {
  const wins = [term(1, 0), term(2, 400), term(7, 800, { title: 'not-mine' })];   // 7 は離れた所に居る
  const thumbs = { 1: STACK[1], 2: STACK[2], 7: { x: 1000, y: 600, w: 130, h: 120 } };
  const { ax, st, byWn } = fakeMc({ windows: wins, own: [], thumbs });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn), sourceWindows: visibleFrom(byWn, st) },
    { plan, hotkeys: HK, externals: [ext(wins[0]), ext(wins[1])], ownWns: [] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(!st.log.some(l => l.startsWith('grab group')), st.log.join(','));
  assert.strictEqual(byWn.get(7).space, 3);
});

test('chooseMcGroupGrab / mcIconPoint: アイコンは山の外接矩形の下端中央', () => {
  const c = [{ title: 'a', x: 100, y: 100, w: 100, h: 100 }, { title: 'b', x: 110, y: 110, w: 100, h: 100 }];
  assert.deepStrictEqual(mcIconPoint(c), { x: 155, y: 204 });
  assert.strictEqual(mcClusters([...c, { title: 'z', x: 500, y: 500, w: 50, h: 50 }]).length, 2);
  const ours = [{ wn: 1, title: 'a', app: 'Terminal' }, { wn: 2, title: 'b', app: 'Terminal' }];
  assert.deepStrictEqual(chooseMcGroupGrab(c, ours, new Set(['Terminal'])), { x: 155, y: 204, size: 2, title: 'a', key: 'a\nb' });
  assert.strictEqual(chooseMcGroupGrab(c, ours, new Set(['Terminal']), () => true, new Set(['a\nb'])), null, '動かなかった山は飛ばす');
  assert.strictEqual(chooseMcGroupGrab(c, ours, new Set()), null, '安全なアプリが無ければ使わない');
  assert.strictEqual(chooseMcGroupGrab(c, ours.slice(0, 1), new Set(['Terminal'])), null, '山に関係ない窓がある');
});

test('Mission Control: アプリが 2 つ (Terminal と iTerm) なら山ごとを 2 回で、10 枚超でも 2 回のドラッグで運ぶ', async () => {
  const wins = [], thumbs = {};
  for (let i = 1; i <= 12; i++) {
    const iterm = i > 7;
    wins.push(term(i, 0, { app: iterm ? 'iTerm2' : 'Terminal' }));
    thumbs[i] = iterm ? { x: 900 + i * 3, y: 300 + i * 3, w: 130, h: 120 } : { x: 300 + i * 3, y: 300 + i * 3, w: 130, h: 120 };
  }
  const { ax, st, byWn } = fakeMc({ windows: wins, own: [900], thumbs });
  const plan = planCarry(SPACES, 3, { direction: 1 });
  const r = await carryToSpace({ ...deps(ax), liveTitles: liveFrom(byWn), sourceWindows: visibleFrom(byWn, st) },
    { plan, hotkeys: HK, externals: wins.map(w => ({ ...ext(w), app: w.app })), ownWns: [900] });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(wins.every(w => byWn.get(w.wn).space === 10));
  assert.deepStrictEqual(st.log.filter(l => l.startsWith('grab')).map(l => l.split(' ').slice(0, 2).join(' ')), ['grab group', 'grab group'], st.log.join(','));
});
