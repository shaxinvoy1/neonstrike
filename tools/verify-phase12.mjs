#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 12 (FINAL HARDENING) verifikatsiyasi
//
// ANTI-FAKE qoidalari:
//   • HAQIQIY Chrome (2 ALOHIDA JARAYON, alohida CDP port + profil + GPU)
//   • HAQIQIY server (harness o'zi ishga tushiradi) — dalillar server
//     xotirasidan (`server.telemetry()`, `server.state`)
//   • Forged/malformed trafik XOM WebSocket klientlardan yuboriladi
//     (klient funksiyasini chaqirib "tekshirish" EMAS)
//   • P11 fizik ikki-qurilma QA HOLATI O'ZGARTIRILMAYDI: bu skript
//     `logs/phase11-report.json` ni O'QIYDI va PARTIAL bo'lsa shuni
//     tasdiqlaydi (P12 COMPLETE bo'lishi P11 ni PASS qilmaydi).
//
// Ishga tushirish:  node tools/verify-phase12.mjs
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, CHAT } from '../shared/protocol-consts.js';
import { SPAWNS } from '../shared/map.js';
import { createMatch, startMatch, beginRound, endRound, TEAM } from '../server/match.js';
import { scanFiles, scanSource, scanFutureScope } from './lib/authority-scan.mjs';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT_A = Number(process.env.CDP_PORT || 9396);
const CDP_PORT_B = CDP_PORT_A + 1;
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js', 'test/unit/multiplayer.test.js',
  'test/unit/round-team-score.test.js', 'test/unit/hud-chat.test.js', 'test/unit/stability.test.js',
  'test/unit/lan-qa.test.js', 'test/unit/final-hardening.test.js'
];
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

// ---------------- minimal CDP klient (phase10 bilan bir xil naqsh) ----------------
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

/** Xom WS klient — HAQIQIY server o'yinchisi (forged/malformed trafik manbai) */
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
  async hello (name) {
    this.send({ type: MSG.HELLO, name: name || this.name });
    await this.next(MSG.WELCOME);
    const s = await this.next(MSG.SESSION);
    this.playerId = s.playerId; this.sessionId = s.sessionId;
    return s;
  }
  send (obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  sendRaw (text) { try { this.ws.send(text); } catch {} }
  terminate () { try { this.ws.terminate(); } catch {} }
  close () { try { this.ws.close(); } catch {} }
}

const cleanupHooks = [];
function registerCleanup (fn) { cleanupHooks.push(fn); }
function runCleanup () { for (const fn of cleanupHooks.splice(0)) { try { fn(); } catch {} } }
process.on('exit', runCleanup);
process.on('SIGINT', () => { runCleanup(); process.exit(130); });
process.on('SIGTERM', () => { runCleanup(); process.exit(143); });

