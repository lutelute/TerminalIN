// lib/layout.js — slot 占有判定とグリッド座標計算 (純粋ロジック)
//
// ここに置く条件: Electron / OS / ネイティブ addon に一切依存しないこと。
// main.js から切り出してあるのは「実機なしで検証できるようにする」ためで、
// 挙動は切り出し前と 1:1 で同じ。変更するときは必ず test/layout.test.js も更新する。
//
// ws として要求するのは以下のプレーンなプロパティだけ (BrowserWindow は見ない):
//   gridWindows      : Map<slot, gw>
//   snappedExternals : Map<windowNumber, { slot, ... }>
//   slotLayout       : Array<{ id, col, row, colSpan, rowSpan }> | null
//   gridCols/gridRows: number
//   colRatios/rowRatios: number[] | undefined
//   viewMode         : 'grid' | 'tab'

// ── slot 占有の一元判定 ──
// 占有者は2種: 内蔵PTY (gridWindows: Map<slot,gw>) と外部窓 (snappedExternals: Map<wn,info{slot}>)。
// 経路ごとに片方のマップしか見ない実装が「同一slotに2窓」「window1が出ない」の原因だったため、
// slot の空き/占有判定は必ず occupiedSlots / nextFreeSlot を通すこと。
// なお削除/unsnap で slot を自動的に詰めない (復元・履歴・外部連携(REST/Raycast の slot) を揺らさないため)。
function occupiedSlots(ws) {
  const used = new Set(ws.gridWindows.keys());
  for (const [, info] of ws.snappedExternals) used.add(info.slot);
  return used;
}

// 現在有効な slot id の集合 (slotLayout があればその id 列、なければ 0..cols*rows-1)。挿入順を保つ。
function validSlotIdSet(ws) {
  return new Set(ws.slotLayout
    ? ws.slotLayout.map(c => c.id)
    : Array.from({ length: ws.gridCols * ws.gridRows }, (_, i) => i));
}

function nextFreeSlot(ws) {
  const used = occupiedSlots(ws);
  for (const id of validSlotIdSet(ws)) if (!used.has(id)) return id;
  return -1;
}

// 空き slot を前に詰める。自動では呼ばない設計 (slot 番号の安定が復元/履歴/外部連携の前提)。
// 将来「詰める」を明示操作 (ボタン/ショートカット) として出すときにここを呼ぶ。
//
// 戻り値: { ok, moved, overflow }
//   ok=false, overflow=n → 有効 slot 数より占有数が n 件多く、**何も変更していない**。
//     以前はあふれた分を全部「最後の有効 slot」に代入しており、複数窓が同一 slot に
//     重なる状態を作っていた (方針C で潰したのと同じクラスのバグ)。
//     どれを退避するかは製品判断 (evict/unsnap) なのでここでは決めず、呼び出し側に返す。
//     この状況は「4窓 snap 済みでグリッドを 2x2 → 1x2 に縮小」等で普通に起きる。
function compactSlots(ws) {
  const all = [];
  for (const [slot, gw] of ws.gridWindows) all.push({ type: 'grid', slot, ref: gw });
  for (const [wn, info] of ws.snappedExternals) all.push({ type: 'ext', slot: info.slot, ref: info, wn });
  all.sort((a, b) => a.slot - b.slot);
  const validSlots = [...validSlotIdSet(ws)];

  // 詰め先が足りないなら一切触らない (中途半端に詰めて重複を作らない)。
  if (all.length > validSlots.length) {
    return { ok: false, moved: 0, overflow: all.length - validSlots.length };
  }

  let moved = 0;
  for (let i = 0; i < all.length; i++) {
    const newSlot = validSlots[i];
    const item = all[i];
    if (item.slot !== newSlot) moved++;
    if (item.type === 'grid') {
      ws.gridWindows.delete(item.slot);
      item.ref.slot = newSlot;
      ws.gridWindows.set(newSlot, item.ref);
    } else {
      item.ref.slot = newSlot;
    }
  }
  return { ok: true, moved, overflow: 0 };
}

