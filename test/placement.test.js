// test/placement.test.js — 置いたあとの読み戻しを分類する (lib/placement.js)
// 値は 2026-11-04 の実測 (macOS 26.7) をそのまま使う。
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyPlacement, needsRetry, createPlacementIssues } = require('../lib/placement');

const at = (x, y, width, height) => ({ x, y, width, height });
const got = (x, y, width, height) => ({ found: true, x, y, width, height });

test('classifyPlacement: 狙いどおり・ターミナルの升目の誤差は ok', () => {
  assert.strictEqual(classifyPlacement(at(120, 140, 700, 500), got(120, 140, 700, 500)).code, 'ok');
  assert.strictEqual(classifyPlacement(at(120, 140, 450, 350), got(120, 140, 447, 357)).code, 'ok', 'ターミナルが升目に合わせて 7 高くなっただけ');
  assert.strictEqual(classifyPlacement(at(120, 140, 300, 250), got(120, 140, 300, 245)).code, 'ok');
  assert.strictEqual(classifyPlacement(at(120, 140, 1000, 700), got(120, 140, 1000, 693)).code, 'ok', '升目 1 つぶん小さいのは許す');
  assert.strictEqual(classifyPlacement(at(120, 140, 380, 300), got(120, 140, 377, 301)).code, 'ok');
});

test('classifyPlacement: アプリの下限で止まったら clamped (書き直さない)', () => {
  const c = classifyPlacement(at(120, 140, 300, 250), got(120, 140, 500, 375));   // Chrome
  assert.strictEqual(c.code, 'clamped');
  assert.deepStrictEqual([c.dw, c.dh], [200, 125]);
  assert.strictEqual(needsRetry(c), false);
  assert.strictEqual(classifyPlacement(at(120, 140, 450, 350), got(120, 140, 450, 492)).code, 'clamped', 'PowerPoint は高さだけ');
});

test('classifyPlacement: 位置がずれた・広げきれなかったら書き直す', () => {
  const m = classifyPlacement(at(120, 140, 450, 350), got(120, 190, 514, 300));   // 直す前の Finder
  assert.strictEqual(m.code, 'misplaced');
  assert.strictEqual(needsRetry(m), true);
  const s = classifyPlacement(at(120, 140, 1000, 700), got(120, 140, 514, 300));
  assert.strictEqual(s.code, 'short');
  assert.strictEqual(needsRetry(s), true);
  assert.strictEqual(classifyPlacement(at(0, 0, 10, 10), { found: false }).code, 'missing');
  assert.strictEqual(classifyPlacement(at(0, 0, 10, 10), null).code, 'missing');
});

test('createPlacementIssues: はみ出しを窓ごとに覚え、収まったら消す。アプリの下限も覚える', () => {
  const pi = createPlacementIssues();
  const t = at(0, 0, 300, 250);
  const a = got(0, 0, 500, 375);
  pi.record(7, 'Google Chrome', t, a, classifyPlacement(t, a));
  assert.deepStrictEqual(pi.get(7), { windowNumber: 7, code: 'clamped', app: 'Google Chrome', minWidth: 500, minHeight: 375 });
  assert.deepStrictEqual(pi.appMinSize('Google Chrome'), { width: 500, height: 375 });
  // 高さだけはみ出す (幅は収まった) ときは幅を 0 で記録
  const t2 = at(0, 0, 600, 300), a2 = got(0, 0, 600, 375);   // +75
  pi.record(8, 'Google Chrome', t2, a2, classifyPlacement(t2, a2));
  assert.strictEqual(pi.get(8).minWidth, 0);
  assert.strictEqual(pi.get(8).minHeight, 375);
  // 大きなマスへ移って収まったら消える
  const t3 = at(0, 0, 700, 500), a3 = got(0, 0, 700, 500);
  pi.record(7, 'Google Chrome', t3, a3, classifyPlacement(t3, a3));
  assert.strictEqual(pi.get(7), null);
  // misplaced は記録を変えない (書き直しの結果で決める)
  const t4 = at(0, 0, 300, 250), a4 = got(0, 40, 500, 375);
  pi.record(8, 'Google Chrome', t4, a4, classifyPlacement(t4, a4));
  assert.ok(pi.get(8));
  pi.forget(8);
  assert.deepStrictEqual(pi.all(), []);
});
