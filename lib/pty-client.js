// lib/pty-client.js — TiN(Electron main)から pty デーモン(lib/ptyd.js)へ接続するクライアント。
// デーモンが居なければ detached spawn(process.execPath を ELECTRON_RUN_AS_NODE=1 で起動)し、
// 接続後に create/attach/input/resize/kill を中継する。接続が切れても自動再接続し、'connect' 時に
// 呼び出し側が再 attach できるよう通知する。
//
// 必須 opts: ptydPath(lib/ptyd.js の実体パス), nodePtyPath(require.resolve('node-pty'))。
// 任意 opts: execPath(既定 process.execPath), pipePath(既定 defaultPipePath())。
//
// イベント: 'connect' | 'disconnect' | 'data'(id,data) | 'exit'(id,code)
//          | 'hello'({sessions}) | 'created'({id}) | 'attached'({id,...}) | 'noSession'({id}) | 'error'(e)

const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function defaultPipePath() {
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME || 'user').replace(/[^a-zA-Z0-9_-]/g, '');
    return '\\\\.\\pipe\\tin-ptyd-' + user;
  }
  const uid = (typeof process.getuid === 'function') ? process.getuid() : 'u';
  return path.join(os.tmpdir(), 'tin-ptyd-' + uid + '.sock');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class PtyClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.execPath = opts.execPath || process.execPath;
    this.ptydPath = opts.ptydPath;
    this.nodePtyPath = opts.nodePtyPath;
    this.pipePath = opts.pipePath || defaultPipePath();
    this.sock = null;
    this.connected = false;
    this._buf = '';
    this._spawned = false;
    this._closing = false;
  }

  _spawnDaemon() {
    try {
      const child = spawn(this.execPath, [this.ptydPath], {
        detached: true,        // 親(TiN)が死んでも生き残る
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TIN_PTYD_PIPE: this.pipePath, TIN_NODEPTY_PATH: this.nodePtyPath },
      });
      child.unref();
    } catch (e) { this.emit('error', e); }
  }

  // 接続を試み、ダメなら一度だけ daemon を spawn してリトライ(最大 ~4s)。
  async connect() {
    for (let i = 0; i < 40; i++) {
      try { this._wire(await this._tryConnect()); return true; }
      catch (e) {
        if (i === 0 && !this._spawned) { this._spawned = true; this._spawnDaemon(); }
        await delay(100);
      }
    }
    throw new Error('ptyd: connect timeout');
  }

  _tryConnect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.pipePath);
      const onErr = (e) => { try { sock.destroy(); } catch {} reject(e); };
      sock.once('error', onErr);
      sock.once('connect', () => { sock.removeListener('error', onErr); resolve(sock); });
    });
  }

  _wire(sock) {
    this.sock = sock;
    this.connected = true;
    this._buf = '';
    try { sock.setKeepAlive(true); } catch {}
    sock.on('data', (chunk) => {
      this._buf += chunk.toString('utf8');
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ev === 'data') this.emit('data', msg.id, msg.data);
        else if (msg.ev === 'exit') this.emit('exit', msg.id, msg.code);
        else if (msg.ev) this.emit(msg.ev, msg);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      this.connected = false; this.sock = null;
      this.emit('disconnect');
      if (!this._closing) this._reconnect();
    });
    this.emit('connect');
  }

  async _reconnect() {
    for (let i = 0; i < 20 && !this._closing; i++) {
      await delay(250);
      try { this._wire(await this._tryConnect()); return; } catch {}
    }
  }

  _send(obj) { if (this.sock && this.connected) { try { this.sock.write(JSON.stringify(obj) + '\n'); } catch {} } }

  hello() { this._send({ op: 'hello' }); }
  create(o) { this._send({ op: 'create', id: o.id, cwd: o.cwd, cols: o.cols, rows: o.rows, shell: o.shell }); }
  attach(id) { this._send({ op: 'attach', id }); }
  input(id, data) { this._send({ op: 'input', id, data }); }
  resize(id, cols, rows) { this._send({ op: 'resize', id, cols, rows }); }
  kill(id) { this._send({ op: 'kill', id }); }
  detach(id) { this._send({ op: 'detach', id }); }
  close() { this._closing = true; if (this.sock) { try { this.sock.end(); } catch {} } }
}

module.exports = { PtyClient, defaultPipePath };
