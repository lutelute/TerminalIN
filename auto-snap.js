// auto-snap.js — LLM によるターミナル自動クラスタリング + snap
// 使用法: メニュー「Auto Snap」or Cmd+Shift+G でトリガー
const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');

const CONFIG_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(CONFIG_DIR, 'auto-snap.yml');
const HISTORY_FILE = path.join(CONFIG_DIR, 'snap-history.jsonl');

// ── Config ──
function getDefaultConfig() {
  return `# TiN Auto-Snap Configuration
# ターミナルウィンドウを自動グループ化するための設定

# Claude API Key (必須)
api_key: ""

# ユーザーコンテキスト — あなたの作業環境を説明すると精度が上がります
context: |
  # ここに自分の作業環境を記述してください。例:
  # 私は大学の研究室で電力系統の研究をしています。
  # サーバー管理、論文執筆、開発のターミナルを分けたい。

# 手動ルール — 特定のパターンを強制的にグループ化
rules:
  # - name: "サーバー"
  #   match: ["ssh", "pws-", "docker"]
  # - name: "開発"
  #   match: ["GitHub", "npm", "node"]

# グループ数の上限 (0 = LLM に任せる)
max_groups: 0

# grid レイアウト (各 workspace のデフォルト)
default_grid:
  cols: 2
  rows: 2
`;
}

function ensureConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, getDefaultConfig(), 'utf-8');
  }
}

function loadConfig() {
  ensureConfig();
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const config = { api_key: '', context: '', rules: [], max_groups: 0, default_grid: { cols: 2, rows: 2 } };
  // api_key: YAML設定 → .env ファイル → 環境変数の順で探す
  const keyMatch = raw.match(/^api_key:\s*"([^"]*)"/m);
  if (keyMatch && keyMatch[1]) {
    config.api_key = keyMatch[1];
  } else {
    // .env ファイルから読む
    const envFile = path.join(path.dirname(CONFIG_FILE), '..', '..', '..', 'Documents', 'GitHub', 'tool_dev_SGNB', 'TerminalIN', '.env');
    const envFile2 = path.join(require.main ? path.dirname(require.main.filename) : __dirname, '.env');
    for (const ef of [envFile2, envFile]) {
      try {
        if (fs.existsSync(ef)) {
          const envRaw = fs.readFileSync(ef, 'utf-8');
          const m = envRaw.match(/^ANTHROPIC_API_KEY=(.+)$/m);
          if (m) { config.api_key = m[1].trim().replace(/^["']|["']$/g, ''); break; }
        }
      } catch {}
    }
    // 保存済みキーファイル
    if (!config.api_key) {
      config.api_key = loadApiKey();
    }
    // 環境変数
    if (!config.api_key && process.env.ANTHROPIC_API_KEY) {
      config.api_key = process.env.ANTHROPIC_API_KEY;
    }
  }
  // context
  const ctxMatch = raw.match(/^context:\s*\|\n((?:\s+.*\n?)*)/m);
  if (ctxMatch) config.context = ctxMatch[1].replace(/^ {2}/gm, '').trim();
  // rules
  const rulesSection = raw.match(/^rules:\n((?:\s+.*\n?)*)/m);
  if (rulesSection) {
    const ruleBlocks = rulesSection[1].matchAll(/- name:\s*"([^"]*)"\n\s+match:\s*\[([^\]]*)\]/g);
    for (const m of ruleBlocks) {
      config.rules.push({
        name: m[1],
        match: m[2].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean),
      });
    }
  }
  // max_groups
  const mgMatch = raw.match(/^max_groups:\s*(\d+)/m);
  if (mgMatch) config.max_groups = parseInt(mgMatch[1]);
  // default_grid
  const colsMatch = raw.match(/cols:\s*(\d+)/);
  const rowsMatch = raw.match(/rows:\s*(\d+)/);
  if (colsMatch) config.default_grid.cols = parseInt(colsMatch[1]);
  if (rowsMatch) config.default_grid.rows = parseInt(rowsMatch[1]);
  return config;
}

// ── History (学習データ) ──
function appendHistory(entry) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {}
}

function loadRecentHistory(maxEntries = 20) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const lines = fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxEntries).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── API Key management ──
const API_KEY_FILE = path.join(CONFIG_DIR, '.api-key');

function loadApiKey() {
  try {
    if (fs.existsSync(API_KEY_FILE)) return fs.readFileSync(API_KEY_FILE, 'utf-8').trim();
  } catch {}
  return '';
}

function saveApiKey(key) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(API_KEY_FILE, key, { mode: 0o600 });
  } catch {}
}

