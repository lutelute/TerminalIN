// test/snap-liveness.test.js — snapped エントリの生死判定
//
// このテストの狙いは「ディスプレイの抜き差しを実機で再現せずに、
// 一斉 evict の分岐を押さえること」。
// 実際のログには display-metrics-changed のバースト直後に
//   [tin] evicted 10 stale snapped in "Workspace 1"
// が残っていた。窓は生きていたのに CGWindowList が一瞬落としただけだった。
// 「判定不能なら保持」を機械的に守るのがここの役目。

const { test } = require('node:test');
const assert = require('node:assert');
const { ABSENT_EVICT_MS, livenessOf, absentVerdict } = require('../lib/snap-liveness');

const WN = 1234;
// 判定不能 (null) を既定にした probe。テストごとに分かるところだけ上書きする。
const unknown = (over = {}) => ({
  windowNumber: WN, processAlive: null, axWindowIds: null, allSpaceWindowIds: null, ...over,
});

// ── livenessOf: gone / alive / unknown の切り分け ──

test('プロセスごと消えていれば閉じたと断定する', () => {
  assert.strictEqual(livenessOf(unknown({ processAlive: false })), 'gone');
});

test('プロセスが消えていれば AX が居ると言っても閉じた扱い (AX の残骸を信じない)', () => {
  assert.strictEqual(livenessOf(unknown({ processAlive: false, axWindowIds: [WN] })), 'gone');
});

test('AX の窓一覧に居れば生存', () => {
  assert.strictEqual(livenessOf(unknown({ processAlive: true, axWindowIds: [999, WN] })), 'alive');
});

test('AX の窓一覧に居なければ閉じたと断定する (タブだけ閉じてプロセスは生存)', () => {
  assert.strictEqual(livenessOf(unknown({ processAlive: true, axWindowIds: [999] })), 'gone');
});

test('AX が空配列 (AXWindowID 非対応/応答なし) なら判定不能として次の根拠に進む', () => {
  assert.strictEqual(
    livenessOf(unknown({ processAlive: true, axWindowIds: [], allSpaceWindowIds: [WN] })), 'alive');
  assert.strictEqual(
    livenessOf(unknown({ processAlive: true, axWindowIds: [], allSpaceWindowIds: [42] })), 'gone');
});

test('別 Space / 最小化で CGWindowList から消えていても AX が居ると言えば生存', () => {
  assert.strictEqual(livenessOf(unknown({ processAlive: true, axWindowIds: [WN], allSpaceWindowIds: [] })), 'alive');
});

// ここが「しばらくすると snap が外れる」の核心。
test('全 probe が判定不能なら unknown (gone と決めつけない)', () => {
  assert.strictEqual(livenessOf(unknown()), 'unknown');
  assert.strictEqual(livenessOf(unknown({ processAlive: true })), 'unknown');
});

test('CGWindowList が空を返す瞬間を「全部閉じた」と読まない', () => {
  // 解像度変更の最中に起きる。ここで gone を返すと 10 個まとめて evict される。
  const entries = [1, 2, 3, 4, 5].map(n => ({
    windowNumber: n, processAlive: true, axWindowIds: [], allSpaceWindowIds: [],
  }));
  assert.deepStrictEqual(entries.map(livenessOf), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
});

test('pid 不明 (processAlive=null) でも AX の答えがあればそれに従う', () => {
  assert.strictEqual(livenessOf(unknown({ axWindowIds: [WN] })), 'alive');
  assert.strictEqual(livenessOf(unknown({ axWindowIds: [777] })), 'gone');
});

// ── absentVerdict: 見えないエントリの扱い ──

const NOW = 1_000_000_000;
const verdict = (over = {}) => absentVerdict({
  stabilizing: false, livenessFn: () => 'unknown', absentSince: 0, now: NOW, ...over,
});

test('stabilize 中は判断を見送る', () => {
  assert.strictEqual(verdict({ stabilizing: true, livenessFn: () => 'gone' }), 'wait');
});

test('stabilize 中は生死の問い合わせ自体を走らせない', () => {
  // CGWindowList が信用できない瞬間に AX を叩いても答えが濁るだけ。
  let called = 0;
  verdict({ stabilizing: true, livenessFn: () => { called++; return 'gone'; } });
  assert.strictEqual(called, 0);
});

test('確証が取れたら破棄', () => {
  assert.strictEqual(verdict({ livenessFn: () => 'gone' }), 'evict');
});

test('生きていると分かっているものは ghost として slot を保持する', () => {
  assert.strictEqual(verdict({ livenessFn: () => 'alive' }), 'ghost');
});

test('別 Space に置きっぱなしでも期限を切らない (生存が確認できている限り保持)', () => {
  // これを落とすと「別 Space から戻ったら slot が空いていた」になる。
  assert.strictEqual(verdict({
    livenessFn: () => 'alive', absentSince: NOW - ABSENT_EVICT_MS * 100,
  }), 'ghost');
});

test('判定不能なら猶予内は保持する', () => {
  assert.strictEqual(verdict({ absentSince: 0 }), 'ghost');
  assert.strictEqual(verdict({ absentSince: NOW - 1000 }), 'ghost');
  assert.strictEqual(verdict({ absentSince: NOW - (ABSENT_EVICT_MS - 1) }), 'ghost');
});

test('判定不能のまま猶予を超えたら破棄する (閉じた窓の slot 永久占有を防ぐ)', () => {
  assert.strictEqual(verdict({ absentSince: NOW - ABSENT_EVICT_MS }), 'evict');
});

test('猶予は呼び出し側で差し替えられる', () => {
  assert.strictEqual(verdict({ absentSince: NOW - 500, evictAfterMs: 100 }), 'evict');
});

test('stabilize 中は猶予切れでも破棄しない (復帰の機会を先に与える)', () => {
  assert.strictEqual(verdict({
    stabilizing: true, absentSince: NOW - ABSENT_EVICT_MS * 2,
  }), 'wait');
});
