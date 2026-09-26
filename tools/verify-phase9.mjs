#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 9 (HUD / POLISH / CHAT) verifikatsiyasi
// (anti-fake: HAQIQIY Chrome + HAQIQIY server + IKKI MUSTAQIL KLIENT + xom WS)
//
// Dalil manbalari:
//   1) SERVER XOTIRASI — harness serverni O'ZI ishga tushiradi:
//      `server.state.lobby/match/sessions/chat` TO'G'RIDAN-TO'G'RI o'qiladi.
//      "HUD avtoritar" da'vosi DOM matni bilan emas, SERVER qiymati ↔ HUD DOM
//      qiymati MOS kelishi bilan isbotlanadi (hudAuthority()).
//   2) HAQIQIY KLAVIATURA/SICHQONCHA — chat T → matn → ENTER bilan HAQIQIY
//      CDP klaviatura hodisalari orqali yuboriladi; o'q HAQIQIY sichqoncha +
//      pointer lock orqali otiladi (server o'zi ray ni hal qiladi).
//   3) KLIENT → SERVER → KLIENT — chat B sahifasida ko'rinishi bilan isbotlanadi.
//   4) OVERLAY HOLATI — getComputedStyle + elementFromPoint (yashirilgan
//      overlay ekranda qolmaydi).
//
// Ishga tushirish:  node tools/verify-phase9.mjs            (real oyna · real GPU)
//                   node tools/verify-phase9.mjs --headless (SwiftShader — GPU dalili EMAS)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { placePlayerAt, sessionSnapshot } from '../server/session.js';
import {
  MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, TEAM, MATCH_PHASE, CHAT
} from '../shared/protocol-consts.js';
import { MATCH_RULES } from '../server/match.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
// IKKI ALOHIDA CHROME JARAYONI — har bir klient O'Z oynasida: fon sahifasida
// rAF to'xtab qolmaydi va "mustaqil klient" dalili kuchayadi.
const CDP_PORT_A = Number(process.env.CDP_PORT || 9391);
const CDP_PORT_B = CDP_PORT_A + 1;
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js',
  'test/unit/multiplayer.test.js', 'test/unit/round-team-score.test.js',
  'test/unit/hud-chat.test.js'
];

const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- minimal CDP klient ----------------
class CDP {
  constructor (url) {
    this.url = url; this.id = 0; this.pending = new Map();
    this.listeners = []; this.logs = []; this.exceptions = []; this.closed = false;
  }
  async open () {
    this.ws = new WebSocket(this.url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      for (const l of this.listeners) l(msg);
    });
    this.ws.on('close', () => { this.closed = true; });
    this.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
        this.logs.push({ level: msg.params.type, text });
      }
      if (msg.method === 'Log.entryAdded') {
        this.logs.push({ level: msg.params.entry.level, text: msg.params.entry.text, source: msg.params.entry.source });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.exceptions.push(d.text + ' ' + (d.exception?.description || ''));
      }
    });
    return this;
  }
  on (fn) { this.listeners.push(fn); }
  send (method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws.readyState !== 1) return reject(new Error('CDP socket yopilgan'));
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 30000);
    });
  }
  async evaluate (expression, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise: opts.awaitPromise !== false,
      returnByValue: true, userGesture: !!opts.userGesture
    });
    if (res.exceptionDetails) {
      throw new Error('in-page xato: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }
  close () { try { this.ws.close(); } catch {} }
}

/** Xom WS klient (haqiqiy ulanish — haqiqiy server o'yinchisi) */
class RawClient {
  constructor (url) { this.url = url; this.q = []; this.waiters = []; }
  open () {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
        for (let i = 0; i < this.waiters.length; i++) {
          const w = this.waiters[i];
          if (!w.type || w.type === m.type) { this.waiters.splice(i, 1); clearTimeout(w.to); return w.resolve(m); }
        }
        this.q.push(m);
      });
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }
  next (type = null, timeout = 6000) {
    for (let i = 0; i < this.q.length; i++) {
      if (!type || this.q[i].type === type) return Promise.resolve(this.q.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`raw msg timeout (${type})`)), timeout);
      this.waiters.push({ type, resolve, to });
    });
  }
  count (type) { return this.q.filter((m) => m.type === type).length; }
  drain (type) { this.q = this.q.filter((m) => m.type !== type); }
  send (obj) { this.ws.send(JSON.stringify(obj)); }
  terminate () { try { this.ws.terminate(); } catch {} }
  close () { try { this.ws.close(); } catch {} }
}

async function launchChrome (base, cdpPort, tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `neon9-${tag}-`));
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    // alohida oyna — ikkala klient ham KO'RINADIGAN bo'lib qoladi
    '--new-window',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1280,800', '--window-position=0,0',
    base
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (b) => {
    const s = b.toString();
    if (/error|fail/i.test(s) && !/GPU|dbus|Fontconfig|gbm|vaapi|IsSandboxed|gcm|PHONE_REGISTRATION/i.test(s)) {
      process.stderr.write('[chrome] ' + s);
    }
  });
  return { child, profile };
}

