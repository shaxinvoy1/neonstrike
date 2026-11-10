// WebSocket mijoz: xabar marshrutlash, ping, qayta ulanish holati
import { MSG } from '/shared/protocol-consts.js';
export class Net {
  constructor () {
    this.ws = null; this.handlers = new Map(); this.seq = 0;  // input seq — ulanish bo'yicha uzluksiz (server eski seq ni rad etadi)
    this.open = false; this.rtt = 0; this.playerId = null; this.sessionId = null;
    this._pingT = 0;
  }
  on (type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); return () => this.handlers.get(type).delete(fn); }
  emit (type, msg) { const h = this.handlers.get(type); if (h) for (const f of h) f(msg); const a = this.handlers.get('*'); if (a) for (const f of a) f(msg); }
  connect (name) {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws = ws;
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; reject(new Error('Server javob bermadi')); try { ws.close(); } catch {} } }, 6000);
      ws.onopen = () => { this.open = true; this.send({ type: MSG.HELLO, name }); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === MSG.SESSION) { this.playerId = m.playerId; this.sessionId = m.sessionId; if (!done) { done = true; clearTimeout(to); resolve(m); } }
        if (m.type === MSG.PONG) this.rtt = performance.now() - m.t;
        this.emit(m.type, m);
      };
      ws.onclose = () => { this.open = false; this.emit('close', {}); if (!done) { done = true; clearTimeout(to); reject(new Error('Ulanish yopildi')); } };
      ws.onerror = () => {};
      this._ping = setInterval(() => this.send({ type: MSG.PING, t: performance.now() }), 2000);
    });
  }
  send (o) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; } return false; }
  close () { clearInterval(this._ping); if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} } this.open = false; }
}
