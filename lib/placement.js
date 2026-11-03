'use strict';
// 窓を置いたあとの「確かめる」部分 (mac)。AX で位置と大きさを書いたあとに読み戻した実際の枠を、
// 狙った枠と比べて分類し、書き直すかどうかと、TiN の画面に出す印 (はみ出し) を決める。
//
// 実測 (2026-11-04, macOS 26.7):
//   - 多くのアプリには「これより小さくできない」大きさがある。書くと AX はエラーを返さず、
//     その大きさで止まる (Chrome 500×375 / Word 475×412 / PowerPoint 420×492 / Excel 500×331 /
//     VS Code 400×270 / Finder 幅 514)。→ 'clamped'。マスの左上に合わせたまま、はみ出しの印を出す
//   - ターミナルは文字の升目に合わせて 1 升ぶん小さく/大きくなる (450×350 → 447×357)。→ 誤差として許す
//   - Finder は AXEnhancedUserInterface が有効だと大きさを無視し位置も崩れる (native 側で書く間だけ切る)。
//     それでもずれたら 'misplaced' として 1 回だけ書き直す
// Windows は win-helper.js が同じ考え方で getMoveIssues() を出している (#43)。形を合わせる。

const POS_TOL = 3;          // 位置の許し (px)
// 大きさの許し: ターミナルは文字の升目に合わせて丸めるので、升目 1 つぶん (幅 ~7-12・高さ ~16-24) の
// 増減は誤差として許す (450×350 → 447×357)。アプリの下限ははるかに大きく外れる (Chrome は +200/+125)
const CELL_W = 16, CELL_H = 24;
const SIZE_TOL = CELL_W;    // 互換のため (記録の判定に使う)

// target: { x, y, width, height } / actual: { found, x, y, width, height } (moveWindows の detail)
// 戻り値: { code: 'ok' | 'clamped' | 'misplaced' | 'short' | 'missing', dx, dy, dw, dh }
//   clamped:   狙いより大きい (アプリの下限)。位置は合っている
//   misplaced: 位置がずれた
//   short:     狙いより升目 1 つ以上小さい (広げられなかった)
function classifyPlacement(target, actual) {
  if (!actual || actual.found === false || !(actual.width > 0) || !(actual.height > 0)) return { code: 'missing' };
  const dx = Math.round(actual.x - target.x), dy = Math.round(actual.y - target.y);
  const dw = Math.round(actual.width - target.width), dh = Math.round(actual.height - target.height);
  const r = { dx, dy, dw, dh };
  if (Math.abs(dx) > POS_TOL || Math.abs(dy) > POS_TOL) return { code: 'misplaced', ...r };
  if (dw > CELL_W || dh > CELL_H) return { code: 'clamped', ...r };
  if (dw < -CELL_W || dh < -CELL_H) return { code: 'short', ...r };
  return { code: 'ok', ...r };
}

// 書き直すべき窓か (1 回だけ)。clamped は書き直しても変わらない
const needsRetry = (c) => c.code === 'misplaced' || c.code === 'short';

// 窓ごとの「はみ出し」の記録と、アプリごとの下限 (いちばん大きく止まった大きさ) の記録。
// get(wn) は Windows の getMoveIssues() と同じ形 { windowNumber, code: 'clamped', minWidth, minHeight }
function createPlacementIssues() {
  const issues = new Map();     // wn → { windowNumber, code, app, minWidth, minHeight }
  const appMin = new Map();     // app → { width, height }
  return {
    record(wn, app, target, actual, c) {
      if (c.code === 'clamped') {
        const minWidth = c.dw > CELL_W ? Math.round(actual.width) : 0;
        const minHeight = c.dh > CELL_H ? Math.round(actual.height) : 0;
        issues.set(wn, { windowNumber: wn, code: 'clamped', app, minWidth, minHeight });
        if (app) {
          const m = appMin.get(app) || { width: 0, height: 0 };
          appMin.set(app, { width: Math.max(m.width, minWidth), height: Math.max(m.height, minHeight) });
        }
      } else if (c.code === 'ok') {
        issues.delete(wn);
      }
      // misplaced / short / missing は記録を変えない (書き直しの結果で決める)
    },
    get: (wn) => issues.get(wn) || null,
    all: () => [...issues.values()],
    forget: (wn) => issues.delete(wn),
    appMinSize: (app) => appMin.get(app) || null,
  };
}

module.exports = { classifyPlacement, needsRetry, createPlacementIssues, POS_TOL, SIZE_TOL };
