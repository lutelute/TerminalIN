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

module.exports = { computeWinBounds };