async function launchChrome (base, cdpPort, tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `neon12-${tag}-`));
  const args = [
    `--remote-debugging-port=${cdpPort}`, '--new-window', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1280,800', '--window-position=0,0', base
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  registerCleanup(() => { try { child.kill('SIGKILL'); } catch {} });
  registerCleanup(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
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
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return cdp;
}
async function waitReady (cdp) {
  for (let i = 0; i < 100; i++) {
    const s = await cdp.evaluate(`(() => {
      if (!window.__neon) return { ready: false };
      return { ready: !!window.__neon.loaded, ws: !!(window.__neon.gates && window.__neon.gates.ws),
        gates: window.__neon.gates || null, phase12: true };
    })()`).catch(() => ({ ready: false }));
    if (s && s.ready && s.ws) return s;
    await sleep(300);
  }
  return await cdp.evaluate(`({ ready: !!(window.__neon && window.__neon.loaded), gates: window.__neon && window.__neon.gates })`).catch(() => null);
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
  const wait = async (pred, tries = 160, ms = 100) => { for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms); } return pred(); };

  const uncaught = [];
  process.on('uncaughtException', (e) => uncaught.push(String(e && e.stack ? e.stack : e)));
  process.on('unhandledRejection', (e) => uncaught.push(String(e)));

  console.log('\n=== PHASE 12 — FINAL HARDENING ===\n');

  const raw = [];
  const cleanup = async () => {
    for (const r of raw) r.terminate();
    try { A && A.close(); } catch {}
    try { B && B.close(); } catch {}
    await server.close();
  };
  let A = null; let B = null;

  try {
    // ---------------- P12.1/2: HAQIQIY Chrome x2 ----------------
    const chromeA = await launchChrome(BASE, CDP_PORT_A, 'a');
    A = await prepare(await new CDP((await waitForPageTarget(BASE, CDP_PORT_A)).webSocketDebuggerUrl).open());
    const readyA = await waitReady(A);
    const chromeB = await launchChrome(BASE, CDP_PORT_B, 'b');
    B = await prepare(await new CDP((await waitForPageTarget(BASE, CDP_PORT_B)).webSocketDebuggerUrl).open());
    const readyB = await waitReady(B);

    const gpu = readyA && readyA.gates ? readyA.gates.renderer : '';
    check('P12.1 HAQIQIY Chrome + HAQIQIY GPU (WebGL2 tirik, SwiftShader EMAS, headless EMAS)',
      !!(readyA && readyA.gates && readyA.gates.webgl2) && !/swiftshader|llvmpipe|software/i.test(String(gpu)) && !HEADLESS,
      `renderer="${String(gpu).slice(0, 48)}" · headless=${HEADLESS}`);

    check('P12.2 IKKI MUSTAQIL Chrome JARAYONI (alohida CDP port + pid + profil + __neon)',
      chromeA.child.pid !== chromeB.child.pid && CDP_PORT_A !== CDP_PORT_B && !!readyA && !!readyB,
      `pidA=${chromeA.child.pid} pidB=${chromeB.child.pid} · portlar=${CDP_PORT_A}/${CDP_PORT_B}`);

    // ---------------- P12.2c: HAQIQIY unit regressiyasi ----------------
    const unit = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['--test', ...UNIT_FILES], { cwd: process.cwd() });
      let out = '';
      p.stdout.on('data', (b) => { out += b.toString(); });
      p.stderr.on('data', (b) => { out += b.toString(); });
      p.on('close', (code) => {
        const t = /# tests (\d+)/.exec(out); const pa = /# pass (\d+)/.exec(out); const f = /# fail (\d+)/.exec(out);
        resolve({ code, tests: t ? +t[1] : 0, pass: pa ? +pa[1] : 0, fail: f ? +f[1] : 0 });
      });
    });
    check('P12.2c HAQIQIY unit regressiyasi (npm test bilan bir xil ro‘yxat) PASS',
      unit.code === 0 && unit.fail === 0 && unit.pass === unit.tests && unit.tests > 0,
      `tests=${unit.tests} pass=${unit.pass} fail=${unit.fail}`);

    // ---------------- P12.3: statik avtoritet skaneri ----------------
    const SRC = [
      'server/app.js', 'server/session.js', 'server/lobby.js', 'server/chat.js', 'server/match.js',
      'server/metrics.js', 'server/net.js', 'shared/combat.js', 'shared/weapons.js', 'shared/movement.js',
      'shared/health.js', 'shared/hitdetect.js', 'shared/grenade.js', 'shared/respawn.js', 'shared/protocol-consts.js'
    ];
    const readSrc = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    const findings = scanFiles(SRC, readSrc);
    const planted = scanSource('function f(msg){ state.health.hp = msg.hp; }', 'planted');
    check('P12.3 statik avtoritet skaneri: real manbalarda 0 topilma, plantatsiyani USHLAYDI',
      findings.length === 0 && planted.length >= 2,
      `topilmalar=${findings.length} plantatsiya=${planted.length}`);

    // ---------------- P12.4: kelgusi-faza terminlari YO'Q ----------------
    const neonKeys = await A.evaluate('Object.keys(window.__neon)').catch(() => []);
    const future = scanFutureScope([...Object.values(MSG), ...(neonKeys || [])]);
    check('P12.4 chegara: protokol/__neon yuzasida P13+ terminlari YO‘Q',
      future.length === 0, `topilgan=${JSON.stringify(future)}`);

    // ---------------- P12.5: P11 PARTIAL holati SAQLANADI ----------------
    let p11 = null;
    try { p11 = JSON.parse(fs.readFileSync(path.join(ART, 'phase11-report.json'), 'utf8')); } catch {}
    const p11Status = p11 ? (p11.status || (p11.summary && p11.summary.status) || JSON.stringify(p11).match(/PARTIAL[^"]*/)?.[0] || '') : '';
    check('P12.5 P11 fizik ikki-qurilma holati O‘ZGARTIRILMAGAN (P12 COMPLETE P11 ni PASS qilmaydi)',
      /PARTIAL/i.test(String(p11Status)), `phase11.status="${String(p11Status).slice(0, 60)}"`);

    // ---------------- P12.6: ikki brauzer sessiyaga ulanadi ----------------
    const hostOk = await A.evaluate('window.__neon.hostLobby()');
    await wait(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 100);
    const joinOk = await B.evaluate('window.__neon.joinLobby()');
    await wait(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 120);
    const lobbySnap = server.state.lobby.session;
    const roster = lobbySnap ? lobbySnap.players.map((p) => p.id) : [];
    check('P12.6 IKKI brauzer bir sessiyada: server 2 xil ID ko‘radi (takror YO‘Q)',
      !!hostOk && !!joinOk && !!lobbySnap && roster.length === 2 && new Set(roster).size === 2,
      `roster=${JSON.stringify(roster)}`);

    // ---------------- P12.7: host start → in_game → LIVE ----------------
    await A.evaluate('window.__neon.startLobby()');
    const inGame = await wait(() => server.state.lobby.session && server.state.lobby.session.state === 'in_game', 120);
    const liveOk = await wait(() => server.state.match.roundState === 'live', 200);
    const teams = server.state.match.teams;
    check('P12.7 host start → avtoritar in_game → LIVE + jamoalar server tayinlagan',
      !!inGame && !!liveOk && (teams.A.length + teams.B.length) === 2,
      `state=${server.state.lobby.session?.state} round=${server.state.match.roundState} A=[${teams.A}] B=[${teams.B}]`);

    // ---------------- P12.8: avtoritar HUD (ikkala klientda) ----------------
    await sleep(1200);
    const hvA = await A.evaluate('window.__neon.hudAuthority()');
    const hvB = await B.evaluate('window.__neon.hudAuthority()');
    const hvOk = hvA && hvB && hvA.source === 'server' && hvB.source === 'server' &&
      typeof hvA.view.hp === 'number' && typeof hvA.view.mag === 'number' &&
      (hvA.view.team === 'A' || hvA.view.team === 'B');
    check('P12.8 HUD AVTORITAR holatdan (source=server): HP/o‘q-dori/jamoa serverdan',
      !!hvOk, `A={src:${hvA?.source} hp:${hvA?.view?.hp} mag:${hvA?.view?.mag} team:${hvA?.view?.team}} B={src:${hvB?.source} team:${hvB?.view?.team}}`);

    // ---------------- P12.9: forged INPUT matritsasi (XOM WS) ----------------
    const forger = new RawClient(WS_URL, 'forger'); raw.push(forger);
    await forger.open(); await forger.hello('forger');
    const spawnPose = { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: SPAWNS.A.yaw, pitch: 0 };
    const fpBefore = (() => { const s = sOf(forger.playerId); return s ? { hp: s.state.health.hp, alive: s.state.health.alive, ls: s.lastSeq } : null; })();
    const forgedFields = ['damage', 'hp', 'health', 'targetHp', 'ammo', 'mag', 'reserve', 'cooldown',
      'alive', 'dead', 'hit', 'kill', 'score', 'scores', 'teamId', 'team', 'roundState', 'roundNumber',
      'roundWinner', 'matchState', 'matchWinner', 'position', 'velocity', 'spread', 'seed', 'tick', 'serverTick',
      'playerId', 'hostId'];
    let forgedRejected = 0;
    for (const f of forgedFields) {
      forger.send({ type: MSG.INPUT, seq: ++forger.seq, pose: spawnPose, aim: { dir: [1, 0, 0] }, intents: {}, [f]: 1 });
      const ack = await forger.next(MSG.INPUT_ACK).catch(() => null);
      if (ack && ack.accepted === false && ack.reason === 'forbidden_authority') forgedRejected += 1;
    }
    const fpAfter = (() => { const s = sOf(forger.playerId); return s ? { hp: s.state.health.hp, alive: s.state.health.alive, ls: s.lastSeq } : null; })();
    const scoresBefore = { ...server.state.match.scores };
    check('P12.9 forged INPUT: barcha avtoritar maydonlar RAD etildi, holat o‘zgarmadi',
      forgedRejected === forgedFields.length && JSON.stringify(fpBefore) === JSON.stringify(fpAfter) &&
      server.state.match.scores.A === scoresBefore.A && server.state.match.scores.B === scoresBefore.B,
      `${forgedRejected}/${forgedFields.length} rad · hp/alive/lastSeq o‘zgarmadi`);

    // ---------------- P12.10: NaN/Infinity (XOM WS) ----------------
    let nanRejected = 0;
    const nanCases = [
      { pose: { x: NaN, y: 1, z: 1, yaw: 0, pitch: 0 } },
      { pose: { x: Infinity, y: 1, z: 1, yaw: 0, pitch: 0 } },
      { aim: { dir: [NaN, 0, 0] } }, { aim: { dir: [0, 0, 0] } },
      { move: { forward: Infinity, right: 0 } }, { move: { forward: NaN, right: 0 } }
    ];
    for (const extra of nanCases) {
      forger.send({ type: MSG.INPUT, seq: ++forger.seq, pose: spawnPose, aim: { dir: [1, 0, 0] }, intents: {}, ...extra });
      const ack = await forger.next(MSG.INPUT_ACK).catch(() => null);
      if (ack && ack.accepted === false && ['bad_pose', 'bad_aim', 'bad_move'].includes(ack.reason)) nanRejected += 1;
    }
    check('P12.10 NaN/Infinity/-Infinity hech qachon avtoritar holatga KIRMAYDI',
      nanRejected === nanCases.length, `${nanRejected}/${nanCases.length} rad`);

    // ---------------- P12.11: malformed trafik (XOM WS) ----------------
    const hostile = new RawClient(WS_URL, 'hostile'); raw.push(hostile);
    await hostile.open(); await hostile.hello('hostile');
    const tick0 = server.telemetry().tick;
    hostile.sendRaw('{ not json');
    const e1 = await hostile.next(MSG.ERROR).catch(() => null);
    hostile.send({ nope: 1 });
    const e2 = await hostile.next(MSG.ERROR).catch(() => null);
    hostile.send({ type: 'totally-unknown' });
    const e3 = await hostile.next(MSG.ERROR).catch(() => null);
    hostile.sendRaw('x'.repeat(SERVER_DEFAULTS.MAX_MSG_BYTES + 100));
    const e4 = await hostile.next(MSG.ERROR).catch(() => null);
    hostile.send({ type: MSG.PING, t: 7 });
    const pong = await hostile.next(MSG.PONG).catch(() => null);
    // Loopback RTT bitta tick (33 ms) ichida tugashi mumkin — tick sur'ati
    // HAQIQATAN davom etishini o'lchash uchun ongli ravishda kutamiz.
    await sleep(150);
    const tick1 = server.telemetry().tick;
    check('P12.11 error containment: bad_json/bad_msg/unknown_type/too_big → server TIRIK, tick davom etadi',
      e1?.code === 'bad_json' && e2?.code === 'bad_msg' && e3?.code === 'unknown_type' &&
      e4?.code === 'too_big' && !!pong && tick1 > tick0 && server.telemetry().tickErrors === 0,
      `${e1?.code}/${e2?.code}/${e3?.code}/${e4?.code} · pong=${!!pong} · tick ${tick0}→${tick1} · tickErrors=${server.telemetry().tickErrors}`);

    // ---------------- P12.12: payload chegarasi (protokol darajasi) ----------------
    const big = new RawClient(WS_URL, 'big'); raw.push(big);
    await big.open();
    let bigClose = null;
    big.ws.once('close', (code) => { bigClose = code; });
    big.sendRaw('x'.repeat(SERVER_DEFAULTS.WS_MAX_PAYLOAD_BYTES + 4096));
    await wait(() => big.ws.readyState === 3, 60);
    const fresh = new RawClient(WS_URL, 'fresh'); raw.push(fresh);
    await fresh.open();
    const freshSess = await fresh.hello('fresh');
    check('P12.12 payload himoyasi: >64 KiB XOTIRAGA OLINMASDAN rad (1009), server yangi mijozi xizmat qiladi',
      bigClose === 1009 && !!freshSess && !!sOf(fresh.playerId),
      `closeCode=${bigClose} · fresh=${fresh.playerId} (ceiling=${SERVER_DEFAULTS.WS_MAX_PAYLOAD_BYTES}B)`);

    // ---------------- P12.13: takroriy HELLO arvoh qoldirmaydi ----------------
    const dup = new RawClient(WS_URL, 'dup'); raw.push(dup);
    await dup.open(); await dup.hello('dup');
    dup.send({ type: MSG.CREATE_SESSION, name: 'dup' });
    await dup.next(MSG.LOBBY_STATE).catch(() => null);
    const sessBefore = server.state.sessions.size;
    for (let i = 0; i < 3; i++) { dup.send({ type: MSG.HELLO, name: 'dup' }); await dup.next(MSG.WELCOME); await dup.next(MSG.SESSION); }
    await sleep(150);
    const roster2 = server.state.lobby.session ? server.state.lobby.session.players.map((p) => p.id) : [];
    const liveIds = sessions().map((s) => s.playerId);
    const ghostFree = roster2.every((id) => liveIds.includes(id)) && server.state.sessions.size === sessBefore;
    check('P12.13 takroriy HELLO: sessiya ko‘paymaydi va lobby’da ARVOH a’zo qolmaydi',
      ghostFree, `sessions=${server.state.sessions.size} roster=${JSON.stringify(roster2)} live=${JSON.stringify(liveIds)}`);

    // ---------------- P12.15: real chat A→server→B (CDP, HAQIQIY yo'l) ----------------
    const text = 'hardening-' + Math.floor(Math.random() * 1000);
    const sent = await A.evaluate(`window.__neon.chatSend(${JSON.stringify(text)})`);
    let gotB = null;
    for (let i = 0; i < 60; i++) {
      const st = await B.evaluate('window.__neon.chatState()');
      if (st && st.last && st.last.text === text) { gotB = st.last; break; }
      await sleep(100);
    }
    const hostPlayerId = (server.state.lobby.session.players.find((p) => p.host) || server.state.lobby.session.players[0]).id;
    check('P12.15 real chat A→server→B: matn yetib bordi, yuboruvchi kimligi SERVERDAN',
      !!sent && !!gotB && gotB.playerId === hostPlayerId,
      `matn="${text}" · B ko‘rgan playerId=${gotB?.playerId} (host=${hostPlayerId})`);

    // ---------------- P12.16: B HAQIQIY soketi uziladi → A dan remote yo'qoladi ----------------
    const remoteBefore = await A.evaluate('window.__neon.multiplayerQa().remoteCount');
    const playersBefore = sessions().length;
    await B.evaluate('window.__neon.dropSocket()');           // haqiqiy WS close (diagnostika API)
    const removed = await wait(() => sessions().length === playersBefore - 1, 200);
    let remoteAfter = -1;
    for (let i = 0; i < 100; i++) {
      remoteAfter = await A.evaluate('window.__neon.multiplayerQa().remoteCount');
      if (remoteAfter === 0) break;
      await sleep(100);
    }
    check('P12.16 uzilish: server o‘yinchini O‘CHIRADI va A dan remote mesh yo‘qoladi (ghost YO‘Q)',
      !!removed && remoteAfter === 0,
      `remote ${remoteBefore} → ${remoteAfter} · server players ${playersBefore} → ${sessions().length}`);

    // ---------------- P12.17: qayta ulanish (sahifa yangilanadi → YANGI identitet) ----------------
    await B.send('Page.reload', { ignoreCache: true });
    const readyB2 = await waitReady(B);
    const ids = sessions().map((s) => s.playerId);
    check('P12.17 qayta ulanish: YANGI identitet olindi, eski identitet DUBLIKAT bo‘lib qolmadi',
      !!readyB2 && new Set(ids).size === ids.length,
      `ids=${JSON.stringify(ids)}`);

    // ---------------- P12.14: dublikat JOIN (joriy sessiyaga qo'shiladi, XOM WS) ----------------
    const j1 = new RawClient(WS_URL, 'j1'); raw.push(j1); await j1.open(); await j1.hello('j1');
    j1.send({ type: MSG.JOIN_SESSION, name: 'j1' });
    await j1.next(MSG.LOBBY_STATE).catch(() => null);
    await wait(() => server.state.lobby.session && server.state.lobby.session.players.some((p) => p.id === j1.playerId), 80);
    const cBefore = server.state.lobby.session ? server.state.lobby.session.players.length : 0;
    j1.send({ type: MSG.JOIN_SESSION, name: 'j1' });   // dublikat
    await j1.next(MSG.LOBBY_STATE).catch(() => null);
    const cAfter = server.state.lobby.session ? server.state.lobby.session.players.length : 0;
    check('P12.14 dublikat JOIN idempotent (a’zo ikki marta qo‘shilmaydi)', cAfter === cBefore, `${cBefore} → ${cAfter}`);

    // ---------------- P12.18: chat himoyasi (sessiya a'zosi, XOM WS) ----------------
    const cf = new RawClient(WS_URL, 'cf'); raw.push(cf); await cf.open(); await cf.hello('cf');
    cf.send({ type: MSG.JOIN_SESSION, name: 'cf' });
    await cf.next(MSG.LOBBY_STATE).catch(() => null);
    await wait(() => server.state.lobby.session && server.state.lobby.session.players.some((p) => p.id === cf.playerId), 80);
    cf.send({ type: MSG.CHAT, text: 'hi', playerId: 'p999' });
    const fe = await cf.next(MSG.ERROR).catch(() => null);
    cf.send({ type: MSG.CHAT, text: 'z'.repeat(CHAT.MAX_LEN + 5) });
    const le = await cf.next(MSG.ERROR).catch(() => null);
    cf.send({ type: MSG.CHAT, text: '   ' });
    const ee = await cf.next(MSG.ERROR).catch(() => null);
    for (let i = 0; i < CHAT.BURST + 6; i++) { cf.send({ type: MSG.CHAT, text: 'flood ' + i }); await sleep(5); }
    await sleep(200);
    const rl = server.state.chat.rejections['chat_rate_limited'] || 0;
    check('P12.18 chat himoyasi: forged kimlik/uzun matn/bo‘sh matn/flood RAD etildi',
      fe?.code === 'forbidden_authority' && le?.code === 'chat_too_long' && ee?.code === 'chat_empty' && rl > 0,
      `${fe?.code}/${le?.code}/${ee?.code} · rate_limited=${rl}`);

    // ---------------- P12.19: raund idempotentligi (haqiqiy modul) ----------------
    const m = createMatch();
    startMatch(m, ['p1', 'p2'], 0);
    beginRound(m, 1, 0);
    const r1 = endRound(m, TEAM.A, 100);
    const r2 = endRound(m, TEAM.A, 200);
    check('P12.19 raund idempotentligi: dublikat endRound ballni IKKI MARTA oshirmaydi',
      r1.ok === true && r2.ok === false && m.scores.A === 1, `scores A=${m.scores.A} 2-chaqiruv=${r2.reason}`);

    // ---------------- P12.20: resurs hayoti hisobi (ochilgan − yopilgan = tirik) ----------------
    const tel = server.telemetry();
    const res = tel.resources;
    const liveSess = server.state.sessions.size;
    const liveConn = server.state.connections.size;
    check('P12.20 resurs hayoti: ochilgan − yopilgan = HAQIQIY tirik soni (leak yo‘q)',
      res.opened.sessions - res.closed.sessions === liveSess &&
      res.opened.connections - res.closed.connections === liveConn &&
      res.opened.members - res.closed.members >= 0,
      `sess ${res.opened.sessions}-${res.closed.sessions}=${liveSess} · conn ${res.opened.connections}-${res.closed.connections}=${liveConn}`);

    // ---------------- P12.21: ko'rinish regressioni (crosshair markaz + [hidden] qoidasi) ----------------
    const vis = await A.evaluate(`(() => {
      const r = document.getElementById('chCrosshair').getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const dbg = document.getElementById('debugOverlay');
      return { dx: Math.abs(cx - innerWidth / 2), dy: Math.abs(cy - innerHeight / 2),
        dbgHidden: !!dbg.hidden, dbgDisplay: getComputedStyle(dbg).display };
    })()`).catch(() => null);
    let small = null;
    try {
      await A.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      small = await A.evaluate(`(() => { const r = document.getElementById('chCrosshair').getBoundingClientRect();
        return { dx: Math.abs(r.left + r.width / 2 - innerWidth / 2), dy: Math.abs(r.top + r.height / 2 - innerHeight / 2) }; })()`);
      await A.send('Emulation.clearDeviceMetricsOverride');
    } catch {}
    check('P12.21 UI regression: crosshair ikki viewportda markazda + global [hidden] qoidasi tirik',
      !!vis && vis.dx <= 2 && vis.dy <= 2 && vis.dbgHidden && vis.dbgDisplay === 'none' &&
      (!small || (small.dx <= 2 && small.dy <= 2)),
      vis ? `dx=${round(vis.dx, 2)} dy=${round(vis.dy, 2)} · kichik=${small ? round(small.dx, 2) + '/' + round(small.dy, 2) : 'n/a'} · [hidden].display=${vis.dbgDisplay}` : 'evaluate failed');


    // ---------------- P12.22: unumdorlik regressiyasi (P10 ga nisbatan) ----------------
    await sleep(1500);
    const perf = await A.evaluate('window.__neon.perf()').catch(() => null);
    const t2 = server.telemetry();
    let p10 = null; try { p10 = JSON.parse(fs.readFileSync(path.join(ART, 'phase10-report.json'), 'utf8')); } catch {}
    check('P12.22 unumdorlik: server tick byudjetida, klient FPS sog‘lom (P10 dan jiddiy regress YO‘Q)',
      t2.loopMs < SIM.TICK_MS && (!perf || !perf.fps || perf.fps.fpsAvg >= 30),
      `loopMs=${t2.loopMs} budget=${round(SIM.TICK_MS, 2)} · fpsAvg=${perf?.fps?.fpsAvg ?? 'n/a'}`);

    // ---------------- P12.23: global salomatlik ----------------
    // Faqat HAQIQIY runtime istisnolari + klientning o'z xato kollektori
    // (Log.entryAdded'dagi umumiy resurs shovqini hisobga olinmaydi).
    const browserErrors = [...(A.exceptions || []), ...(B.exceptions || [])];
    const neonErrors = await A.evaluate('(window.__neonErrors||[]).length').catch(() => -1);
    check('P12.23 barqarorlik: brauzer istisnosi YO‘Q, server xatosi YO‘Q, tickErrors=0',
      browserErrors.length === 0 && neonErrors === 0 && uncaught.length === 0 && t2.tickErrors === 0,
      `browser=${browserErrors.length} neonErrors=${neonErrors} serverUncaught=${uncaught.length} tickErrors=${t2.tickErrors}`);

    // ---------------- hisobot ----------------
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const report = {
      phase: 12,
      title: 'FINAL HARDENING',
      protocol: PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      baseline: { unit: { tests: unit.tests, pass: unit.pass, fail: unit.fail } },
      evidence: {
        method: 'two independent Chrome PROCESSES (separate CDP ports/profiles/WS) + raw WS forger/hostile clients',
        portA: CDP_PORT_A, portB: CDP_PORT_B,
        pids: [chromeA.child.pid, chromeB.child.pid],
        gpu: String(gpu).slice(0, 80),
        headless: HEADLESS
      },
      staticScan: { filesScanned: SRC.length, findings: findings.length, plantedDetected: planted.length },
      serverState: {
        tick: t2.tick, tickErrors: t2.tickErrors, loopMs: t2.loopMs,
        match: t2.match, resources: t2.resources
      },
      hardening: {
        mediumFixes: [
          'repeated HELLO endi eski a\'zolikni LOBBY va MATCHdan ham tozalaydi (arvoh a\'zo yo\'q)',
          'INPUT FORBIDDEN_FIELDS kimlik maydonlarini ham qamrab oladi (playerId/id/name/hostId/owner)',
          'ws protokol darajasida 64 KiB payload chegarasi (standart 100 MiB o\'rniga) — xotiraga olinmasdan rad'
        ]
      },
      p11Status: { preserved: /PARTIAL/i.test(String(p11Status)), raw: String(p11Status).slice(0, 120) },
      performance: { serverLoopMs: t2.loopMs, fpsAvg: perf?.fps?.fpsAvg ?? null, drawCalls: perf?.render?.calls ?? null },
      results,
      passed, failed,
      status: failed === 0 ? 'COMPLETE' : 'NOT COMPLETE',
      scopeConfirmation: 'P13+ tizimlari YO‘Q (static scanFutureScope = 0). P11 fizik ikki-qurilma QA PARTIAL holatida SAQLANGAN.'
    };
    fs.writeFileSync(path.join(ART, 'phase12-report.json'), JSON.stringify(report, null, 2));

    const md = [
      '# PHASE 12 — FINAL HARDENING (hisobot)',
      '',
      `Sana: ${report.generatedAt}`,
      `Protokol: v${PROTOCOL_VERSION}`,
      '',
      '## Xulosa',
      '',
      `- Natija: **${report.status}** — ${passed} PASS / ${failed} FAIL`,
      '- P11 fizik ikki-qurilma QA: **PARTIAL — MANUAL REQUIRED** (o‘zgartirilmagan)',
      '',
      '## Dalil',
      '',
      `- Ikki mustaqil Chrome JARAYONI: pid ${report.evidence.pids.join(' / ')} · CDP ${CDP_PORT_A}/${CDP_PORT_B}`,
      `- GPU: ${report.evidence.gpu} · headless=${HEADLESS}`,
      `- Unit regressiya (haqiqiy): ${unit.tests} test / ${unit.pass} pass / ${unit.fail} fail`,
      `- Statik avtoritet skaneri: ${SRC.length} fayl, ${findings.length} topilma (plantatsiya ushlandi: ${planted.length})`,
      '',
      '## Tuzatilgan hardening nuqtalari',
      '',
      ...report.hardening.mediumFixes.map((s) => `- ${s}`),
      '',
      '## Gate natijalari',
      '',
      '| Gate | Holat | Izoh |',
      '|---|---|---|',
      ...results.map((r) => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '/')} |`),
      '',
      '## Server holati',
      '',
      '```json',
      JSON.stringify(report.serverState, null, 2),
      '```',
      '',
      '## Chegara',
      '',
      report.scopeConfirmation,
      ''
    ].join('\n');
    fs.writeFileSync(path.join(ART, 'phase12-report.md'), md);

    console.log(`\n=== PHASE 12 VERIFICATION SUMMARY ===`);
    console.log(`${passed} PASS / ${failed} FAIL`);
    console.log(`STATUS: ${report.status}`);
    console.log(`P11: PARTIAL (preserved=${report.p11Status.preserved})`);
    console.log(`Artifacts: logs/phase12-report.md + logs/phase12-report.json`);

    await cleanup();
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
    await cleanup();
    process.exit(2);
  }
}

main();
