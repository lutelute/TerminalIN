'use strict';
// 窓の操作 (他アプリの窓を動かす・上げる・一覧を取る) をここに集める。main.js からは AX を直接呼ばず、
// これを通す (2026-11-04 の再設計 ④)。
//
// なぜ:
//   - AX は相手のアプリに問い合わせる。遅いアプリ (PowerPoint は 1 回 150〜500ms、しまった直後の Finder は数秒)
//     があると、main スレッドで同期に呼ぶたびに TiN 全体が止まっていた → mac は native の *Async (専用の
//     直列キュー) を使う。書く (動かす・上げる) は 1 本の列なので、頼んだ順に効き、位置が前後しない
//   - 作業窓ごとの poll が同じ瞬間に一覧を取りに行っていた → 同時の頼みは 1 回にまとめ、短い間は使い回す
//   - 運搬 (別のデスクトップへ運ぶ) の最中に、ほかの処理が窓を動かしたり上げたりすると、合成ドラッグや
//     Mission Control の縮小表示が崩れる → 運搬は排他 (exclusive) で持ち、その間ほかの「待たない移動」と
//     「上げる」は捨てる (運搬の最後に並べ直す)
// Windows は win-helper (koffi) の同期 API をそのまま使う (*Async が無ければ同期で呼ぶ)。

function createWindowOps(ax, { log = () => {}, now = () => Date.now(), listMaxAgeMs = 150 } = {}) {
  const hasAsync = !!(ax && ax.moveWindowsAsync && ax.listWindowsAsync && ax.raiseWindowsAsync);

  // ── 一覧 (今見えている窓) ──
  let listInFlight = null, listCache = null, listAt = 0;
  async function list({ maxAgeMs = listMaxAgeMs } = {}) {
    if (!ax) return [];
    if (listCache && now() - listAt <= maxAgeMs) return listCache;
    if (listInFlight) return listInFlight;
    listInFlight = (async () => {
      try {
        const r = hasAsync ? await ax.listWindowsAsync() : ax.listWindows();
        listCache = Array.isArray(r) ? r : [];
        listAt = now();
        return listCache;
      } finally { listInFlight = null; }
    })();
    return listInFlight;
  }
  // 動かしたあとは使い回さない
  const invalidate = () => { listCache = null; };

  // ── 排他 (運搬) ──
  let exclusiveLabel = null;
  const carrying = () => !!exclusiveLabel;
  // fn の間は排他。もう誰かが持っていたら fn は呼ばず { busy: true, label } を返す
  async function exclusive(label, fn) {
    if (exclusiveLabel) return { busy: true, label: exclusiveLabel };
    exclusiveLabel = label || 'exclusive';
    try { return { busy: false, value: await fn() }; }
    finally { exclusiveLabel = null; }
  }

  // ── 動かす (書き終わるのを待つ) ──
  // detail: 読み戻した実際の枠 [{ windowNumber, found, x, y, width, height, ... }] を返す (mac)
  async function move(cmds, { positionOnly = false, detail = false } = {}) {
    if (!ax || !cmds || !cmds.length) return detail ? [] : 0;
    invalidate();
    return hasAsync ? ax.moveWindowsAsync(cmds, positionOnly, detail) : ax.moveWindows(cmds, positionOnly, detail);
  }

  // ── 動かす (待たない・最新だけ) ──
  // ドラッグ中の追従など。書いている途中に次が来たら、窓ごとに最新だけ残して、終わってから送る。
  // 大きさも書く頼みが先に来ていたら、位置だけの頼みで大きさを消さない。運搬中は捨てる。
  let ffInFlight = false, ffPending = null;   // Map(wn → { cmd, positionOnly })
  function moveLatest(cmds, positionOnly = false) {
    if (!ax || !cmds || !cmds.length) return;
    if (carrying()) return;
    invalidate();
    if (!hasAsync) {
      try { ax.moveWindows(cmds, positionOnly); } catch (e) { log(`[window-ops] move failed: ${e && e.message}`); }
      return;
    }
    if (ffInFlight) {
      if (!ffPending) ffPending = new Map();
      for (const w of cmds) {
        const prev = ffPending.get(w.windowNumber);
        const keepSize = prev && !prev.positionOnly && positionOnly;
        ffPending.set(w.windowNumber, keepSize
          ? { cmd: { ...w, width: prev.cmd.width, height: prev.cmd.height }, positionOnly: false }
          : { cmd: w, positionOnly });
      }
      return;
    }
    ffInFlight = true;
    Promise.resolve()
      .then(() => ax.moveWindowsAsync(cmds, positionOnly))
      .catch(e => log(`[window-ops] move failed: ${e && e.message}`))
      .finally(() => {
        ffInFlight = false;
        if (!ffPending) return;
        const p = [...ffPending.values()]; ffPending = null;
        const full = p.filter(x => !x.positionOnly).map(x => x.cmd);
        const pos = p.filter(x => x.positionOnly).map(x => x.cmd);
        if (full.length) moveLatest(full, false);
        if (pos.length) moveLatest(pos, true);
      });
  }
  // 待たない移動がすべて書き終わるまで待つ (試験・終了処理用)
  async function settle(timeoutMs = 3000) {
    const t0 = now();
    while ((ffInFlight || ffPending) && now() - t0 < timeoutMs) await new Promise(r => setTimeout(r, 10));
  }

  // ── 上げる (z-order) ──
  // 動かすのと同じ列に並ぶ (動かしてから上げる、の順が崩れない)。運搬中は force でなければ捨てる
  async function raise(cmds, { force = false } = {}) {
    if (!ax || !cmds || !cmds.length) return 0;
    if (carrying() && !force) return 0;
    return hasAsync ? ax.raiseWindowsAsync(cmds) : ax.raiseWindows(cmds);
  }

  return { list, invalidate, move, moveLatest, settle, raise, exclusive, carrying, hasAsync };
}

module.exports = { createWindowOps };
