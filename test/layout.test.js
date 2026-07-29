// test/layout.test.js — slot 占有判定とグリッド座標計算
//
// ここでカバーするのは「過去に実際に壊れた」2系統:
//   1. slot 占有を片方のマップしか見ず「同一slotに2窓」「window1が出ない」(方針C / 697c093)
//   2. セル幅を個別に round して累積誤差が出て右端に余白 (#8)
// 実行: npm test

const { test } = require('node:test');
const assert = require('node:assert');
const {
  occupiedSlots, validSlotIdSet, nextFreeSlot, compactSlots, fitGridDims, computeSlotBounds,
} = require('../lib/layout');

// ── テスト用の最小 ws (BrowserWindow は一切持たない) ──
function mkWs({ grid = [], ext = [], cols = 2, rows = 2, slotLayout = null, viewMode = 'grid', colRatios, rowRatios } = {}) {
  return {
    gridWindows: new Map(grid.map(slot => [slot, { slot, tag: `pty${slot}` }])),
    snappedExternals: new Map(ext.map((slot, i) => [1000 + i, { slot, app: `App${i}` }])),
    gridCols: cols, gridRows: rows, slotLayout, viewMode, colRatios, rowRatios,
  };
}
const AREA = { x: 0, y: 0, width: 1000, height: 600 };
const PAD_X = 8, PAD_TOP = 4, PAD_BOTTOM = 8;

// ────────────────────────── 占有判定 ──────────────────────────

test('occupiedSlots: 内蔵PTYと外部窓の両方を数える', () => {
  const ws = mkWs({ grid: [0, 3], ext: [1] });
  assert.deepStrictEqual([...occupiedSlots(ws)].sort(), [0, 1, 3]);
});

test('occupiedSlots: 外部窓のみでも取りこぼさない (片方しか見ない実装を落とす)', () => {
  assert.deepStrictEqual([...occupiedSlots(mkWs({ ext: [0, 1] }))].sort(), [0, 1]);
});

test('occupiedSlots: 内蔵PTYのみでも取りこぼさない', () => {
  assert.deepStrictEqual([...occupiedSlots(mkWs({ grid: [2] }))].sort(), [2]);
});

test('nextFreeSlot: 外部窓が居る slot を再利用しない (同一slotに2窓の回帰)', () => {
  // slot0 = 内蔵PTY, slot1 = 外部窓 → 次は 2 でなければならない
  assert.strictEqual(nextFreeSlot(mkWs({ grid: [0], ext: [1] })), 2);
});

test('nextFreeSlot: 空きは昇順で最小のものを返す', () => {
  assert.strictEqual(nextFreeSlot(mkWs({ grid: [0, 2], ext: [3] })), 1);
});

test('nextFreeSlot: 満杯なら -1', () => {
  assert.strictEqual(nextFreeSlot(mkWs({ grid: [0, 1], ext: [2, 3] })), -1);
});

test('nextFreeSlot: 空の 2x2 なら 0', () => {
  assert.strictEqual(nextFreeSlot(mkWs()), 0);
});

test('validSlotIdSet: slotLayout なしは 0..cols*rows-1', () => {
  assert.deepStrictEqual([...validSlotIdSet(mkWs({ cols: 3, rows: 2 }))], [0, 1, 2, 3, 4, 5]);
});

