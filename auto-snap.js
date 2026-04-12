// auto-snap.js — LLM によるターミナル自動クラスタリング + snap
// 使用法: メニュー「Auto Snap」or Cmd+Shift+G でトリガー
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

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
  // 簡易 YAML パーサー (依存なし)
  const config = { api_key: '', context: '', rules: [], max_groups: 0, default_grid: { cols: 2, rows: 2 } };
  // api_key
  const keyMatch = raw.match(/^api_key:\s*"([^"]*)"/m);
  if (keyMatch) config.api_key = keyMatch[1];
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

// ── LLM Clustering ──
async function clusterWindows(windows, config) {
  if (!config.api_key) {
    return { error: 'API キーが設定されていません。\n設定ファイル: ' + CONFIG_FILE };
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
      model: 'claude-sonnet-4-20250514',
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
