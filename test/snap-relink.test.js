// lib/snap-relink.js のテスト
//
// ここで守りたいのはただ 1 点 — 「見失ったエントリの引き継ぎ先に、まだ生きている
// 別のエントリの窓を選ばない」。ターミナルの title は完全一致することがあるので、
// これを許すと閉じた端末が生きた窓を横取りし、snap に残り続ける。

const test = require('node:test');
const assert = require('node:assert');
const { findRelinkTarget, matchPersistedToLive } = require('../lib/snap-relink');

const W = (windowNumber, title, extra = {}) =>
  ({ windowNumber, app: 'ターミナル', title, width: 800, height: 600, ...extra });

// 同一設定・同一 cwd のターミナル 2 枚は title まで完全に同じになる
const SAME = 'ターミナル: shigenoburyuto — shigenoburyuto@Mac — ~ — -zsh — 52×38';

// ── findRelinkTarget (稼働中の再リンク) ──

test('windowNumber が変わった窓を title で引き継げる', () => {
  const info = { app: 'ターミナル', title: SAME };
  const got = findRelinkTarget(info, [W(200, SAME)], () => false);
  assert.strictEqual(got.windowNumber, 200);
});

test('同じ title でも既に他エントリの snap になっている窓は引き継がない', () => {
  const info = { app: 'ターミナル', title: SAME };
  const claimed = new Set([200]);
  const got = findRelinkTarget(info, [W(200, SAME)], wn => claimed.has(wn));
  assert.strictEqual(got, null, '生きている隣の窓を横取りしてはいけない');
});

test('claimed を除いた先に空いている窓があればそちらを引き継ぐ', () => {
  const info = { app: 'ターミナル', title: SAME };
  const claimed = new Set([200]);
  const got = findRelinkTarget(info, [W(200, SAME), W(201, SAME)], wn => claimed.has(wn));
  assert.strictEqual(got.windowNumber, 201);
});

test('title 前方 40 文字一致でも引き継げる (末尾の桁数だけ変わるケース)', () => {
  const base = 'ターミナル: TerminalIN — shigenoburyuto@Mac — ~/x — -zsh';
  const info = { app: 'ターミナル', title: base + ' — 52×38' };
  const got = findRelinkTarget(info, [W(300, base + ' — 60×40')], () => false);
  assert.strictEqual(got.windowNumber, 300);
});

test('前方一致の候補も claimed なら引き継がない', () => {
  const base = 'ターミナル: TerminalIN — shigenoburyuto@Mac — ~/x — -zsh';
  const info = { app: 'ターミナル', title: base + ' — 52×38' };
  const got = findRelinkTarget(info, [W(300, base + ' — 60×40')], () => true);
  assert.strictEqual(got, null);
});

test('app が違えば title が同じでも引き継がない', () => {
  const info = { app: 'ターミナル', title: SAME };
  const got = findRelinkTarget(info, [W(400, SAME, { app: 'iTerm2' })], () => false);
  assert.strictEqual(got, null);
});

test('title が無いエントリは引き継ぎ先を探さない (誤爆防止)', () => {
  assert.strictEqual(findRelinkTarget({ app: 'ターミナル', title: '' }, [W(1, SAME)], () => false), null);
  assert.strictEqual(findRelinkTarget(null, [W(1, SAME)], () => false), null);
});

test('isClaimed 省略時は全窓が候補 (呼び出し側の既定挙動を壊さない)', () => {
  const got = findRelinkTarget({ app: 'ターミナル', title: SAME }, [W(200, SAME)]);
  assert.strictEqual(got.windowNumber, 200);
});

// ── matchPersistedToLive (再起動後の復元) ──

const P = (over = {}) => ({
  windowNumber: 100, app: 'ターミナル', title: SAME,
  origW: 800, origH: 600, slot: 0, ...over,
});

test('windowNumber が生きていればそれを使う', () => {
  const got = matchPersistedToLive(P(), [W(100, 'まったく別のtitle'), W(200, SAME)], () => false);
  assert.strictEqual(got.windowNumber, 100);
});

test('windowNumber 一致でも claimed なら別候補を探す (重複エントリを黙って捨てない)', () => {
  const claimed = new Set([100]);
  const got = matchPersistedToLive(P(), [W(100, SAME), W(200, SAME)], wn => claimed.has(wn));
  assert.strictEqual(got.windowNumber, 200);
});

test('候補が全部 claimed ならマッチ無し (= unrestored に回して保持する)', () => {
  const got = matchPersistedToLive(P(), [W(100, SAME), W(200, SAME)], () => true);
  assert.strictEqual(got, null);
});

test('title 完全一致で復元できる (windowNumber は再起動で変わる)', () => {
  const got = matchPersistedToLive(P(), [W(999, SAME)], () => false);
  assert.strictEqual(got.windowNumber, 999);
});

test('セクション一致は候補が唯一のときだけ使う', () => {
  const p = P({ title: 'DevMaze — ✳ something — 48×31' });
  const two = [W(1, 'DevMaze — other — 10×10'), W(2, 'DevMaze — another — 10×10')];
  assert.strictEqual(matchPersistedToLive(p, two, () => false), null, '2 つあるなら決められない');
  assert.strictEqual(matchPersistedToLive(p, [two[0]], () => false).windowNumber, 1);
});

test('セクション一致の唯一性判定は claimed を除いた後で行う', () => {
  const p = P({ title: 'DevMaze — ✳ something — 48×31' });
  const claimed = new Set([1]);
  const two = [W(1, 'DevMaze — other — 10×10'), W(2, 'DevMaze — another — 10×10')];
  const got = matchPersistedToLive(p, two, wn => claimed.has(wn));
  assert.strictEqual(got.windowNumber, 2, '空いている側が唯一なら復元してよい');
});

test('サイズ近似はそのアプリの窓が 1 つだけのときに限る', () => {
  const p = P({ title: 'もう存在しない端末', origW: 800, origH: 600 });
  assert.strictEqual(matchPersistedToLive(p, [W(1, 'ぜんぜん別', { width: 810, height: 590 })], () => false).windowNumber, 1);
  const two = [W(1, 'ぜんぜん別', { width: 810, height: 590 }), W(2, 'これも別', { width: 805, height: 595 })];
  assert.strictEqual(matchPersistedToLive(p, two, () => false), null);
});

test('サイズ近似もサイズが離れていればマッチしない', () => {
  const p = P({ title: 'もう存在しない端末', origW: 800, origH: 600 });
  assert.strictEqual(matchPersistedToLive(p, [W(1, '別', { width: 1200, height: 600 })], () => false), null);
});

test('live が空なら null (起動直後の列挙失敗で誤マッチしない)', () => {
  assert.strictEqual(matchPersistedToLive(P(), [], () => false), null);
});
