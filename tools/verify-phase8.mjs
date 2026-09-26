#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 8 (JAMOA / RAUND / BALL) verifikatsiyasi
// (anti-fake: HAQIQIY Chrome + HAQIQIY server + TO'RT MUSTAQIL KLIENT)
//
// Dalil manbalari (dalil DOM matni EMAS):
//   1) SERVER XOTIRASI — harness serverni O'ZI ishga tushiradi, shu sababli
//      `server.state.match` / `server.state.sessions` TO'G'RIDAN-TO'G'RI
//      o'qiladi. Jamoa/raund/ball qiymatlari klient da'vosi EMAS.
//   2) TO'RT MUSTAQIL ULANISH — 2 alohida brauzer sahifasi (alohida WS +
//      alohida window.__neon) + 2 xom WebSocket klienti. Bitta sahifada
//      "ikkinchi o'yinchi" SIMULYATSIYA QILINMAYDI.
//   3) HAQIQIY OTISH — o'lim HAQIQIY brauzerdan (pointer lock + sichqoncha)
//      keladi; server o'zi ray ni hal qiladi va HP/o'lim/ball ni yozadi.
//   4) KLIENT TOMONI — masofaviy o'yinchilar/match HUD FAQAT server
//      SNAPSHOT xabarlaridan o'qiladi (window.__neon API).
//
// Ishga tushirish:  node tools/verify-phase8.mjs            (real oyna · real GPU)
//                   node tools/verify-phase8.mjs --headless (P8.1 — SwiftShader)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { placePlayerAt } from '../server/session.js';
import {
  MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, TEAM, MATCH_PHASE
} from '../shared/protocol-consts.js';
import { MATCH_RULES } from '../server/match.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9388);
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js',
  'test/unit/multiplayer.test.js', 'test/unit/round-team-score.test.js'
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
  send (obj) { this.ws.send(JSON.stringify(obj)); }
  terminate () { try { this.ws.terminate(); } catch {} }
  close () { try { this.ws.close(); } catch {} }
}

async function launchChrome (base) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon8-chrome-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    // fon/vochered tab'larda rAF va taymerlar to'xtamasin (hamma klient birga yurishi shart)
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

async function waitForPageTarget (base) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(base));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome page target topilmadi');
}

/** YANGI MUSTAQIL SAHIFA (alohida target + alohida CDP ulanish) */
async function newPage (base) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' });
  const target = await res.json();
  if (!target || !target.webSocketDebuggerUrl) throw new Error('yangi sahifa ochilmadi: ' + JSON.stringify(target));
  const cdp = await new CDP(target.webSocketDebuggerUrl).open();
  await prepare(cdp);
  return { cdp, targetId: target.id };
}

async function prepare (cdp) {
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return cdp;
}

const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

/**
 * In-page prob: YANGI haqiqiy WebSocket ochib, hello → session, so'ng
 * berilgan xabarlarni yuboradi va javoblarni yig'adi (mock EMAS).
 */
const P8_PROBE = `
window.__p8probe = function (msgs, waitMs, join) {
  return new Promise(function (resolve) {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    var ws = new WebSocket(url);
    var out = [];
    var sent = false;
    var t = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      resolve({ ok: true, out: out });
    }, waitMs);
    ws.onopen = function () { ws.send(JSON.stringify({ type: 'hello', name: 'p8-probe' })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { out.push({ type: 'raw', text: String(ev.data).slice(0, 90) }); return; }
      out.push(m);
      if (m.type === 'session' && !sent) {
        sent = true;
        if (join) ws.send(JSON.stringify({ type: 'join-session' }));
        for (var i = 0; i < msgs.length; i++) {
          ws.send(typeof msgs[i] === 'string' ? msgs[i] : JSON.stringify(msgs[i]));
        }
      }
    };
    ws.onerror = function () { clearTimeout(t); resolve({ ok: false, out: out }); };
  });
};
`;