test('validSlotIdSet: slotLayout があれば その id 列を挿入順で使う', () => {
  const layout = [
    { id: 7, col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: 3, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  assert.deepStrictEqual([...validSlotIdSet(mkWs({ slotLayout: layout }))], [7, 3]);
});

test('nextFreeSlot: slotLayout の id 空間で空きを探す (0..n-1 を前提にしない)', () => {
  const layout = [
    { id: 7, col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: 3, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  assert.strictEqual(nextFreeSlot(mkWs({ grid: [7], slotLayout: layout })), 3);
});

// ────────────────────────── compactSlots ──────────────────────────

test('compactSlots: 前詰めしても slot が重複しない', () => {
  const ws = mkWs({ grid: [3], ext: [1] });
  compactSlots(ws);
  const slots = [...occupiedSlots(ws)];
  assert.strictEqual(slots.length, 2, '2件が2つの slot を占めること');
  assert.deepStrictEqual(slots.sort(), [0, 1]);
});

test('compactSlots: gridWindows の Map キーも新しい slot に張り替わる', () => {
  const ws = mkWs({ grid: [3] });
  compactSlots(ws);
  assert.ok(ws.gridWindows.has(0), 'キーが 0 に移動していること');
  assert.ok(!ws.gridWindows.has(3), '古いキーが残っていないこと');
  assert.strictEqual(ws.gridWindows.get(0).slot, 0, 'gw.slot も更新されること');
});

test('compactSlots: 外部窓の info.slot も更新される', () => {
  const ws = mkWs({ ext: [2] });
  compactSlots(ws);
  assert.strictEqual([...ws.snappedExternals.values()][0].slot, 0);
});

test('compactSlots: 元から詰まっていれば何も変えない (moved=0)', () => {
  const ws = mkWs({ grid: [0], ext: [1] });
  const r = compactSlots(ws);
  assert.deepStrictEqual([...occupiedSlots(ws)].sort(), [0, 1]);
  assert.deepStrictEqual(r, { ok: true, moved: 0, overflow: 0 });
});

test('compactSlots: 実際に slot が変わった件数を moved で返す', () => {
  // 占有 {ext:1, grid:3} は slot 昇順で詰め直されるので ext:1→0 / grid:3→1 の 2 件が動く
  const r = compactSlots(mkWs({ grid: [3], ext: [1] }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.moved, 2);

  // 先頭が既に 0 なら動くのは後ろの 1 件だけ
  const r2 = compactSlots(mkWs({ grid: [0], ext: [3] }));
  assert.strictEqual(r2.moved, 1, 'slot0 は据え置き、slot3 → slot1 のみ');
});

test('compactSlots: 有効slotを超える占有は詰めずに overflow を返す (slot重複の回帰)', () => {
  // 2x2 で 4 窓 snap 済み → グリッドを 1x2 に縮小した直後の状態
  const ws = mkWs({ grid: [0, 1], ext: [2, 3], cols: 2, rows: 1 });
  const r = compactSlots(ws);
  assert.strictEqual(r.ok, false, 'あふれる場合は失敗を返す');
  assert.strictEqual(r.overflow, 2, '有効slot 2 に対し 4 件 → 2 件あふれ');
  assert.strictEqual(r.moved, 0);
});

test('compactSlots: あふれる場合は ws を一切変更しない', () => {
  const ws = mkWs({ grid: [0, 1], ext: [2, 3], cols: 2, rows: 1 });
  compactSlots(ws);
  assert.deepStrictEqual([...ws.gridWindows.keys()].sort(), [0, 1], 'PTY の slot は不変');
  assert.deepStrictEqual([...ws.snappedExternals.values()].map(i => i.slot).sort(), [2, 3], '外部窓の slot も不変');
});

test('compactSlots: 実行後に slot が重複しない (件数 = slot数)', () => {
  // 詰められるケースでは占有件数と slot 数が必ず一致する
  for (const c of [{ grid: [3], ext: [1] }, { grid: [0, 2] }, { ext: [1, 3] }, { grid: [2], ext: [0, 3] }]) {
    const ws = mkWs(c);
    const n = (c.grid || []).length + (c.ext || []).length;
    const r = compactSlots(ws);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(occupiedSlots(ws).size, n, `${JSON.stringify(c)} で slot が重複しないこと`);
  }
});

test('compactSlots: 非連続な slotLayout id でも重複しない', () => {
  // valid=[0,9] に対し占有[0,5] — 旧実装は「最後の有効slot」代入で 9 が重なり得た形
  const layout = [
    { id: 0, col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: 9, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const ws = mkWs({ grid: [0], ext: [5], cols: 2, rows: 1, slotLayout: layout });
  const r = compactSlots(ws);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(occupiedSlots(ws).size, 2, '2件が2つの異なる slot を占める');
  assert.deepStrictEqual([...occupiedSlots(ws)].sort((a, b) => a - b), [0, 9]);
});

// ────────────────────────── 座標計算 ──────────────────────────

test('computeSlotBounds: area が null なら null (ウィンドウ破棄後)', () => {
  assert.strictEqual(computeSlotBounds(null, mkWs(), 0), null);
});

test('computeSlotBounds: tab モードは全スロットが同一の全画面矩形', () => {
  const ws = mkWs({ viewMode: 'tab' });
  const a = computeSlotBounds(AREA, ws, 0);
  const b = computeSlotBounds(AREA, ws, 3);
  assert.deepStrictEqual(a, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepStrictEqual(a, b, 'tab では slot によらず同じ矩形');
});

test('computeSlotBounds: 2x2 の左上セル', () => {
  assert.deepStrictEqual(computeSlotBounds(AREA, mkWs(), 0), { x: 8, y: 4, width: 488, height: 290 });
});

test('computeSlotBounds: #8 回帰 — 最終列の右端が area の端(padding内)にちょうど揃う', () => {
  // 各セル幅を個別に round すると累積誤差でここが 1px ずれる
  for (const cols of [2, 3, 4, 5, 7]) {
    const ws = mkWs({ cols, rows: 1 });
    const last = computeSlotBounds(AREA, ws, cols - 1);
    assert.strictEqual(last.x + last.width, AREA.x + AREA.width - PAD_X,
      `cols=${cols} で右端が揃うこと`);
  }
});

test('computeSlotBounds: #8 回帰 — 割り切れない比率でも右端が揃う', () => {
  const ws = mkWs({ cols: 3, rows: 1, colRatios: [0.333, 0.333, 0.334] });
  const last = computeSlotBounds(AREA, ws, 2);
  assert.strictEqual(last.x + last.width, AREA.x + AREA.width - PAD_X);
});

test('computeSlotBounds: #8 回帰 — 最終行の下端も揃う', () => {
  for (const rows of [2, 3, 5]) {
    const ws = mkWs({ cols: 1, rows });
    const last = computeSlotBounds(AREA, ws, rows - 1);
    assert.strictEqual(last.y + last.height, AREA.y + AREA.height - PAD_BOTTOM,
      `rows=${rows} で下端が揃うこと`);
  }
});

test('computeSlotBounds: 隣接セルは gap(8px) ちょうど空き、重ならない', () => {
  for (const cols of [2, 3, 4]) {
    const ws = mkWs({ cols, rows: 1 });
    for (let i = 0; i < cols - 1; i++) {
      const a = computeSlotBounds(AREA, ws, i);
      const b = computeSlotBounds(AREA, ws, i + 1);
      assert.strictEqual(b.x - (a.x + a.width), 8, `cols=${cols} slot${i}/${i + 1} の間隔`);
    }
  }
});

test('computeSlotBounds: 先頭セルは padding 分だけ内側から始まる', () => {
  const b = computeSlotBounds(AREA, mkWs({ cols: 3, rows: 3 }), 0);
  assert.strictEqual(b.x, AREA.x + PAD_X);
  assert.strictEqual(b.y, AREA.y + PAD_TOP);
});

test('computeSlotBounds: 幅・高さが負にならない (極端に小さい area)', () => {
  const tiny = { x: 0, y: 0, width: 200, height: 100 };
  const b = computeSlotBounds(tiny, mkWs({ cols: 2, rows: 2 }), 3);
  assert.ok(b.width >= 0 && b.height >= 0, `width=${b.width} height=${b.height}`);
});

test('computeSlotBounds: colRatios の長さが cols と不一致なら均等割りにフォールバック', () => {
  const bad = computeSlotBounds(AREA, mkWs({ cols: 2, rows: 1, colRatios: [0.9] }), 0);
  const even = computeSlotBounds(AREA, mkWs({ cols: 2, rows: 1 }), 0);
  assert.deepStrictEqual(bad, even);
});

test('computeSlotBounds: 比率を変えると幅が比率どおりに配分される', () => {
  const ws = mkWs({ cols: 2, rows: 1, colRatios: [0.75, 0.25] });
  const a = computeSlotBounds(AREA, ws, 0);
  const b = computeSlotBounds(AREA, ws, 1);
  assert.ok(a.width > b.width * 2.5, `左が右の約3倍 (a=${a.width} b=${b.width})`);
  assert.strictEqual(b.x + b.width, AREA.x + AREA.width - PAD_X, '比率変更後も右端は揃う');
});

test('computeSlotBounds: slotLayout の colSpan は隣のセル + gap 分だけ広い', () => {
  const layout = [
    { id: 0, col: 0, row: 0, colSpan: 2, rowSpan: 1 },
    { id: 1, col: 2, row: 0, colSpan: 1, rowSpan: 1 },
  ];
  const ws = mkWs({ cols: 3, rows: 1, slotLayout: layout });
  const wide = computeSlotBounds(AREA, ws, 0);
  const narrow = computeSlotBounds(AREA, ws, 1);
  // #8 の丸め方針 (端を round し 幅 = 右端 - 左端) の帰結として、
  // 「右端は厳密に揃う」代わりに「個別セルの幅は最大 1px 揺れる」。
  // ここはその契約そのものを固定している — 完全一致で書くと丸め由来で落ちる。
  assert.ok(Math.abs(wide.width - (narrow.width * 2 + 8)) <= 1,
    `colSpan=2 は 1セル×2 + gap ±1px (wide=${wide.width} narrow=${narrow.width})`);
  assert.strictEqual(narrow.x + narrow.width, AREA.x + AREA.width - PAD_X, '右端は厳密に揃う');
  assert.strictEqual(wide.x, AREA.x + PAD_X, 'span セルの左端は padding 内側');
  assert.strictEqual(narrow.x - (wide.x + wide.width), 8, 'span セルと次のセルの間隔は gap');
});

test('computeSlotBounds: slotLayout に無い slot は null', () => {
  const layout = [{ id: 0, col: 0, row: 0, colSpan: 1, rowSpan: 1 }];
  assert.strictEqual(computeSlotBounds(AREA, mkWs({ cols: 1, rows: 1, slotLayout: layout }), 99), null);
});

test('computeSlotBounds: 同じ入力なら常に同じ出力 (純粋性)', () => {
  const ws = mkWs({ cols: 3, rows: 2 });
  assert.deepStrictEqual(computeSlotBounds(AREA, ws, 4), computeSlotBounds(AREA, ws, 4));
});

// ────────────────────────── fitGridDims ──────────────────────────
// All Snap の「窓数をターミナル数に自動で合わせる」の形状選択。
// 方針は「今の行数 (keepRows) を維持して列だけ動かす」— 何行が good かは
// 好みであって計算では決まらない、というユーザー判断 (2026-07-29) に基づく。
// 行数を曲げるのは「行がまるごと空く」「列が maxCols 超過」の2ケースのみ。

const LIMITS = { maxCols: 20, maxRows: 20 };

test('fitGridDims: 1行運用なら列だけ増減して1行のまま', () => {
  for (const need of [1, 2, 5, 7, 12]) {
    assert.deepStrictEqual(fitGridDims(need, { ...LIMITS, keepRows: 1 }), { cols: need, rows: 1 },
      `need=${need} は ${need}x1`);
  }
});

test('fitGridDims: 2行運用なら2行のまま列を合わせる', () => {
  const expected = { 4: 2, 6: 3, 7: 4, 8: 4, 12: 6 };
  for (const [need, cols] of Object.entries(expected)) {
    assert.deepStrictEqual(fitGridDims(Number(need), { ...LIMITS, keepRows: 2 }), { cols, rows: 2 },
      `need=${need} は ${cols}x2`);
  }
});

test('fitGridDims: 行がまるごと空くなら行を減らす', () => {
  // 3行に4窓 → 2x3 は最終行が丸ごと空く → 2x2 に落とす
  assert.deepStrictEqual(fitGridDims(4, { ...LIMITS, keepRows: 3 }), { cols: 2, rows: 2 });
  // 2行に1窓 → 1x2 は下段が空く → 1x1
  assert.deepStrictEqual(fitGridDims(1, { ...LIMITS, keepRows: 2 }), { cols: 1, rows: 1 });
  // 2行に2窓は「1列2行」で両方埋まるので減らさない (2行運用の維持)
  assert.deepStrictEqual(fitGridDims(2, { ...LIMITS, keepRows: 2 }), { cols: 1, rows: 2 });
});

test('fitGridDims: 全形状で全窓が収まり、空きは行数未満', () => {
  for (const keepRows of [1, 2, 3]) {
    for (let need = 1; need <= 16; need++) {
      const { cols, rows } = fitGridDims(need, { ...LIMITS, keepRows });
      assert.ok(cols * rows >= need, `keepRows=${keepRows} need=${need}: 収まる (${cols}x${rows})`);
      assert.ok(cols * rows - need < Math.max(rows, 2),
        `keepRows=${keepRows} need=${need}: 空きは行数未満 (${cols}x${rows})`);
    }
  }
});

test('fitGridDims: 列が maxCols を超えるときだけ行を増やす (セルが細くなりすぎる)', () => {
  // 1行運用でも 12窓を maxCols=10 には入れられない → 行方向に逃がす
  assert.deepStrictEqual(fitGridDims(12, { maxCols: 10, maxRows: 20, keepRows: 1 }), { cols: 6, rows: 2 });
  // 上限内なら1行のまま
  assert.deepStrictEqual(fitGridDims(10, { maxCols: 10, maxRows: 20, keepRows: 1 }), { cols: 10, rows: 1 });
});

test('fitGridDims: どの形状でも収まらないときは上限形状 (skipped は呼び出し側)', () => {
  assert.deepStrictEqual(fitGridDims(20, { maxCols: 3, maxRows: 3, keepRows: 1 }), { cols: 3, rows: 3 });
});

test('fitGridDims: need が 0 以下や非数なら 1x1', () => {
  assert.deepStrictEqual(fitGridDims(0, { ...LIMITS, keepRows: 3 }), { cols: 1, rows: 1 });
  assert.deepStrictEqual(fitGridDims(NaN, { ...LIMITS, keepRows: 3 }), { cols: 1, rows: 1 });
});

test('fitGridDims: keepRows 未指定/不正でも 1行として扱う', () => {
  assert.deepStrictEqual(fitGridDims(5, {}), { cols: 5, rows: 1 });
  assert.deepStrictEqual(fitGridDims(5, { ...LIMITS, keepRows: 0 }), { cols: 5, rows: 1 });
  assert.deepStrictEqual(fitGridDims(5, { ...LIMITS, keepRows: -3 }), { cols: 5, rows: 1 });
});

// All Snap の前詰め (main.js snapAllTerminals) が依存する契約。
// 「開いた順に左上から」を壊さないことが前提なので、順序保持は明示的に固定しておく。
test('compactSlots: 前詰めしても占有者の相対順が変わらない', () => {
  // slot 0,1,2,4,5,6,7 に7窓 (slot3 が unsnap 跡の穴) — 実機で観測した形
  const ws = mkWs({ ext: [0, 1, 2, 4, 5, 6, 7], cols: 4, rows: 2 });
  const before = [...ws.snappedExternals].sort((a, b) => a[1].slot - b[1].slot).map(([wn]) => wn);
  const r = compactSlots(ws);
  assert.strictEqual(r.ok, true);
  const after = [...ws.snappedExternals].sort((a, b) => a[1].slot - b[1].slot).map(([wn]) => wn);
  assert.deepStrictEqual(after, before, '詰めても並び順は不変');
  assert.deepStrictEqual([...ws.snappedExternals].map(([, i]) => i.slot).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6], '穴が埋まり 0..6 が連続で埋まる');
});