// need 個の窓がちょうど収まるグリッド形状 (cols × rows) を選ぶ。
// All Snap の「窓数をターミナル数に自動で合わせる」用 (拡張も縮小もする)。
//
// **方針: 今の行数 (keepRows) を維持して列数だけ合わせる** (ユーザー判断 2026-07-29)。
// 1行で使っている人は1行のまま、2行の人は2行のまま列だけ増減する。
// 「セルが正方形に近い形を自動で選ぶ」案は却下 — 1行運用が習慣だと毎回
// 右パネルで戻す羽目になり、自動化した意味が消えるため。何行がいいかは
// 好みであって計算で決まるものではない、というのが結論。
//
// 行数を曲げるのは次の2ケースだけ:
//   - 行がまるごと空く形にはしない (rows=3 に4窓 → 2x2 に落とす)
//   - 列が maxCols を超える = セルが細くなりすぎるときだけ行方向に逃がす
// need が maxCols*maxRows を超える場合は上限形状を返す
// (収まらない分の扱い = skipped は呼び出し側の責務)。
function fitGridDims(need, { maxCols = 20, maxRows = 20, keepRows = 1 } = {}) {
  if (!Number.isFinite(need) || need < 1) return { cols: 1, rows: 1 };
  let rows = Math.max(1, Math.min(Math.floor(keepRows) || 1, maxRows));
  let cols = Math.ceil(need / rows);
  while (rows > 1 && cols * (rows - 1) >= need) {
    rows--;
    cols = Math.ceil(need / rows);
  }
  if (cols > maxCols) {
    rows = Math.min(maxRows, Math.ceil(need / maxCols));
    cols = Math.min(maxCols, Math.ceil(need / rows));
  }
  return { cols, rows };
}

// グリッド領域 area (= getGridArea(ws) の戻り値) の中で slot が占める矩形を返す。
// area を引数で受けることで BrowserWindow 依存を呼び出し側に押し出してある。
// main.js の getSlotBounds は「getGridArea + この関数」の薄いラッパ。
function computeSlotBounds(area, ws, slot) {
  if (!area) return null;

  // ── Tab モード: 全スロットを同じ全画面位置に配置、AX raise でアクティブを前面に ──
  // オフスクリーンパーキング不可（CGWindowList の OnScreenOnly から消える → unsnap 誤発火）
  if (ws.viewMode === 'tab') {
    return { x: area.x, y: area.y, width: area.width, height: area.height };
  }

  // ── Grid モード: 通常のグリッドレイアウト ──
  // gap/padding は workspace.html の .gp-grid-container と一致させる
  // CSS: gap:8px, padding: 4px 8px 8px (top=4, right=8, bottom=8, left=8)
  const cols = ws.gridCols, rows = ws.gridRows;
  const gap = 8, padX = 8, padTop = 4, padBottom = 8;

  const colRatios = (ws.colRatios && ws.colRatios.length === cols) ? ws.colRatios : Array(cols).fill(1/cols);
  const rowRatios = (ws.rowRatios && ws.rowRatios.length === rows) ? ws.rowRatios : Array(rows).fill(1/rows);

  const innerW = area.width  - padX * 2 - gap * (cols - 1);
  const innerH = area.height - padTop - padBottom - gap * (rows - 1);

  // ── 柔軟グリッド: slotLayout がある場合は colSpan/rowSpan を考慮 ──
  let cellCol, cellRow, cellColSpan, cellRowSpan;
  if (ws.slotLayout) {
    const cell = ws.slotLayout.find(c => c.id === slot);
    if (!cell) return null;
    cellCol = cell.col; cellRow = cell.row;
    cellColSpan = cell.colSpan; cellRowSpan = cell.rowSpan;
  } else {
    cellCol = slot % cols; cellRow = Math.floor(slot / cols);
    cellColSpan = 1; cellRowSpan = 1;
  }

  let xOff = 0, yOff = 0;
  for (let i = 0; i < cellCol; i++) xOff += innerW * colRatios[i] + gap;
  for (let i = 0; i < cellRow; i++) yOff += innerH * rowRatios[i] + gap;

  let w = 0, h = 0;
  for (let i = 0; i < cellColSpan; i++) w += innerW * colRatios[cellCol + i] + (i > 0 ? gap : 0);
  for (let i = 0; i < cellRowSpan; i++) h += innerH * rowRatios[cellRow + i] + (i > 0 ? gap : 0);

  // #8: 端を丸めて幅 = 右端 - 左端 とする(各セルの幅を個別に round すると累積誤差で
  // 右端/下端に余白が出る)。最終列/行の右端は area の端(padding 内)にちょうど揃う。
  const x  = Math.round(area.x + padX + xOff);
  const y  = Math.round(area.y + padTop + yOff);
  const x2 = Math.round(area.x + padX + xOff + w);
  const y2 = Math.round(area.y + padTop + yOff + h);
  return { x, y, width: x2 - x, height: y2 - y };
}

module.exports = { occupiedSlots, validSlotIdSet, nextFreeSlot, compactSlots, fitGridDims, computeSlotBounds };
