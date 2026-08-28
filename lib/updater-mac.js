// lib/updater-mac.js — mac 自動アップデート (GitHub Releases + ditto/xattr、署名不要)
//
// なぜ Windows と別実装なのか:
//   mac 版 TiN は未署名なので Squirrel.Mac が使えず、electron-updater の経路に乗れない。
//   代わりに GitHub Releases API を直接叩いて mac zip を取り、`ditto` で
//   /Applications/TiN.app を丸ごと差し替え、`xattr -rd com.apple.quarantine` で
//   Gatekeeper の隔離属性を落とす (AtelierX の updateManager.cjs と同じ手口)。
//   feed メタファイル (latest-mac.yml) は不要。
//
// lib/updater.js (Windows/electron-updater) には手を入れず、darwin のときだけ
// こちらへ分岐する。**レンダラーから見た振る舞いは Windows と同一** — 同じ
// 'update-status' イベント (checking/available/downloading/downloaded/error) を送り、
// 同じ 'update-install-now' / 'update-check-now' を受ける。workspace.html は無改造。
//
// Windows との意図的な違い:
//   - 終了時の自動インストールはしない。アプリ本体を差し替える操作なので、
//     ユーザーが「今すぐ再起動」を押したときだけ実行する。押さなければ次回起動時に再提示。
//   - Release に mac zip が無い場合は警告ログのみで UI を出さない (誤って
//     「ダウンロード中」と言わないため)。CI の mac ジョブが zip を吐くのが前提。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GITHUB_OWNER = 'lutelute';
const GITHUB_REPO = 'TerminalIN';
const SIX_HOURS = 6 * 60 * 60 * 1000;
const MAX_REDIRECTS = 10;

// ─────────────────────────────────────────────────────────────
// 純粋ロジック (electron に依存しない = test/updater-mac.test.js から直接叩ける)
// ─────────────────────────────────────────────────────────────

