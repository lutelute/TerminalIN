// test/window-ops.test.js — 窓の操作をまとめる層 (lib/window-ops.js)
const { test } = require('node:test');
const assert = require('node:assert');
const { createWindowOps } = require('../lib/window-ops');

// 偽の ax: *Async は手で解決する (書いている途中に次の頼みが来る状況を作る)
function fakeAx() {
  const calls = [];
  const pending = [];
  const ax = {
    listWindows: () => { calls.push('list-sync'); return [{ windowNumber: 1 }]; },
    listWindowsAsync: () => { calls.push('list'); return new Promise(r => pending.push(() => r([{ windowNumber: 1 }]))); },
    moveWindows: (c, p) => { calls.push(`move-sync ${c.map(x => x.windowNumber)} ${p}`); return c.length; },
    moveWindowsAsync: (c, p, d) => { calls.push(`move ${c.map(x => `${x.windowNumber}@${x.x}${x.width ? 'x' + x.width : ''}`)} ${p ? 'pos' : 'full'}${d ? ' detail' : ''}`); return new Promise(r => pending.push(() => r(d ? [] : c.length))); },
    raiseWindows: (c) => { calls.push('raise-sync'); return c.length; },
    raiseWindowsAsync: (c) => { calls.push(`raise ${c.map(x => x.windowNumber)}`); return new Promise(r => pending.push(() => r(c.length))); },
  };
  const flush = async () => { while (pending.length) { pending.shift()(); await new Promise(r => setImmediate(r)); } };
  return { ax, calls, flush };
}

test('list: 同時の頼みは 1 回にまとめ、短い間は使い回す。動かしたら取り直す', async () => {
  const { ax, calls, flush } = fakeAx();
  let t = 1000;
  const ops = createWindowOps(ax, { now: () => t });
  const a = ops.list(), b = ops.list();
  await flush();
  assert.deepStrictEqual(await a, await b);
  assert.strictEqual(calls.filter(c => c === 'list').length, 1);
  t += 100;
  await ops.list();
  assert.strictEqual(calls.filter(c => c === 'list').length, 1, '150ms 以内は使い回す');
  t += 100;
  const c = ops.list(); await flush(); await c;
  assert.strictEqual(calls.filter(x => x === 'list').length, 2, '古くなったら取り直す');
  ops.moveLatest([{ windowNumber: 1, x: 0, y: 0 }], true);
  const d = ops.list(); await flush(); await d;
  assert.strictEqual(calls.filter(x => x === 'list').length, 3, '動かしたら取り直す');
});

test('moveLatest: 書いている途中の頼みは窓ごとに最新だけ残す。大きさの頼みは位置だけの頼みで消さない', async () => {
  const { ax, calls, flush } = fakeAx();
  const ops = createWindowOps(ax);
  ops.moveLatest([{ windowNumber: 1, x: 10, y: 0, width: 300, height: 200 }], false);
  await new Promise(r => setImmediate(r));
  ops.moveLatest([{ windowNumber: 1, x: 20, y: 0 }], true);    // 途中
  ops.moveLatest([{ windowNumber: 1, x: 30, y: 0 }], true);    // 途中 (これが最新)
  ops.moveLatest([{ windowNumber: 2, x: 5, y: 0, width: 100, height: 100 }], false);
  ops.moveLatest([{ windowNumber: 2, x: 6, y: 0, width: 100, height: 100 }], true);   // 大きさの頼みのあとに位置だけ
  await flush(); await flush();
  await ops.settle(100);
  assert.deepStrictEqual(calls, ['move 1@10x300 full', 'move 2@6x100 full', 'move 1@30 pos']);
});

test('exclusive: 運搬の間はほかの待たない移動と上げるを捨てる。二重には入れない', async () => {
  const { ax, calls, flush } = fakeAx();
  const ops = createWindowOps(ax);
  let inner = null;
  const p = ops.exclusive('carry', async () => {
    assert.strictEqual(ops.carrying(), true);
    ops.moveLatest([{ windowNumber: 1, x: 0, y: 0 }], true);
    assert.strictEqual(await ops.raise([{ windowNumber: 1 }]), 0);
    inner = await ops.exclusive('again', async () => 1);
    const r = ops.raise([{ windowNumber: 1 }], { force: true });
    await flush();
    await r;
    return 'done';
  });
  const r = await p;
  assert.deepStrictEqual(r, { busy: false, value: 'done' });
  assert.deepStrictEqual(inner, { busy: true, label: 'carry' });
  assert.deepStrictEqual(calls, ['raise 1'], '運搬の中は force の上げるだけ');
  assert.strictEqual(ops.carrying(), false);
});

test('move / raise: 書き終わるのを待てる。*Async が無い環境 (Windows) は同期で呼ぶ', async () => {
  const { ax, calls, flush } = fakeAx();
  const ops = createWindowOps(ax);
  const m = ops.move([{ windowNumber: 3, x: 1, y: 2, width: 3, height: 4 }], { detail: true });
  await flush();
  assert.deepStrictEqual(await m, []);
  assert.deepStrictEqual(calls, ['move 3@1x3 full detail']);
  const sync = createWindowOps({ listWindows: ax.listWindows, moveWindows: ax.moveWindows, raiseWindows: ax.raiseWindows });
  assert.strictEqual(sync.hasAsync, false);
  assert.strictEqual(await sync.move([{ windowNumber: 4, x: 0, y: 0 }], { positionOnly: true }), 1);
  sync.moveLatest([{ windowNumber: 5, x: 0, y: 0 }], true);
  assert.strictEqual(await sync.raise([{ windowNumber: 5 }]), 1);
  assert.deepStrictEqual((await sync.list()).length, 1);
  assert.ok(calls.includes('move-sync 4 true') && calls.includes('move-sync 5 true') && calls.includes('raise-sync') && calls.includes('list-sync'));
});
