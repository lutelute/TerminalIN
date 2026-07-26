// test/rest-guard.test.js — REST API のアクセス制御 (DNS rebinding 対策)
//
// /api/v1/launch は任意コマンド実行なので、ここが抜けると即 RCE になる。
// 正規表現のアンカー漏れ (127.0.0.1.evil.com が通る等) を機械的に落とすのが主目的。

const { test } = require('node:test');
const assert = require('node:assert');
const { isAllowedRestRequest } = require('../lib/rest-guard');

const allow = (h) => assert.strictEqual(isAllowedRestRequest(h), true, `許可されるべき: ${JSON.stringify(h)}`);
const deny  = (h) => assert.strictEqual(isAllowedRestRequest(h), false, `拒否されるべき: ${JSON.stringify(h)}`);

// ── ネイティブクライアント (curl / Raycast / AtelierX): Origin なし ──

test('Origin なし + ループバック Host は許可', () => {
  allow({ host: '127.0.0.1:37123' });
  allow({ host: 'localhost:37123' });
  allow({ host: '[::1]:37123' });
});

test('ポート無しの Host も許可', () => {
  allow({ host: '127.0.0.1' });
  allow({ host: 'localhost' });
});

test('Host の大文字小文字は問わない', () => {
  allow({ host: 'LOCALHOST:37123' });
});

// ── DNS rebinding: 攻撃ドメインを 127.0.0.1 に解決させて叩く経路 ──

test('外部ドメインの Host は拒否 (DNS rebinding の入口)', () => {
  deny({ host: 'evil.com' });
  deny({ host: 'evil.com:37123' });
  deny({ host: 'tin.attacker.test' });
});

test('Host が無い/空なら拒否', () => {
  deny({});
  deny({ host: '' });
  deny(undefined);
  deny(null);
});

test('ループバックを含む紛らわしい Host を拒否 (正規表現アンカーの検証)', () => {
  deny({ host: '127.0.0.1.evil.com' });      // 前方一致すり抜け
  deny({ host: 'evil.com#127.0.0.1' });
  deny({ host: 'localhost.evil.com' });      // サブドメイン偽装
  deny({ host: 'notlocalhost' });
  deny({ host: 'xlocalhost:37123' });
  deny({ host: '127.0.0.10' });              // 別アドレスへの誤マッチ
  deny({ host: '127.0.0.1:37123.evil.com' });
});

test('ループバック以外のプライベート IP も拒否 (LAN からの到達を許さない)', () => {
  deny({ host: '192.168.1.5:37123' });
  deny({ host: '10.0.70.42:37123' });
  deny({ host: '0.0.0.0:37123' });
});

// ── ブラウザ発 (Origin 付き) ──

test('ローカル開発ページの Origin は許可', () => {
  allow({ host: '127.0.0.1:37123', origin: 'http://localhost:3000' });
  allow({ host: 'localhost:37123', origin: 'http://127.0.0.1:5173' });
  allow({ host: 'localhost:37123', origin: 'https://localhost' });
});

test('外部ページの Origin は拒否', () => {
  deny({ host: '127.0.0.1:37123', origin: 'https://evil.com' });
  deny({ host: 'localhost:37123', origin: 'http://evil.com:3000' });
});

test("Origin 'null' (sandbox iframe / file://) は拒否", () => {
  deny({ host: '127.0.0.1:37123', origin: 'null' });
});

test('ループバックに似せた Origin を拒否', () => {
  deny({ host: '127.0.0.1:37123', origin: 'http://localhost.evil.com' });
  deny({ host: '127.0.0.1:37123', origin: 'http://127.0.0.1.evil.com' });
  deny({ host: '127.0.0.1:37123', origin: 'https://127.0.0.10' });
});

test('javascript: / data: スキームの Origin は拒否', () => {
  deny({ host: '127.0.0.1:37123', origin: 'javascript:alert(1)' });
  deny({ host: '127.0.0.1:37123', origin: 'data:text/html,x' });
  deny({ host: '127.0.0.1:37123', origin: 'file://' });
});

test('Host が不正なら Origin が正当でも拒否 (Host 判定が先に効く)', () => {
  deny({ host: 'evil.com', origin: 'http://localhost:3000' });
});
