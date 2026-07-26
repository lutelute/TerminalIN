// test/win-geom.test.js — Windows のウィンドウ座標変換 (DIP → 物理px + DWM 縁補正)
//
// このテストの狙いは「mac 上で Windows の DPI 200% を検証すること」。
// 実機がないと再現できなかった高DPIのズレを、ここで機械的に押さえる。

const { test } = require('node:test');
const assert = require('node:assert');
const { computeWinBounds } = require('../lib/win-geom');

const NO_BORDER = { l: 0, t: 0, r: 0, b: 0 };
// 典型的な DWM の不可視縁 (左右下に 7px、上は 0)
const DWM = { l: 7, t: 0, r: 7, b: 7 };

test('100% (dpiScale=1) / 縁なし: 入力がそのまま出る', () => {
  assert.deepStrictEqual(
    computeWinBounds({ x: 100, y: 200, width: 800, height: 600 }, NO_BORDER, 1, false),
    { x: 100, y: 200, cx: 800, cy: 600 });
});

test('200% (dpiScale=2): 座標もサイズも 2 倍になる', () => {
  assert.deepStrictEqual(
    computeWinBounds({ x: 100, y: 200, width: 800, height: 600 }, NO_BORDER, 2, false),
    { x: 200, y: 400, cx: 1600, cy: 1200 });
});

test('150% (dpiScale=1.5): 端数は round される', () => {
  const r = computeWinBounds({ x: 101, y: 7, width: 333, height: 111 }, NO_BORDER, 1.5, false);
  assert.deepStrictEqual(r, { x: Math.round(151.5), y: Math.round(10.5), cx: Math.round(499.5), cy: Math.round(166.5) });
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.cx), '整数であること (SetWindowPos は int)');
});

test('DWM の不可視縁を差し引き、見える縁が要求座標に揃う', () => {
  const r = computeWinBounds({ x: 100, y: 200, width: 800, height: 600 }, DWM, 1, false);
  // 実際の描画は縁の内側なので、見える左端 = x + l が要求値に戻る
  assert.strictEqual(r.x + DWM.l, 100, '見える左端');
  assert.strictEqual(r.y + DWM.t, 200, '見える上端');
  assert.strictEqual(r.cx - DWM.l - DWM.r, 800, '見える幅');
  assert.strictEqual(r.cy - DWM.t - DWM.b, 600, '見える高さ');
});

test('200% + DWM 縁: 縁は物理pxなのでスケールされない (二重スケールの回帰)', () => {
  const r = computeWinBounds({ x: 100, y: 200, width: 800, height: 600 }, DWM, 2, false);
  assert.strictEqual(r.x, 200 - DWM.l, 'x は DIP をスケールしてから縁を引く');
  assert.strictEqual(r.cx, 1600 + DWM.l + DWM.r, '幅は スケール後に縁を足す');
  // 縁まで 2 倍していたら x = 200 - 14 になってしまう
  assert.notStrictEqual(r.x, 200 - DWM.l * 2);
});

test('positionOnly: サイズは算出せず 0 (SWP_NOSIZE 前提)', () => {
  const r = computeWinBounds({ x: 100, y: 200, width: 800, height: 600 }, DWM, 2, true);
  assert.strictEqual(r.cx, 0);
  assert.strictEqual(r.cy, 0);
  assert.strictEqual(r.x, 200 - DWM.l, 'positionOnly でも位置は同じ計算');
  assert.strictEqual(r.y, 400 - DWM.t);
});

test('width/height 未指定は 0 として扱う (undefined が NaN にならない)', () => {
  const r = computeWinBounds({ x: 0, y: 0 }, NO_BORDER, 2, false);
  assert.strictEqual(r.cx, 0);
  assert.strictEqual(r.cy, 0);
  assert.ok(!Number.isNaN(r.cx) && !Number.isNaN(r.cy));
});

test('dpiScale が未設定/0/負なら 1 として扱う (ゼロ潰れの防止)', () => {
  const expected = { x: 100, y: 200, cx: 800, cy: 600 };
  const c = { x: 100, y: 200, width: 800, height: 600 };
  assert.deepStrictEqual(computeWinBounds(c, NO_BORDER, undefined, false), expected);
  assert.deepStrictEqual(computeWinBounds(c, NO_BORDER, 0, false), expected);
  assert.deepStrictEqual(computeWinBounds(c, NO_BORDER, -2, false), expected);
});

test('border が未指定でも落ちない', () => {
  assert.deepStrictEqual(
    computeWinBounds({ x: 10, y: 20, width: 30, height: 40 }, null, 1, false),
    { x: 10, y: 20, cx: 30, cy: 40 });
});

test('負の座標 (左/上のサブディスプレイ) も正しく変換される', () => {
  const r = computeWinBounds({ x: -1920, y: -100, width: 800, height: 600 }, NO_BORDER, 2, false);
  assert.strictEqual(r.x, -3840);
  assert.strictEqual(r.y, -200);
});

test('スケールしても隣接ウィンドウが重ならない (グリッド整列の実効性)', () => {
  // DIP で隣接する 2 枚 (800幅 + gap8) が、200% でも重ならず gap が保たれること
  const a = computeWinBounds({ x: 0,   y: 0, width: 800, height: 600 }, NO_BORDER, 2, false);
  const b = computeWinBounds({ x: 808, y: 0, width: 800, height: 600 }, NO_BORDER, 2, false);
  assert.strictEqual(b.x - (a.x + a.cx), 16, 'gap 8 DIP が物理 16px として保たれる');
});
