// TiN Bridge Plugin for AtelierX
//
// AtelierX と TerminalIN (TiN) を疎結合に連携させるプラグイン。
// - TiN の snapped.json / info.json を監視して、AtelierX のカードに装飾を適用
// - AtelierX のカードから tin:// URL scheme で TiN を操作
// - A/B 独立性保証: TiN 未起動時は静かに無効化
//
// 契約仕様: TerminalIN/docs/PROTOCOL.md

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shell } = require('electron');

// ── 定数 ──
const TIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'TiN');
const INFO_FILE = path.join(TIN_DIR, 'info.json');
const SNAPPED_FILE = path.join(TIN_DIR, 'snapped.json');
const POLL_INTERVAL = 500;
const INFO_STALE_MS = 15 * 60 * 1000; // 15分以上更新がない info.json は stale とみなす
const SUPPORTED_PROTOCOLS = new Set(['1.0']);

// ── 状態 ──
let api;
let pollTimer = null;
let watchHandleSnapped = null;
let watchHandleInfo = null;
let lastSnappedHash = '';
let tinInfo = null;            // { protocol, version, capabilities, ... } or null
let tinCapabilities = new Set();
let registeredActionIds = [];  // unregister 用

// macOS はロケールによって CGWindowList のアプリ名が変わる
// AtelierX は AppleScript で英語名 "Terminal" を取得、TiN は CGWindowList で
// "ターミナル" を取得するため、マッチング前に正規化する
const APP_NAME_MAP = {
  'ターミナル': 'Terminal',
  'ファインダー': 'Finder',
};
function normalizeAppName(name) {
  if (!name) return name;
  return APP_NAME_MAP[name] || name;
}

// ── ユーティリティ ──

function safeReadJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    if (api) api.error('safeReadJSON failed:', filePath, e.message);
    return null;
  }
}

function isTinProcessAlive(info) {
  if (!info || typeof info !== 'object') return false;
  if (!SUPPORTED_PROTOCOLS.has(info.protocol)) return false;
  if (typeof info.updatedAt !== 'number') return false;
  // updatedAt が極端に古い場合は stale (TiN がクラッシュして info.json が残った)
  return Date.now() - info.updatedAt < INFO_STALE_MS;
}

// TiN の存在検出 + capability 更新
function detectTin() {
  const info = safeReadJSON(INFO_FILE);
  if (isTinProcessAlive(info)) {
    tinInfo = info;
    tinCapabilities = new Set(info.capabilities || []);
    return true;
  }
  tinInfo = null;
  tinCapabilities = new Set();
  return false;
}

// マッチングキー構築: AtelierX WindowRef を snapped.json の識別子に近づける
function buildMatchKeys(windowRef) {
  const keys = [];
  if (!windowRef || !windowRef.app) return keys;
  const app = windowRef.app;
  const id = windowRef.id || '';
  const name = windowRef.name || '';

  // 第1候補: app + id (数値IDが windowNumber と一致する場合に効く)
  if (/^\d+$/.test(id)) {
    keys.push(`n:${app}:${id}`);
  }
  // 第2候補: app + name (完全一致)
  if (name) keys.push(`t:${app}:${name}`);
  // 第3候補: app + name 前方40文字一致
  if (name.length > 0) {
    const prefix = name.slice(0, Math.min(40, name.length));
    keys.push(`p:${app}:${prefix}`);
  }
  return keys;
}

function buildSnappedLookup(snapped) {
  // snapped.json の各エントリに対して、マッチングキーを逆引き可能にする
  // app 名は normalize (ターミナル → Terminal) して AtelierX カード側と揃える
  const byNumKey = new Set();   // "normalizedApp:windowNumber"
  const byFullTitle = new Set(); // "normalizedApp:title"
  const byPrefix = [];           // { app: normalized, prefix }
  for (const w of (snapped?.snappedWindows || [])) {
    const app = normalizeAppName(w.app);
    if (w.windowNumber) byNumKey.add(`${app}:${w.windowNumber}`);
    if (w.title) byFullTitle.add(`${app}:${w.title}`);
    if (w.title) byPrefix.push({ app, prefix: w.title.slice(0, Math.min(40, w.title.length)) });
  }
  return { byNumKey, byFullTitle, byPrefix };
}