async function promptForApiKey() {
  // まずコンソールを開く案内
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Auto Snap — API キー設定',
    message: 'Claude API キーが必要です',
    detail: '1. 「キーを取得」でコンソールを開く\n2. API キーを作成・コピー\n3. 「キーを入力」で貼り付け',
    buttons: ['キーを取得', 'キーを入力', 'キャンセル'],
    defaultId: 0,
  });
  if (response === 2) return null;
  if (response === 0) {
    shell.openExternal('https://console.anthropic.com/settings/keys');
    // 少し待ってから入力ダイアログ
    await new Promise(r => setTimeout(r, 1500));
  }
  // キー入力 (clipboard から)
  const { clipboard } = require('electron');
  const clipText = clipboard.readText().trim();
  const prefilled = clipText.startsWith('sk-ant-') ? clipText : '';

  // Electron にはテキスト入力ダイアログがないので、BrowserWindow で作る
  return new Promise((resolve) => {
    const { BrowserWindow } = require('electron');
    const w = new BrowserWindow({
      width: 480, height: 180, resizable: false,
      titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 },
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, sans-serif; padding: 40px 24px 20px; background: #fff; }
  h3 { font-size: 14px; margin-bottom: 12px; color: #333; }
  input { width: 100%; padding: 8px 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 6px; font-family: monospace; }
  input:focus { outline: none; border-color: #4a90d9; }
  .btns { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
  button { padding: 6px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #ccc; background: #f5f5f5; }
  button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
  button.primary:hover { background: #1d4ed8; }
</style></head><body>
  <h3>Anthropic API キー</h3>
  <input id="key" type="password" placeholder="sk-ant-..." value="${prefilled}" />
  <div class="btns">
    <button onclick="require('electron').ipcRenderer.send('api-key-result','')">キャンセル</button>
    <button class="primary" onclick="require('electron').ipcRenderer.send('api-key-result',document.getElementById('key').value.trim())">保存</button>
  </div>
  <script>
    const inp = document.getElementById('key');
    inp.focus(); inp.select();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); require('electron').ipcRenderer.send('api-key-result', inp.value.trim()); }});
  </script>
</body></html>`)}`);
    const { ipcMain } = require('electron');
    const handler = (_e, key) => {
      ipcMain.removeListener('api-key-result', handler);
      w.close();
      resolve(key || null);
    };
    ipcMain.on('api-key-result', handler);
    w.on('closed', () => {
      ipcMain.removeListener('api-key-result', handler);
      resolve(null);
    });
  });
}

// ── LLM Clustering ──
async function clusterWindows(windows, config) {
  if (!config.api_key) {
    // 初回: ダイアログで API キー入力を促す
    const key = await promptForApiKey();
    if (!key) return { error: 'キャンセルされました' };
    config.api_key = key;
    saveApiKey(key);
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.api_key });

  const history = loadRecentHistory();
  const historyText = history.length > 0
    ? '\n\n## 過去の snap 履歴 (学習データ)\n' + history.map(h =>
        `- グループ "${h.group}": ${(h.titles || []).join(', ')}`
      ).join('\n')
    : '';

  const rulesText = config.rules.length > 0
    ? '\n\n## ユーザー定義ルール\n' + config.rules.map(r =>
        `- "${r.name}": タイトルに ${r.match.map(m => `"${m}"`).join(' or ')} を含むものをグループ化`
      ).join('\n')
    : '';

  const windowList = windows.map((w, i) => `${i + 1}. [${w.app}] ${w.title}`).join('\n');

  const maxGroupsHint = config.max_groups > 0
    ? `グループ数は最大 ${config.max_groups} にしてください。`
    : 'グループ数は適切に判断してください (2-6 が目安)。';

  const prompt = `あなたはターミナルウィンドウの整理アシスタントです。
以下のターミナルウィンドウを、作業内容に基づいてグループ分けしてください。

## ユーザーコンテキスト
${config.context || '(未設定)'}
${rulesText}${historyText}

## 現在のターミナルウィンドウ
${windowList}

## ルール
- ${maxGroupsHint}
- 各グループに分かりやすい短い名前をつけてください (日本語OK)
- 1つのウィンドウは1つのグループにのみ所属
- 関連性が低いものは「その他」にまとめてOK

## 出力形式 (JSON のみ、説明不要)
\`\`\`json
{
  "groups": [
    { "name": "グループ名", "windows": [1, 3, 5] },
    { "name": "グループ名", "windows": [2, 4] }
  ]
}
\`\`\``;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { error: 'LLM の応答を解析できませんでした' };

    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    if (!parsed.groups || !Array.isArray(parsed.groups)) return { error: '無効なグループ形式' };

    // window index (1-based) → window object にマッピング
    const result = parsed.groups.map(g => ({
      name: g.name,
      windows: (g.windows || []).map(idx => windows[idx - 1]).filter(Boolean),
    })).filter(g => g.windows.length > 0);

    return { groups: result };
  } catch (e) {
    return { error: `API エラー: ${e.message}` };
  }
}

// ── Auto-snap 実行 ──
// createWorkspaceFn: (name) => ws
// snapFn: (ws, window) => Promise
async function executeAutoSnap(availableWindows, createWorkspaceFn, snapFn) {
  const config = loadConfig();
  const result = await clusterWindows(availableWindows, config);

  if (result.error) return result;

  const created = [];
  for (const group of result.groups) {
    const ws = createWorkspaceFn(group.name);
    for (const w of group.windows) {
      await snapFn(ws, w);
    }
    // 履歴に記録
    appendHistory({
      timestamp: Date.now(),
      group: group.name,
      titles: group.windows.map(w => w.title),
    });
    created.push({ name: group.name, count: group.windows.length });
  }

  return { ok: true, created };
}

module.exports = { loadConfig, ensureConfig, clusterWindows, executeAutoSnap, appendHistory, loadRecentHistory, CONFIG_FILE, HISTORY_FILE };
