// lib/rest-guard.js — REST API のアクセス制御判定 (純粋ロジック)
//
// ここはセキュリティ境界そのもの。挙動を変えるときは必ず test/rest-guard.test.js を
// 先に更新してから触ること。ネットワーク I/O は持たず headers だけを見る。

// ── ローカル以外・ブラウザ経由のアクセスを遮断 ──
// bind は 127.0.0.1 だが、ブラウザは DNS rebinding (攻撃ドメインを 127.0.0.1 に向ける) で
// 任意の Web ページから叩けてしまう (CORS は応答の読取だけを制御し、送信自体は止めない)。
// /api/v1/launch は任意コマンド実行なのでここは実質 RCE 面。
// - Host が 127.0.0.1 / localhost / [::1] 以外 → 拒否 (rebinding はここで落ちる)
// - Origin 付き (=ブラウザ発) で localhost 系以外 → 拒否 ('null' Origin も拒否)
// ネイティブクライアントは Origin を送らないため影響なし。
const HOST_RE   = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function isAllowedRestRequest(headers) {
  const h = headers || {};
  const host = String(h.host || '').toLowerCase();
  if (!HOST_RE.test(host)) return false;
  const origin = h.origin;
  if (!origin) return true;
  return ORIGIN_RE.test(origin);
}

module.exports = { isAllowedRestRequest };
