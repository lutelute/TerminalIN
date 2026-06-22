// lib/ptyd.js — TiN PTY デーモン: 端末セッションを TiN 本体から切り離して常駐保持する。
//
// TiN(Electron main)が落ちる/更新で終了しても、この常駐プロセスが node-pty セッションを
// 保持し続け、TiN 再起動時に再アタッチ + 出力リングバッファ再生でスクロールバックを復元する
// (tmux / screen のサーバ相当)。
//
// 起動: TiN が process.execPath を ELECTRON_RUN_AS_NODE=1 で detached spawn する。
//   env:
//     TIN_PTYD_PIPE    — listen する named pipe / unix socket のパス
//     TIN_NODEPTY_PATH — node-pty の解決済みパス (asar/ABI を跨いで確実に require するため)
//
// プロトコル: 改行区切り JSON。
//   client→daemon: {op:'hello'} | {op:'create',id,cwd,cols,rows,shell} | {op:'attach',id}
//                  | {op:'input',id,data} | {op:'resize',id,cols,rows} | {op:'kill',id} | {op:'detach',id}
//   daemon→client: {ev:'hello',sessions:[...]} | {ev:'created',id} | {ev:'attached',id,cols,rows,alive}
//                  | {ev:'data',id,data} | {ev:'exit',id,code} | {ev:'killed',id} | {ev:'noSession',id}

const net = require('net');
const fs = require('fs');

const PIPE = process.env.TIN_PTYD_PIPE;
const NODEPTY = process.env.TIN_NODEPTY_PATH || 'node-pty';
if (!PIPE) { process.stderr.write('ptyd: TIN_PTYD_PIPE not set\n'); process.exit(2); }

let pty;
try { pty = require(NODEPTY); } catch (e) { process.stderr.write('ptyd: node-pty load failed: ' + (e && e.message) + '\n'); process.exit(3); }

const BUF_MAX = 256 * 1024; // 1 セッションあたりのスクロールバック保持上限(バイト相当)
const IDLE_EXIT_MS = 30000; // セッションも接続も無い状態が続いたら終了

// sessions: id -> { id, pty, cwd, title, cols, rows, buf:string[], bufLen, alive, exitCode }
const sessions = new Map();
const clients = new Set(); // 接続中 socket。各 socket は _attached:Set<id> を持つ

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/bash';
}

function appendBuf(s, data) {
  s.buf.push(data);
  s.bufLen += data.length;
  while (s.bufLen > BUF_MAX && s.buf.length > 1) s.bufLen -= s.buf.shift().length;
}

function send(sock, obj) { try { sock.write(JSON.stringify(obj) + '\n'); } catch {} }
function broadcast(id, obj) { for (const c of clients) if (c._attached && c._attached.has(id)) send(c, obj); }

function createSession({ id, cwd, cols, rows, shell }) {
  if (sessions.has(id)) return sessions.get(id);
  const p = pty.spawn(shell || defaultShell(), [], {
    name: 'xterm-256color',
    cols: cols || 80, rows: rows || 24,
    cwd: cwd || process.env.HOME || process.env.USERPROFILE || process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  const s = { id, pty: p, cwd: cwd || '', title: '', cols: cols || 80, rows: rows || 24, buf: [], bufLen: 0, alive: true, exitCode: null };
  sessions.set(id, s);
  p.onData((data) => { appendBuf(s, data); broadcast(id, { ev: 'data', id, data }); });
  p.onExit((e) => { s.alive = false; s.exitCode = (e && e.exitCode) || 0; broadcast(id, { ev: 'exit', id, code: s.exitCode }); });
  return s;
}

function handleMsg(sock, msg) {
  switch (msg.op) {
    case 'hello': {
      const list = [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, title: s.title, cols: s.cols, rows: s.rows, alive: s.alive }));
      send(sock, { ev: 'hello', sessions: list });
      break;
    }
    case 'create': {
      const s = createSession(msg);
      sock._attached.add(s.id);
      send(sock, { ev: 'created', id: s.id });
      break;
    }
    case 'attach': {
      const s = sessions.get(msg.id);
      if (!s) { send(sock, { ev: 'noSession', id: msg.id }); break; }
      sock._attached.add(s.id);
      send(sock, { ev: 'attached', id: s.id, cols: s.cols, rows: s.rows, alive: s.alive });
      if (s.buf.length) send(sock, { ev: 'data', id: s.id, data: s.buf.join('') }); // スクロールバック再生
      if (!s.alive) send(sock, { ev: 'exit', id: s.id, code: s.exitCode });
      break;
    }
    case 'input': {
      const s = sessions.get(msg.id);
      if (s && s.alive) { try { s.pty.write(msg.data); } catch {} }
      break;
    }
    case 'resize': {
      const s = sessions.get(msg.id);
      if (s && s.alive) { s.cols = msg.cols; s.rows = msg.rows; try { s.pty.resize(msg.cols, msg.rows); } catch {} }
      break;
    }
    case 'kill': {
      const s = sessions.get(msg.id);
      if (s) { try { s.pty.kill(); } catch {} sessions.delete(msg.id); }
      send(sock, { ev: 'killed', id: msg.id });
      scheduleIdleExit();
      break;
    }
    case 'detach': { sock._attached.delete(msg.id); break; }
  }
}

let _idleTimer = null;
function clearIdle() { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } }
function scheduleIdleExit() {
  clearIdle();
  if (sessions.size === 0 && clients.size === 0) {
    _idleTimer = setTimeout(() => { if (sessions.size === 0 && clients.size === 0) process.exit(0); }, IDLE_EXIT_MS);
  }
}

const server = net.createServer((sock) => {
  clearIdle();
  sock._attached = new Set();
  sock._buf = '';
  clients.add(sock);
  sock.setKeepAlive(true);
  sock.on('data', (chunk) => {
    sock._buf += chunk.toString('utf8');
    let nl;
    while ((nl = sock._buf.indexOf('\n')) >= 0) {
      const line = sock._buf.slice(0, nl);
      sock._buf = sock._buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      try { handleMsg(sock, msg); } catch (e) { process.stderr.write('ptyd: handle error ' + (e && e.message) + '\n'); }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => { clients.delete(sock); scheduleIdleExit(); });
});

server.on('error', (e) => {
  // 既に別 daemon が listen 済み(多重起動)→ 静かに終了。
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) process.exit(0);
  process.stderr.write('ptyd: server error ' + (e && e.code) + '\n');
  process.exit(4);
});

// unix socket は前回の残骸を unlink。Windows named pipe は不要。
if (process.platform !== 'win32') { try { fs.unlinkSync(PIPE); } catch {} }
server.listen(PIPE, () => {
  scheduleIdleExit(); // 誰も繋がず・作らなければ IDLE_EXIT_MS 後に自動終了 (orphan 防止)
});

// 端末側の Ctrl+C(SIGINT)で巻き込まれて死なないようにする(子 pty に渡るのは別経路)。
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
