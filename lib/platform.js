'use strict';
// プラットフォーム差分を集約する軽量モジュール。
// main.js / auto-snap.js から require して OS 依存(シェル・パス・ウィンドウ chrome)を吸収する。
//
// スコープ: 最小版(Windows 起動 + 内蔵ターミナル + グリッド + REST API)。
// 外部ウィンドウ操作(snap/move/raise)の抽象化は第2マイルストーン(Win32 native addon)で
// このモジュールに windowManager インターフェースとして拡張する。それまで Windows では
// ax_helper.node が存在せず main.js の `if (axHelper)` ガードにより自動 no-op になる。
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// 内蔵ターミナル(node-pty)で起動するデフォルトシェル。TIN_SHELL で明示上書き可能。
//   Windows: PowerShell を優先(ConPTY と相性が良い)。cmd を使いたい場合は TIN_SHELL=cmd.exe。
//   mac/linux: ログインシェル($SHELL)、無ければ zsh。
function defaultShell() {
  if (isWin) {
    return process.env.TIN_SHELL || 'powershell.exe';
  }
  return process.env.TIN_SHELL || process.env.SHELL || '/bin/zsh';
}

// node-pty.spawn に渡す OS 差分オプション。Windows は ConPTY を明示有効化(Win10 1809+)。
function ptyOptions() {
  return isWin ? { useConpty: true } : {};
}

// ホームディレクトリ。HOME / USERPROFILE 差を os.homedir() で吸収。
function homeDir() {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || '/';
}

// 一時ディレクトリ。/tmp の代替(Windows は %TEMP%)。
function tmpDir() {
  return os.tmpdir();
}

// BrowserWindow の OS 別 chrome オプション。
// macOS: 従来挙動を完全維持(hiddenInset + trafficLight + transparent)。
// Windows: transparent / hiddenInset は最大化・Aero スナップ・描画と相性が悪く UI を壊すため、
//          hidden + titleBarOverlay(OS コントロールを右上に表示) + 非透過にする。
//          workspace.html に閉じるボタンが無く mac の trafficLight に依存しているため、
//          titleBarOverlay でウィンドウを閉じられる状態を必ず確保する。
//          height は main.js の TITLEBAR_H(36) と一致させる。
function browserWindowChrome() {
  if (isWin) {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#1e1e1e', symbolColor: '#cccccc', height: 36 },
      backgroundColor: '#1e1e1e',
    };
  }
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    transparent: true,
    backgroundColor: '#00000000',
  };
}

module.exports = {
  isWin, isMac, isLinux,
  defaultShell, ptyOptions, homeDir, tmpDir, browserWindowChrome,
};