function cardHasSnappedWindow(card, lookup) {
  if (!card || !Array.isArray(card.windows)) {
    // 旧形式 (単一ウィンドウ) 対応: card.windowApp / windowName / windowId を直接見る
    if (card && card.windowApp) {
      const synthRef = { app: card.windowApp, id: card.windowId || '', name: card.windowName || '' };
      return cardHasSnappedWindow({ windows: [synthRef] }, lookup);
    }
    return null;
  }
  for (const w of card.windows) {
    if (!w || !w.app) continue;
    // app 名を normalize (AtelierX 側は "Terminal" 英語を使う)
    const app = normalizeAppName(w.app);
    const id = w.id || '';
    const name = w.name || '';
    // 第1候補: app + 数値ID (AtelierX の getAppWindows は `id of w` で numericId を返す)
    if (/^\d+$/.test(id) && lookup.byNumKey.has(`${app}:${id}`)) {
      return w;
    }
    // 第2候補: app + title 完全一致
    if (name && lookup.byFullTitle.has(`${app}:${name}`)) {
      return w;
    }
    // 第3候補: app + title 前方一致
    if (name) {
      for (const p of lookup.byPrefix) {
        if (p.app !== app) continue;
        if (name.startsWith(p.prefix)) return w;
      }
    }
  }
  return null;
}

// ── 同期ロジック ──

function syncDecorators() {
  if (!api) return;

  const snapped = safeReadJSON(SNAPPED_FILE) || { snappedWindows: [] };
  const hash = JSON.stringify(snapped.snappedWindows);
  if (hash === lastSnappedHash) return;
  lastSnappedHash = hash;

  const lookup = buildSnappedLookup(snapped);
  const cards = api.getAllCards();

  let matchedCount = 0;
  for (const card of cards) {
    const matched = cardHasSnappedWindow(card, lookup);
    if (matched) {
      api.setCardDecorator(card.id, {
        badge: '🔒 TiN',
        tooltip: `TiN管理中 (${matched.app})`,
        excludeFromGrid: true,
      });
      matchedCount++;
    } else {
      api.clearCardDecorator(card.id);
    }
  }

  // カードに紐付いていないウィンドウも Grid から除外するため、
  // window 単位の除外リストも登録する (setWindowExclusion が使える AtelierX v1.13.3+)
  if (typeof api.setWindowExclusion === 'function') {
    const excludeIds = [];
    for (const w of (snapped.snappedWindows || [])) {
      if (w.windowNumber) excludeIds.push(String(w.windowNumber));
    }
    api.setWindowExclusion(excludeIds);
  }

  if (matchedCount > 0 || (snapped.snappedWindows || []).length > 0) {
    api.log(`synced ${matchedCount} TiN-snapped cards, ${(snapped.snappedWindows || []).length} window exclusions`);
  }
}

// ── TiN コマンド送信 (URL scheme) ──

function openTinUrl(action, params = {}) {
  if (!detectTin()) {
    // TiN 未起動 — 何もしない (graceful)
    api?.log('openTinUrl: TiN not running, ignoring', action);
    return false;
  }
  const query = new URLSearchParams(params).toString();
  const url = `tin://${action}${query ? '?' + query : ''}`;
  try {
    shell.openExternal(url);
    return true;
  } catch (e) {
    api?.error('openExternal failed:', e.message);
    return false;
  }
}

// ── カードアクション登録 ──

