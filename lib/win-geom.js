// lib/win-geom.js — Windows のウィンドウ座標変換 (純粋ロジック)
//
// win-helper.js の moveWindows から算術部分だけを切り出したもの。
// 目的は「mac 上で DPI 200% の座標計算を検証できるようにする」こと —
// 実機 Windows がないと再現できなかった不具合を単体テストで潰せるようにする。
// koffi / Win32 には一切依存しない。

// Electron screen API は DIP を返し、Win32 SetWindowPos は物理ピクセルを取る。
// さらに DWM の不可視な縁 (border) の分だけ「見える窓の縁」がずれるので、
// DWMWA_EXTENDED_FRAME_BOUNDS との差分 border で補正する。
//
// c           : { x, y, width, height }  — DIP 座標の要求値
// border      : { l, t, r, b }           — frameBorder(hWnd) の戻り値 (物理px)
// dpiScale    : number                   — 例 200% なら 2
// positionOnly: true なら SWP_NOSIZE 前提でサイズを算出しない (cx/cy は 0)
function computeWinBounds(c, border, dpiScale, positionOnly) {
  const b = border || { l: 0, t: 0, r: 0, b: 0 };
  const s = (dpiScale && dpiScale > 0) ? dpiScale : 1;
  const x = Math.round(c.x * s) - b.l;
  const y = Math.round(c.y * s) - b.t;
  if (positionOnly) return { x, y, cx: 0, cy: 0 };
  return {
    x, y,
    cx: Math.round((c.width  || 0) * s) + b.l + b.r,
    cy: Math.round((c.height || 0) * s) + b.t + b.b,
  };
}

// ── Per-monitor DPI (issue #43-4) ──
// Electron の display.nativeOrigin (物理px 原点) + bounds (DIP) + scaleFactor から
// DIP 矩形を「その矩形が乗るモニタ」のスケールで物理pxへ変換する。
// displays: [{ dipX, dipY, dipW, dipH, physX, physY, scale }] (main.js が注入)
//
// Windows の仮想スクリーン座標は物理px で、モニタごとに DIP↔物理 の対応が変わる。
// 単一スケール (primary) しか使わないと、異 DPI のサブモニタで位置もサイズもずれる。
function pickDisplayForRect(c, displays) {
  if (!Array.isArray(displays) || !displays.length) return null;
  const cx = c.x + (c.width || 0) / 2, cy = c.y + (c.height || 0) / 2;
  let best = null, bestOverlap = -1;
  for (const d of displays) {
    if (cx >= d.dipX && cx < d.dipX + d.dipW && cy >= d.dipY && cy < d.dipY + d.dipH) return d;
    // 中心がどのモニタ上にも無い場合は重なり面積が最大のモニタへ
    const ox = Math.max(0, Math.min(c.x + (c.width || 0), d.dipX + d.dipW) - Math.max(c.x, d.dipX));
    const oy = Math.max(0, Math.min(c.y + (c.height || 0), d.dipY + d.dipH) - Math.max(c.y, d.dipY));
    if (ox * oy > bestOverlap) { bestOverlap = ox * oy; best = d; }
  }
  return best;
}

// computeWinBounds のモニタ別スケール版。displays が無い/引けない場合は
// 従来の単一スケール (fallbackScale) へフォールバックする。
function computeWinBoundsMulti(c, border, displays, fallbackScale, positionOnly) {
  const d = pickDisplayForRect(c, displays);
  if (!d) return computeWinBounds(c, border, fallbackScale, positionOnly);
  const b = border || { l: 0, t: 0, r: 0, b: 0 };
  const x = d.physX + Math.round((c.x - d.dipX) * d.scale) - b.l;
  const y = d.physY + Math.round((c.y - d.dipY) * d.scale) - b.t;
  if (positionOnly) return { x, y, cx: 0, cy: 0 };
  return {
    x, y,
    cx: Math.round((c.width  || 0) * d.scale) + b.l + b.r,
    cy: Math.round((c.height || 0) * d.scale) + b.t + b.b,
  };
}

// SetWindowPos 後の実測 RECT (物理px) と要求を比べ、サイズのクランプを検出する。
// Windows Terminal / cmd 等は WM_GETMINMAXINFO の最小サイズと文字セル量子化で
// 要求より大きいサイズに切り上げられることがある (issue #43)。
//
// want       : computeWinBounds(Multi) の戻り値 (SetWindowPos に渡した物理px)
// actualRect : GetWindowRect の戻り値 { left, top, right, bottom } (物理px, 不可視縁込み)
// tolPx      : 許容差 (物理px)。文字セル量子化 (〜十数px) は「収まらない」とは言わない。
// 戻り値: null (許容内) or { dw, dh } — 要求を超えた物理px (負は 0 に丸める)
function assessMoveResult(want, actualRect, tolPx = 20) {
  const aw = actualRect.right - actualRect.left;
  const ah = actualRect.bottom - actualRect.top;
  const dw = Math.max(0, aw - want.cx);
  const dh = Math.max(0, ah - want.cy);
  if (dw <= tolPx && dh <= tolPx) return null;
  return { dw, dh };
}

// クランプされた窓をスロット内で中央寄せするための position-only 再配置座標 (物理px)。
// 素直に置くと超過分が右下に全部はみ出して隣スロットを覆うため、左右 (上下) に
// 半分ずつ振り分けてはみ出しを均す。
function recenterClamped(want, actualRect) {
  const aw = actualRect.right - actualRect.left;
  const ah = actualRect.bottom - actualRect.top;
  return {
    x: want.x - Math.round(Math.max(0, aw - want.cx) / 2),
    y: want.y - Math.round(Math.max(0, ah - want.cy) / 2),
  };
}

module.exports = { computeWinBounds, computeWinBoundsMulti, pickDisplayForRect, assessMoveResult, recenterClamped };
