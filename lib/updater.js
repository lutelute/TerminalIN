// lib/updater.js — Windows 自動アップデート (electron-updater + GitHub Releases)
//
// 挙動: 起動時 + 6時間ごとに更新を確認 → 新版があればバックグラウンドで自動ダウンロード →
// ダウンロード完了でレンダラーへ通知 (小さなトースト) + アプリ終了時に自動インストール。
// ユーザー操作はほぼ不要 (「今すぐ再起動して更新」も選べる)。
//
// 安全策:
//  - パッケージ版 (app.isPackaged) かつ Windows のみ有効。dev / mac(未署名 dir/zip)では no-op。
//  - electron-updater が require できない / publish 情報が無い環境でも握りつぶして起動を妨げない。
//  - publish 設定 (provider: github, owner/repo) は package.json の build.publish から
//    electron-builder が app-update.yml に焼き込む。これが無いと checkForUpdates は静かに失敗する。

const { app, ipcMain } = require('electron');

const SIX_HOURS = 6 * 60 * 60 * 1000;

function initAutoUpdate(getWin) {
  // dev 実行や mac は対象外 (mac は署名が無く electron-updater が動かないため)。
  if (!app.isPackaged || process.platform !== 'win32') return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.warn('[tin] electron-updater 未導入 — 自動更新は無効:', e && e.message);
    return;
  }

  autoUpdater.autoDownload = true;          // 新版を自動でバックグラウンド DL
  autoUpdater.autoInstallOnAppQuit = true;  // 終了時に自動インストール
  autoUpdater.allowDowngrade = false;

  const send = (state, extra) => {
    try {
      const w = getWin && getWin();
      if (w && !w.isDestroyed()) w.webContents.send('update-status', { state, ...extra });
    } catch {}
  };

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => send('available', { version: info && info.version }));
  autoUpdater.on('update-not-available', () => send('none'));
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p && p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => send('downloaded', { version: info && info.version }));
  autoUpdater.on('error', (err) => {
    console.warn('[tin] auto-update error:', err && err.message);
    send('error', { message: String((err && err.message) || err) });
  });

  const check = () => { autoUpdater.checkForUpdates().catch(() => {}); };

  // 起動直後は少し遅延させて初回描画を妨げない
  setTimeout(check, 8000);
  const timer = setInterval(check, SIX_HOURS);
  app.on('before-quit', () => clearInterval(timer));

  // レンダラーからの「今すぐ更新」/「再確認」
  ipcMain.handle('update-install-now', () => {
    try { autoUpdater.quitAndInstall(); } catch (e) { console.warn('[tin] quitAndInstall failed:', e && e.message); }
  });
  ipcMain.handle('update-check-now', () => { check(); return true; });
}

module.exports = { initAutoUpdate };