function registerCardActions() {
  if (!api) return;
  registeredActionIds = [];

  if (tinCapabilities.has('raise')) {
    api.registerCardAction({
      id: 'tin-raise',
      label: 'TiN',
      title: 'TiNで前面化',
      position: 'card-header',
      handler: (_cardId, cardData) => {
        const w = cardData?.windows?.[0] || (cardData?.windowApp ? { app: cardData.windowApp, id: cardData.windowId, name: cardData.windowName } : null);
        if (!w || !w.app) {
          api.error('tin-raise: no window linked to card');
          return;
        }
        const params = { app: w.app };
        if (/^\d+$/.test(String(w.id || ''))) params.windowNumber = String(w.id);
        if (w.name) params.title = w.name;
        openTinUrl('raise', params);
      },
    });
    registeredActionIds.push('tin-raise');
  }

  if (tinCapabilities.has('workspace')) {
    api.registerCardAction({
      id: 'tin-workspace-focus',
      label: 'TiN Focus',
      title: 'TiNアクティブワークスペースを前面化',
      position: 'card-footer',
      handler: () => openTinUrl('workspace/focus'),
    });
    registeredActionIds.push('tin-workspace-focus');
  }


  api.log(`registered ${registeredActionIds.length} TiN actions`);
}

// ── ライフサイクル ──

module.exports = {
  onload(_api) {
    api = _api;
    api.log('TiN Bridge loading...');

    // TiN 検出 & capability 判定
    const tinAvailable = detectTin();
    if (tinAvailable) {
      api.log(`TiN detected: v${tinInfo.version}, capabilities: ${[...tinCapabilities].join(', ')}`);
      registerCardActions();
    } else {
      api.log('TiN not running or not installed. Plugin will stay inactive.');
    }

    // 初回同期 (TiN起動時のみ意味がある、未起動でも空 snapped なので安全)
    syncDecorators();

    // ファイル監視 (macOS の fs.watch は不安定な場合があるので try/catch)
    try {
      if (fs.existsSync(SNAPPED_FILE)) {
        watchHandleSnapped = fs.watch(SNAPPED_FILE, () => syncDecorators());
      }
    } catch (e) {
      api.log('fs.watch(snapped) failed, falling back to polling only');
    }
    try {
      if (fs.existsSync(INFO_FILE)) {
        watchHandleInfo = fs.watch(INFO_FILE, () => {
          const wasAvailable = !!tinInfo;
          const nowAvailable = detectTin();
          if (wasAvailable !== nowAvailable) {
            api.log(`TiN availability changed: ${wasAvailable} → ${nowAvailable}`);
            // capability 再登録
            for (const id of registeredActionIds) {
              try { api.unregisterCardAction(id); } catch {}
            }
            if (nowAvailable) registerCardActions();
          }
        });
      }
    } catch (e) {
      api.log('fs.watch(info) failed');
    }

    // ポーリング fallback (fs.watch が発火しないmacOS bug対策)
    pollTimer = setInterval(() => {
      // TiN 状態変化検出
      const wasAvailable = !!tinInfo;
      const nowAvailable = detectTin();
      if (wasAvailable !== nowAvailable) {
        api.log(`TiN availability changed (poll): ${wasAvailable} → ${nowAvailable}`);
        for (const id of registeredActionIds) {
          try { api.unregisterCardAction(id); } catch {}
        }
        if (nowAvailable) registerCardActions();
      }
      syncDecorators();
    }, POLL_INTERVAL);

    // カード変更購読 → 装飾を再評価
    api.onCardsChange(() => {
      // カードが変わるとマッチング結果が変わる可能性 → hash リセット
      lastSnappedHash = '';
      syncDecorators();
    });

    api.log('TiN Bridge loaded');
  },

  onunload() {
    if (watchHandleSnapped) { try { watchHandleSnapped.close(); } catch {} watchHandleSnapped = null; }
    if (watchHandleInfo) { try { watchHandleInfo.close(); } catch {} watchHandleInfo = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    // registerCardAction / setCardDecorator は pluginManager が自動クリアする
    api = null;
    tinInfo = null;
    tinCapabilities = new Set();
    registeredActionIds = [];
    lastSnappedHash = '';
  },
};