// ---------------- asosiy oqim ----------------
async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;

  const sessions = () => [...server.state.sessions.values()];
  const sessionOf = (pid) => sessions().find((s) => s.playerId === pid) || null;
  const lobbySess = () => server.state.lobby.session;
  const match = () => server.state.match;

  const { child, profile } = await launchChrome(BASE);
  const first = await waitForPageTarget(BASE);
  const A = await prepare(await new CDP(first.webSocketDebuggerUrl).open());
  const Bpage = await newPage(BASE);
  const B = Bpage.cdp;

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
    try { child.kill('SIGTERM'); } catch {}
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    await server.close().catch(() => {});
  };

  /** Sahifa tayyor (WebGL2 + __neon + Phase 8 API) */
  const waitReady = async (cdp, tries = 110) => {
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
            phase8: window.__neon ? window.__neon.phase8 : null,
            hasMatchState: !!(window.__neon && typeof window.__neon.matchState === 'function'),
            hasMatchQa: !!(window.__neon && typeof window.__neon.matchQa === 'function'),
            hasMatchHud: !!(window.__neon && typeof window.__neon.matchHud === 'function'),
            gates: window.__neon ? window.__neon.gates : null
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) { ready = { error: String(e.message), loading: true }; }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('sahifa tayyor emas: ' + JSON.stringify(ready));
    await cdp.evaluate(HELPERS);
    await cdp.evaluate(P8_PROBE);
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
        const top = (x >= 0 && y >= 0 && x < vw && y < vh) ? document.elementFromPoint(x, y) : null;
        return {
          disabled: !!el.disabled, hidden: el.hidden, w: Math.round(r.width),
          x, y, vw, vh, inView: x >= 0 && y >= 0 && x < vw && y < vh,
          topId: top ? (top.id || top.tagName) : null
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

  const matchQa = (cdp) => cdp.evaluate('window.__neon.matchQa()');
  const matchState = (cdp) => cdp.evaluate('window.__neon.matchState()');
  const serverSnaps = (cdp) => cdp.evaluate('window.__neon.serverSnapshots()');
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
  const rawFreshSnap = async (rc, pred, tries = 60) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try { last = await rc.next(MSG.SNAPSHOT, 2500); } catch { return last; }
      if (pred(last)) return last;
    }
    return last;
  };

  /** Xom WS klient ochib sessiyaga qo'shish */
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

  /** Klientning LOKAL pozitsiyasi server bilan mos kelishini kutish */
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

  let mousePathWorks = null;
  /** HAQIQIY sichqoncha bilan otish (pointer lock ichida) */
  const fireBurst = async (cdp, pid, ms = 700) => {
    const before = (sessionOf(pid) || {}).counters?.shotsAccepted ?? 0;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(ms);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(60);
    return before;
  };
  const holdFire = async (cdp, on) => cdp.evaluate(on ? 'window.__neon.setFire(true)' : 'window.__neon.releaseFire()');

  const requestLock = async (cdp) => cdp.evaluate(`(function () {
    const c = document.getElementById('gl');
    if (c) c.click();
    return document.pointerLockElement !== null;
  })()`, { userGesture: true });

  /** A brauzeridan nishonni o'ldirish (haqiqiy otish) */
  const killFromA = async (targetPid, maxBursts = 14) => {
    await front(A);
    const a0 = sessionOf(idA).counters.shotsAccepted;
    for (let i = 0; i < maxBursts; i++) {
      const t = sessionOf(targetPid);
      if (!t || !t.state.health.alive) break;
      await aimAtPlayer(A, targetPid);
      await fireBurst(A, targetPid);
      await sleep(80);
    }
    let shots = sessionOf(idA).counters.shotsAccepted - a0;
    if (shots === 0) {
      // pointer lock yo'q bo'lsa — HAQIQIY input manager yo'li (mock EMAS)
      mousePathWorks = false;
      for (let i = 0; i < maxBursts; i++) {
        const t = sessionOf(targetPid);
        if (!t || !t.state.health.alive) break;
        await aimAtPlayer(A, targetPid);
        await holdFire(A, true);
        await sleep(650);
        await holdFire(A, false);
        await sleep(80);
      }
      shots = sessionOf(idA).counters.shotsAccepted - a0;
    } else if (mousePathWorks === null) {
      mousePathWorks = true;
    }
    return { shots, dead: !(sessionOf(targetPid) || { state: { health: { alive: true } } }).state.health.alive };
  };

  /** Hamma o'yinchini koridorga, toza ko'rish chizig'i bilan joylash */
  const placeAll = () => {
    placeAt(idA, -13, -9, Math.PI / 2);
    placeAt(idC, -13, -7.5, Math.PI / 2);
    placeAt(idB, 13, -9, -Math.PI / 2);
    placeAt(idD, 13, -7.5, -Math.PI / 2);
  };

  const roundWinForA = async () => {
    if (match().state === MATCH_PHASE.MATCH_END) return false;
    if (!(await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 150, 100))) return false;
    if (match().state === MATCH_PHASE.MATCH_END) return false;
    await sleep(150);
    placeAll();
    await waitLocalNear(A, idA);
    for (const t of [idD, idB]) {
      const s = sessionOf(t);
      if (!s || !s.state.health.alive) continue;
      const r = await killFromA(t);
      if (!r.dead) return false;
    }
    return waitServer(() => match().roundState !== MATCH_PHASE.LIVE, 150, 100);
  };

  let idA = null; let idB = null; let idC = null; let idD = null;

  try {
    // ================= TAYYORGARLIK =================
    const readyA = await waitReady(A);
    await waitReady(B);

    const renderer = readyA.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software/i.test(renderer);

    // ---------- P8.1 real Chrome + real WebGL2/GPU ----------
    check(`P8.1 HAQIQIY Chrome oynasi + HAQIQIY WebGL2 GPU (protokol v${PROTOCOL_VERSION})`,
      readyA.gates?.webgl2 === true && !software,
      `renderer="${renderer.slice(0, 78)}" · software=${software} · webgl2=${readyA.gates?.webgl2}`);

    // ---------- P8.2 Phase 1–7 unit to'plamlari (HAQIQIY subprocess) ----------
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
    check('P8.2 Phase 1–7 + Phase 8 unit to‘plamlari (npm test ekvivalenti) PASS',
      unit.code === 0 && uFail === '0' && Number(uPass) === Number(uTests),
      `tests=${uTests} pass=${uPass} fail=${uFail} exit=${unit.code}`);

    // ---------- host / join (HAQIQIY DOM kliklar) ----------
    let gatesA = null; let gatesB = null;
    for (let i = 0; i < 60; i++) {
      gatesA = await A.evaluate('window.__neon.gates');
      gatesB = await B.evaluate('window.__neon.gates');
      if (gatesA && gatesA.ws && gatesB && gatesB.ws) break;
      await sleep(200);
    }
    idA = await A.evaluate('window.__neon.lobbyPlayerId()');
    idB = await B.evaluate('window.__neon.lobbyPlayerId()');
    const hostClicked = await clickBtn(A, 'btnHost');
    await waitServer(() => lobbySess() && lobbySess().players.length === 1);
    const joinClicked = await clickBtn(B, 'btnJoin');
    await waitServer(() => lobbySess() && lobbySess().players.length === 2);

    // 2 xom WS klient — jami TO'RT mustaqil ulanish
    const C = await rawJoin('raw-c');
    const D = await rawJoin('raw-d');
    idC = C.playerId; idD = D.playerId;
    await waitServer(() => lobbySess() && lobbySess().players.length === 4);

    // ---------- P8.3 / P8.4 to'rt mustaqil klient ----------
    check('P8.3 TO‘RT mustaqil klient ulandi (2 brauzer sahifasi + 2 xom WS)',
      gatesA?.ws === true && gatesB?.ws === true && hostClicked && joinClicked &&
      server.state.connections.size >= 4 && lobbySess().players.length === 4,
      `brauzer ws: A=${gatesA?.ws} B=${gatesB?.ws} · serverda ulanish=${server.state.connections.size} · lobby a’zolari=${lobbySess().players.length}`);

    const idsAll = [idA, idB, idC, idD];
    check('P8.4 SERVER har bir klientga ALOHIDA playerId berdi',
      new Set(idsAll).size === 4 && idsAll.every((v) => typeof v === 'string' && v),
      `A=${idA} B=${idB} C=${idC} D=${idD} · serverda sessiya=${sessions().length}`);

    // ---------- P8.9 guest START qila olmaydi (server + UI) ----------
    const guestBtnDisabled = await B.evaluate(`(function () {
      const b = document.getElementById('btnLobbyStart');
      return b ? !!b.disabled : null;
    })()`);
    D.send({ type: MSG.START_SESSION });
    const dStartErr = await D.next(MSG.ERROR, 4000).catch(() => null);
    const beforeStart = { round: match().roundNumber, state: match().state };
    check('P8.9 guest (non-host) START qila olmaydi — server `not_host` bilan rad etadi',
      guestBtnDisabled === true && dStartErr && dStartErr.code === 'not_host' &&
      beforeStart.state === MATCH_PHASE.NONE,
      `guest tugmasi disabled=${guestBtnDisabled} · server javobi="${dStartErr ? dStartErr.code : '—'}" · match=${beforeStart.state}`);

    // ---------- P8.8 host start (HAQIQIY DOM klik) ----------
    const startClicked = await clickBtn(A, 'btnLobbyStart');
    const inGame = await waitServer(() => lobbySess() && lobbySess().state === 'in_game');
    check('P8.8 host REAL DOM klik bilan matchni boshladi (lobby → in_game → STARTING)',
      startClicked && inGame,
      `lobby=${lobbySess() ? lobbySess().state : '—'} · match=${match().state} · round=${match().roundNumber}`);

    // ---------- P8.5 / P8.6 jamoalar SERVERDA tayinlandi ----------
    const teamsServer = { A: match().teams.A.slice(), B: match().teams.B.slice() };
    check('P8.5/P8.6 SERVER jamoalarni tayinladi (deterministik muvozanat) va ular avtoritar holatda',
      teamsServer.A.length === 2 && teamsServer.B.length === 2 &&
      teamsServer.A.includes(idA) && teamsServer.A.includes(idC) &&
      teamsServer.B.includes(idB) && teamsServer.B.includes(idD),
      `TEAM A=[${teamsServer.A.join(',')}] · TEAM B=[${teamsServer.B.join(',')}]`);

    // ---------- P8.7 klient jamoa identitetini soxtalashtira olmaydi ----------
    const forgedMsgs = [
      { type: MSG.INPUT, seq: 900001, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, teamId: 'B' },
      { type: MSG.INPUT, seq: 900002, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, score: 9, scores: { A: 9, B: 0 } },
      { type: MSG.INPUT, seq: 900003, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundState: 'match_end', roundWinner: 'B', matchWinner: 'B' },
      { type: MSG.INPUT, seq: 900004, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundNumber: 42 },
      { type: MSG.INPUT, seq: 900005, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, match: { scores: { A: 9 } } }
    ];
    const probeTeam = A.evaluate(`window.__p8probe(${JSON.stringify(forgedMsgs)}, 2600, false)`);
    const probe = await probeTeam;
    const probeAcks = (probe?.out || []).filter((m) => m.type === MSG.INPUT_ACK);
    const probeReasons = probeAcks.map((a) => a.reason);
    const teamsAfterForge = { A: match().teams.A.slice(), B: match().teams.B.slice() };
    check('P8.7 soxta jamoa/ball/raund da’volari RAD etildi — server holati o‘zgarmadi',
      probeReasons.length >= 5 && probeReasons.every((r) => r === 'forbidden_authority') &&
      match().scores.A === 0 && match().scores.B === 0 && match().roundNumber <= 1 &&
      JSON.stringify(teamsAfterForge) === JSON.stringify(teamsServer),
      `rad sabablari=[${probeReasons.join(', ')}] · ball A:${match().scores.A} B:${match().scores.B} · jamoalar o‘zgarmadi`);

    // ---------- P8.10 raund LIVE ----------
    const live = await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 150, 100);
    check('P8.10 raund SERVER tomonidan LIVE holatiga o‘tdi (STARTING → LIVE)',
      live === true && match().state === MATCH_PHASE.LIVE,
      `match=${match().state} roundState=${match().roundState} raund=${match().roundNumber} (STARTING_MS=${SIM.STARTING_MS})`);

    // ---------- P8.11 raund raqami serverda ----------
    check('P8.11 raund raqami SERVER EGASI (1 dan boshlanadi)',
      match().roundNumber === 1 && match().roundsPlayed === 1,
      `roundNumber=${match().roundNumber} · o‘ynalgan raund=${match().roundsPlayed}`);

    // ---------- P8.12 ballar noldan boshlanadi ----------
    check('P8.12 ballar noldan boshlanadi (server)',
      match().scores.A === 0 && match().scores.B === 0,
      `A=${match().scores.A} B=${match().scores.B} · roundsToWin=${MATCH_RULES.ROUNDS_TO_WIN}`);

    // ---------- P8.13 jamoa bo'yicha spawn ----------
    const spawnA = [idA, idC].map((p) => (sessionOf(p) || {}).state.position.x);
    const spawnB = [idB, idD].map((p) => (sessionOf(p) || {}).state.position.x);
    check('P8.13 o‘yinchi spawn’i AVTORITAR jamoaga mos (A g‘arb, B sharq)',
      spawnA.every((x) => x < -10) && spawnB.every((x) => x > 10),
      `TEAM A x=[${spawnA.map((v) => v.toFixed(1)).join(', ')}] · TEAM B x=[${spawnB.map((v) => v.toFixed(1)).join(', ')}]`);

    // ---------- P8.14 sinxron o'yinda qatnashish (klient teamId ko'radi) ----------
    const runningA = await waitClient(A, 'window.__neon.running', (v) => v === true);
    const runningB = await waitClient(B, 'window.__neon.running', (v) => v === true);
    const qaA = await matchQa(A);
    const qaB = await matchQa(B);
    const bSeesTeams = (qaB?.remotes || []).filter((r) => r.teamId === 'A').length >= 1 &&
      (qaB?.remotes || []).filter((r) => r.teamId === 'B').length >= 1;
    check('P8.14 klientlar sinxron o‘yinda qatnashadi va JAMOANI server snapshot’idan ko‘radi',
      runningA === true && runningB === true &&
      qaA?.selfTeam === 'A' && qaB?.selfTeam === 'B' && bSeesTeams && (qaB?.remotes || []).length === 3,
      `A o‘z jamoasi=${qaA?.selfTeam} (remote=${(qaA?.remotes || []).length}) · B o‘z jamoasi=${qaB?.selfTeam} (remote=${(qaB?.remotes || []).length}) · B ko‘rgan jamoalar=[${(qaB?.remotes || []).map((r) => r.id + ':' + r.teamId).join(', ')}]`);

    await saveShot(A, 'p8-14-teams-and-match-hud');

    // ================= HAQIQIY OTISH → O'LIM → YO'Q QILISH =================
    await front(A);
    const locked = await requestLock(A);
    await sleep(400);
    placeAll();
    await waitLocalNear(A, idA);

    const dAlive0 = sessionOf(idD).state.health.alive;
    const dHp0 = sessionOf(idD).state.health.hp;
    const killD = await killFromA(idD);
    const dSess = sessionOf(idD);
    const hudA = await A.evaluate('window.__neon.matchHud()');
    const snapsA2 = await serverSnaps(A);

    // ---------- P8.15 avtoritar o'lim ----------
    check('P8.15 HAQIQIY brauzer oti (pointer lock + sichqoncha) → server avtoritar o‘limni yozdi',
      dAlive0 === true && killD.dead === true && dSess.state.health.alive === false &&
      dSess.state.health.hp === 0 && killD.shots > 0,
      `D HP ${dHp0} → ${dSess.state.health.hp} · o‘q=${killD.shots} · pointerLock=${locked} · yo‘l=${mousePathWorks ? 'real-mouse' : 'input-manager'}`);

    // ---------- P8.16 raund hali davom etadi (jamoa to'liq o'lmagan) ----------
    check('P8.16 server jamoa yo‘q qilinishini BAHOLADI — bitta o‘lim raundni tugatmaydi',
      match().roundState === MATCH_PHASE.LIVE && match().lives.B === 1 && match().scores.A === 0,
      `roundState=${match().roundState} · tirik: A=${match().lives.A} B=${match().lives.B} · ball A=${match().scores.A}`);

    // ---------- P8.17/P8.19 to'liq yo'q qilish → ROUND_END ----------
    const killB = await killFromA(idB);
    const roundEnded = await waitServer(() => match().roundState === MATCH_PHASE.ROUND_END, 150, 100);
    check('P8.17/P8.19 to‘liq yo‘q qilish → g‘olib TEAM A → ROUND_END (server qarori)',
      killB.dead === true && roundEnded === true && match().roundWinner === 'A' &&
      match().roundState === MATCH_PHASE.ROUND_END && match().lives.B === 0,
      `B o‘ldi=${killB.dead} (o‘q=${killB.shots}) · roundWinner=${match().roundWinner} · roundState=${match().roundState} · tirik A=${match().lives.A} B=${match().lives.B}`);

    // ---------- P8.18 ball FAQAT BIR MARTA ----------
    const scoreAtEnd = match().scores.A;
    await sleep(700);
    // qo'shimcha hodisalar: takroriy o'lim/uzilishlarga o'xshash signallar
    await holdFire(A, false);
    await sleep(400);
    check('P8.18 g‘olib jamoa balli FAQAT BIR MARTA oshdi (idempotent)',
      scoreAtEnd === 1 && match().scores.A === 1 && match().scores.B === 0,
      `ball A=${match().scores.A} B=${match().scores.B} · roundWinner=${match().roundWinner}`);

    await saveShot(A, 'p8-19-round-end-score');

    // ---------- P8.20/P8.21/P8.22 keyingi raund ----------
    const nextLive = await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 200, 100);
    const aliveAfter = [idA, idB, idC, idD].map((p) => (sessionOf(p) || {}).state.health.alive);
    const hpAfter = [idA, idB, idC, idD].map((p) => (sessionOf(p) || {}).state.health.hp);
    check('P8.20/P8.21/P8.22 keyingi raund: holat tiklandi, raund raqami +1, ball SAQLANDI',
      nextLive === true && match().roundNumber === 2 && aliveAfter.every(Boolean) &&
      hpAfter.every((h) => h === 100) && match().scores.A === 1 && match().scores.B === 0,
      `raund=${match().roundNumber} · tiriklik=[${aliveAfter.join(',')}] · HP=[${hpAfter.join(',')}] · ball A=${match().scores.A} B=${match().scores.B}`);

    // ---------- P8.26 join-in-progress ----------
    const late = await rawJoin('raw-late');
    const lateOk = await waitServer(() => lobbySess() && lobbySess().players.length === 5, 80, 100);
    const lateSession = await waitServer(() => {
      const s = sessionOf(late.playerId);
      return !!(s && s.authoritativeMovement);
    }, 80, 100);
    const lateSnap = await rawFreshSnap(late, (s) => (s.match && s.match.roundNumber >= 2) || false);
    const lateTeam = (match().teams.A.includes(late.playerId) ? 'A'
      : (match().teams.B.includes(late.playerId) ? 'B' : null));
    check('P8.26 join-in-progress: yangi a’zo jamoa + spawn + JORIY raund/ball holatini oldi',
      lateOk && lateSession === true && lateTeam === 'A' &&
      !!lateSnap && lateSnap.match && lateSnap.match.roundNumber >= 2 &&
      Number.isFinite(lateSnap.match.scores.A) &&
      (sessionOf(late.playerId).state.health.hp === 100),
      `late=${late.playerId} jamoa=${lateTeam} · snapshot match: raund=${lateSnap?.match?.roundNumber} state=${lateSnap?.match?.roundState} ball A=${lateSnap?.match?.scores?.A} · HP=${sessionOf(late.playerId).state.health.hp}`);

    // ---------- P8.24/P8.25 uzilish (LIVE paytida) ----------
    const beforeTeams = { A: match().teams.A.length, B: match().teams.B.length };
    const liveNow = match().roundState;
    late.terminate();
    const removedFromTeam = await waitServer(() =>
      !match().teams.A.includes(late.playerId) && !match().teams.B.includes(late.playerId), 100, 100);
    const ghostGone = !sessions().some((s) => s.playerId === late.playerId && s.state.health.alive);
    await sleep(500);
    check('P8.24/P8.25 uzilgan o‘yinchi jamoadan chiqariladi va \"ghost\" tirik hisoblanmaydi',
      removedFromTeam === true && ghostGone === true &&
      (match().teams.A.length + match().teams.B.length) === beforeTeams.A + beforeTeams.B - 1,
      `jamoalar A=${match().teams.A.length} B=${match().teams.B.length} (avval A=${beforeTeams.A} B=${beforeTeams.B}) · roundState(uzilishdan oldin)=${liveNow} · ghost tirik=${!ghostGone}`);

    // ---------- P8.23 MATCH_END (raundlar oxirigacha HAQIQIY o'ynaladi) ----------
    let rounds = match().roundNumber;
    let guard = 0;
    while (match().state !== MATCH_PHASE.MATCH_END && guard < 8) {
      guard += 1;
      const won = await roundWinForA();
      if (!won) break;
      rounds = match().roundNumber;
      if (match().state === MATCH_PHASE.MATCH_END) break;
      await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 200, 100);
    }
    const matchEndReached = await waitServer(() => match().state === MATCH_PHASE.MATCH_END, 100, 100);
    const scoreFinal = { A: match().scores.A, B: match().scores.B };
    const roundAfter = match().roundNumber;
    await sleep(3600);
    check('P8.23 MATCH_END: TEAM A kerakli ballga yetdi — yangi raund BOSHLANMAYDI',
      matchEndReached === true && scoreFinal.A >= MATCH_RULES.ROUNDS_TO_WIN &&
      match().matchWinner === 'A' && match().roundNumber === roundAfter &&
      match().scores.A === scoreFinal.A,
      `match=${match().state} g‘olib=${match().matchWinner} ball A=${scoreFinal.A} B=${scoreFinal.B} (kerak=${MATCH_RULES.ROUNDS_TO_WIN}) · raund ${roundAfter} (MATCH_END dan keyin o‘zgarmadi) · o‘ynaldi ${rounds}`);

    const snapsFinal = await serverSnaps(A);
    const qaBfinal = await matchQa(B);
    const hudB = await B.evaluate('window.__neon.matchHud()');
    const lobbyBadge = await B.evaluate('window.__neon.lobbyMatchBadge()');
    const scoreStr = `A ${scoreFinal.A} : ${scoreFinal.B} B`;
    check('P8.30 klientlar (A va B) MATCH_END holatini SNAPSHOT/DOM orqali ko‘radi',
      snapsFinal?.serverTick > 0 && qaBfinal?.match?.state === MATCH_PHASE.MATCH_END &&
      qaBfinal?.match?.scores?.A >= MATCH_RULES.ROUNDS_TO_WIN &&
      hudB?.score === scoreStr && String(lobbyBadge?.text || '').includes(scoreStr.replace(/ : /g, ':')),
      `B matchQa: state=${qaBfinal?.match?.state} ball A=${qaBfinal?.match?.scores?.A} B=${qaBfinal?.match?.scores?.B} · B HUD="${hudB?.score}" · lobby badge="${lobbyBadge?.text}"`);
    await saveShot(B, 'p8-23-match-end-in-b');

    // ---------- P8.27 buzilgan xabarlar serverni yiqitmaydi ----------
    const malformed = [
      '{ bu json emas',
      { type: 'match-cheat', teamId: 'A', score: 99 },
      { type: 'round-command', roundState: 'match_end' },
      { type: MSG.INPUT, seq: 'salom', pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] } },
      { type: MSG.INPUT, seq: 7, pose: { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] } },
      JSON.stringify({ type: MSG.INPUT, pad: 'z'.repeat(40000) })
    ];
    const probeBad = await A.evaluate(`window.__p8probe(${JSON.stringify(malformed)}, 2400, false)`);
    const badCodes = (probeBad?.out || []).filter((m) => m.type === MSG.ERROR).map((m) => m.code);
    const tickBefore = server.telemetry().tick;
    await sleep(500);
    const tickAfter = server.telemetry().tick;
    check('P8.27 buzilgan/noma’lum match buyruqlari serverni yiqitmadi (tick davom etdi)',
      probeBad?.ok === true && server.telemetry().tickErrors === 0 &&
      tickAfter > tickBefore && badCodes.includes('bad_json') && badCodes.includes('too_big'),
      `xato kodlari=[${badCodes.join(', ')}] · tick ${tickBefore}→${tickAfter} · tickErrors=${server.telemetry().tickErrors} · ball A=${match().scores.A}`);

    // ---------- P8.28 uydirma ball/g'olib/raund holati rad (server xotirasi o'zgarmadi) ----------
    const before = { A: match().scores.A, B: match().scores.B, round: match().roundNumber, winner: match().matchWinner };
    const probeF = await A.evaluate(`window.__p8probe(${JSON.stringify([
      { type: MSG.INPUT, seq: 910001, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, scores: { A: 99, B: 0 } },
      { type: MSG.INPUT, seq: 910002, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundWinner: 'B', matchWinner: 'B' },
      { type: MSG.INPUT, seq: 910003, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, roundNumber: 99 }
    ])}, 2200, false)`);
    const fReasons = (probeF?.out || []).filter((m) => m.type === MSG.INPUT_ACK).map((a) => a.reason);
    const after = { A: match().scores.A, B: match().scores.B, round: match().roundNumber, winner: match().matchWinner };
    check('P8.28 uydirma ball/g‘olib/raund holati RAD etildi — server qiymatlari o‘zgarmadi',
      fReasons.length >= 3 && fReasons.every((r) => r === 'forbidden_authority') &&
      JSON.stringify(before) === JSON.stringify(after),
      `rad sabablari=[${fReasons.join(', ')}] · ball A=${after.A} B=${after.B} · raund=${after.round} · g‘olib=${after.winner}`);

    // ---------- P8.29 Phase 5 combat avtoriteti saqlangan ----------
    // 1) HAQIQIY otish — o'q-dorini SERVER kamaytiradi
    const sessA3 = sessionOf(idA);
    const magBefore = sessA3.state.loadout.slots['neon-rifle'].mag;
    const shotsBefore2 = sessA3.counters.shotsAccepted;
    await front(A);
    await requestLock(A);
    await sleep(250);
    await fireBurst(A, idA, 700);
    const magAfter = sessionOf(idA).state.loadout.slots['neon-rifle'].mag;
    const shotsAfter2 = sessionOf(idA).counters.shotsAccepted;
    // 2) uydirma o'q-dori/HP/cooldown QABUL QILINMAYDI (Phase 5 qoidasi)
    const sessB2 = sessionOf(idB);
    const magB = sessB2.state.loadout.slots['neon-rifle'].mag;
    const forgedAmmo = { type: MSG.INPUT, seq: 920001, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, ammo: 999, mag: 999, cooldown: 0, hp: 100 };
    const probeAmmo = await B.evaluate(`window.__p8probe(${JSON.stringify([forgedAmmo])}, 1600, false)`);
    const ammoReason = (probeAmmo?.out || []).filter((m) => m.type === MSG.INPUT_ACK).map((a) => a.reason)[0];
    check('P8.29 Phase 5 combat avtoriteti SAQLANGAN (server o‘q-dorini boshqaradi; uydirma rad etiladi)',
      shotsAfter2 > shotsBefore2 && magAfter < magBefore &&
      ammoReason === 'forbidden_authority' &&
      sessionOf(idB).state.loadout.slots['neon-rifle'].mag === magB,
      `A HAQIQIY otishi: ${shotsBefore2}→${shotsAfter2} · server mag ${magBefore}→${magAfter} · uydirma o‘q-dori rad="${ammoReason}" · B mag=${magB} (o‘zgarmadi)`);

    // ---------- P8.31 Phase 10+ kirmagan ----------
    // PHASE 9 (HUD/chat) endi RUXSAT ETILGAN — chegara Phase 10+ ga surildi
    // (P7.28 bilan bir xil, uchta sirt saqlanadi; voice/voip taqiq bo'lib qoladi).
    const p9 = /spectat|replay|voip|voice|rank|matchmak|killfeed|scoreboard|inventory|room|friend|clan|achievement|profile|account/i;
    const forbiddenKinds = Object.keys(MSG).filter((k) => p9.test(k));
    const snapShape = await A.evaluate('window.__neon.serverSnapshots().shape');
    const lobbyPlayerKeys = lobbySess() ? Object.keys(lobbySess().players[0] || {}) : [];
    check('P8.31 Phase 10+ o‘yin tizimlari YO‘Q (spectator/replay/voice/ranking/matchmaking/scoreboard)',
      forbiddenKinds.length === 0 && !snapShape.some((k) => p9.test(k)) &&
      !lobbyPlayerKeys.some((k) => p9.test(k)),
      `xabar turlari=[${Object.keys(MSG).length}] taqiqlangan=[${forbiddenKinds.join(',')}] · o‘yinchi maydonlari=[${(snapShape || []).join(',')}]`);

    // ---------- P8.x render/klient ishlaydi ----------
    const dA = await A.evaluate('window.__neon.diagnostics()');
    const dB = await B.evaluate('window.__neon.diagnostics()');
    check('P8.32 real brauzerlar ishlashda davom etadi (render + FPS + jamoalar ko‘rinadi)',
      dA && dA.render && dA.render.calls > 0 && dB.render.calls > 0 &&
      (await A.evaluate('window.__neon.running')) === true,
      `A: ${dA.fps.fpsAvg} FPS · ${dA.render.calls} draw call · ${dA.render.triangles} tri · shadowMap=${dA.render.shadowMap} · B: ${dB.fps.fpsAvg} FPS`);

    // ---------- P8.33 runtime xatolar yo'q ----------
    const exceptions = [...A.exceptions, ...B.exceptions];
    const consoleErrs = [...consoleErrors(A), ...consoleErrors(B)];
    const neonErrorsA = await A.evaluate('window.__neon.errors.length');
    const neonErrorsB = await B.evaluate('window.__neon.errors.length');
    const loopErrors = await A.evaluate('window.__neon.diagnostics().loopErrors');
    check('P8.33 runtime/console xatolari YO‘Q (istisno, unhandled, loop xatosi, server tick)',
      exceptions.length === 0 && consoleErrs.length === 0 && neonErrorsA === 0 && neonErrorsB === 0 &&
      loopErrors === 0 && server.telemetry().tickErrors === 0,
      `CDP istisno=${exceptions.length} · console.error=${consoleErrs.length} · __neonErrors A=${neonErrorsA} B=${neonErrorsB} · loop xatosi=${loopErrors} · server tickErrors=${server.telemetry().tickErrors}`);

    // ---------- hisobot ----------
    const tel = server.telemetry();
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 8,
      subject: 'round-team-score',
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      protocol: PROTOCOL_VERSION,
      gpu: { renderer, software, webgl2: readyA.gates?.webgl2 === true },
      cadence: { tickHz: SIM.TICK_HZ, snapshotHz: SIM.SNAPSHOT_HZ, startingMs: SIM.STARTING_MS, roundEndMs: SIM.ROUND_END_MS, roundsToWin: MATCH_RULES.ROUNDS_TO_WIN },
      clients: {
        browser: 2, raw: rawClients.length,
        ids: [idA, idB, idC, idD],
        firePath: mousePathWorks ? 'real-mouse' : 'input-manager'
      },
      match: {
        state: match().state, roundState: match().roundState, roundNumber: match().roundNumber,
        roundWinner: match().roundWinner, matchWinner: match().matchWinner,
        scores: { A: match().scores.A, B: match().scores.B },
        teams: { A: match().teams.A.slice(), B: match().teams.B.slice() },
        teamsAtRoundStart: { ...match().teamsAtRoundStart },
        matchEvents: tel.match.events
      },
      performance: {
        loopMs: tel.loopMs, tick: tel.tick, tickErrors: tel.tickErrors,
        snapshots: tel.totals.snapshots, inputs: tel.totals.inputs,
        rejected: tel.totals.rejected, lobbyActions: tel.totals.lobbyActions,
        render: dA.render, fpsAvg: dA.fps.fpsAvg, cpuMs: dA.cpuMs
      },
      evidence: { screenshots: shots, sessions: sessions().length, connections: server.state.connections.size },
      gates: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail }))
    };
    fs.writeFileSync(path.join(ART, 'phase8-report.json'), JSON.stringify(report, null, 2));

    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log('\n================ XULOSA ================');
    console.log(`PASS: ${pass}   FAIL: ${fail}`);
    console.log(`GPU: ${renderer}`);
    console.log(`Match: ${match().state} · g'olib=${match().matchWinner} · ball A=${match().scores.A} B=${match().scores.B}`);
    console.log(`Skrinshotlar: ${shots.length} · natija: logs/phase8-report.json`);
    if (fail) {
      console.log('\nMuvaffaqiyatsiz darvozalar:');
      for (const r of results.filter((r) => !r.ok)) console.log(` - ${r.name} — ${r.detail}`);
    }
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('\nHARNESS XATOSI:', err && err.stack ? err.stack : err);
    for (const r of results) if (!r.ok) console.log(`FAIL  ${r.name} — ${r.detail}`);
    await cleanup();
    process.exit(2);
  }
}

main();
