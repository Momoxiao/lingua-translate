/**
 * Lingua — dependency-free CDP transport.
 *
 * Node's built-in WebSocket is rejected by Chrome's DevTools endpoint (the
 * handshake closes with 1006), and this project has a strict no-npm-dependency
 * rule, so the WebSocket client is hand-rolled on node:net / node:crypto.
 * Only the features CDP actually needs are implemented: text frames, ping/pong,
 * fragmentation and close.
 */

import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class TinyWS {
  constructor(url) {
    this.url = new URL(url);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onText = null;
    this.onClose = null;
    this.open = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const port = Number(this.url.port || 80);
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(port, this.url.hostname);
      this.socket = socket;

      const timer = setTimeout(() => reject(new Error('ws handshake timeout')), 10000);
      let handshake = Buffer.alloc(0);
      let upgraded = false;

      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      socket.on('data', (chunk) => {
        if (!upgraded) {
          handshake = Buffer.concat([handshake, chunk]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = handshake.subarray(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 101/.test(head)) {
            clearTimeout(timer);
            reject(new Error('ws upgrade failed: ' + head.split('\r\n')[0]));
            return;
          }
          upgraded = true;
          this.open = true;
          clearTimeout(timer);
          const rest = handshake.subarray(end + 4);
          handshake = Buffer.alloc(0);
          resolve();
          if (rest.length) this._feed(rest);
          return;
        }
        this._feed(chunk);
      });

      socket.on('close', () => {
        this.open = false;
        if (this.onClose) this.onClose();
      });

      // Chrome rejects the upgrade with 403 when an Origin header is present but
      // not on --remote-allow-origins. Omitting it entirely is always accepted.
      socket.write(
        `GET ${this.url.pathname || '/'} HTTP/1.1\r\n` +
          `Host: ${this.url.host}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const buf = this.buffer;
    let off = 0;
    while (buf.length - off >= 2) {
      const b0 = buf[off];
      const b1 = buf[off + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = off + 2;
      if (len === 126) {
        if (buf.length - p < 2) break;
        len = buf.readUInt16BE(p);
        p += 2;
      } else if (len === 127) {
        if (buf.length - p < 8) break;
        len = Number(buf.readBigUInt64BE(p));
        p += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length - p < 4) break;
        mask = buf.subarray(p, p + 4);
        p += 4;
      }
      if (buf.length - p < len) break;
      let payload = buf.subarray(p, p + len);
      if (mask) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      off = p + len;

      if (opcode === 0x8) {
        this.open = false;
        this._sendFrame(Buffer.alloc(0), 0x8);
        this.socket.end();
        if (this.onClose) this.onClose();
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          if (this.onText) this.onText(text);
        }
      }
    }
    this.buffer = buf.subarray(off);
  }

  _sendFrame(payload, opcode) {
    const len = payload.length;
    const lenBytes = len < 126 ? 0 : len < 65536 ? 2 : 8;
    const out = Buffer.alloc(2 + lenBytes + 4 + len);
    out[0] = 0x80 | opcode;
    let off = 2;
    if (lenBytes === 0) out[1] = 0x80 | len;
    else if (lenBytes === 2) {
      out[1] = 0x80 | 126;
      out.writeUInt16BE(len, off);
      off += 2;
    } else {
      out[1] = 0x80 | 127;
      out.writeBigUInt64BE(BigInt(len), off);
      off += 8;
    }
    const mask = crypto.randomBytes(4);
    mask.copy(out, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = payload[i] ^ mask[i & 3];
    this.socket.write(out);
  }

  send(str) {
    this._sendFrame(Buffer.from(str, 'utf8'), 0x1);
  }

  close() {
    try {
      this._sendFrame(Buffer.alloc(0), 0x8);
      this.socket.end();
    } catch (e) {
      /* ignore */
    }
  }
}

/** Minimal CDP client: browser-level connection with flat session routing. */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onText = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' — ' + msg.error.data : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.listeners) h(msg);
      }
    };
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

/**
 * Chrome 154 stopped serving the /json/* HTTP endpoints, so the only way in is
 * the UUID-scoped WebSocket path recorded in DevToolsActivePort. That file also
 * covers Chrome instances started from chrome://inspect rather than with an
 * explicit --remote-debugging-port flag.
 */
function readActivePortFile() {
  const candidates = [
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
    path.join(os.homedir(), 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
    path.join(os.homedir(), 'Library/Application Support/Chromium/DevToolsActivePort'),
    path.join(os.homedir(), '.config/google-chrome/DevToolsActivePort'),
    path.join(os.homedir(), '.config/chromium/DevToolsActivePort'),
  ];
  for (const p of candidates) {
    try {
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
      const port = parseInt(lines[0], 10);
      const wsPath = (lines[1] || '').trim();
      if (port > 0 && wsPath) return { port, wsPath };
    } catch (e) {
      /* try the next candidate */
    }
  }
  return null;
}

/** Connect to a running Chrome DevTools endpoint and return { cdp, ws, wsUrl }. */
export async function connect(port = 9222, host = '127.0.0.1') {
  let wsUrl = null;

  // Preferred: the HTTP discovery endpoint (present when Chrome was started with
  // an explicit --remote-debugging-port on older versions).
  try {
    const res = await fetch(`http://${host}:${port}/json/version`);
    if (res.ok) {
      const info = await res.json();
      if (info.webSocketDebuggerUrl) wsUrl = info.webSocketDebuggerUrl;
    }
  } catch (e) {
    /* fall through to DevToolsActivePort */
  }

  if (!wsUrl) {
    const active = readActivePortFile();
    if (active) wsUrl = `ws://${host}:${active.port}${active.wsPath}`;
  }

  if (!wsUrl) throw new Error(`No Chrome DevTools endpoint on ${host}:${port}`);

  const ws = new TinyWS(wsUrl);
  await ws.connect();
  return { cdp: new CDP(ws), ws, wsUrl };
}

/**
 * Attach to a target and collect its execution contexts.
 * Returns helpers bound to the page session.
 */
export async function attach(cdp, targetId, { collectConsole = true } = {}) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const contexts = [];
  const consoleErrors = [];

  cdp.onEvent((ev) => {
    if (ev.sessionId !== sessionId) return;
    if (ev.method === 'Runtime.executionContextCreated') contexts.push(ev.params.context);
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      consoleErrors.push(d.exception ? d.exception.description : d.text);
    }
    if (collectConsole && ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      consoleErrors.push(ev.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await new Promise((r) => setTimeout(r, 400)); // let existing contexts arrive

  const evalIn = async (expression, contextId) => {
    const r = await cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) },
      sessionId
    );
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    }
    return r.result.value;
  };

  return {
    sessionId,
    contexts,
    consoleErrors,
    evalPage: (expr) => evalIn(expr),
    evalIn,
    /** Every non-default execution context (each extension gets its own world). */
    isolatedContexts: () => contexts.filter((c) => c.auxData && c.auxData.isDefault === false && c.name !== ''),
    /**
     * The isolated world that actually belongs to this extension.
     * Other installed extensions inject their own worlds into the same frame, so
     * picking "the first isolated context" is not good enough — probe instead.
     */
    findWorld: async (probe = "typeof YTST !== 'undefined' && !!YTST.store") => {
      for (const c of contexts.filter((x) => x.auxData && x.auxData.isDefault === false && x.name !== '')) {
        try {
          if (await evalIn(probe, c.id)) return c;
        } catch (e) {
          /* not this one */
        }
      }
      return null;
    },
    /** Back-compat alias for the simple single-extension case. */
    isolatedContext: () => contexts.find((c) => c.auxData && c.auxData.isDefault === false && c.name !== ''),
    screenshot: (format = 'png') => cdp.send('Page.captureScreenshot', { format }, sessionId),
  };
}