async function waitForPageTarget (base, cdpPort) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(base));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Chrome page target topilmadi (port ${cdpPort})`);
}

async function prepare (cdp) {
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return cdp;
}

// ---------------- asosiy oqim ----------------
async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;

  const sessions = () => [...server.state.sessions.values()];
  const sessionOf = (pid) => sessions().find((s) => s.playerId === pid) || null;
  /** Sessiya MAJBURIY bo'lishi kerak — yo'q bo'lsa tushunarli xato (jim crash EMAS) */
  const reqSess = (pid) => {
    const s = sessionOf(pid);
    if (!s) {
      throw new Error(`server sessiyasi yo‘q: ${pid} · mavjud=[${sessions().map((x) => x.playerId).join(',')}] · ` +
        `ulanishlar=${server.state.connections.size} · lobby=[${(lobbySess()?.players || []).map((p) => p.id).join(',')}]`);
    }
    return s;
  };
  /** Avtoritar QUROL holati (server hal qilgan: mag/reserve/reloading) */
  const sessWeapon = (pid) => sessionSnapshot(reqSess(pid)).weapon;
  const lobbySess = () => server.state.lobby.session;
  const match = () => server.state.match;
  const chat = () => server.state.chat;

  // KLIENT A — 1-Chrome jarayoni · KLIENT B — 2-Chrome jarayoni (mustaqil)
  const chromeA = await launchChrome(BASE, CDP_PORT_A, 'a');
  const targetA = await waitForPageTarget(BASE, CDP_PORT_A);
  const A = await prepare(await new CDP(targetA.webSocketDebuggerUrl).open());
  const chromeB = await launchChrome(BASE, CDP_PORT_B, 'b');
  const targetB = await waitForPageTarget(BASE, CDP_PORT_B);
  const B = await prepare(await new CDP(targetB.webSocketDebuggerUrl).open());

  const shots = [];
  const saveShot = async (cdp, name) => {
    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      const file = path.join(ART, name + '.png');
      fs.writeFileSync(file, buf);
      shots.push({ name, file, bytes: buf.length });
      return true;
    } catch { return false; }
  };

  const rawClients = [];
  const cleanup = async () => {
    for (const rc of rawClients) { try { rc.terminate(); } catch {} }
    try { A.close(); } catch {}
    try { B.close(); } catch {}
    for (const c of [chromeA, chromeB]) {
      try { c.child.kill('SIGTERM'); } catch {}
    }
    await sleep(600);
    for (const c of [chromeA, chromeB]) {
      try { fs.rmSync(c.profile, { recursive: true, force: true }); } catch {}
    }
    await server.close().catch(() => {});
  };

  /** Sahifa tayyor (WebGL2 + __neon + Phase 9 API) */
  const waitReady = async (cdp, tries = 120) => {
    let ready = null;
    for (let i = 0; i < tries; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          return {
            loading: false,
            loaded: !!(window.__neon && window.__neon.loaded),
            ready: btn.dataset.ready === '1',
            version: window.__neon ? window.__neon.version : null,
            phase9: window.__neon ? window.__neon.phase9 : null,
            hasHudView: !!(window.__neon && typeof window.__neon.hudView === 'function'),
            hasChat: !!(window.__neon && typeof window.__neon.chatSend === 'function'),
            hasOverlay: !!(window.__neon && typeof window.__neon.overlay === 'function'),
            gates: window.__neon ? window.__neon.gates : null
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) { ready = { error: String(e.message), loading: true }; }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('sahifa tayyor emas: ' + JSON.stringify(ready));
    return ready;
  };

  const front = async (cdp) => { try { await cdp.send('Page.bringToFront'); } catch {} await sleep(200); };

  /** HAQIQIY DOM klik (koordinata bo'yicha) */
  const clickBtn = async (cdp, id) => {
    await front(cdp);
    for (let i = 0; i < 40; i++) {
      const info = await cdp.evaluate(`(function () {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        return {
          disabled: !!el.disabled, hidden: el.hidden, w: Math.round(r.width),
          x, y, inView: x >= 0 && y >= 0 && x < vw && y < vh
        };
      })()`);
      if (info && !info.disabled && !info.hidden && info.w > 0 && info.inView) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', {
            type, x: info.x, y: info.y, button: 'left', clickCount: 1, pointerType: 'mouse',
            buttons: type === 'mousePressed' ? 1 : 0
          });
        }
        return true;
      }
      await sleep(100);
    }
    return false;
  };

  const consoleErrors = (cdp) => (cdp.logs || []).filter((l) =>
    l.level === 'error' && !/favicon|Failed to load resource|net::ERR/i.test(l.text || ''));

  const waitServer = async (pred, tries = 120, ms = 100) => {
    for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms); }
    return pred();
  };
  const waitClient = async (cdp, expr, pred, tries = 60) => {
    let v = null;
    for (let i = 0; i < tries; i++) {
      try { v = await cdp.evaluate(expr); } catch { v = null; }
      if (v && pred(v)) return v;
      await sleep(120);
    }
    return v;
  };

  /** Xom WS klient ochib sessiyaga qo'shish (HAQIQIY server o'yinchisi) */
  const rawJoin = async (name) => {
    const rc = new RawClient(WS_URL);
    rawClients.push(rc);
    await rc.open();
    rc.send({ type: MSG.HELLO, name });
    const sess = await rc.next(MSG.SESSION);
    rc.playerId = sess.playerId;
    rc.sessionId = sess.sessionId;
    rc.send({ type: MSG.JOIN_SESSION });
    return rc;
  };

  /** O'yinchini berilgan nuqtaga qo'yish (server ishlab chiqarish API si) */
  const placeAt = (pid, x, z, yaw) => {
    const s = sessionOf(pid);
    if (!s) return null;
    placePlayerAt(s, { x, y: 0, z, yaw }, Date.now());
    s.movement.pos = s.state.position;
    return s.state.position;
  };

  const waitLocalNear = async (cdp, pid, tol = 0.35, tries = 60) => {
    const s = sessionOf(pid);
    if (!s) return false;
    const t = s.state.position;
    for (let i = 0; i < tries; i++) {
      try {
        const l = await cdp.evaluate('window.__neon.multiplayerQa().local');
        if (l && Math.hypot(l.x - t.x, l.z - t.z) < tol) return true;
      } catch {}
      await sleep(100);
    }
    return false;
  };

  const aimAtPlayer = async (cdp, pid) => {
    const s = sessionOf(pid);
    if (!s) return null;
    const p = s.state.position;
    return cdp.evaluate(`window.__neon.aimAtPoint(${p.x}, ${p.y + 1.15}, ${p.z})`);
  };

  /** HAQIQIY sichqoncha bilan otish (pointer lock ichida) */
  const fireBurst = async (cdp, ms = 700) => {
    await front(cdp);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(ms);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(60);
  };
  const holdFire = (cdp, on) => cdp.evaluate(on ? 'window.__neon.setFire(true)' : 'window.__neon.releaseFire()');

  /**
   * PAUZA oynasi FAQAT pointer lock bo'lmaganda ko'rinadi (dizayn). Shuning
   * uchun "toza o'tish" dalili = ko'rinish pointer lock holatiga MOS bo'lishi.
   */
  const pauseConsistent = (cdp) => cdp.evaluate(`(function () {
    const p = document.getElementById('pause');
    const locked = document.pointerLockElement !== null;
    const display = getComputedStyle(p).display;
    return {
      locked, hidden: p.hidden, display,
      consistent: (p.hidden === locked) && ((p.hidden && display === 'none') || (!p.hidden && display === 'flex'))
    };
  })()`);

  /** Haqiqiy o'q (mag tushguncha) — pointer lock yo'q bo'lsa input manager */
  const fireUntilMagDrops = async (cdp, pid, maxTries = 8) => {
    const mag = () => sessWeapon(pid).mag;
    const m0 = mag();
    for (let i = 0; i < maxTries; i++) {
      if (mag() < m0) return { before: m0, after: mag(), viaMouse: true };
      await front(cdp);
      await fireBurst(cdp, 200);
      await sleep(150);
      if (mag() < m0) return { before: m0, after: mag(), viaMouse: true };
      await holdFire(cdp, true);
      await sleep(260);
      await holdFire(cdp, false);
      await sleep(160);
      if (mag() < m0) return { before: m0, after: mag(), viaMouse: false };
    }
    return { before: m0, after: mag(), viaMouse: null };
  };

  /** Xom WS javobini SHU turdagi MOS xabargacha kutish (eski navbat aralashmaydi) */
  const rawUntil = async (rc, type, pred, tries = 40) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try { last = await rc.next(type, 2500); } catch { return last; }
      if (!pred || pred(last)) return last;
    }
    return last;
  };

  /**
   * Qisqa o'q — nishonni O'LDIRMASDAN zarar yetkazish. Natija SERVERDAN
   * tekshiriladi (o'q qabul qilindi va HP tushdi). Pointer Lock bo'lmasa —
   * ishlab chiqarish input manager yo'li (mock EMAS).
   */
  const damageOnce = async (cdp, fromPid, targetPid, maxTries = 6) => {
    const s = sessionOf(targetPid);
    if (!s) return { hpBefore: 0, hpAfter: 0, shots: 0, viaMouse: null };
    const hpBefore = s.state.health.hp;
    const a0 = (sessionOf(fromPid) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted;
    await front(cdp);
    let viaMouse = null;
    for (let i = 0; i < maxTries; i++) {
      if (s.state.health.hp < hpBefore || !s.state.health.alive) break;
      await aimAtPlayer(cdp, targetPid);
      await fireBurst(cdp, 90);            // ~1 o'q (600 RPM = 100 ms oraliq)
      await sleep(140);
      if (s.state.health.hp < hpBefore) { viaMouse = true; break; }
      await aimAtPlayer(cdp, targetPid);
      await holdFire(cdp, true);           // pointer lock yo'q → input manager
      await sleep(300);
      await holdFire(cdp, false);
      await sleep(160);
      viaMouse = false;
    }
    const shots = (sessionOf(fromPid) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted - a0;
    return { hpBefore, hpAfter: s.state.health.hp, shots, viaMouse };
  };

  /**
   * `from` sahifasidan `targetPid` ni otib tushirish (HAQIQIY yo'l: aim + sichqoncha;
   * pointer lock ishlamasa — ishlab chiqarish input manager yo'li).
   */
  const killFrom = async (cdp, fromPid, targetPid, maxBursts = 16) => {
    await front(cdp);
    const a0 = (sessionOf(fromPid) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted;
    for (let i = 0; i < maxBursts; i++) {
      const t = sessionOf(targetPid);
      if (!t || !t.state.health.alive) break;
      // o'q-dori tugashiga yo'l qo'ymaymiz — SERVER tasdiqlagan reload
      // (klient o'zi to'ldirmaydi; mag yetmasa burst yaroqsiz bo'lardi)
      if (sessWeapon(fromPid).mag < 5) {
        await cdp.evaluate('window.__neon.requestReload()');
        await sleep(2700);
      }
      await aimAtPlayer(cdp, targetPid);
      await fireBurst(cdp, 350);
      await sleep(60);
    }
    let shots = (sessionOf(fromPid) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted - a0;
    let viaMouse = shots > 0;
    if (shots === 0) {
      for (let i = 0; i < maxBursts; i++) {
        const t = sessionOf(targetPid);
        if (!t || !t.state.health.alive) break;
        await aimAtPlayer(cdp, targetPid);
        await holdFire(cdp, true);
        await sleep(600);
        await holdFire(cdp, false);
        await sleep(80);
      }
      shots = (sessionOf(fromPid) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted - a0;
      viaMouse = false;
    }
    return { shots, viaMouse, dead: !(sessionOf(targetPid) || { state: { health: { alive: true } } }).state.health.alive };
  };

  /**
   * Hamma o'yinchini TOZA o'q chizig'iga joylash.
   *
   * z = -14 — xarita bo'ylab o'lchangan aniq ko'rinish yo'lagi (o'q devorga
   * urilmaydi). Jamoadoshlar 2 m oraliqda (z = -12) turadi — bu burchak ham
   * o'lchovda 100% toza chiqqan. Eski (-13,-9) diagoniali devor bilan
   * to'silar edi (28/30 o'q bloklangan).
   */
  const placeAll = () => {
    placeAt(idA, -13, -14, Math.PI / 2);
    placeAt(idC, -13, -12, Math.PI / 2);
    placeAt(idB, 13, -14, -Math.PI / 2);
    placeAt(idD, 13, -12, -Math.PI / 2);
  };

  /** A jamoasi raundni yutadi (haqiqiy otish: D, keyin B o'ladi) */
  const roundWinForA = async () => {
    if (match().state === MATCH_PHASE.MATCH_END) return false;
    if (!(await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 150, 100))) return false;
    if (match().state === MATCH_PHASE.MATCH_END) return false;
    await sleep(200);
    placeAll();
    await waitLocalNear(A, idA);
    for (const t of [idD, idB]) {
      const s = sessionOf(t);
      if (!s || !s.state.health.alive) continue;
      const r = await killFrom(A, idA, t);
      if (!r.dead) return false;
    }
    return waitServer(() => match().roundState !== MATCH_PHASE.LIVE, 200, 100);
  };

  /** B jamoasi raundni yutadi (A va C o'ladi — haqiqiy otish B dan) */
  const roundWinForB = async () => {
    if (match().state === MATCH_PHASE.MATCH_END) return false;
    if (!(await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 150, 100))) return false;
    await sleep(200);
    placeAll();
    await waitLocalNear(B, idB);
    for (const t of [idA, idC]) {
      const s = sessionOf(t);
      if (!s || !s.state.health.alive) continue;
      const r = await killFrom(B, idB, t);
      if (!r.dead) return false;
    }
    return waitServer(() => match().roundState !== MATCH_PHASE.LIVE, 200, 100);
  };

  /** HAQIQIY klaviatura hodisasi */
  const keyPress = async (cdp, code, key, vk) => {
    const base = { code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(120);
  };

  /**
   * Chatni HAQIQIY klaviatura bilan yozib yuborish:
   * T (chat ochiladi) → matn (Input.insertText) → ENTER (yuborish)
   */
  const typeAndSendChat = async (cdp, text) => {
    await front(cdp);
    await keyPress(cdp, 'KeyT', 't', 84);
    const opened = (await waitClient(cdp, 'window.__neon.chatOpen()', (v) => v === true, 25)) === true;
    await cdp.send('Input.insertText', { text });
    const typed = (await waitClient(cdp, 'window.__neon.chatInputValue()', (v) => v === text, 25)) === text;
    await keyPress(cdp, 'Enter', 'Enter', 13);
    return { opened, typed };
  };

  let idA = null; let idB = null; let idC = null; let idD = null;
  let pointerLocked = false;   // HAQIQIY pointer lock (kuchliroq sichqoncha dalili)

  try {
    // ================= TAYYORGARLIK =================
    const readyA = await waitReady(A);
    const readyB = await waitReady(B);
    const renderer = readyA.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software/i.test(renderer);

    // ---------- P9.1 real Chrome + real WebGL2/GPU ----------
    check(`P9.1 HAQIQIY Chrome oynasi + HAQIQIY WebGL2 GPU (protokol v${PROTOCOL_VERSION})`,
      readyA.gates?.webgl2 === true && readyB.gates?.webgl2 === true && !software,
      `renderer="${renderer.slice(0, 74)}" · software=${software} · A webgl2=${readyA.gates?.webgl2} B=${readyB.gates?.webgl2}`);

    // ---------- P9.3 Phase 1–8 + Phase 9 unit to'plamlari ----------
    const unit = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['--test', ...UNIT_FILES], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (b) => { out += b.toString(); });
      p.stderr.on('data', (b) => { out += b.toString(); });
      p.on('close', (code) => resolve({ code, out }));
    });
    const uTests = (unit.out.match(/^# tests (\d+)/m) || [])[1];
    const uPass = (unit.out.match(/^# pass (\d+)/m) || [])[1];
    const uFail = (unit.out.match(/^# fail (\d+)/m) || [])[1];
    check('P9.3 Phase 1–8 regressiyasi + Phase 9 unit to‘plamlari (npm test ekvivalenti) PASS',
      unit.code === 0 && uFail === '0' && Number(uPass) === Number(uTests),
      `tests=${uTests} pass=${uPass} fail=${uFail} exit=${unit.code}`);

    // ---------- host / join (HAQIQIY DOM kliklar) ----------
    for (let i = 0; i < 60; i++) {
      const ga = await A.evaluate('window.__neon.gates');
      const gb = await B.evaluate('window.__neon.gates');
      if (ga?.ws && gb?.ws) break;
      await sleep(200);
    }
    idA = await A.evaluate('window.__neon.lobbyPlayerId()');
    idB = await B.evaluate('window.__neon.lobbyPlayerId()');
    const hostClicked = await clickBtn(A, 'btnHost');
    await waitServer(() => lobbySess() && lobbySess().players.length === 1);
    const joinClicked = await clickBtn(B, 'btnJoin');
    await waitServer(() => lobbySess() && lobbySess().players.length === 2);

    const C = await rawJoin('raw-c');
    const D = await rawJoin('raw-d');
    idC = C.playerId; idD = D.playerId;
    await waitServer(() => lobbySess() && lobbySess().players.length === 4);

    // ---------- P9.4 ikki mustaqil klient ----------
    const gatesA = await A.evaluate('window.__neon.gates');
    const gatesB = await B.evaluate('window.__neon.gates');
    check('P9.4 IKKI mustaqil brauzer klienti (+2 xom WS) — alohida WS, alohida playerId',
      gatesA?.ws === true && gatesB?.ws === true && hostClicked && joinClicked &&
      server.state.connections.size >= 4 && new Set([idA, idB, idC, idD]).size === 4,
      `A=${idA} B=${idB} C=${idC} D=${idD} · ulanish=${server.state.connections.size} · lobby=${lobbySess()?.players.length}`);

    // ---------- P9.33 (1/3) guest START qila olmaydi ----------
    const guestBtnDisabled = await B.evaluate(`(function () {
      const b = document.getElementById('btnLobbyStart');
      return b ? !!b.disabled : null;
    })()`);
    D.send({ type: MSG.START_SESSION });
    const dStartErr = await D.next(MSG.ERROR, 4000).catch(() => null);
    const guestStartRejected = guestBtnDisabled === true && dStartErr?.code === 'not_host' &&
      match().state === MATCH_PHASE.NONE;

    // ---------- host START (HAQIQIY DOM klik) ----------
    const startClicked = await clickBtn(A, 'btnLobbyStart');
    const inGame = await waitServer(() => lobbySess() && lobbySess().state === 'in_game');
    if (!inGame) throw new Error('host START ishlamadi');

    // ---------- P9.33 (2/3) soxta jamoa/ball/raund da'volari ----------
    const teamsServer = { A: match().teams.A.slice(), B: match().teams.B.slice() };
    const roundBeforeForge = match().roundNumber;
    const forged = [
      { type: MSG.INPUT, seq: 910001, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, teamId: 'B' },
      { type: MSG.INPUT, seq: 910002, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, score: 9, scores: { A: 9, B: 0 } },
      { type: MSG.INPUT, seq: 910003, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundState: 'match_end', roundWinner: 'B', matchWinner: 'B' },
      { type: MSG.INPUT, seq: 910004, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundNumber: 42 },
      { type: MSG.INPUT, seq: 910005, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, match: { scores: { A: 9 } } }
    ];
    for (let i = 0; i < forged.length; i++) forged[i].seq += 100 * i;
    for (const m of forged) C.send(m);
    const ackReasons = [];
    for (let i = 0; i < forged.length; i++) {
      const ack = await C.next(MSG.INPUT_ACK, 3000).catch(() => null);
      ackReasons.push(ack ? ack.reason : 'TIMEOUT');
    }
    const roundAfterForge = match().roundNumber;
    const scoresAfterForge = { A: match().scores.A, B: match().scores.B };
    const matchAfterForge = match().state;
    const teamsAfterForge = { A: match().teams.A.slice(), B: match().teams.B.slice() };
    const forgedRejected = ackReasons.length === forged.length &&
      ackReasons.every((r) => r === 'forbidden_authority') &&
      scoresAfterForge.A === 0 && scoresAfterForge.B === 0 &&
      roundAfterForge === roundBeforeForge && matchAfterForge !== MATCH_PHASE.MATCH_END &&
      JSON.stringify(teamsAfterForge) === JSON.stringify(teamsServer);

    // ---------- P9.10/poydevor: raund LIVE ----------
    const live = await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 150, 100);
    if (!live) throw new Error('raund LIVE holatiga o‘tmadi');
    await waitClient(A, 'window.__neon.running', (v) => v === true);
    await waitClient(B, 'window.__neon.running', (v) => v === true);
    await sleep(600);
    await saveShot(A, 'p9-01-hud-live');

    // HAQIQIY pointer lock urinishi (foydalanuvchi jesti bilan) — muvaffaqiyatli
    // bo'lsa o'q HAQIQIY sichqoncha orqali otiladi (dalil kuchayadi).
    try {
      await A.evaluate(`(function () {
        const c = document.getElementById('gl');
        if (c && !document.pointerLockElement) c.click();
        return document.pointerLockElement !== null;
      })()`, { userGesture: true });
      await sleep(350);
      pointerLocked = await A.evaluate('document.pointerLockElement !== null');
      pointerLocked = (await pauseConsistent(A)).locked;
    } catch { pointerLocked = false; }

    // ---------- P9.2 WebGL2 render tirik (o'yin ishlayotganda) ----------
    const diagA0 = await A.evaluate('window.__neon.diagnostics()');
    check('P9.2 WebGL2 render ishlashda davom etadi (kadrlar chiziladi, kontekst tirik)',
      diagA0?.render?.calls > 0 && diagA0?.render?.triangles > 0 && readyA.gates?.webgl2 === true,
      `draw call=${diagA0?.render?.calls} · tri=${diagA0?.render?.triangles} · FPS=${diagA0?.fps?.fpsAvg} · shadowMap=${diagA0?.render?.shadowMap}`);

    // ================= P9.5 — AVTORITAR HP HUD DA =================
    // B (haqiqiy brauzer) A ni otadi → zarar SERVERDA yoziladi → A HUD i
    // AVTORITAR qiymatni ko'rsatishi shart (lokal bashorat EMAS).
    placeAll();
    await waitLocalNear(A, idA);
    const shot = await damageOnce(B, idB, idA);           // bitta zarba — o'ldirmasdan
    const hpRaw = shot.hpAfter;                            // server qiymati (falloff → kasr)
    const hpServer = Math.round(hpRaw);                    // HUD ko'rsatadigan qiymat
    const aliveServer = reqSess(idA).state.health.alive;
    // HUD 20 Hz STATE oladi — qiymat yetib kelguncha kutamiz (poysa EMAS)
    const hudA1 = await waitClient(A, 'window.__neon.hudAuthority()',
      (v) => v && v.view && v.view.hp === hpServer, 40);
    const damaged = hpRaw < shot.hpBefore && hpRaw > 0;
    check('P9.5 avtoritar HP HUD da — B otgan zarar SERVERDA yozildi va HUD aynan shu qiymatni ko‘rsatadi',
      shot.shots > 0 && damaged && aliveServer === true &&
      hudA1?.source === 'server' && hudA1?.view?.hp === hpServer &&
      hudA1?.dom?.hp === String(hpServer) && hudA1?.view?.alive === true,
      `server HP ${shot.hpBefore} → ${hpRaw} (ko‘rsatiladigan ${hpServer}, o‘q=${shot.shots}, ${shot.viaMouse ? 'real-mouse' : 'input-manager'}) · HUD view=${hudA1?.view?.hp} DOM=${hudA1?.dom?.hp} · manba=${hudA1?.source}`);

    // ================= P9.6 — AVTORITAR O'Q-DORI + RELOAD HUD DA =================
    const magBefore = sessWeapon(idA).mag;
    const fired = await fireUntilMagDrops(A, idA);
    const magServer = fired.after;
    const hudA2 = await waitClient(A, 'window.__neon.hudAuthority()',
      (v) => v && v.view && v.view.mag === magServer, 40);
    // reload — HAQIQIY yo'l (input manager intent), tugashini SERVER belgilaydi
    await A.evaluate('window.__neon.requestReload()');
    const reloading = await waitClient(A, 'window.__neon.serverState().weapon.reloading', (v) => v === true, 30);
    const hudReload = await A.evaluate('window.__neon.hudAuthority()');
    const reloadDone = await waitClient(A, 'window.__neon.serverState().weapon.reloading', (v) => v === false, 60);
    await sleep(150);
    const afterReload = sessWeapon(idA);
    const hudA3 = await waitClient(A, 'window.__neon.hudAuthority()',
      (v) => v && v.view && v.view.mag === afterReload.mag && !v.view.reloading, 40);
    check('P9.6 avtoritar o‘q-dori + reload HUD da (server mag/reserve/reload ustuvor)',
      magServer < magBefore && hudA2?.dom?.mag === String(magServer) &&
      hudA2?.view?.mag === magServer && fired.viaMouse !== null &&
      reloading === true && hudReload?.view?.reloading === true &&
      reloadDone === false && afterReload.mag === 30 &&
      hudA3?.view?.mag === afterReload.mag && hudA3?.dom?.mag === String(afterReload.mag) &&
      hudA3?.view?.reserve === afterReload.reserve,
      `mag ${magBefore}→${magServer} (${fired.viaMouse ? 'real-mouse' : 'input-manager'}), reload ${reloading ? 'ko‘rindi' : 'ko‘rinmadi'}, mag ${afterReload.mag}/reserve ${afterReload.reserve} · HUD=${hudA3?.dom?.mag}/${hudA3?.dom?.reserve} · manba=${hudA3?.source}`);

    // ================= P9.7 / P9.8 / P9.9 — JAMOA / BALL / RAUND =================
    const hudA4 = await A.evaluate('window.__neon.hudAuthority()');
    const chipsA = await A.evaluate('window.__neon.hudChips()');
    const teamA = match().teams.A.includes(idA) ? TEAM.A : TEAM.B;
    check('P9.7 o‘z jamoasi HUD da — qiymat SERVER match.teams bilan bir xil',
      hudA4?.view?.team === teamA && String(chipsA?.team || '').includes(teamA) &&
      String(chipsA?.me || '').includes(idA),
      `server jamoa=${teamA} · HUD view=${hudA4?.view?.team} chip="${chipsA?.team}" · ID chip="${chipsA?.me}"`);

    const scoreText = `A ${match().scores.A} : ${match().scores.B} B`;
    check('P9.8 avtoritar ball HUD da (klient hisoblamaydi)',
      hudA4?.view?.scores?.A === match().scores.A && hudA4?.view?.scores?.B === match().scores.B &&
      chipsA?.matchLine?.score === scoreText,
      `server A=${match().scores.A} B=${match().scores.B} · HUD="${chipsA?.matchLine?.score}" (kutilgan "${scoreText}")`);

    check('P9.9 raund holati/raqami HUD da server bilan mos',
      hudA4?.view?.roundNumber === match().roundNumber && hudA4?.view?.roundState === match().roundState &&
      String(chipsA?.matchLine?.round || '').includes(String(match().roundNumber)) &&
      String(chipsA?.matchLine?.round || '').includes('LIVE'),
      `server round=${match().roundNumber}/${match().roundState} · HUD="${chipsA?.matchLine?.round}"`);

    // ================= P9.17–P9.20 — CHAT (HAQIQIY klaviatura) =================
    const chatBefore = chat().accepted;
    const typed = await typeAndSendChat(A, 'salom B, HUD tayyor');
    const chatAfter = await waitServer(() => chat().accepted > chatBefore, 60, 100);
    const lastChat = chat().entries[chat().entries.length - 1] || null;
    const aChat = await A.evaluate('window.__neon.chatState()');
    check('P9.17/P9.18 klient A HAQIQIY klaviatura bilan chat yubordi va SERVER qabul qildi',
      typed.opened === true && typed.typed === true && chatAfter === true &&
      lastChat?.text === 'salom B, HUD tayyor',
      `chat ochildi=${typed.opened} matn yozildi=${typed.typed} · server qabul=${chat().accepted - chatBefore} · matn="${lastChat?.text}"`);

    const bChat = await waitClient(B, 'window.__neon.chatState()',
      (v) => v && v.messages > 0 && v.last && v.last.text === 'salom B, HUD tayyor', 40);
    const bLog = await B.evaluate('window.__neon.chatLog()');
    check('P9.19 klient B A ning chatini oldi (klient → SERVER → klient)',
      bChat?.last?.text === 'salom B, HUD tayyor' &&
      (bLog || []).some((t) => t.includes('salom B, HUD tayyor')) &&
      (bLog || []).some((t) => t.includes('[p')),
      `B xabarlari=${bChat?.messages} · B ro‘yxati=[${(bLog || []).join(' | ').slice(0, 80)}]`);
    await saveShot(B, 'p9-02-chat-b');

    check('P9.20 yuboruvchi KIMLIGI serverdan (klient faqat matn yuboradi)',
      lastChat?.playerId === idA && aChat?.last?.playerId === idA &&
      bChat?.last?.playerId === idA && typeof bChat?.last?.name === 'string',
      `server playerId=${lastChat?.playerId} · A ko‘rgani=${aChat?.last?.playerId} · B ko‘rgani=${bChat?.last?.playerId}/${bChat?.last?.name} · A id=${idA}`);

    // ================= P9.21–P9.25 — CHAT XAVFSIZLIGI =================
    const maxLenAttr = await A.evaluate('(function(){ const i=document.getElementById("chatInput"); return i ? Number(i.maxLength) : null; })()');
    const chatBeforeLong = chat().accepted;
    C.send({ type: MSG.CHAT, text: 'x'.repeat(CHAT.MAX_LEN + 1) });
    const longErr = await C.next(MSG.ERROR, 4000).catch(() => null);
    check('P9.21 UZUN chat rad etiladi (server chegarasi + HUD maxLength)',
      longErr?.code === 'chat_too_long' && chat().accepted === chatBeforeLong && maxLenAttr === CHAT.MAX_LEN,
      `server javobi=${longErr?.code} · qabul o‘zgarmadi=${chat().accepted === chatBeforeLong} · input maxLength=${maxLenAttr}`);

    // buzilgan/xato chat + keyin HAQIQIY chat ishlashi
    while (C.q.some((m) => m.type === MSG.ERROR)) await C.next(MSG.ERROR);
    const acceptedBeforeBad = chat().accepted;
    C.ws.send('{ bu JSON emas');
    const eJson = await C.next(MSG.ERROR, 3000).catch(() => null);
    C.send({ type: 'chat-noma-lum', text: 'x' });
    const eUnknown = await C.next(MSG.ERROR, 3000).catch(() => null);
    C.send({ type: MSG.CHAT, text: 42 });
    const eText = await C.next(MSG.ERROR, 3000).catch(() => null);
    const badType = eText || eUnknown || eJson;
    const healthy = await (async () => {
      C.send({ type: MSG.CHAT, text: 'server tirikmi?' });
      // eski navbatdagi xabarlar aralashmasin — AYNAN shu matnni kutamiz
      const got = await rawUntil(C, MSG.CHAT_MSG, (m) => m && m.text === 'server tirikmi?', 40);
      return got?.text === 'server tirikmi?';
    })();
    const telBad = server.telemetry();
    check('P9.22 buzilgan/begona chat serverni YIQITMAYDI (keyin chat ishlaydi, tick xatosi yo‘q)',
      healthy === true && telBad.tickErrors === 0 && !!badType &&
      telBad.chat.accepted === acceptedBeforeBad + 1,
      `javoblar=[${[eJson?.code, eUnknown?.code, eText?.code].join(', ')}] · keyingi chat ishladi=${healthy} · tickErrors=${telBad.tickErrors} · qabul=${telBad.chat.accepted}`);

    // sessiyadan tashqaridagi o'yinchi chatni KO'RMAYDI
    const outsider = new RawClient(WS_URL);
    rawClients.push(outsider);
    await outsider.open();
    outsider.send({ type: MSG.HELLO, name: 'outsider' });
    await outsider.next(MSG.SESSION);
    outsider.send({ type: MSG.CHAT, text: 'men tashqaridaman' });
    const outsiderErr = await outsider.next(MSG.ERROR).catch(() => null);
    const outBefore = chat().accepted;
    C.send({ type: MSG.CHAT, text: 'faqat sessiya uchun' });
    await sleep(500);
    const leakedToOutsider = outsider.count(MSG.CHAT_MSG);
    check('P9.23 chat SESSIYA-ICHIDA (a’zo bo‘lmagan olmaydi, tashqariga chiqmaydi)',
      outsiderErr?.code === 'chat_no_session' && leakedToOutsider === 0 &&
      chat().accepted > outBefore,
      `begona so‘rovi=${outsiderErr?.code} · begonaga yetgan xabar=${leakedToOutsider}`);

    // FLOOD himoyasi (server tomonda)
    const floodBase = chat().accepted;
    const limitedBase = chat().rejections.chat_rate_limited || 0;
    for (let i = 0; i < CHAT.BURST + 4; i++) C.send({ type: MSG.CHAT, text: 'flood-' + i });
    await sleep(500);
    const floodAccepted = chat().accepted - floodBase;
    const floodLimited = (chat().rejections.chat_rate_limited || 0) - limitedBase;
    check('P9.24 flood himoyasi — chegaradan keyingi chatlar RAD (ko‘paytirish yo‘q)',
      floodAccepted <= CHAT.BURST && floodLimited >= 4,
      `qabul=${floodAccepted}/${CHAT.BURST} · rate_limited=${floodLimited} · oyna=${CHAT.WINDOW_MS}ms`);

    // soxta yuboruvchi kimligi (navbat tozalanadi — eski ERROR lar aralashmasin)
    while (C.q.some((m) => m.type === MSG.ERROR)) await C.next(MSG.ERROR);
    const beforeForge = chat().entries.length;
    const forgedLast = chat().entries[chat().entries.length - 1];
    C.send({ type: MSG.CHAT, text: 'men p999 man', playerId: 'p999' });
    C.send({ type: MSG.CHAT, text: 'men hostman', name: 'host', teamId: TEAM.B });
    await sleep(250);
    const forgeErrs = [];
    while (C.q.some((m) => m.type === MSG.ERROR)) forgeErrs.push((await C.next(MSG.ERROR)).code);
    const afterForgeEntries = chat().entries.length;
    check('P9.25 soxta yuboruvchi kimligi RAD etiladi (xabar tarqatilmaydi)',
      forgeErrs.length >= 2 && forgeErrs.every((c) => c === 'forbidden_authority') &&
      afterForgeEntries === beforeForge &&
      chat().entries[chat().entries.length - 1]?.playerId === forgedLast?.playerId,
      `rad sabablari=[${forgeErrs.join(', ')}] · tarix o‘zgarmadi=${afterForgeEntries === beforeForge}`);

    // ================= P9.14 / P9.27 — KO'RINISH (o'yin ichida) =================
    const vis1 = await A.evaluate('window.__neon.overlayVisibility()');
    const diagVis = await A.evaluate('window.__neon.diagnostics()');
    const pause1 = await pauseConsistent(A);
    check('P9.14 lobby → gameplay o‘tishi toza (lobby yashirin, pauza faqat pointer lock yo‘qligida)',
      diagVis?.running === true &&
      (await A.evaluate('(function(){ return document.getElementById("menu").hidden === true && document.getElementById("stage").hidden === false; })()')) === true &&
      pause1.consistent === true && (!pause1.locked || vis1?.pause?.topAtCenter === false) &&
      vis1?.chDead?.display === 'none' && vis1?.matchHud?.display !== 'none' &&
      vis1?.chatPanel?.display !== 'none',
      `running=${diagVis?.running} · pointerLock=${pause1.locked} pauza=${pause1.display}(top=${vis1?.pause?.topAtCenter}) mos=${pause1.consistent} · o‘lim oynasi=${vis1?.chDead?.display} · match HUD=${vis1?.matchHud?.display} · chat=${vis1?.chatPanel?.display}`);

    const cross1 = await A.evaluate(`(function () {
      const el = document.getElementById('chCrosshair');
      const bars = [...el.querySelectorAll('i')].filter((b) => {
        const c = getComputedStyle(b); const r = b.getBoundingClientRect();
        return c.display !== 'none' && c.visibility !== 'hidden' && r.width > 0 && r.height > 0 &&
          /rgba?\\(\\s*5\\d\\s*,\\s*20\\d\\s*,\\s*25\\d/.test(c.backgroundColor);
      }).length;
      const r = el.getBoundingClientRect();
      const off = Math.hypot((r.x + r.width / 2) - window.innerWidth / 2, (r.y + r.height / 2) - window.innerHeight / 2);
      return { bars, off, vw: window.innerWidth, vh: window.innerHeight, connected: el.isConnected };
    })()`);
    check('P9.27 crosshair markazda qoladi (reload/overlay qatlamlaridan keyin ham)',
      cross1.connected === true && cross1.bars === 4 && cross1.off <= 2,
      `bars=${cross1.bars} · markazdan chetlanish=${cross1.off.toFixed(2)}px · viewport=${cross1.vw}×${cross1.vh}`);

    // ================= P9.10 — RAUND TUGASHI (haqiqiy o'lim → ball) =================
    const scoreBeforeA = { A: match().scores.A, B: match().scores.B };
    const roundBefore = match().roundNumber;
    const wonA = await roundWinForA();
    const roundState1 = match().roundState;
    const scoreAfterA = { A: match().scores.A, B: match().scores.B };
    // KLIENT 20 Hz snapshot + 5 Hz HUD yangilanishini kutadi (poysa EMAS)
    const overlayRoundEnd = await waitClient(A, 'window.__neon.overlay()',
      (o) => o && o.visible === true && /^ROUND \d+ OVER$/.test(o.title || ''), 40);
    const hudRoundEnd = await A.evaluate('window.__neon.hudAuthority()');
    const chipsRoundEnd = await A.evaluate('window.__neon.hudChips()');
    await saveShot(A, 'p9-03-round-end');
    check('P9.10 raund tugashi HUD da ko‘rinadi — AVTORITAR g‘olib va ball bilan',
      wonA === true && scoreAfterA.A === scoreBeforeA.A + 1 && scoreAfterA.B === scoreBeforeA.B &&
      hudRoundEnd?.view?.roundWinner === TEAM.A &&
      hudRoundEnd?.view?.scores?.A === scoreAfterA.A &&
      chipsRoundEnd?.matchLine?.score === `A ${scoreAfterA.A} : ${scoreAfterA.B} B` &&
      overlayRoundEnd?.title === `ROUND ${roundBefore} OVER` &&
      /TEAM A WINS/.test(overlayRoundEnd?.sub || ''),
      `round ${roundBefore} g‘olib=${hudRoundEnd?.view?.roundWinner} · server ball A=${scoreAfterA.A} B=${scoreAfterA.B} · overlay="${overlayRoundEnd?.title} / ${overlayRoundEnd?.sub}"`);

    // ---------- P9.15 gameplay → round-end o'tishi toza ----------
    check('P9.15 gameplay → round-end o‘tishi toza (banner KO‘RINADI, eski lobby oynasi qaytmaydi)',
      roundState1 === MATCH_PHASE.ROUND_END && overlayRoundEnd?.visible === true &&
      overlayRoundEnd?.kind === 'round' &&
      overlayRoundEnd?.hidden === false &&
      (await A.evaluate('(function(){ return document.getElementById("menu").hidden === true; })()')) === true &&
      (await pauseConsistent(A)).consistent === true,
      `roundState=${roundState1} · banner ko‘rinadi=${overlayRoundEnd?.visible} turi=${overlayRoundEnd?.kind} · lobby oynasi yashirin=true · pauza holati mos=true`);

    // ================= P9.11 — KEYINGI RAUNDDA HUD TIKLANADI =================
    const round2 = await waitServer(() => match().roundNumber === roundBefore + 1 && match().roundState === MATCH_PHASE.LIVE, 250, 100);
    await sleep(500);
    // A o'ladi (2-raund) → HUD o'lim ekranini ko'rsatishi kerak (avtoritar o'lim)
    placeAll();
    await waitLocalNear(B, idB);
    const killA = await killFrom(B, idB, idA, 16);
    const deadServer = !sessionOf(idA).state.health.alive;
    // HUD DOM kadrda yangilanadi — o'lim holati "o'rnashguncha" kutamiz
    const hudDead = await waitClient(A, 'window.__neon.hudAuthority()',
      (v) => v && v.dom && v.dom.dead === true && v.view && v.view.alive === false, 40);
    const visDead = await waitClient(A, 'window.__neon.overlayVisibility()',
      (v) => v && v.chDead && v.chDead.display !== 'none', 40);
    const deadText = await A.evaluate('(function(){ const t=document.getElementById("chDeadTitle"); const w=document.getElementById("chDeadWait"); const r=document.getElementById("chDeadRespawn"); return { title: t?t.textContent:null, waitHidden: w?!!w.hidden:null, respawnHidden: r?!!r.hidden:null }; })()');
    check('P9.5b avtoritar O‘LIM HUD da — server o‘limni yozdi, HUD o‘lim ekranini ko‘rsatdi',
      killA.dead === true && deadServer === true && hudDead?.view?.alive === false &&
      hudDead?.view?.hp === 0 && hudDead?.dom?.dead === true &&
      visDead?.chDead?.display !== 'none' && deadText.title === 'ELIMINATED' &&
      deadText.waitHidden === false && deadText.respawnHidden === true,
      `server alive=${!deadServer} HP=${sessionOf(idA).state.health.hp} · HUD "${deadText.title}" (kutish satri ko‘rinadi=${!deadText.waitHidden}) · o‘lim oynasi=${visDead?.chDead?.display}`);

    const bShotsBefore = (sessionOf(idB) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted;
    const wonB = await roundWinForB();
    const scoreAfterB = { A: match().scores.A, B: match().scores.B };
    const cState = sessionOf(idC) ? sessionOf(idC).state.health : null;
    const bShots = (sessionOf(idB) || { counters: { shotsAccepted: 0 } }).counters.shotsAccepted - bShotsBefore;
    const bFireReasons = JSON.stringify(sessionOf(idB) ? sessionOf(idB).fireReasons : {});
    await saveShot(A, 'p9-04-next-round');
    const backAlive = await waitServer(() => sessionOf(idA).state.health.alive === true, 200, 100);
    await sleep(400);
    const hudNext = await A.evaluate('window.__neon.hudAuthority()');
    const overlayNext = await A.evaluate('window.__neon.overlay()');
    const chipsNext = await A.evaluate('window.__neon.hudChips()');
    check('P9.11 keyingi raundda HUD tiklanishi — HP 100, tirik, ball SAQLANADI, banner yo‘qoladi',
      round2 === true && wonB === true && scoreAfterB.A === scoreAfterA.A &&
      scoreAfterB.B === scoreAfterA.B + 1 && backAlive === true &&
      hudNext?.view?.hp === 100 && hudNext?.view?.alive === true &&
      hudNext?.dom?.hp === '100' &&
      chipsNext?.matchLine?.score === `A ${scoreAfterB.A} : ${scoreAfterB.B} B` &&
      overlayNext?.hidden === true && overlayNext?.visible === false,
      `ball A=${scoreAfterB.A} B=${scoreAfterB.B} (oldin A=${scoreAfterA.A} B=${scoreAfterA.B}) · B o‘qlari=${bShots} (rad: ${bFireReasons}) · C HP=${cState ? cState.hp : '—'} alive=${cState ? cState.alive : '—'} · tirik A=${match().lives.A} B=${match().lives.B} · HUD HP=${hudNext?.dom?.hp} · banner yashirin=${overlayNext?.hidden}`);

    // ================= P9.12 / P9.16 — MATCH_END =================
    let rounds = 0;
    while (match().state !== MATCH_PHASE.MATCH_END && rounds < 10) {
      rounds += 1;
      if (!(await roundWinForA())) break;
      await sleep(200);
    }
    const matchEnded = match().state === MATCH_PHASE.MATCH_END;
    const finalScores = { A: match().scores.A, B: match().scores.B };
    const roundAtEnd = match().roundNumber;
    const overlayEnd = await A.evaluate('window.__neon.overlay()');
    const overlayEndB = await B.evaluate('window.__neon.overlay()');
    const hudEnd = await A.evaluate('window.__neon.hudAuthority()');
    const chipsEnd = await A.evaluate('window.__neon.hudChips()');
    const visEnd = await A.evaluate('window.__neon.overlayVisibility()');
    await saveShot(A, 'p9-05-match-end');
    check('P9.12 MATCH_END natijasi HUD da — AVTORITAR g‘olib va yakuniy ball',
      matchEnded === true &&
      finalScores.A === MATCH_RULES.ROUNDS_TO_WIN && finalScores.B === scoreAfterB.B &&
      hudEnd?.view?.matchWinner === TEAM.A && hudEnd?.view?.matchState === MATCH_PHASE.MATCH_END &&
      chipsEnd?.matchLine?.score === `A ${finalScores.A} : ${finalScores.B} B` &&
      /MATCH COMPLETE/.test(overlayEnd?.title || '') && /TEAM A WINS/.test(overlayEnd?.sub || ''),
      `state=${match().state} g‘olib=${hudEnd?.view?.matchWinner} · ball A=${finalScores.A} B=${finalScores.B} · overlay="${overlayEnd?.title} / ${overlayEnd?.sub}"`);

    check('P9.16 MATCH_END KO‘RINADI (banner ekranda, ikki klientda ham, yangi raund boshlanmaydi)',
      visEnd?.roundBanner?.display !== 'none' && visEnd?.roundBanner?.hidden === false &&
      visEnd?.roundBanner?.topAtCenter !== true &&
      overlayEndB?.visible === true && /MATCH COMPLETE/.test(overlayEndB?.title || '') &&
      match().roundNumber === roundAtEnd &&
      (await waitServer(() => match().roundNumber === roundAtEnd, 10, 200)),
      `A banner="${overlayEnd?.title}" ko‘rinadi=${overlayEnd?.visible} · B banner="${overlayEndB?.title}" · raund ${roundAtEnd} (o‘zgarmadi=${match().roundNumber === roundAtEnd})`);

    // ================= P9.26 — ESKI OVERLAY QOLMAYDI =================
    const visAfter = await A.evaluate('window.__neon.overlayVisibility()');
    const logAfter = await A.evaluate('window.__neon.chatLog()');
    const domState = await A.evaluate(`(function () {
      const m = document.getElementById('menu');
      const st = document.getElementById('stage');
      const p = document.getElementById('pause');
      return {
        menuHidden: m.hidden, stageHidden: st.hidden,
        pauseHidden: p.hidden, pauseDisplay: getComputedStyle(p).display,
        deadDisplay: getComputedStyle(document.getElementById('chDead')).display,
        combatHudDisplay: getComputedStyle(document.getElementById('combatHud')).display
      };
    })()`);
    const pauseAfter = await pauseConsistent(A);
    check('P9.26 holat o‘tishlaridan keyin eski overlay/lobby oynasi QOLMAYDI',
      domState.menuHidden === true && domState.stageHidden === false &&
      pauseAfter.consistent === true &&
      domState.deadDisplay === 'none' && domState.combatHudDisplay !== 'none' &&
      visAfter?.roundBanner?.display !== 'none' &&
      Array.isArray(logAfter) && logAfter.length > 0,
      `menu yashirin=${domState.menuHidden} · pauza=${pauseAfter.display}(mos=${pauseAfter.consistent}, lock=${pauseAfter.locked}) · o‘lim=${domState.deadDisplay} · combat HUD=${domState.combatHudDisplay} · banner=${visAfter?.roundBanner?.display} · chat yozuvlari=${logAfter?.length}`);

    // ================= P9.28 — KICHIK VIEWPORT =================
    await A.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const small = await A.evaluate(`(function () {
      const el = document.getElementById('chCrosshair');
      const r = el.getBoundingClientRect();
      const off = Math.hypot((r.x + r.width / 2) - window.innerWidth / 2, (r.y + r.height / 2) - window.innerHeight / 2);
      const inside = (id) => {
        const e = document.getElementById(id);
        if (!e) return false;
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.left >= -1 && b.top >= -1 &&
          b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1;
      };
      const vis = (id) => { const e = document.getElementById(id); return e ? getComputedStyle(e).display !== 'none' : false; };
      return {
        vw: window.innerWidth, vh: window.innerHeight, off,
        hudTop: inside('hudFps'), ammo: inside('chAmmoBlock'), hp: inside('chHealthBar'),
        chat: inside('chatPanel'), match: inside('matchHud'),
        connVisible: vis('hudConn'), teamVisible: vis('hudTeam'),
        battle: document.getElementById('chHp').textContent
      };
    })()`);
    await saveShot(A, 'p9-06-small-viewport');
    await A.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
    const restored = await A.evaluate('(function(){ return { vw: window.innerWidth, vh: window.innerHeight }; })()');
    check('P9.28 kichik viewportda HUD o‘qiladi (crosshair markazda, panellar ekran ichida)',
      small.vw === 800 && small.vh === 600 && small.off <= 2 &&
      small.hudTop && small.ammo && small.hp && small.chat && small.match &&
      small.connVisible && small.teamVisible && small.battle !== undefined,
      `viewport=${small.vw}×${small.vh} crosshair chetlanish=${small.off?.toFixed(2)}px · HUD chip=${small.hudTop} ammo=${small.ammo} HP=${small.hp} chat=${small.chat} match=${small.match} (qaytarildi ${restored.vw}×${restored.vh})`);

    // ================= P9.13 — ULANISH HOLATI (HAQIQIY) =================
    const connOn = await B.evaluate('window.__neon.connection()');
    const viewOn = await B.evaluate('window.__neon.hudView()');
    const dropped = await B.evaluate('window.__neon.dropSocket()');
    const connOff = await waitClient(B, 'window.__neon.connection()',
      (v) => v && v.readyState !== 1 && v.badge && v.badge.cls === 'bad', 40);
    const viewOff = await B.evaluate('window.__neon.hudView()');
    check('P9.13 ulanish holati HAQIQIY WS holatidan (ulangan → uzilgan ko‘rsatadi)',
      connOn?.connected === true && connOn?.readyState === 1 &&
      String(connOn?.badge?.className || '').includes('ok') &&
      viewOn?.connection?.state === 'connected' &&
      dropped === true && connOff?.readyState !== 1 &&
      String(connOff?.badge?.className || '').includes('bad') &&
      viewOff?.connection?.state === 'disconnected',
      `oldin: readyState=${connOn?.readyState} "${connOn?.badge?.text}" (${connOn?.badge?.className}) · keyin: readyState=${connOff?.readyState} "${connOff?.badge?.text}" (${connOff?.badge?.className}) · HUD=${viewOff?.connection?.state}`);
    await saveShot(B, 'p9-07-offline-b');

    // ================= P9.31 — P5 AVTORITETI SAQLANGAN =================
    const hpBeforeForge = reqSess(idA).state.health.hp;
    const magBeforeForge = sessWeapon(idA).mag;
    const hpForged = [
      { type: MSG.INPUT, seq: 920001, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, damage: 100 },
      { type: MSG.INPUT, seq: 920002, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, targetHp: 0, hit: true },
      { type: MSG.INPUT, seq: 920003, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, hp: 9999, ammo: 999, cooldown: 0 },
      { type: MSG.INPUT, seq: 920004, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [NaN, 0, 1] } },
      { type: MSG.INPUT, seq: 920005, pose: { x: 0, y: 0, z: Infinity, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] } }
    ];
    for (const m of hpForged) C.send(m);
    const p5Reasons = [];
    for (let i = 0; i < hpForged.length; i++) {
      const ack = await C.next(MSG.INPUT_ACK, 3000).catch(() => null);
      p5Reasons.push(ack ? ack.reason : 'TIMEOUT');
    }
    const hpAfterForge = sessionOf(idA).state.health.hp;
    const magAfterForge = sessWeapon(idA).mag;
    check('P9.31 P5 avtoriteti saqlangan — zarar/HP/o‘q-dori/aim/pose da’volari RAD, holat o‘zgarmadi',
      p5Reasons.length === hpForged.length &&
      p5Reasons.every((r) => ['forbidden_authority', 'bad_aim', 'bad_pose'].includes(r)) &&
      hpAfterForge === hpBeforeForge && magAfterForge === magBeforeForge,
      `rad sabablari=[${p5Reasons.join(', ')}] · HP ${hpBeforeForge}=${hpAfterForge} · mag ${magBeforeForge}=${magAfterForge}`);

    // ================= P9.32 — P7 SINXRONIZATSIYA SAQLANGAN =================
    const snapsA = await A.evaluate('window.__neon.serverSnapshots()');
    const mpA = await A.evaluate('window.__neon.multiplayerQa()');
    const snapsC = await C.next(MSG.SNAPSHOT, 4000).catch(() => null);
    check('P9.32 P7 sinxronizatsiyasi saqlangan (snapshot maydonlari, ack, interpolyatsiya)',
      snapsA?.messages > 0 && snapsA?.ackSeq >= 0 && snapsA?.serverTick > 0 &&
      Array.isArray(snapsA?.shape) && snapsA.shape.length >= 8 &&
      snapsA.shape.includes('teamId') && snapsA.shape.includes('hp') && snapsA.shape.includes('alive') &&
      snapsC && Array.isArray(snapsC.players) && snapsC.players.length >= 2 &&
      typeof snapsC.match?.matchState === 'string' &&
      (mpA?.interpolation?.samples || 0) > 0,
      `snapshot xabarlari=${snapsA?.messages} ackSeq=${snapsA?.ackSeq} maydonlar=[${snapsA?.shape.join(',')}] · server snapshot o‘yinchilari=${snapsC?.players?.length} · interp namunalari=${mpA?.interpolation?.samples}`);

    // ================= P9.33 (3/3) — P8 avtoriteti =================
    const hudFinal = await A.evaluate('window.__neon.hudAuthority()');
    // Jamoalar faqat QONUNIY uzilish bilan qisqarishi mumkin: soxta da'vo
    // hech kimni qo'shmagan/olib tashlamaganini "qism-to'plam" bilan isbotlaymiz
    // (P9.13 da B uzildi — shuning uchun exact tenglik emas, subset tengligi).
    const teamsNow = { A: match().teams.A.slice(), B: match().teams.B.slice() };
    const teamsIntact = teamsNow.A.every((p) => teamsServer.A.includes(p)) &&
      teamsNow.B.every((p) => teamsServer.B.includes(p));
    const hudServerSynced = hudFinal?.view?.scores?.A === match().scores.A &&
      hudFinal?.view?.scores?.B === match().scores.B &&
      hudFinal?.view?.matchWinner === match().matchWinner;
    check('P9.33 P8 jamoa/raund/ball avtoriteti saqlangan (guest START rad, soxta da’vo rad, HUD ↔ server mos)',
      guestStartRejected === true && forgedRejected === true && teamsIntact === true &&
      hudServerSynced === true,
      `guest START rad=${guestStartRejected} · soxta da’volar rad=[${ackReasons.join(', ')}] (${forgedRejected}) · raund ${roundBeforeForge}→${roundAfterForge} · soxta ball A=${scoresAfterForge.A} B=${scoresAfterForge.B} · HUD↔server mos=${hudServerSynced} (HUD A=${hudFinal?.view?.scores?.A} B=${hudFinal?.view?.scores?.B}/g‘olib=${hudFinal?.view?.matchWinner} · server A=${match().scores.A} B=${match().scores.B}/g‘olib=${match().matchWinner}) · jamoalar soxta da’vo bilan o‘zgarmadi=${teamsIntact} (A=[${teamsNow.A}] B=[${teamsNow.B}] ⊆ boshlang‘ich)`);

    // ================= P9.34 — P10+ KIRMAGAN =================
    const p10 = /spectat|replay|voip|voice|matchmak|ranking|scoreboard|killfeed|inventory|lobbybrowser|friend|clan|achievement|profile|account/i;
    const forbiddenKinds = Object.keys(MSG).filter((k) => p10.test(k));
    const neonKeys = await A.evaluate('Object.keys(window.__neon)');
    const forbiddenApi = (neonKeys || []).filter((k) => p10.test(k));
    const telObj = server.telemetry();
    const forbiddenTelemetry = Object.keys(telObj).filter((k) => p10.test(k));
    // MURNIY tekshiruv: Phase 9 chat MATN qoidalari P10 tizimlariga bog'lanmaydi
    const chatMod = fs.readFileSync(new URL('../server/chat.js', import.meta.url), 'utf8');
    const chatClean = !p10.test(chatMod.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' '));
    check('P9.34 P10+ o‘yin tizimlari YO‘Q (spectator/replay/voip/matchmaking/ranking/scoreboard)',
      forbiddenKinds.length === 0 && forbiddenApi.length === 0 &&
      forbiddenTelemetry.length === 0 && chatClean,
      `xabar turlari=${Object.keys(MSG).length} taqiqlangan=[${forbiddenKinds.join(',')}] · __neon API taqiqlangan=[${forbiddenApi.join(',')}] · telemetriya=[${forbiddenTelemetry.join(',')}]`);

    // ================= P9.29 — RUNTIME XATOLAR YO'Q =================
    const exceptions = [...A.exceptions, ...B.exceptions];
    const consoleErrs = [...consoleErrors(A), ...consoleErrors(B)];
    const neonErrorsA = await A.evaluate('window.__neon.errors.length');
    const neonErrorsB = await B.evaluate('window.__neon.errors.length');
    const loopErrors = await A.evaluate('window.__neon.diagnostics().loopErrors');
    check('P9.29 runtime/console xatolari YO‘Q (istisno, unhandled, loop xatosi)',
      exceptions.length === 0 && consoleErrs.length === 0 &&
      neonErrorsA === 0 && neonErrorsB === 0 && loopErrors === 0,
      `CDP istisno=${exceptions.length} · console.error=${consoleErrs.length} · __neonErrors A=${neonErrorsA} B=${neonErrorsB} · loop xatosi=${loopErrors}`);

    // ================= P9.30 — SERVER TICK XATOSIZ =================
    const tel = server.telemetry();
    check('P9.30 server tickErrors = 0 (chat/match/HUD yuki ostida ham)',
      tel.tickErrors === 0 && tel.totals.ticks > 100 && tel.totals.snapshots > 100,
      `tick=${tel.totals.ticks} snapshot=${tel.totals.snapshots} tickErrors=${tel.tickErrors} loop=${tel.loopMs}ms`);

    // ---------- hisobot ----------
    const perf = await A.evaluate('window.__neon.diagnostics()');
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 9,
      subject: 'hud-polish-chat',
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      protocol: PROTOCOL_VERSION,
      gpu: { renderer, software, webgl2: readyA.gates?.webgl2 === true },
      twoClient: {
        method: 'two independent Chrome PROCESSES (separate CDP ports ' + CDP_PORT_A + '/' + CDP_PORT_B +
          ' + separate profiles + separate WS + separate window.__neon + separate rAF loop) ' +
          '+ 2 xom WebSocket klient (C/D) + 1 begona (sessiyasiz)',
        chromePids: { A: chromeA.child.pid, B: chromeB.child.pid },
        pageA: { playerId: idA, sessionId: lobbySess()?.id },
        pageB: { playerId: idB, sessionId: lobbySess()?.id },
        raw: { C: idC, D: idD, outsider: 'hello-only' },
        pointerLock: pointerLocked
      },
      hud: {
        source: hudFinal?.source,
        authority: 'server STATE (HP/o‘q-dori/reload) + SNAPSHOT.match (jamoa/raund/ball)',
        chatMaxLen: CHAT.MAX_LEN,
        chatBurst: CHAT.BURST,
        chatWindowMs: CHAT.WINDOW_MS
      },
      chat: {
        accepted: chat().accepted,
        rejected: chat().rejected,
        rejections: { ...chat().rejections },
        delivered: chat().entries.length,
        last: chat().entries.length ? chat().entries[chat().entries.length - 1] : null
      },
      match: {
        state: match().state,
        roundsPlayed: match().roundsPlayed,
        scores: { A: match().scores.A, B: match().scores.B },
        winner: match().matchWinner,
        events: tel.match.events
      },
      narrative: {
        baseline: { unit: 209, phase2: 42, phase3: 25, phase4: 22, phase5: 18, phase6: 21, phase7: 33, phase8: 28 },
        phase9Scope: 'authoritative HUD + gameplay/menu polish + session chat',
        filesNew: [
          'server/chat.js', 'client/js/game/hud-state.js',
          'test/unit/hud-chat.test.js', 'tools/verify-phase9.mjs'
        ],
        filesChanged: [
          'shared/protocol-consts.js', 'server/app.js',
          'client/js/game/hud.js', 'client/js/game/index.js', 'client/js/game/combat.js',
          'client/js/game/input.js', 'client/js/main.js', 'client/index.html',
          'client/css/hud.css', 'package.json',
          'test/unit/smoke.test.js', 'test/unit/lobby.test.js',
          'test/unit/combat.test.js', 'test/unit/multiplayer.test.js',
          'tools/verify-phase7.mjs', 'tools/verify-phase8.mjs'
        ],
        limitations: [
          'grenade blast hali ham faqat o\u2018ziga zarar (hitscan — PvP yo\u2018li) — P8 dan meros',
          'mashq nishonlari (dummy) match paytida ham xaritada qoladi',
          'ikki qurilmali HAQIQIY LAN QA hali o\u2018tkazilmagan (P11)',
          'P10 (performance/stability) ishi bajarilmagan'
        ],
        scopeConfirmation: 'Phase 10/11/12 tizimlari YO\u2018Q: spectator/replay/voip/voice/' +
          'ranking/matchmaking/scoreboard/killfeed/inventory/lobbybrowser/friend/clan/' +
          'achievement/profile/account terminlari protokol, __neon API va telemetriyada yo\u2018q (P9.34)'
      },
      performance: {
        fpsAvg: perf?.fps?.fpsAvg, cpuMs: perf?.cpuMs,
        drawCalls: perf?.render?.calls, triangles: perf?.render?.triangles,
        shadowMap: perf?.render?.shadowMap,
        serverLoopMs: tel.loopMs, ticks: tel.totals.ticks, snapshots: tel.totals.snapshots,
        tickErrors: tel.tickErrors
      },
      unit: { tests: Number(uTests), pass: Number(uPass), fail: Number(uFail) },
      shotCount: shots.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      gates: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
      gateMap: 'P9.1–P9.34 — spetsifikatsiya ro‘yxati; P9.5b/P9.15 — qo‘shimcha dalil darvozalari'
    };
    fs.writeFileSync(path.join(ART, 'phase9-report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== PHASE 9 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    console.log(`GPU: ${renderer.slice(0, 90)}${software ? ' (SOFTWARE!)' : ''}`);
    console.log(`HUD manbasi: ${hudFinal?.source} · chat: qabul=${chat().accepted} rad=${chat().rejected} yetkazilgan=${chat().entries.length}`);
    console.log(`MATCH: ${match().state} ball A=${match().scores.A} B=${match().scores.B} g‘olib=${match().matchWinner}`);
    console.log(`Perf: ${perf?.fps?.fpsAvg} FPS · CPU ${perf?.cpuMs}ms · ${perf?.render?.calls} call · ${perf?.render?.triangles} tri · server loop ${tel.loopMs}ms`);
    console.log(`Artifacts: ${shots.length} screenshot + logs/phase9-report.json`);
    if (report.failed) process.exitCode = 1;
  } catch (err) {
    console.error('\n[verify-phase9] XATO:', err && err.stack ? err.stack : err);
    check('P9.x kutilmagan xato', false, String(err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main();
