#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 10 (PERFORMANCE / STABILITY) verifikatsiyasi
//
// ANTI-FAKE qoidalari (P10 §17):
//   • HAQIQIY Chrome (2 ALOHIDA JARAYON, alohida CDP port + profil)
//   • HAQIQIY Intel/Mesa GPU (SwiftShader dalil EMAS — `--headless` ishlatilmaydi)
//   • HAQIQIY SERVER (harness o'zi ishga tushiradi) — barcha o'lchovlar server
//     xotirasidan (`server.telemetry()`) va HAQIQIY klient hisoblagichlaridan
//   • UZOQ MUDDATLI yuk: sukut bo'yicha 5 daqiqa (`--minutes=N` bilan o'zgaradi)
//     va yuk BO'SH TURMAYDI: harakat, o'q, reload, granata, chat (to'g'ri +
//     buzg'unchi), raund/match aylanishi, join/leave, malformed trafik.
//   • KLIENT A → HAQIQIY WS → SERVER → HAQIQIY WS → KLIENT B modeli saqlanadi
//     (+ xom WS klientlar — ular ham haqiqiy server o'yinchilari).
//
// Ishga tushirish:  node tools/verify-phase10.mjs
//                   node tools/verify-phase10.mjs --minutes=1   (qisqa tekshiruv)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { placePlayerAt } from '../server/session.js';
import { MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, TEAM, MATCH_PHASE, CHAT } from '../shared/protocol-consts.js';
import { MATCH_RULES } from '../server/match.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT_A = Number(process.env.CDP_PORT || 9394);
const CDP_PORT_B = CDP_PORT_A + 1;
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const MINUTES = (() => {
  const a = process.argv.find((x) => x.startsWith('--minutes='));
  const n = a ? Number(a.split('=')[1]) : 5;
  return Number.isFinite(n) && n > 0 ? n : 5;
})();
const RUN_MS = Math.round(MINUTES * 60 * 1000);
// PHASE 1–9 unit to'plamlari (package.json `npm test` bilan AYNAN bir xil ro'yxat)
const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js', 'test/unit/multiplayer.test.js',
  'test/unit/round-team-score.test.js', 'test/unit/hud-chat.test.js', 'test/unit/stability.test.js',
  'test/unit/lan-qa.test.js'   // PHASE 11 qo'shdi — ro'yxat `npm test` bilan bir xil qolishi kerak
];
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

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
      // PHASE 10: timeout HAR DOIM tozalanadi — aks holda harness o'zi yuzlab
      // "runaway timer" yaratib, server o'lchovini iflos qilardi.
      const to = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 30000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); }
      });
      if (this.ws.readyState !== 1) return reject(new Error('CDP socket yopilgan'));
      this.ws.send(JSON.stringify({ id, method, params }));
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

