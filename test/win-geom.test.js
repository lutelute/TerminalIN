// test/win-geom.test.js — Windows のウィンドウ座標変換 (DIP → 物理px + DWM 縁補正)
//
// このテストの狙いは「mac 上で Windows の DPI 200% を検証すること」。
// 実機がないと再現できなかった高DPIのズレを、ここで機械的に押さえる。

const { test } = require('node:test');
const assert = require('node:assert');
const { computeWinBounds, computeWinBoundsMulti, pickDisplayForRect, assessMoveResult, recenterClamped } = require('../lib/win-geom');

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

// ── assessMoveResult: SetWindowPos 後のクランプ検出 (issue #43) ──
// want は computeWinBounds(Multi) の戻り、actualRect は GetWindowRect の戻り (物理px, 不可視縁込み)

function rectFor(x, y, w, h) { return { left: x, top: y, right: x + w, bottom: y + h }; }

test('assess: 要求どおりのサイズなら null (クランプなし)', () => {
  const want = computeWinBounds({ x: 100, y: 200, width: 400, height: 600 }, DWM, 2, false);
  const r = assessMoveResult(want, rectFor(want.x, want.y, want.cx, want.cy));
  assert.strictEqual(r, null);
});

test('assess: 文字セル量子化程度 (許容内) は null — 収まらない扱いにしない', () => {
  const want = computeWinBounds({ x: 0, y: 0, width: 400, height: 600 }, NO_BORDER, 1, false);
  // 半角セル幅 ~8px / 行高 ~17px 程度の切り上げは許容
  const r = assessMoveResult(want, rectFor(want.x, want.y, want.cx + 7, want.cy + 16));
  assert.strictEqual(r, null);
});

test('assess: 最小幅で止まった窓は超過分 dw を返す (Windows Terminal の狭い列)', () => {
  const want = computeWinBounds({ x: 0, y: 0, width: 300, height: 600 }, DWM, 2, false); // 狭い列 300 DIP
  // 実際は最小幅で止まり 286px 超過した想定
  const r = assessMoveResult(want, rectFor(want.x, want.y, want.cx + 286, want.cy));
  assert.deepStrictEqual(r, { dw: 286, dh: 0 });
});

test('assess: 要求より小さい分は超過ではない (負は 0 に丸める)', () => {
  const want = computeWinBounds({ x: 0, y: 0, width: 800, height: 600 }, NO_BORDER, 1, false);
  const r = assessMoveResult(want, rectFor(want.x, want.y, want.cx - 100, want.cy));
  assert.strictEqual(r, null);
});

test('recenter: 超過分が左右均等に振られる (右にだけはみ出さない)', () => {
  const want = computeWinBounds({ x: 100, y: 0, width: 300, height: 600 }, NO_BORDER, 1, false);
  const actual = rectFor(want.x, want.y, want.cx + 200, want.cy);  // 幅が 200px 超過
  const rc = recenterClamped(want, actual);
  assert.strictEqual(rc.x, want.x - 100, '超過 200 の半分 100 だけ左へ');
  assert.strictEqual(rc.y, want.y, '高さ超過なしなら y は不変');
});

test('recenter: 200% + DWM 縁でも中心が保たれる', () => {
  const want = computeWinBounds({ x: 100, y: 50, width: 300, height: 400 }, DWM, 2, false);
  const actual = rectFor(want.x, want.y, want.cx + 300, want.cy + 60);
  const rc = recenterClamped(want, actual);
  // 再配置後の中心 x = 要求スロットの中心 x (物理px)
  const wantCenter = want.x + want.cx / 2;
  const gotCenter = rc.x + (want.cx + 300) / 2;
  assert.ok(Math.abs(gotCenter - wantCenter) <= 1, `中心ズレ ${gotCenter - wantCenter}px`);
  assert.strictEqual(rc.y, want.y - 30, '高さ超過 60 の半分だけ上へ');
});

// ── Per-monitor DPI (issue #43-4): computeWinBoundsMulti ──
// primary 200% (DIP 1280x800 = 物理 2560x1600) + 右に secondary 100% (物理原点 x=2560)
const DISPLAYS = [
  { dipX: 0,    dipY: 0, dipW: 1280, dipH: 800,  physX: 0,    physY: 0, scale: 2 },
  { dipX: 1280, dipY: 0, dipW: 1920, dipH: 1080, physX: 2560, physY: 0, scale: 1 },
];

test('multi: primary 上の矩形は従来の単一スケールと同じ結果', () => {
  const c = { x: 100, y: 200, width: 400, height: 300 };
  assert.deepStrictEqual(
    computeWinBoundsMulti(c, DWM, DISPLAYS, 2, false),
    computeWinBounds(c, DWM, 2, false));
});

test('multi: secondary (100%) 上の矩形はそのモニタのスケールで変換される', () => {
  // DIP x=1400 は secondary 上 → 物理 x = 2560 + (1400-1280)*1 = 2680
  const r = computeWinBoundsMulti({ x: 1400, y: 100, width: 800, height: 600 }, NO_BORDER, DISPLAYS, 2, false);
  assert.deepStrictEqual(r, { x: 2680, y: 100, cx: 800, cy: 600 });
  // 単一スケール (primary の 2) だと x=2800 / 幅1600 になり位置もサイズも壊れる (回帰意図)
  const single = computeWinBounds({ x: 1400, y: 100, width: 800, height: 600 }, NO_BORDER, 2, false);
  assert.notStrictEqual(r.x, single.x);
  assert.notStrictEqual(r.cx, single.cx);
});

test('multi: displays が空/null なら fallbackScale で従来動作', () => {
  const c = { x: 100, y: 200, width: 400, height: 300 };
  assert.deepStrictEqual(computeWinBoundsMulti(c, DWM, null, 2, false), computeWinBounds(c, DWM, 2, false));
  assert.deepStrictEqual(computeWinBoundsMulti(c, DWM, [], 2, false), computeWinBounds(c, DWM, 2, false));
});

test('multi: モニタ跨ぎの矩形は中心が乗っているモニタのスケールを使う', () => {
  // 中心 x = 1200+400 = 1400 (DIP) → secondary
  const d = pickDisplayForRect({ x: 1200, y: 100, width: 800, height: 600 }, DISPLAYS);
  assert.strictEqual(d.scale, 1);
  // 中心 x = 1000 → primary
  const d2 = pickDisplayForRect({ x: 600, y: 100, width: 800, height: 600 }, DISPLAYS);
  assert.strictEqual(d2.scale, 2);
});

test('multi: どのモニタにも中心が無い場合は重なり最大のモニタへフォールバック', () => {
  // 画面下へ大きくはみ出し、中心はどのモニタ外。secondary との重なりが大きい
  const d = pickDisplayForRect({ x: 1300, y: 900, width: 800, height: 800 }, DISPLAYS);
  assert.strictEqual(d.scale, 1);
});

test('multi: positionOnly はサイズ 0 (SWP_NOSIZE 前提) で位置だけモニタ別変換', () => {
  const r = computeWinBoundsMulti({ x: 1400, y: 100, width: 800, height: 600 }, DWM, DISPLAYS, 2, true);
  assert.deepStrictEqual(r, { x: 2680 - DWM.l, y: 100 - DWM.t, cx: 0, cy: 0 });
});