// semver 比較: latest が current より新しければ true。
// 文字列比較だと "1.10.0" < "1.9.0" になってしまうので桁ごとに数値比較する。
function isNewer(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Release の assets から mac 用 zip を選ぶ (例 TiN-1.15.0-arm64-mac.zip)。
// 見つからなければ null。win 用の .exe や blockmap を拾わないこと。
function selectMacAsset(release) {
  const assets = (release && release.assets) || [];
  return assets.find((a) => a && typeof a.name === 'string'
    && a.name.endsWith('.zip') && /mac/i.test(a.name)) || null;
}

// 実行中アプリの exe パス (/Applications/TiN.app/Contents/MacOS/TiN) から .app の根を得る。
// 差し替え先を /Applications 決め打ちにすると、別の場所から起動している場合に
// 見当違いの .app を壊すため、必ず「今動いている自分」の位置を基準にする。
// .app の中に居ない (dev 実行など) なら null。
function appRootFromExecPath(execPath) {
  if (!execPath) return null;
  const marker = '.app/';
  const i = String(execPath).indexOf(marker);
  if (i === -1) return null;
  return execPath.slice(0, i + marker.length - 1);
}

// GitHub の release JSON を、更新判定に必要な形へ畳む。
// HTTP を挟まないのでテストできる。asset が無い場合は downloadUrl:null になり、
// 呼び出し側はログだけ出して黙る (UI は出さない)。
function evaluateRelease(release, currentVersion) {
  const latest = String((release && release.tag_name) || '').replace(/^v/, '');
  if (!latest || !isNewer(latest, currentVersion)) {
    return { available: false, version: currentVersion };
  }
  const asset = selectMacAsset(release);
  return {
    available: true,
    version: latest,
    downloadUrl: asset ? asset.browser_download_url : null,
    releaseUrl: (release && release.html_url) || null,
  };
}

// ─────────────────────────────────────────────────────────────
// I/O (electron の require は遅延させる — node --test でこのファイルを読めるように)
// ─────────────────────────────────────────────────────────────

function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: { 'User-Agent': 'TiN-Updater', Accept: 'application/vnd.github.v3+json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve({ error: `HTTP ${res.statusCode}` }); return; }
        try { resolve({ release: JSON.parse(data) }); }
        catch (e) { resolve({ error: e.message }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

// GitHub の実体は S3 へのリダイレクトなので追跡する。
function downloadTo(url, filePath, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) { reject(new Error('リダイレクトが多すぎます')); return; }
    const u = new URL(url);
    const proto = u.protocol === 'https:' ? https : http;
    const req = proto.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'TiN-Updater' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        downloadTo(res.headers.location, filePath, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      let got = 0;
      const out = fs.createWriteStream(filePath);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress && total > 0) onProgress(Math.round((got / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(filePath); });
      out.on('error', (e) => { fs.unlink(filePath, () => {}); reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('ダウンロードタイムアウト')); });
    req.end();
  });
}

// zip を展開して destApp を新版に差し替える。
//
// 「先に消してからコピー」にしない。ditto のコピーは 200MB 級で数秒かかり、その間に
// 失敗するとアプリが消えたまま残る (= 手で入れ直すまで起動できない)。
// 隣に完成品を作ってから rename 2回で入れ替え、アプリが存在しない時間を最小にする。
// 差し替えに失敗したら旧版を戻す。
//
// ditto を使うのは拡張属性を保持するため (cp -R だと壊れる)。
function installFromZip(zipPath, updatesDir, destApp) {
  if (!destApp) return { ok: false, error: '差し替え先の .app を特定できません' };
  const extractDir = path.join(updatesDir, 'extract');
  const staged = destApp + '.tin-new';
  const backup = destApp + '.tin-old';
  const sh = (cmd, opts) => execSync(cmd, { timeout: 120000, ...opts });

  try {
    // 1. 前回の残骸を掃除してから展開
    sh(`rm -rf "${extractDir}" "${staged}" "${backup}"`);
    fs.mkdirSync(extractDir, { recursive: true });
    sh(`ditto -x -k "${zipPath}" "${extractDir}"`, { timeout: 60000 });

    const appFile = fs.readdirSync(extractDir).find((f) => f.endsWith('.app'));
    if (!appFile) { sh(`rm -rf "${extractDir}"`); return { ok: false, error: 'zip の中に .app が見つかりません' }; }

    // 2. まず「隣」に完成品を作る。ここまでで失敗しても現行アプリは無傷。
    sh(`ditto "${path.join(extractDir, appFile)}" "${staged}"`);
    // 未署名アプリの Gatekeeper 対策。属性が無いと xattr は非0で返るので握りつぶす。
    try { sh(`xattr -rd com.apple.quarantine "${staged}" 2>/dev/null`); } catch {}

    // 3. 入れ替えは rename 2回だけ (同一ディレクトリ = 同一 fs なので瞬時)
    const hadOld = fs.existsSync(destApp);
    if (hadOld) sh(`mv "${destApp}" "${backup}"`);
    try {
      sh(`mv "${staged}" "${destApp}"`);
    } catch (e) {
      // ここで戻せないと本当にアプリが無くなる
      if (hadOld && !fs.existsSync(destApp)) sh(`mv "${backup}" "${destApp}"`);
      throw e;
    }

    // 4. 後片付け。旧版の削除に失敗しても更新自体は成立しているので致命ではない
    //    (残っても次回 1. が消す)。
    try { sh(`rm -rf "${extractDir}" "${backup}"`); } catch {}
    return { ok: true, installedTo: destApp };
  } catch (e) {
    try { sh(`rm -rf "${extractDir}" "${staged}"`); } catch {}
    // dest が無く backup が残っている = 3. の途中で落ちた → 戻す
    try {
      if (!fs.existsSync(destApp) && fs.existsSync(backup)) sh(`mv "${backup}" "${destApp}"`);
    } catch {}
    const detail = (e && e.stderr && e.stderr.toString && e.stderr.toString()) || (e && e.message) || String(e);
    return { ok: false, error: detail };
  }
}

// ─────────────────────────────────────────────────────────────
// 起動
// ─────────────────────────────────────────────────────────────

function initMacAutoUpdate(getWin) {
  const { app, ipcMain } = require('electron');
  if (!app.isPackaged || process.platform !== 'darwin') return;

  const updatesDir = path.join(app.getPath('userData'), 'updates');
  const send = (state, extra) => {
    try {
      const w = getWin && getWin();
      if (w && !w.isDestroyed()) w.webContents.send('update-status', { state, ...extra });
    } catch {}
  };

  let downloadedZip = null;   // インストール待ちの zip
  let busy = false;           // 確認/DL の多重起動を防ぐ

  const check = async () => {
    if (busy || downloadedZip) return;   // DL 済みなら再確認しない (バナーが出ている)
    busy = true;
    try {
      send('checking');
      const { release, error } = await fetchLatestRelease();
      if (error) { console.warn('[tin] mac update check failed:', error); send('error', { message: error }); return; }

      const info = evaluateRelease(release, app.getVersion());
      if (!info.available) { send('none'); return; }
      if (!info.downloadUrl) {
        // CI の mac ジョブが zip を出していないケース。嘘の進捗を出さずログだけ残す。
        console.warn(`[tin] mac update v${info.version} はあるが mac zip アセットが無い — 自動更新をスキップ`);
        return;
      }

      send('available', { version: info.version });
      fs.mkdirSync(updatesDir, { recursive: true });
      const dest = path.join(updatesDir, path.basename(new URL(info.downloadUrl).pathname));
      await downloadTo(info.downloadUrl, dest, (percent) => send('downloading', { percent }));
      downloadedZip = dest;
      send('downloaded', { version: info.version });
    } catch (e) {
      console.warn('[tin] mac update error:', e && e.message);
      send('error', { message: String((e && e.message) || e) });
    } finally {
      busy = false;
    }
  };

  // 起動直後は少し遅延させて初回描画を妨げない (Windows 版と同じ 8 秒)
  setTimeout(() => { check(); }, 8000);
  const timer = setInterval(() => { check(); }, SIX_HOURS);
  app.on('before-quit', () => clearInterval(timer));

  // レンダラーからの「今すぐ再起動」。Windows と違い、押されたときだけ差し替える。
  ipcMain.handle('update-install-now', () => {
    if (!downloadedZip || !fs.existsSync(downloadedZip)) {
      send('error', { message: 'ダウンロード済みの更新が見つかりません' });
      return { ok: false };
    }
    // 差し替えるのは「今動いている自分」。/Applications 決め打ちにはしない。
    const destApp = appRootFromExecPath(app.getPath('exe'));
    const r = installFromZip(downloadedZip, updatesDir, destApp);
    if (!r.ok) {
      console.warn('[tin] mac update install failed:', r.error);
      send('error', { message: r.error });
      return { ok: false, error: r.error };
    }
    try { fs.unlinkSync(downloadedZip); } catch {}
    downloadedZip = null;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });

  ipcMain.handle('update-check-now', () => { check(); return true; });
}

module.exports = { initMacAutoUpdate, isNewer, selectMacAsset, evaluateRelease, appRootFromExecPath, installFromZip };