/** Xom WS klient — HAQIQIY server o'yinchisi (masalan, klient yuk generatori) */
class RawClient {
  constructor (url, name = 'raw') { this.url = url; this.name = name; this.q = []; this.waiters = []; this.seq = 0; }
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
  send (obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  sendRaw (text) { try { this.ws.send(text); } catch {} }
  terminate () { try { this.ws.terminate(); } catch {} }
  close () { try { this.ws.close(); } catch {} }
}

// Xato bo'lsa ham Chrome/jarayonlar tozalanadi (aks holda CDP port band qoladi
// va keyingi yurish «Address already in use» bilan boshlanmaydi)
const cleanupHooks = [];
function registerCleanup (fn) { cleanupHooks.push(fn); }
function runCleanup () {
  for (const fn of cleanupHooks.splice(0)) { try { fn(); } catch {} }
}
process.on('exit', runCleanup);
process.on('SIGINT', () => { runCleanup(); process.exit(130); });
process.on('SIGTERM', () => { runCleanup(); process.exit(143); });

async function launchChrome (base, cdpPort, tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `neon10-${tag}-`));
  const args = [
    `--remote-debugging-port=${cdpPort}`,
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
  const tree = { child, profile };
  registerCleanup(() => { try { child.kill('SIGKILL'); } catch {} });
  registerCleanup(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
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
  for (let i = 0; i < 120; i++) {
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

// ============================================================
async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;

  const sessions = () => [...server.state.sessions.values()];
  const sOf = (pid) => sessions().find((s) => s.playerId === pid) || null;
  const match = () => server.state.match;
  const live = () => match().roundState === MATCH_PHASE.LIVE;
  const waitServer = async (pred, tries = 200, ms = 100) => {
    for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms); }
    return pred();
  };

  // Uncaught xatolar — server jarayoni o'lganini EMAS, xato otilganini o'lchaydi
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(String(err && err.stack ? err.stack : err));
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  console.log(`\n=== PHASE 10 — uzoq muddatli barqarorlik (${MINUTES} daqiqa) ===\n`);
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

  const raws = [];
  const cleanup = async () => {
    for (const r of raws) { try { r.terminate(); } catch {} }
    try { A.close(); } catch {}
    try { B.close(); } catch {}
    for (const c of [chromeA, chromeB]) { try { c.child.kill('SIGTERM'); } catch {} }
    await sleep(600);
    for (const c of [chromeA, chromeB]) { try { fs.rmSync(c.profile, { recursive: true, force: true }); } catch {} }
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUncaught);
    await server.close().catch(() => {});
  };

  const front = async (cdp) => { try { await cdp.send('Page.bringToFront'); } catch {} await sleep(150); };
  const consoleErrors = (cdp) => (cdp.logs || []).filter((l) =>
    l.level === 'error' && !/favicon|Failed to load resource|net::ERR/i.test(l.text || ''));
  const waitClient = async (cdp, expr, pred, tries = 80) => {
    let v = null;
    for (let i = 0; i < tries; i++) {
      try { v = await cdp.evaluate(expr); } catch { v = null; }
      if (v && pred(v)) return v;
      await sleep(150);
    }
    return v;
  };

  const waitReady = async (cdp, tries = 120) => {
    let ready = null;
    for (let i = 0; i < tries; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          return {
            loading: false, loaded: !!(window.__neon && window.__neon.loaded),
            ready: btn.dataset.ready === '1',
            phase10: window.__neon ? window.__neon.phase10 : null,
            hasPerf: !!(window.__neon && typeof window.__neon.perf === 'function'),
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

  /** Haqiqiy klaviatura hodisasi (production InputManager keydown/keyup eshitadi) */
  const key = async (cdp, type, code, k, vk) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type, code, key: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
    }).catch(() => {});
  };

  /** Xom klient yordamchilari */
  const rawHello = async (name, create = false, join = false) => {
    const rc = new RawClient(WS_URL, name);
    await rc.open();
    raws.push(rc);
    rc.send({ type: MSG.HELLO, name });
    await rc.next(MSG.WELCOME);
    const sess = await rc.next(MSG.SESSION);
    rc.playerId = sess.playerId;
    rc.sessionId = sess.sessionId;
    if (create) { rc.send({ type: MSG.CREATE_SESSION }); await rc.next(MSG.LOBBY_STATE); }
    if (join) {
      rc.send({ type: MSG.JOIN_SESSION });
      await waitServer(() => {
        const ls = server.state.lobby.session;
        return !!ls && ls.players.some((p) => p.id === rc.playerId);
      }, 60, 100);
    }
    return rc;
  };

  /** Xom klientdan HAQIQIY input (server hamma narsani o'zi hal qiladi) */
  const rawInput = (rc, { move = { forward: 0, right: 0, sprint: false }, fire = false, reload = false, aim = null, extra = {} } = {}) => {
    const s = sOf(rc.playerId);
    if (!s) return null;
    const p = s.state.position;
    rc.seq += 1;
    const dir = aim || [Math.sin(s.state.yaw || 0), 0, Math.cos(s.state.yaw || 0)];
    rc.send({
      type: MSG.INPUT, seq: rc.seq,
      pose: { x: p.x, y: p.y, z: p.z, yaw: s.state.yaw || 0, pitch: s.state.pitch || 0 },
      aim: { dir },
      move,
      intents: { fire, firePressed: fire, reload, switchTo: null, moving: !!(move.forward || move.right) },
      ...extra
    });
    return rc.seq;
  };

  /** O'q otuvchini nishonga qaratish (server o'zi ray ni hal qiladi) */
  const aimAt = (shooterPid, targetPid) => {
    const s = sOf(shooterPid); const t = sOf(targetPid);
    if (!s || !t) return null;
    const p = s.state.position; const q = t.state.position;
    const dx = q.x - p.x, dy = (q.y + 1.15) - (p.y + 1.6), dz = q.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return [dx / len, dy / len, dz / len];
  };

  // ---------------- 1) HAQIQIY CHROME + GPU ----------------
  const readyA = await waitReady(A);
  const readyB = await waitReady(B);
  const gpu = await A.evaluate(`(function () {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { renderer: 'WebGL2 YO‘Q', webgl2: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      webgl2: true
    };
  })()`).catch(() => null);
  const renderer = (gpu && gpu.renderer) || (readyA.gates && readyA.gates.renderer) || 'noma’lum';
  check('P10.1 HAQIQIY Chrome + HAQIQIY GPU (WebGL2 tirik, 2 jarayon)',
    !HEADLESS && !!readyA.gates?.webgl2 && !!readyB.gates?.webgl2 && !/swiftshader/i.test(String(renderer)),
    `renderer="${renderer}" · headless=${HEADLESS} · A webgl2=${readyA.gates?.webgl2} B=${readyB.gates?.webgl2}`);
  check('P10.2 IKKI MUSTAQIL Chrome JARAYONI (alohida CDP port + profil + WS + __neon)',
    chromeA.child.pid !== chromeB.child.pid && CDP_PORT_A !== CDP_PORT_B && readyA.phase10?.version === 10,
    `pidA=${chromeA.child.pid} pidB=${chromeB.child.pid} · portlar=${CDP_PORT_A}/${CDP_PORT_B} · __neon.phase10=${JSON.stringify(readyA.phase10)}`);

  // ---------------- 1b) PHASE 1–9 regressiyasi (HAQIQIY unit to'plamlari) ----------------
  const unitRun = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--test', ...UNIT_FILES], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => { out += b.toString(); });
    p.stderr.on('data', (b) => { out += b.toString(); });
    p.on('close', (code) => resolve({ code, out }));
  });
  const uTests = Number((unitRun.out.match(/^# tests (\d+)/m) || [])[1]);
  const uPass = Number((unitRun.out.match(/^# pass (\d+)/m) || [])[1]);
  const uFail = Number((unitRun.out.match(/^# fail (\d+)/m) || [])[1]);
  check('P10.2c PHASE 1–9 regressiyasi: HAQIQIY unit to‘plamlari (npm test bilan bir xil ro‘yxat) PASS',
    unitRun.code === 0 && uFail === 0 && uTests > 0 && uPass === uTests,
    `tests=${uTests} pass=${uPass} fail=${uFail} exit=${unitRun.code} · to‘plamlar=${UNIT_FILES.length}`);

  // ---------------- 2) sessiya + xom klientlar ----------------
  await front(A);
  await A.evaluate('window.__neon.hostLobby()');
  await waitServer(() => server.state.lobby.session && server.state.lobby.session.state === 'lobby', 100, 100);
  await front(B);
  await B.evaluate('window.__neon.joinLobby()');
  const rawC = await rawHello('load-c', false, true);
  const rawD = await rawHello('load-d', false, true);
  await waitServer(() => server.state.lobby.session && server.state.lobby.session.players.length === 4, 100, 100);
  await front(A);
  await A.evaluate('window.__neon.startLobby()');
  await A.evaluate('window.__neon.enterGame()').catch(() => {});
  await B.evaluate('window.__neon.enterGame()').catch(() => {});
  await waitServer(() => match().roundState === MATCH_PHASE.LIVE, 200, 100);

  const ids = { A: await A.evaluate('window.__neon.lobbyPlayerId()'), B: await B.evaluate('window.__neon.lobbyPlayerId()'), C: rawC.playerId, D: rawD.playerId };
  const distinct = new Set(Object.values(ids)).size;
  check('P10.2b 4 mustaqil o‘yinchi (2 brauzer + 2 xom WS) BIR sessiyada, ID lar takrorlanmagan',
    distinct === 4 && server.state.lobby.session.players.length === 4 && live(),
    `ids=${JSON.stringify(ids)} · a’zolar=${server.state.lobby.session.players.length} · raund=${match().roundState}`);

  // ---------------- 3) BOSHLANG'ICH (baseline) o'lchovlar ----------------
  await sleep(1200);
  const basePerf = await A.evaluate('window.__neon.perf()');
  const baseTel = server.telemetry();
  await saveShot(A, 'p10-01-baseline');
  check('P10.3 boshlang‘ich o‘lchov olindi (FPS/kadr/draw call/tri/DOM/HUD hisoblagichlari)',
    !!basePerf && !!basePerf.fps && basePerf.fps.fpsAvg > 0 && basePerf.dom.total > 0 &&
    typeof basePerf.hud.domWrites === 'number' && basePerf.render.calls > 0,
    `FPS=${round(basePerf.fps.fpsAvg, 1)} · kadr=${basePerf.fps.p95Ms ?? '—'} ms · calls=${basePerf.render.calls} · tri=${basePerf.render.triangles} · DOM=${basePerf.dom.total} · HUD yozuv=${basePerf.hud.domWrites}/o‘tkazib=${basePerf.hud.domSkips}`);

  // ---------------- 4) UZOQ MUDDATLI YUK (asosiy qism) ----------------
  server.metrics.reset();
  server.metrics.sampleMemory(Date.now(), true);
  const memStart = server.telemetry().perf.memory;
  const resStart = server.telemetry().resources;
  const heapStart = basePerf.memory ? basePerf.memory.usedHeapMb : null;

  const samples = [];
  const errorsDuring = { uncaught: 0, browser: 0 };
  const t0 = Date.now();
  let phase = 0;
  let roundsObserved = 0;
  let cycles = 0;
  const roundResults = [];

  // yuk generatori holati
  const keysDown = new Map();
  const keyDown = async (cdp, code, k, vk) => { if (!keysDown.has(cdp)) keysDown.set(cdp, new Set()); const set = keysDown.get(cdp); if (set.has(code)) return; set.add(code); await key(cdp, 'rawKeyDown', code, k, vk); };
  const keyUp = async (cdp, code, k, vk) => { const set = keysDown.get(cdp); if (!set || !set.has(code)) return; set.delete(code); await key(cdp, 'keyUp', code, k, vk); };

  const hostileBurst = () => {
    const rc = rawC;
    rc.sendRaw('{ bu JSON emas');
    rc.send({ type: 'such-a-type' });
    rc.send({ type: MSG.INPUT });
    rc.send({ type: MSG.INPUT, seq: 'x' });
    rc.send({ type: MSG.INPUT, seq: -5 });
    rc.send({ type: MSG.INPUT, seq: Infinity });
    rc.send({ type: MSG.CHAT, text: 'z'.repeat(CHAT.MAX_LEN + 200) });
    rc.send({ type: MSG.JOIN_SESSION, sessionId: 99999 });
    rc.sendRaw('{"type":"input","seq":1,"pose":{"x":NaN},"damage":999,"hp":1,"teamId":"A","score":42}');
    rc.send({ type: MSG.INPUT, seq: rc.seq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, damage: 999, hp: 1, targetHp: 0, teamId: 'B', score: 99, kills: 10 });
    rc.sendRaw('x'.repeat(SERVER_DEFAULTS.MAX_MSG_BYTES + 500));
  };

  const chatBurst = () => {
    for (let i = 0; i < CHAT.BURST + 3; i++) rawD.send({ type: MSG.CHAT, text: `load-${i}-${Date.now() % 1000}` });
    rawC.send({ type: MSG.CHAT, text: '' });
    rawC.send({ type: MSG.CHAT, text: '    ' });
    rawC.send({ type: MSG.CHAT, text: 42 });
    rawC.send({ type: MSG.CHAT, text: 'a'.repeat(CHAT.MAX_LEN + 5), playerId: 'p999' });
  };

  /** Raund sikli: jamoalarni aniq o'q chizig'iga qo'yib xom klientdan o'q otish */
  const playRound = async (winnerTeam) => {
    if (!live()) return false;
    const s = server.state.lobby.session;
    if (!s) return false;
    const teamA = match().teams.A.map(String);
    const teamB = match().teams.B.map(String);
    const shooters = winnerTeam === TEAM.A ? teamA : teamB;
    const victims = winnerTeam === TEAM.A ? teamB : teamA;
    const shooter = shooters.map((id) => ({ id, sess: sOf(id), rc: raws.find((r) => r.playerId === id) }))
      .find((x) => x.sess && x.sess.state.health.alive && x.rc);
    if (!shooter) return false;
    for (const victimId of victims) {
      const victim = sOf(victimId);
      if (!victim || !victim.state.health.alive) continue;
      if (!live()) break;
      // aniq ko'rinish yo'lagi (x o'qi bo'ylab z=-14; o'lchangan)
      placePlayerAt(shooter.sess, { x: 13, y: 0, z: -14, yaw: 0 }, Date.now());
      placePlayerAt(victim, { x: -13, y: 0, z: -14, yaw: 0 }, Date.now());
      await sleep(80);
      for (let i = 0; i < 8; i++) {
        const v = sOf(victimId);
        if (!v || !v.state.health.alive) break;
        rawInput(shooter.rc, { aim: aimAt(shooter.id, victimId), fire: true });
        await sleep(110);
      }
      rawInput(shooter.rc, { fire: false });
    }
    return true;
  };

  const restartMatch = async () => {
    // MATCH_END dan keyin YANGI match: sessiya faqat OXIRGI a'zo chiqqanda
    // yopiladi — shuning uchun HAMMA (brauzerlar + xom) chiqadi, keyin qayta
    // host/join/start (ishlab chiqarish oqimi, o'ylab topilgan API EMAS).
    await front(A);
    await A.evaluate('window.__neon.leaveLobby()').catch(() => {});
    await front(B);
    await B.evaluate('window.__neon.leaveLobby()').catch(() => {});
    rawC.send({ type: MSG.LEAVE_SESSION });
    rawD.send({ type: MSG.LEAVE_SESSION });
    await waitServer(() => !server.state.lobby.session, 150, 100);
    await front(A);
    await A.evaluate('window.__neon.hostLobby()'); await sleep(250);
    await front(B); await B.evaluate('window.__neon.joinLobby()'); await sleep(250);
    rawC.send({ type: MSG.JOIN_SESSION }); await sleep(200);
    rawD.send({ type: MSG.JOIN_SESSION }); await sleep(200);
    await waitServer(() => server.state.lobby.session && server.state.lobby.session.players.length === 4, 100, 100);
    await front(A); await A.evaluate('window.__neon.startLobby()');
    await A.evaluate('window.__neon.enterGame()').catch(() => {});
    await B.evaluate('window.__neon.enterGame()').catch(() => {});
    await waitServer(() => live(), 200, 100);
    cycles += 1;
    return true;
  };

  console.log(`[load] ${MINUTES} daqiqalik yuk boshlandi (trafik aralash: harakat/o‘q/chat/raund/join/malformed)`);
  const restartWaiters = [];
  while (Date.now() - t0 < RUN_MS) {
    phase += 1;
    const elapsed = Date.now() - t0;

    // (a) HAQIQIY brauzer kiritishi: klaviatura + sichqoncha (production InputManager)
    if (phase % 2 === 1) {
      await keyDown(A, 'KeyW', 'w', 87);
      await keyDown(A, 'KeyD', 'd', 68);
      await A.evaluate('window.__neon.lookBy(14, 2)').catch(() => {});
      await B.evaluate('window.__neon.lookBy(-11, -3)').catch(() => {});
      await B.evaluate('window.__neon.setFire(true)').catch(() => {});
    } else {
      await keyUp(A, 'KeyW', 'w', 87);
      await keyUp(A, 'KeyD', 'd', 68);
      await B.evaluate('window.__neon.releaseFire()').catch(() => {});
      await B.evaluate('window.__neon.requestReload()').catch(() => {});
    }
    // haqiqiy sichqoncha (pointer lock bo'lsa o'q uziladi)
    if (phase % 6 === 0) {
      const locked = await A.evaluate('document.pointerLockElement !== null').catch(() => false);
      if (locked) {
        await A.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 1 });
        await sleep(120);
        await A.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 0 });
      }
    }

    // (b) xom klientlar: harakat + o'q + reload (haqiqiy WS → server)
    rawInput(rawC, { move: { forward: phase % 3 === 0 ? 1 : -1, right: phase % 2 ? 0.6 : -0.6, sprint: phase % 5 === 0 }, fire: phase % 3 === 0 });
    rawInput(rawD, { move: { forward: phase % 4 === 0 ? 1 : 0, right: phase % 2 ? -0.8 : 0.8, sprint: false }, fire: phase % 4 === 1, reload: phase % 40 === 0 });

    // (c) buzg'unchi trafik (har ~2 s)
    if (phase % 8 === 0) hostileBurst();
    // (d) chat (to'g'ri + chegaradan oshgan)
    if (phase % 12 === 0) chatBurst();
    if (phase % 20 === 0) rawC.send({ type: MSG.CHAT, text: 'stable ' + phase });

    // (e) raund/match aylanishi (har ~6 s)
    if (phase % 24 === 0 && !restartWaiters.length) {
      if (live()) {
        const wantA = (roundResults.length % 2 === 0);
        const scoreBefore = { ...match().scores };
        const roundBefore = match().roundNumber;
        await playRound(wantA ? TEAM.A : TEAM.B);
        if (await waitServer(() => match().roundState !== MATCH_PHASE.LIVE, 60, 100)) {
          roundsObserved += 1;
          const scoreAfter = { ...match().scores };
          roundResults.push({
            matchSeq: cycles,
            roundBefore, roundAfter: match().roundNumber,
            winner: match().roundWinner,
            totalBefore: scoreBefore.A + scoreBefore.B,
            totalAfter: scoreAfter.A + scoreAfter.B,
            scores: scoreAfter
          });
        }
      }
      if (match().state === MATCH_PHASE.MATCH_END) {
        restartWaiters.push(restartMatch());
        await restartWaiters.pop();
      }
    }

    // (f) davriy o'lchov (har ~10 s)
    if (phase % 40 === 0) {
      const tel = server.telemetry();
      const p = await A.evaluate('window.__neon.perf()').catch(() => null);
      samples.push({
        atMs: elapsed,
        heapMb: tel.perf.memory.heapMb,
        rssMb: tel.perf.memory.rssMb,
        sessions: tel.resources.sessions,
        connections: tel.resources.connections,
        chatEntries: tel.resources.chatEntries,
        tickErrors: tel.tickErrors,
        clientHeapMb: p && p.memory ? p.memory.usedHeapMb : null,
        clientFps: p && p.fps ? p.fps.fpsAvg : null,
        clientDom: p && p.dom ? p.dom.total : null,
        remotes: p && p.sync ? p.sync.remotes : null
      });
      errorsDuring.browser = consoleErrors(A).length + consoleErrors(B).length;
    }

    await sleep(120);
  }
  const ranMs = Date.now() - t0;
  await sleep(500);

  // ---------------- 5) UZOQ YUKDAN KEYINGI O'LCHOVLAR ----------------
  const endTel = server.telemetry();
  const endPerf = await A.evaluate('window.__neon.perf()');
  server.metrics.sampleMemory(Date.now(), true);
  const memEnd = server.telemetry().perf.memory;
  await saveShot(A, 'p10-02-after-long-run');
  await saveShot(B, 'p10-03-after-long-run-b');

  check('P10.4 uzoq muddatli yuk HAQIQATAN bajarildi (bo‘sh turmadi)',
    ranMs >= RUN_MS * 0.95 && endTel.perf.ops.inputs > 500 && endTel.perf.snapshot.count > 500 &&
    roundsObserved >= 1 && samples.length >= 3,
    `davomiylik=${round(ranMs / 1000, 1)} s (target ${MINUTES * 60} s) · input=${endTel.perf.ops.inputs} · snapshot=${endTel.perf.snapshot.count} · raundlar=${roundsObserved} · namunalar=${samples.length} · qayta boshlash=${cycles}`);

  check('P10.5 server tick o‘lchovi (o‘rtacha/maks/p95/p99 + byudjet ulushi)',
    endTel.perf.tick.count > 1000 && endTel.perf.tick.avgMs < SIM.TICK_MS && endTel.perf.tick.p95Ms < SIM.TICK_MS,
    `tick=${endTel.perf.tick.count} · avg=${endTel.perf.tick.avgMs} ms · max=${endTel.perf.tick.maxMs} ms · p95=${endTel.perf.tick.p95Ms} · p99=${endTel.perf.tick.p99Ms} · byudjet=${endTel.perf.budgetMs} ms · ulush=${endTel.perf.tick.utilPct}% · oshish=${endTel.perf.tick.overruns} (${endTel.perf.tick.overrunPct}%)`);

  check('P10.6 server BARQAROR: tickErrors = 0, ushlanmagan xato YO‘Q, jarayon tirik',
    endTel.tickErrors === 0 && uncaught.length === 0 &&
    server.httpServer.listening === true,
    `tickErrors=${endTel.tickErrors} · uncaught=${uncaught.length}${uncaught.length ? ' · ' + uncaught[0].slice(0, 90) : ''} · tick=${endTel.tick}`);

  check('P10.7 snapshot oqimi barqaror (20 Hz) va o‘lchandi',
    endTel.perf.snapshot.count > 100 && endTel.perf.snapshot.playersMax <= SIM.MAX_SNAPSHOT_PLAYERS &&
    endTel.sync.frames > 0,
    `snapshot qadam=${endTel.perf.snapshot.count} · avg=${endTel.perf.snapshot.avgMs} ms · maks o‘yinchi=${endTel.perf.snapshot.playersMax} · sync frames=${endTel.sync.frames}`);

  check('P10.8 input: hajm + avtoritet saqlangan (rad etilganlar holatni o‘zgartirmagan)',
    endTel.perf.ops.inputs > 500 && endTel.perf.ops.inputsRejected > 0 &&
    endTel.perf.ops.inputsAccepted > 0 && endTel.perf.ops.malformed > 0,
    `input=${endTel.perf.ops.inputs} (qabul=${endTel.perf.ops.inputsAccepted} rad=${endTel.perf.ops.inputsRejected}) · buzilgan=${endTel.perf.ops.malformed} · o‘q qabul/rad=${endTel.perf.ops.shotsAccepted}/${endTel.perf.ops.shotsRejected}`);

  check('P10.9 chat yuki: qabul + rad + tarix CHEGARADA (cross-session leak yo‘q)',
    endTel.chat.accepted > 5 && endTel.chat.rejected > 5 &&
    server.state.chat.entries.length <= CHAT.HISTORY &&
    endTel.perf.ops.chatAccepted + endTel.perf.ops.chatRejected > 5,
    `qabul=${endTel.chat.accepted} rad=${endTel.chat.rejected} · tarix=${server.state.chat.entries.length}/${CHAT.HISTORY} · rad turlari=${JSON.stringify(endTel.chat.rejections)}`);

  // Raund/match aylanishi: ball = raundlar soni (dublikat ball yo'q)
  const scoreSum = match().scores.A + match().scores.B;
  // Raund raqami o'sish tartibida bo'lishi shart — FAQAT bir match ichida
  // (yangi match 1 dan boshlanadi, shuning uchun matchSeq bo'yicha guruhlaymiz)
  const transitionsSane = roundResults.every((r, i) => {
    if (!i) return true;
    const prev = roundResults[i - 1];
    if (prev.matchSeq !== r.matchSeq) return true;
    return r.roundAfter >= prev.roundAfter;
  });
  const roundSteps = roundResults.map((r) => r.totalAfter - r.totalBefore);
  const roundJumps = roundResults.map((r) => r.roundAfter - r.roundBefore);
  const noDoubleScore = roundSteps.every((d) => d === 1);
  const noRoundJump = roundJumps.every((d) => d >= 0 && d <= 1);
  const roundEndAge = match().roundState === MATCH_PHASE.ROUND_END
    ? Date.now() - (match().roundEndsAt || 0) : 0;
  check('P10.10 raund/match aylanishi: ball HAR RAUNDDA aynan +1, holat qotib qolmagan',
    roundsObserved >= 1 && noDoubleScore && noRoundJump && transitionsSane &&
    !(match().roundState === MATCH_PHASE.ROUND_END && roundEndAge > 60000),
    `kuzatilgan raund=${roundsObserved} · har qadamda ball o‘sishi=[${roundSteps.join(',')}] · raund raqami sakrashi=[${roundJumps.join(',')}] · joriy ball A=${match().scores.A} B=${match().scores.B} (yig‘indi=${scoreSum}) · holat=${match().state}/${match().roundState} · yangi match=${cycles}`);

  // ---------------- 6) KLIENT TOMONI (resurslar HALI TIRIK) ----------------
  const samplesBounded = samples.every((s) => s.sessions <= 4 && s.chatEntries <= CHAT.HISTORY && s.tickErrors === 0);
  check('P10.11 uzoq yuk davomida konteynerlar o‘smagan (davriy namunalar)',
    samples.length >= 3 && samplesBounded,
    samples.slice(-4).map((s) => `${round(s.atMs / 1000, 0)}s: heap=${s.heapMb}MB sess=${s.sessions} chat=${s.chatEntries} fps=${s.clientFps}`).join(' | '));

  const errA = consoleErrors(A).length;
  const errB = consoleErrors(B).length;
  const exA = A.exceptions.length;
  const exB = B.exceptions.length;
  check('P10.12 klient runtime: console.error YO‘Q, istisno YO‘Q, rAF/input tirik',
    errA === 0 && errB === 0 && exA === 0 && exB === 0 &&
    endPerf.hud.frames > basePerf.hud.frames + 100 &&
    endPerf.errors.neon === 0 && endPerf.errors.loop === 0,
    `console.error A=${errA} B=${errB} · istisno A=${exA} B=${exB} · kadr ${basePerf.hud.frames} → ${endPerf.hud.frames} · __neon xatolari=${endPerf.errors.neon} loop=${endPerf.errors.loop}`);

  const domGrowth = endPerf.dom.total - basePerf.dom.total;
  const writes = endPerf.hud.domWrites - basePerf.hud.domWrites;
  const frames = endPerf.hud.frames - basePerf.hud.frames;
  check('P10.13 HUD/render: har kadr DOM qayta qurilmaydi + DOM o‘sishi chegaralangan + remote mesh hisobi TO‘G‘RI',
    writes < frames / 4 && domGrowth <= 80 &&
    endPerf.dom.chatItems <= 12 &&
    endPerf.sync.remotesCreated === endPerf.sync.remotesDisposed + endPerf.sync.remotes,
    `DOM yozuv=${writes} / kadr=${frames} (${round((writes / Math.max(1, frames)) * 100, 1)}%) · DOM tugun Δ${domGrowth} · chat DOM=${endPerf.dom.chatItems} · remote mesh: yaratilgan=${endPerf.sync.remotesCreated} yo‘q qilingan=${endPerf.sync.remotesDisposed} hozir=${endPerf.sync.remotes}`);

  check('P10.14 navbat chegaralari buzilmagan (input/snapshot/interpolatsiya)',
    endPerf.sync.bounds.pendingMax <= endPerf.sync.bounds.limits.pending &&
    endPerf.sync.bounds.bufferMaxOverall <= endPerf.sync.bounds.limits.buffer &&
    endPerf.sync.bounds.pendingMax > 0 && endPerf.sync.bounds.bufferMaxOverall > 0,
    `pending maks=${endPerf.sync.bounds.pendingMax}/${endPerf.sync.bounds.limits.pending} · interp bufer maks=${endPerf.sync.bounds.bufferMaxOverall}/${endPerf.sync.bounds.limits.buffer} · interp namunalari=${endPerf.sync.interpolation.samples} · rekonsiliatsiya=${JSON.stringify(endPerf.sync.reconciliation)}`);

  // ---------------- 8) ERROR CONTAINMENT: yangi klient hali ham xizmat oladi ----------------
  const fresh = new RawClient(WS_URL, 'fresh');
  await fresh.open();
  raws.push(fresh);
  fresh.send({ type: MSG.HELLO, name: 'fresh' });
  await fresh.next(MSG.WELCOME);
  const freshSess = await fresh.next(MSG.SESSION);
  fresh.send({ type: MSG.PING, t: 12345 });
  const pong = await fresh.next(MSG.PONG);
  fresh.send({ type: MSG.CREATE_SESSION });
  const lobbyMsg = await fresh.next(MSG.LOBBY_STATE);
  check('P10.15 error containment: buzg‘unchi trafikdan keyin ham server TO‘LIQ xizmat qiladi',
    pong.t === 12345 && !!freshSess.playerId && !!lobbyMsg &&
    server.telemetry().tickErrors === 0 && server.state.lobby.session !== null,
    `yangi playerId=${freshSess.playerId} · PONG=${pong.t} · lobby state=${lobbyMsg.state} · tickErrors=${server.telemetry().tickErrors}`);
  fresh.terminate();
  await waitServer(() => !server.state.lobby.session, 80, 100);

  // ---------------- 7) TO‘LIQ TEARDOWN — resurs hayoti + leak ----------------
  const midResources = server.telemetry().resources;      // yuk paytida (4 a’zo)
  await front(A); await A.evaluate('window.__neon.leaveLobby()').catch(() => {});
  await front(B); await B.evaluate('window.__neon.leaveLobby()').catch(() => {});
  for (const r of raws) { try { r.terminate(); } catch {} }
  await A.evaluate('window.__neon.dropSocket()').catch(() => {});
  await B.evaluate('window.__neon.dropSocket()').catch(() => {});
  await waitServer(() => server.state.connections.size === 0, 150, 100);
  await sleep(800);
  const afterResources = server.telemetry().resources;
  const afterTel = server.telemetry();
  const afterPerf = await A.evaluate('window.__neon.perf()').catch(() => null);

  check('P10.16 to‘liq teardown: ulanish/sessiya/lobby/chat BO‘SH, ghost YO‘Q, hisob to‘g‘ri',
    afterResources.connections === 0 && afterResources.sessions === 0 &&
    afterResources.lobbyMembers === 0 && afterResources.chatEntries === 0 &&
    afterResources.opened.connections - afterResources.closed.connections === 0 &&
    afterResources.opened.sessions - afterResources.closed.sessions === 0 &&
    afterResources.opened.members - afterResources.closed.members === 0 &&
    afterTel.tickErrors === 0 &&
    (afterPerf === null || (afterPerf.sync.enabled === false && afterPerf.sync.remotes === 0 &&
      afterPerf.sync.remotesCreated === afterPerf.sync.remotesDisposed)),
    `ulanish=${afterResources.connections} sessiya=${afterResources.sessions} a’zo=${afterResources.lobbyMembers} chat=${afterResources.chatEntries} · ochilgan/yopilgan: ulanish=${afterResources.opened.connections}/${afterResources.closed.connections} sessiya=${afterResources.opened.sessions}/${afterResources.closed.sessions} a’zo=${afterResources.opened.members}/${afterResources.closed.members} · klient: sync=${afterPerf ? afterPerf.sync.enabled : '—'} remote=${afterPerf ? afterPerf.sync.remotes : '—'} (yaratilgan=${afterPerf ? afterPerf.sync.remotesCreated : '—'} yo‘q=${afterPerf ? afterPerf.sync.remotesDisposed : '—'})`);

  server.metrics.sampleMemory(Date.now(), true);
  const memAfter = server.telemetry().perf.memory;
  const memDelta = round(memAfter.heapMb - memStart.heapMb, 2);
  const rssDelta = round(memAfter.rssMb - memStart.rssMb, 2);
  const activeAfter = afterResources.activeResources;
  check('P10.17 xotira/resurs leak YO‘Q (heap o‘sishi chegaralangan, runaway timer yo‘q)',
    Math.abs(memDelta) < 150 && memAfter.samples > 2 &&
    (activeAfter === null || (activeAfter.byType.Timeout || 0) <= 6) &&
    (activeAfter === null || Object.keys(activeAfter.byType).every((k) => /PipeWrap|TCPServerWrap|Timeout|TCPSocketWrap|ProcessWrap|Immediate/.test(k))),
    `heap ${memStart.heapMb} → ${memAfter.heapMb} MB (Δ${memDelta}) · rss Δ${rssDelta} MB · maks heap=${memAfter.maxHeapMb} MB · aktiv resurslar=${activeAfter ? JSON.stringify(activeAfter.byType) : 'n/a'} · namunalar=${memAfter.samples}`);

  // ---------------- 8) RENDER / PERFORMANCE maqsadlari ----------------
  const worstFps = await A.evaluate('window.__neon.diagnostics().fps');
  check('P10.18 unumdorlik maqsadlari (FPS≥30, CPU<16.6ms, calls≤165, tri≤32k, shadow OFF)',
    worstFps.fpsAvg >= 30 && (worstFps.min === undefined || worstFps.min >= 15) &&
    endPerf.frame.cpuMs < 16.6 && endPerf.render.calls <= 165 &&
    endPerf.render.triangles <= 32000 && endPerf.render.shadowMap === false,
    `FPS o‘rt=${round(worstFps.fpsAvg, 1)} min=${worstFps.min ?? '—'} · CPU=${endPerf.frame.cpuMs} ms · calls=${endPerf.render.calls} · tri=${endPerf.render.triangles} · shadowMap=${endPerf.render.shadowMap}`);

  // ---------------- 10) SCOPE: P11/P12 YO'Q ----------------
  const forbidden = /spectat|replay|voip|voice|matchmak|ranking|scoreboard|killfeed|inventory|lobbybrowser|friend|clan|achievement|profile|account|lanqa|two[-_]device|hardening|deploy|cloud|matchmak/i;
  const msgKeys = Object.keys(MSG).filter((k) => forbidden.test(k));
  const neonKeys = (await A.evaluate('Object.keys(window.__neon)')).filter((k) => forbidden.test(k));
  const telKeys = Object.keys(server.telemetry()).filter((k) => forbidden.test(k));
  const resKeys = Object.keys(server.telemetry().resources).filter((k) => forbidden.test(k));
  check('P10.19 P11/P12 (LAN QA / final hardening) tizimlari YO‘Q',
    msgKeys.length === 0 && neonKeys.length === 0 && telKeys.length === 0 && resKeys.length === 0,
    `xabar turlari=${Object.keys(MSG).length} taqiqlangan=[${msgKeys.join(',')}] · __neon API taqiqlangan=[${neonKeys.join(',')}] · telemetriya taqiqlangan=[${telKeys.join(',')}] · resurs kalitlari taqiqlangan=[${resKeys.join(',')}]`);

  // ---------------- hisobot ----------------
  const report = {
    generatedAt: new Date().toISOString(),
    phase: 10,
    subject: 'performance-stability',
    mode: HEADLESS ? 'headless' : 'real-window',
    url: BASE,
    protocol: PROTOCOL_VERSION,
    runMinutes: MINUTES,
    ranMs,
    gpu: { renderer, headless: HEADLESS, webgl2: !!readyA.gates?.webgl2 },
    twoProcess: {
      method: 'two independent Chrome PROCESSES (separate CDP ports/profiles/WS/__neon/rAF) + raw WS load clients',
      portA: CDP_PORT_A, portB: CDP_PORT_B,
      pidA: chromeA.child.pid, pidB: chromeB.child.pid,
      players: ids, pointerLockSeen: await A.evaluate('document.pointerLockElement !== null').catch(() => null)
    },
    server: {
      tick: endTel.perf.tick,
      snapshot: endTel.perf.snapshot,
      ops: endTel.perf.ops,
      memoryAfterLoad: memEnd,
      memoryAfterTeardown: memAfter,
      memoryStart: memStart,
      memoryDeltaMb: memDelta,
      rssDeltaMb: rssDelta,
      tickErrors: endTel.tickErrors,
      uncaught: uncaught.length,
      activeResources: activeAfter,
      samples,
      rounds: {
        observed: roundsObserved, restarts: cycles,
        scoreSteps: roundSteps, roundJumps,
        results: roundResults.slice(0, 20), scores: { ...match().scores }
      }
    },
    resources: {
      start: resStart, duringLoad: midResources, afterTeardown: afterResources,
      clientAfterTeardown: afterPerf ? { enabled: afterPerf.sync.enabled, remotes: afterPerf.sync.remotes, created: afterPerf.sync.remotesCreated, disposed: afterPerf.sync.remotesDisposed } : null
    },
    chat: {
      accepted: endTel.chat.accepted, rejected: endTel.chat.rejected,
      rejections: { ...endTel.chat.rejections },
      history: server.state.chat.entries.length, historyLimit: CHAT.HISTORY
    },
    client: {
      fps: worstFps, frame: endPerf.frame, render: endPerf.render,
      hud: endPerf.hud, dom: endPerf.dom, domGrowth,
      sync: { bounds: endPerf.sync.bounds, interpolation: endPerf.sync.interpolation, reconciliation: endPerf.sync.reconciliation, remotesCreated: endPerf.sync.remotesCreated, remotesDisposed: endPerf.sync.remotesDisposed },
      memory: endPerf.memory, memoryStartMb: heapStart,
      consoleErrors: { A: errA, B: errB }, exceptions: { A: exA, B: exB }
    },
    unit: { tests: uTests, pass: uPass, fail: uFail, exit: unitRun.code, files: UNIT_FILES.length },
    narrative: {
      baseline: { unit: 232, phase2: 42, phase3: 25, phase4: 22, phase5: 18, phase6: 21, phase7: 33, phase8: 28, phase9: 34 },
      phase10Scope: 'performance + stability + resource lifetime + long-run robustness + error containment (yangi oyin/qurol/xarita YOQ)',
      filesNew: ['server/metrics.js', 'test/unit/stability.test.js', 'tools/verify-phase10.mjs'],
      filesChanged: [
        'server/app.js', 'client/js/game/multiplayer.js', 'client/js/game/hud.js',
        'client/js/game/index.js', 'client/js/main.js', 'package.json'
      ],
      defectsFixed: [
        'close() osilib qolishi mumkin edi (wss.close callbackiga bogliq) -> closeAllConnections + chegaralangan guard',
        'metrics.reset() kumulyativ hayot hisobini (opened - closed = live) buzardi -> endi reset faqat oynani tozalaydi',
        'bitta socketda takroriy HELLO sessiya/azo hisobini kopaytirardi -> eski sessiya/azo yopiladi va hisobga olinadi',
        'lanAddresses() har bir azo uchun qayta hisoblanardi (olchandi ~65 us x L) -> broadcastda bir marta hisoblanadi',
        'klientda remote mesh yaratilishi/yoq qilinishi va HUD DOM yozuvlari o lchanmasdi -> hisoblagichlar qoshildi'
      ],
      phaseBoundaryNote: 'P7.28/P8.31 faza-chegara darvozalari P9 paytida Phase 10+ ga kochirilgan (P9 chat yetkazgan edi) — P10 da ularning kuchi/ko lam ozgarmadi (P10.19 P11/P12 ni tekshiradi)'
    },
    shotCount: shots.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    gates: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
    limitations: [
      'ikki qurilmali HAQIQIY LAN QA bu fazada YO‘Q (P11 ishi) — klientlar bitta mashinada',
      'qayta ulanish (auto-reconnect) ishlab chiqilmagan — hayot sikli halol sinovdan o‘tkazildi',
      'granata portlashi hamon faqat o‘ziga zarar (P8 merosi)',
      'P9 HUD/chat yuki o‘lchandi; P10 optimizatsiya FAQAT dalil bo‘lgan joyda qilindi'
    ],
    scopeConfirmation: 'P10 faqat o‘lchov/barqarorlik: yangi o‘yin, qurol, xarita, LAN QA, bulut, akkaunt YO‘Q (P10.19)'
  };
  fs.writeFileSync(path.join(ART, 'phase10-report.json'), JSON.stringify(report, null, 2));

  console.log('\n=== PHASE 10 VERIFICATION SUMMARY ===');
  console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
  console.log(`GPU: ${renderer}`);
  console.log(`SERVER: tick=${endTel.perf.tick.count} avg=${endTel.perf.tick.avgMs}ms max=${endTel.perf.tick.maxMs}ms p95=${endTel.perf.tick.p95Ms}ms tickErrors=${endTel.tickErrors} heapΔ=${memDelta}MB`);
  console.log(`YUK: ${round(ranMs / 1000, 1)}s · input=${endTel.perf.ops.inputs} · snapshot=${endTel.perf.snapshot.count} · chat=${endTel.chat.accepted}/${endTel.chat.rejected} · raundlar=${roundsObserved} · malformed=${endTel.perf.ops.malformed}`);
  console.log(`KLIENT: FPS=${round(worstFps.fpsAvg, 1)} CPU=${endPerf.frame.cpuMs}ms calls=${endPerf.render.calls} tri=${endPerf.render.triangles} DOMΔ=${domGrowth}`);
  console.log(`Artifacts: ${shots.length} screenshot + logs/phase10-report.json`);

  await cleanup();
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
  runCleanup();
  process.exit(2);
});
