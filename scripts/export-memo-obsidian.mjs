#!/usr/bin/env node
// TiN ワークスペース → Obsidian/Markdown エクスポート
//
// TiN の REST API (要: Preferences → Orchestration API を ON) から
// 全ワークスペースの名前・メモ・snap 中ウィンドウを取得し、Markdown で出力する。
//
// 使い方:
//   node scripts/export-memo-obsidian.mjs                     # stdout に出力
//   node scripts/export-memo-obsidian.mjs ~/Obsidian/TiN.md   # ファイルに追記 (日時見出し付き)
//   node scripts/export-memo-obsidian.mjs --daily ~/Obsidian/daily
//                                  # daily/YYYY-MM-DD.md に追記 (デイリーノート運用)
//
// cron / Claude Code フックから定期実行すれば「作業ワークスペースの自動記録」になる。
import fs from 'node:fs';
import path from 'node:path';

const API = process.env.TIN_API || 'http://127.0.0.1:37123';

function fmtDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function fmtTime(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

let status;
try {
  const res = await fetch(`${API}/api/v1/status`);
  status = await res.json();
} catch {
  console.error(`[export-memo] TiN API (${API}) に接続できません。TiN 起動 + Preferences → Orchestration API を確認してください。`);
  process.exit(1);
}
if (!status?.ok) { console.error('[export-memo] status 取得失敗'); process.exit(1); }

// メモか snap が1つでもあるワークスペースだけを出力対象にする
const wss = (status.workspaces || []).filter(w => (w.memo || '').trim() || (w.snapped || []).length);
if (!wss.length) { console.error('[export-memo] 出力対象のワークスペースがありません'); process.exit(0); }

const lines = [];
for (const w of wss) {
  lines.push(`### ${w.name} (TiN WS${w.id})`);
  if ((w.memo || '').trim()) {
    lines.push(...w.memo.trim().split('\n').map(l => `> ${l}`));
  }
  if ((w.snapped || []).length) {
    lines.push(`- グリッド: ${w.grid.cols}×${w.grid.rows}`);
    for (const s of w.snapped) lines.push(`- [slot ${s.slot}] **${s.app}** — ${s.title}`);
  }
  lines.push('');
}
const body = lines.join('\n');

const args = process.argv.slice(2);
let outFile = null;
if (args[0] === '--daily' && args[1]) {
  fs.mkdirSync(args[1], { recursive: true });
  outFile = path.join(args[1], `${fmtDate()}.md`);
} else if (args[0]) {
  outFile = args[0];
}

if (!outFile) {
  console.log(body);
} else {
  const section = `\n## TiN ワークスペース記録 (${fmtDate()} ${fmtTime()})\n\n${body}`;
  fs.appendFileSync(outFile, section);
  console.log(`[export-memo] ${wss.length} workspace → ${outFile} に追記しました`);
}
