// auto-snap.js — Claude Code CLI によるターミナル自動クラスタリング + snap
// API キー不要 — ユーザーの Claude サブスクをそのまま使用
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { execFile } = require('child_process');

const CONFIG_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(CONFIG_DIR, 'auto-snap.yml');
const HISTORY_FILE = path.join(CONFIG_DIR, 'snap-history.jsonl');

// ── Config ──
function getDefaultConfig() {
  return `# TiN Auto-Snap Configuration
# ターミナルウィンドウを自動グループ化するための設定

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

# グループ数の上限 (0 = AI に任せる)
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
  const config = { context: '', rules: [], max_groups: 0, default_grid: { cols: 2, rows: 2 } };
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

// ── Claude CLI 呼び出し ──
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const claudePath = process.env.HOME + '/.local/bin/claude';
    const os = require('os');
    // プロンプトを一時ファイルに書き出して stdin からパイプ
    const tmpFile = path.join(os.tmpdir(), `tin-prompt-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt, 'utf-8');
    const child = require('child_process').spawn('sh', ['-c', `cat "${tmpFile}" | "${claudePath}" -p --model haiku`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: os.tmpdir(),
      timeout: 30000,
      env: { ...process.env },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      if (code !== 0) return reject(new Error(stderr.trim() || `exit code ${code}`));
      resolve(stdout.trim());
    });
    child.on('error', (e) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      reject(e);
    });
  });
}

// ── LLM Clustering ──
async function clusterWindows(windows, config) {
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
    const text = await callClaude(prompt);
    console.log('[auto-snap] raw response:', text.substring(0, 500));
    // JSON を抽出 (複数パターン対応)
    let jsonStr = null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) jsonStr = fenced[1].trim();
    if (!jsonStr) {
      const braces = text.match(/\{[\s\S]*"groups"[\s\S]*\}/);
      if (braces) jsonStr = braces[0];
    }
    if (!jsonStr) return { error: 'AI の応答を解析できませんでした\n\n応答: ' + text.substring(0, 200) };

    const parsed = JSON.parse(jsonStr);
    if (!parsed.groups || !Array.isArray(parsed.groups)) return { error: '無効なグループ形式' };

    const result = parsed.groups.map(g => ({
      name: g.name,
      windows: (g.windows || []).map(idx => windows[idx - 1]).filter(Boolean),
    })).filter(g => g.windows.length > 0);

    return { groups: result };
  } catch (e) {
    return { error: `Claude CLI エラー: ${e.message}` };
  }
}

// ── Auto-snap 実行 ──
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
