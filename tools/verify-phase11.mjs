#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 11: REAL LAN QA verifikatsiyasi
//
// HALOLLIK QOIDASI (birinchi darajali talab):
//   Bu harness "IKKI QURILMA" ni SOXTA ISBOTLAMAYDI.
//   U ikki sinfga bo'linadi:
//
//   [AUTOMATED]  bitta hostda HAQIQATAN o'lchanadigan narsa:
//     • server 0.0.0.0 ga bind
//     • REAL LAN interfeys IPv4 orqali HTTP + WS (loopback EMAS)
//     • peer tasnifi ('loopback' | 'self' | 'remote') — server ko'rgan manzil
//     • LAN interfeys orqali ikki klient: ID/sessiya/lobby oqimi
//     • LAN interfeys orqali o'yin: harakat → o'q → HP → reload → raund
//     • LAN interfeys orqali chat A → server → B
//     • HAQIQIY brauzer LAN URL'ni ochadi va ulanish holatini ko'rsatadi
//     • Phase 1–10 unit to'plamlari + P12 scope darvozasi
//
//   [MANUAL REQUIRED] faqat IKKINCHI JISMONIY QURILMA bilan bajariladigan narsa.
//     Ular PASS deb YOZILMAYDI. Har birida nima yetishmayotgani ko'rsatiladi.
//     Agar `--wait-remote=SEC` berilsa, harness HAQIQIY 'remote' peer'ni kutadi:
//     ikkinchi qurilma ulansa — M1/M2 haqiqiy server dalili bilan tasdiqlanadi.
//
// Ishga tushirish:
//   node tools/verify-phase11.mjs                      (avtomatik qism)
//   node tools/verify-phase11.mjs --wait-remote=180    (Device B uchun 3 daqiqa kutish)
//   node tools/verify-phase11.mjs --headless           (GPU dalili EMAS)
//   node tools/verify-phase11.mjs --port=3000          (ANIQ port: Device B qayta urinishi uchun)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { placePlayerAt, sessionSnapshot } from '../server/session.js';
import {
  MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, MATCH_PHASE
} from '../shared/protocol-consts.js';
import { MATCH_RULES } from '../server/match.js';
import {
  lanInterfaces, lanUrls, classifyPeer, localIpv4Addresses, normalizeIp
} from '../server/net.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9396);
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const WAIT_REMOTE_SEC = (() => {
  const a = process.argv.find((x) => x.startsWith('--wait-remote='));
  const n = a ? Number(a.split('=')[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
// Aniq port (ixtiyoriy): ikkinchi qurilma qayta yuklashi/urinishi oson bo'lishi uchun.
// Berilmasa — 0 (OS bo'sh port beradi, avvalgi xatti-harakat).
const FIXED_PORT = (() => {
  const a = process.argv.find((x) => x.startsWith('--port='));
  const n = a ? Number(a.split('=')[1]) : 0;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
})();
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js', 'test/unit/multiplayer.test.js',
  'test/unit/round-team-score.test.js', 'test/unit/hud-chat.test.js', 'test/unit/stability.test.js',
  'test/unit/lan-qa.test.js'
];

const results = [];
const manual = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
/** PASS/FAIL emas — bajarilmagan jismoniy tekshiruv. HECH QACHON PASS yozilmaydi. */
function manualRequired (name, why) {
  manual.push({ name, status: 'MANUAL REQUIRED', detail: why });
  console.log(`MANUAL REQUIRED  ${name}  — ${why}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------- minimal CDP klient (Phase 9/10 bilan bir xil naqsh) ----------------
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
        this.logs.push({ level: msg.params.type, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ') });
      }
      if (msg.method === 'Log.entryAdded') this.logs.push({ level: msg.params.entry.level, text: msg.params.entry.text });
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
  async evaluate (expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error('in-page xato: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    return res.result.value;
  }
  close () { try { this.ws.close(); } catch {} }
}

/** Xom WS klient — HAQIQIY LAN interfeys manziliga ulanadi */
class RawClient {
  constructor (url) { this.url = url; this.q = []; this.waiters = []; this.seq = 0; }
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

async function launchChrome (url, tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `neon11-${tag}-`));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`, '--new-window',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion',
    '--window-size=1280,800', '--window-position=0,0', url
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return { child, profile };
}
async function waitForPageTarget (url, cdpPort) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(url));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Chrome page target topilmadi (port ${cdpPort})`);
}

// ---------------- asosiy oqim ----------------
let server; let chrome; let A; const raws = [];

async function cleanup () {
  for (const rc of raws) { try { rc.terminate(); } catch {} }
  try { A?.close(); } catch {}
  if (chrome) {
    try { chrome.child.kill('SIGTERM'); } catch {}
    await sleep(500);
    try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
  }
  try { await server?.close(); } catch {}
}
const runCleanup = () => { for (const rc of raws) { try { rc.terminate(); } catch {} } try { chrome?.child.kill('SIGTERM'); } catch {} try { server?.close(); } catch {} };

async function main () {
  server = createNeonServer({ port: FIXED_PORT, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const bound = server.httpServer.address();
  const port = bound.port;

  // ---- HAQIQIY tarmoq inventari (o'ylab topilmaydi — tizimdan olinadi) ----
  const ifaces = lanInterfaces();
  const lanIp = ifaces.length ? ifaces[0].address : null;
  const locals = localIpv4Addresses();
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : null;
  const lanWs = lanIp ? `ws://${lanIp}:${port}/ws` : null;
  const env = {
    deviceA: {
      hostname: os.hostname(), platform: `${os.type()} ${os.release()}`,
      os: (() => { try { return fs.readFileSync('/etc/os-release', 'utf8').match(/PRETTY_NAME="([^"]+)"/)[1]; } catch { return 'noma’lum'; } })(),
      cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9),
      node: process.version
    },
    interfaces: ifaces,
    localIpv4: locals,
    netPath: ifaces.length ? 'real-interface' : 'loopback-only',
    port, lanUrl, lanWs, wsPath: SERVER_DEFAULTS.WS_PATH
  };
  console.log(`\n=== PHASE 11 — REAL LAN QA ===`);
  console.log(`DEVICE A: ${env.deviceA.os} · ${os.hostname()} · ${lanIp || 'LAN interfeysi YO‘Q'}:${port}`);
  if (lanUrl) console.log(`DEVICE B shu manzilni ochadi: ${lanUrl}`);

  // ---------------- 1) server 0.0.0.0 bind ----------------
  check('P11.1 server 0.0.0.0 ga bind bo‘ldi (LAN uchun ochiq, real port)',
    bound.address === '0.0.0.0' && port > 0 && server.httpServer.listening === true &&
    server.telemetry().addresses.length >= 1,
    `bind=${bound.address}:${port} · e’lon qilingan manzillar=[${server.telemetry().addresses.join(', ')}]`);

  // ---------------- 2) Device B manzili haqiqiy interfeysdan ----------------
  const urls = server.telemetry().addresses;
  check('P11.2 Device B manzili REAL interfeysdan olinadi (hard-code YO‘Q, loopback emas)',
    !!lanIp && urls.some((u) => u.startsWith(`http://${lanIp}:`)) && !urls.some((u) => u.includes('127.0.0.1')),
    `interfeys=${ifaces.map((i) => `${i.name}=${i.address}`).join(', ') || '—'} · urls=[${urls.join(', ')}]`);

  // ---------------- 3) loopback EMAS: HAQIQIY LAN IP orqali HTTP ----------------
  let httpOk = false; let httpDetail = 'LAN interfeysi yo‘q';
  if (lanIp) {
    try {
      const res = await fetch(`${lanUrl}/`, { signal: AbortSignal.timeout(5000) });
      const html = await res.text();
      httpOk = res.status === 200 && /<canvas/i.test(html);
      httpDetail = `GET ${lanUrl}/ → ${res.status} · ${html.length} bayt · loopback EMAS (${ifaces[0].name})`;
    } catch (e) { httpDetail = `GET ${lanUrl}/ → XATO: ${e.message}`; }
  }
  check('P11.3 HAQIQIY LAN interfeys orqali HTTP javob beradi (127.0.0.1 EMAS)', httpOk, httpDetail);

  // ---------------- 4) LAN interfeys orqali WS + peer tasnifi ----------------
  const lanRaw = async (name, { create = false, join = false } = {}) => {
    const rc = new RawClient(lanWs);
    await rc.open();
    raws.push(rc);
    rc.send({ type: MSG.HELLO, name });
    await rc.next(MSG.WELCOME);
    const sess = await rc.next(MSG.SESSION);
    rc.playerId = sess.playerId; rc.sessionId = sess.sessionId;
    if (create) { rc.send({ type: MSG.CREATE_SESSION }); await rc.next(MSG.LOBBY_STATE); }
    if (join) {
      rc.send({ type: MSG.JOIN_SESSION });
      for (let i = 0; i < 60; i++) {
        if ((server.state.lobby.session?.players || []).some((p) => p.id === rc.playerId)) break;
        await sleep(50);
      }
    }
    return rc;
  };
  /** Peer manzili FAQAT server xotirasidan (seshanba→socket→remoteAddress) */
  const peerOf = (pid) => {
    const sess = [...server.state.sessions.values()].find((s) => s.playerId === pid);
    return sess?.socket?._socket ? normalizeIp(sess.socket._socket.remoteAddress) : null;
  };
  const allPeers = () => [...server.state.connections].map((s) => normalizeIp(s._socket.remoteAddress));

  const host = await lanRaw('lan-host', { create: true });
  const guest = await lanRaw('lan-guest', { join: true });
  const peers = allPeers();
  const classified = [...new Set(peers.map((p) => classifyPeer(p, locals)))];
  const lanPathProven = peers.length === 2 && peers.every((p) => p === lanIp) &&
    classified.length === 1 && classified[0] === 'self';
  check('P11.4 LAN interfeys orqali WS ulanadi va peer HALOL tasniflanadi',
    lanPathProven,
    `peerlar=[${peers.join(', ')}] · tasnif=[${classified.join(', ')}] · tarmoq yo‘li=${ifaces[0]?.name} (loopback EMAS, lekin BITTA qurilma)`);

  // ---------------- 5) LAN interfeys orqali lobby oqimi ----------------
  const lobby = server.state.lobby.session;
  check('P11.5 LAN orqali ikki klient: avtoritar ID + bitta sessiya + host tayinlangan',
    !!lobby && lobby.players.length === 2 && host.playerId !== guest.playerId &&
    lobby.hostId === host.playerId && lobby.players.every((p) => classifyPeer(peerOf(p.id), locals) === 'self'),
    `host=${lobby?.hostId} · a’zolar=[${lobby?.players.map((p) => p.id).join(', ')}] · sig‘im=${server.state.lobby.capacity} · dublikat ID YO‘Q`);

  // ---------------- 6) LAN orqali raund + harakat + o‘q + HP + reload ----------------
  host.send({ type: MSG.START_SESSION });
  for (let i = 0; i < 100; i++) {
    if (server.state.match.roundState === MATCH_PHASE.LIVE) break;
    await sleep(50);
  }
  const live = server.state.match.roundState === MATCH_PHASE.LIVE;
  const sessOf = (pid) => [...server.state.sessions.values()].find((s) => s.playerId === pid);
  const sHost = sessOf(host.playerId); const sGuest = sessOf(guest.playerId);
  const teams = { [host.playerId]: sHost?.teamId, [guest.playerId]: sGuest?.teamId };

  // harakat: HAQIQIY input → server AVTORITAR pozitsiyani o'zgartiradi
  const posOf = (s) => ({ ...s.state.position });
  const before = { host: posOf(sHost), guest: posOf(sGuest) };
  const move = (rc, s, seq, forward = 1) => rc.send({
    type: MSG.INPUT, seq,
    pose: { x: s.state.position.x, y: s.state.position.y, z: s.state.position.z, yaw: s.state.yaw || 0, pitch: s.state.pitch || 0 },
    aim: { dir: [Math.sin(s.state.yaw || 0), 0, Math.cos(s.state.yaw || 0)] },
    move: { forward, right: 0, sprint: false },
    intents: { fire: false, firePressed: false, reload: false, switchTo: null, moving: true }
  });
  for (let i = 0; i < 12; i++) {
    move(host, sHost, ++host.seq);
    move(guest, sGuest, ++guest.seq);
    await sleep(60);
  }
  const moved = {
    host: round(Math.hypot(sHost.state.position.x - before.host.x, sHost.state.position.z - before.host.z), 2),
    guest: round(Math.hypot(sGuest.state.position.x - before.guest.x, sGuest.state.position.z - before.guest.z), 2)
  };
  check('P11.6 LAN orqali AVTORITAR o‘yin: LIVE raund + ikki tomonlama harakat (server simulyatsiyasi)',
    live && moved.host > 0.3 && moved.guest > 0.3 && teams[host.playerId] !== teams[guest.playerId],
    `raund=${server.state.match.roundNumber}/${server.state.match.roundState} · jamoa A=${teams[host.playerId]} B=${teams[guest.playerId]} · ` +
    `ko‘chish host=${moved.host} m guest=${moved.guest} m · tick=${server.state.tick}`);

  // o'q: FAQAT server hal qiladi (o'q-dori, cooldown, ray, HP)
  placePlayerAt(sHost, { x: 13, y: 0, z: -14, yaw: 0 }, Date.now());
  placePlayerAt(sGuest, { x: -13, y: 0, z: -14, yaw: 0 }, Date.now());
  await sleep(120);
  const hpBefore = sGuest.state.health.hp;
  const mag0 = sessionSnapshot(sHost).weapon.mag;
  const aimAt = (s, t) => {
    const p = s.state.position; const q = t.state.position;
    const dx = q.x - p.x, dy = (q.y + 1.15) - (p.y + 1.6), dz = q.z - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return [dx / len, dy / len, dz / len];
  };
  let shotsAccepted = 0;
  for (let i = 0; i < 10; i++) {
    if (!sGuest.state.health.alive) break;
    const before2 = server.telemetry().perf.ops.shotsAccepted;
    host.send({
      type: MSG.INPUT, seq: ++host.seq,
      pose: { x: sHost.state.position.x, y: sHost.state.position.y, z: sHost.state.position.z, yaw: sHost.state.yaw || 0, pitch: sHost.state.pitch || 0 },
      aim: { dir: aimAt(sHost, sGuest) },
      move: { forward: 0, right: 0, sprint: false },
      intents: { fire: true, firePressed: true, reload: false, switchTo: null, moving: false }
    });
    await sleep(120);
    if (server.telemetry().perf.ops.shotsAccepted > before2) shotsAccepted++;
  }
  host.send({
    type: MSG.INPUT, seq: ++host.seq,
    pose: { x: sHost.state.position.x, y: sHost.state.position.y, z: sHost.state.position.z, yaw: sHost.state.yaw || 0, pitch: sHost.state.pitch || 0 },
    aim: { dir: [1, 0, 0] }, move: { forward: 0, right: 0, sprint: false },
    intents: { fire: false, firePressed: false, reload: false, switchTo: null, moving: false }
  });
  await sleep(200);
  const hpAfter = sGuest.state.health.hp;
  const mag1 = sessionSnapshot(sHost).weapon.mag;
  check('P11.7 LAN orqali o‘q: SERVER avtoritar hal qiladi (o‘q-dori −, nishon HP −)',
    shotsAccepted > 0 && hpAfter < hpBefore && mag1 < mag0 && sHost.state.stats.shots > 0,
    `qabul qilingan o‘q=${shotsAccepted} · HP ${hpBefore}→${hpAfter} · mag ${mag0}→${mag1} · server hisobi shots=${sHost.state.stats.shots} hits=${sHost.state.stats.hits}`);

  // soxta HP: klient "hp: 999" da'vo qilsa — server RAD etadi va holat o'zgarmaydi
  const hpInjectBefore = sGuest.state.health.hp;
  const aliveInjectBefore = sGuest.state.health.alive;
  guest.send({
    type: MSG.INPUT, seq: ++guest.seq,
    pose: { x: sGuest.state.position.x, y: sGuest.state.position.y, z: sGuest.state.position.z, yaw: 0, pitch: 0 },
    aim: { dir: [0, 0, 1] }, move: { forward: 0, right: 0, sprint: false },
    intents: { fire: false, firePressed: false, reload: false, switchTo: null, moving: false },
    hp: 999, damage: 999, alive: true
  });
  await sleep(200);
  check('P11.8 LAN orqali ham avtoritet buzilmaydi (soxta hp/damage/alive RAD, holat o‘zgarmadi)',
    sGuest.state.health.hp === hpInjectBefore && sGuest.state.health.alive === aliveInjectBefore,
    `soxta {hp:999, damage:999, alive:true} yuborildi · server HP ${hpInjectBefore}→${sGuest.state.health.hp} · ` +
    `alive ${aliveInjectBefore}→${sGuest.state.health.alive} (o‘zgarmadi) · raund=${server.state.match.roundState} · tickErrors=${server.telemetry().tickErrors}`);

  // ---------------- 7) LAN orqali chat A → server → B ----------------
  guest.q.length = 0;
  host.send({ type: MSG.CHAT, text: 'salom device B' });
  let chatMsg = null;
  try { chatMsg = await guest.next(MSG.CHAT_MSG, 3000); } catch { chatMsg = null; }
  check('P11.9 LAN orqali chat A → server → B (identifikatsiya SERVERdan)',
    !!chatMsg && chatMsg.text === 'salom device B' && chatMsg.playerId === host.playerId,
    chatMsg ? `B qabul qildi: [${chatMsg.playerId}] "${chatMsg.text}" · seq=${chatMsg.seq}` : 'B xabar olmadi');

  // ---------------- 8) LAN manzil / firewall diagnostikasi ----------------
  // Diqqat: `systemctl is-active ufw` YOLG‘ON signal beradi — ufw oneshot unit bo‘lib,
  // ENABLED=no bo‘lsa ham "active (exited)" ko‘rinadi. Shuning uchun HAQIQIY holat
  // faqat root BO‘LMASDAN o‘qiladigan manbalardan aniqlanadi:
  //   /etc/ufw/ufw.conf  → ENABLED
  //   /etc/ufw/user.rules → hajmi (307 bayt = bo‘sh shablon, qoida yo‘q)
  //   /lib/ufw/ufw-init  → ENABLED=no bo‘lsa qoida yuklanmasdan exit 0
  const fw = await (async () => {
    const out = { verdict: 'noma’lum', enabled: null, serviceActive: null, userRulesBytes: null, initSkips: null, note: '' };
    try {
      const { execSync } = await import('node:child_process');
      out.serviceActive = execSync('systemctl is-active ufw 2>/dev/null || true', { encoding: 'utf8' }).trim() || 'yo‘q';
    } catch { out.serviceActive = 'aniqlanmadi'; }
    try { out.userRulesBytes = fs.statSync('/etc/ufw/user.rules').size; } catch { out.userRulesBytes = null; }
    let conf = null;
    try { conf = fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'); } catch { conf = null; }
    if (conf === null) {
      out.verdict = 'ufw o‘rnatilmagan/o‘qilmaydi (host firewall dalili YO‘Q)';
      out.note = 'ufw.conf o‘qilmadi — bu hostda ufw qoidasi qo‘llanayotgani tasdiqlanmadi';
      return out;
    }
    out.enabled = (conf.match(/^ENABLED=(\S+)/m) || [])[1] || 'noma’lum';
    try {
      const init = fs.readFileSync('/lib/ufw/ufw-init', 'utf8');
      out.initSkips = /\[ "\$2" = "quiet" \] && \[ "\$ENABLED" = "no" \]/.test(init);
    } catch { out.initSkips = null; }
    if (out.enabled === 'no') {
      out.verdict = 'ufw O‘CHIRILGAN — kiruvchi qoidalar QO‘LLANMAYDI (blocking dalili yo‘q)';
      out.note = 'is-active="active" faqat oneshot unit bajarilganini bildiradi, qoida emas';
    } else {
      out.verdict = 'ufw YOQILGAN — kiruvchi qoidalar qo‘llanadi';
      out.note = `user.rules=${out.userRulesBytes} bayt — ikkinchi qurilma uchun ruxsat KERAK BO‘LISHI MUMKIN`;
    }
    return out;
  })();
  check('P11.10 LAN yo‘li isbotlandi va firewall holati HALOL aniqlandi (root talab qilinmadi, o‘zgartirilmadi)',
    httpOk && lanPathProven && fw.verdict !== 'noma’lum',
    `ufw=${fw.verdict} · ENABLED=${fw.enabled} · is-active=${fw.serviceActive} · user.rules=${fw.userRulesBytes} bayt · ` +
    `port=${port} · LAN HTTP=${httpOk} · LAN WS=${lanPathProven} · ${fw.note}`);

  // ---------------- 9) HAQIQIY brauzer LAN URL orqali ----------------
  chrome = await launchChrome(lanUrl || `http://127.0.0.1:${port}`, 'lan');
  const target = await waitForPageTarget(lanUrl || `http://127.0.0.1:${port}`, CDP_PORT);
  A = await new CDP(target.webSocketDebuggerUrl).open();
  await A.send('Runtime.enable'); await A.send('Log.enable'); await A.send('Page.enable');
  let ready = null;
  for (let i = 0; i < 120; i++) {
    try {
      ready = await A.evaluate(`(function () {
        const btn = document.getElementById('btnTraining');
        if (document.readyState === 'loading' || !btn) return { loading: true };
        return {
          loading: false, href: location.href, host: location.host,
          wsUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
          loaded: !!(window.__neon && window.__neon.loaded),
          gates: window.__neon ? window.__neon.gates : null,
          phase10: window.__neon ? window.__neon.phase10 : null
        };
      })()`);
      if (ready && !ready.loading && ready.loaded) break;
    } catch { ready = { loading: true }; }
    await sleep(250);
  }
  let connState = null;
  try { connState = await A.evaluate('window.__neon && window.__neon.connection ? window.__neon.connection() : null'); } catch {}
  const wsConnected = !!connState?.connected;
  const shots = [];
  const saveShot = async (name) => {
    try {
      const r = await A.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(r.data, 'base64');
      fs.writeFileSync(path.join(ART, name + '.png'), buf);
      shots.push({ name, bytes: buf.length });
      return true;
    } catch { return false; }
  };
  await saveShot('p11-01-deviceA-lan-url');
  const browserPeer = allPeers().includes(lanIp);
  check('P11.11 HAQIQIY brauzer LAN URL’ni ochdi va LAN manzil orqali ulanish qurdi',
    !!ready && ready.host?.startsWith(`${lanIp}:`) && browserPeer && wsConnected &&
    ready.gates?.webgl2 === true && (A.exceptions.length === 0),
    `href=${ready?.href} · ws=${ready?.wsUrl} · webgl2=${ready?.gates?.webgl2} · readyState=${connState?.readyState} connected=${wsConnected} · ` +
    `GPU=${String(ready?.gates?.renderer || '').slice(0, 46)} · exception=${A.exceptions.length}`);

  // ---------------- 10) unit to‘plamlari (Phase 1–11) ----------------
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
  check('P11.12 Phase 1–11 unit to‘plamlari (npm test bilan bir xil ro‘yxat) PASS',
    unitRun.code === 0 && uFail === 0 && uTests > 0 && uPass === uTests,
    `tests=${uTests} pass=${uPass} fail=${uFail} exit=${unitRun.code} · to‘plamlar=${UNIT_FILES.length}`);

  // ---------------- 11) P12 scope darvozasi ----------------
  // Diqqat: `auth` ATAYLAB yo‘q — u mavjud `serverAuthority`/`hudAuthority` nomlariga
  // tegib ketadi (ular P5/P9 API'si, P12 emas). P12 nishonlari ANIQ yozilgan.
  const forbidden = /deploy|cloud|account|hardening|spectat|replay|voip|voice|matchmak|ranked|ranking|scoreboard|killfeed|inventory|profile|friend|clan|achievement|mobile|lanqa|two[-_]device/i;
  const msgKeys = Object.keys(MSG).filter((k) => forbidden.test(k));
  const neonKeys = (await A.evaluate('Object.keys(window.__neon)').catch(() => [])).filter((k) => forbidden.test(k));
  const telKeys = Object.keys(server.telemetry()).filter((k) => forbidden.test(k));
  check('P11.13 P12 (deploy/cloud/account/hardening) tizimlari YO‘Q',
    msgKeys.length === 0 && neonKeys.length === 0 && telKeys.length === 0,
    `xabar turlari=${Object.keys(MSG).length} · __neon kalitlari=${neonKeys.length} · telemetriya=${telKeys.length} · taqiqlangan=[${[...msgKeys, ...neonKeys, ...telKeys].join(',')}]`);

  // ---------------- 12) REMOTE PEER DETEKTORI (jismoniy qurilma) ----------------
  const remotes = [];
  const collectRemotes = () => {
    for (const s of server.state.connections) {
      const ip = normalizeIp(s._socket.remoteAddress);
      if (classifyPeer(ip, locals) === 'remote' && !remotes.some((r) => r.ip === ip && r.socket === s)) {
        remotes.push({ ip, socket: s, at: Date.now(), playerId: null, joinedSession: false, ua: null });
      }
    }
  };
  collectRemotes();
  if (WAIT_REMOTE_SEC > 0) {
    console.log(`\n--- DEVICE B KUTILYAPTI (${WAIT_REMOTE_SEC} s) ---`);
    console.log(`   Device B'da brauzerda oching: ${lanUrl}`);
    console.log('   so‘ng LOBBY panelida "QO‘SHILISH" tugmasini bosing.\n');
    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_REMOTE_SEC * 1000) {
      collectRemotes();
      for (const r of remotes) {
        // peer'ning kimligini SERVER xotirasidan aniqlaymiz (klient da'vosi EMAS)
        const sess = [...server.state.sessions.values()].find((s) => s.socket === r.socket);
        if (sess) r.playerId = sess.playerId;
        r.joinedSession = !!r.playerId &&
          (server.state.lobby.session?.players || []).some((p) => p.id === r.playerId);
      }
      if (remotes.length && remotes.every((r) => r.joinedSession)) break;
      await sleep(500);
    }
    for (const r of remotes) { delete r.socket; delete r.at; }
  }

  const physical = {
    performed: remotes.length > 0,
    method: WAIT_REMOTE_SEC > 0 ? `remote-peer wait ${WAIT_REMOTE_SEC}s` : 'not attempted (use --wait-remote=SEC with a second physical device)',
    remotePeers: remotes.map((r) => ({ ip: r.ip, playerId: r.playerId, joinedSession: r.joinedSession })),
    classification: {
      loopback: 0,
      self: allPeers().filter((p) => classifyPeer(p, locals) === 'self').length,
      remote: remotes.length
    }
  };

  // ---------------- MANUAL REQUIRED (jismoniy qurilma) ----------------
  const haveRemote = physical.performed && remotes.some((r) => r.joinedSession);
  if (haveRemote) {
    check('P11.M1 HAQIQIY ikkinchi qurilma (remote peer) LAN orqali ulandi',
      true,
      `remote IP=[${remotes.map((r) => r.ip).join(', ')}] · bu manzil shu hostning manzillari ichida EMAS (localIpv4=[${locals.join(', ')}])`);
    check('P11.M2 Device B avtoritar identifikatsiya oldi va sessiyaga qo‘shildi',
      remotes.every((r) => !!r.playerId && r.joinedSession),
      `playerId=[${remotes.map((r) => r.playerId).join(', ')}] · sessiya a’zolari=[${(server.state.lobby.session?.players || []).map((p) => p.id).join(', ')}]`);
  } else {
    manualRequired('P11.M1 HAQIQIY ikkinchi qurilma (remote peer) LAN orqali ulanadi',
      'server ko‘rgan peerlarning BARCHASI shu hostning o‘z manzillari ("self") — jismoniy Device B YO‘Q');
    manualRequired('P11.M2 Device B avtoritar identifikatsiya oladi va sessiyaga qo‘shiladi',
      'P11.M1 bajarilmagan (remote peer yo‘q)');
  }
  manualRequired('P11.M3 harakat IKKI QURILMA orasida (A→B va B→A ko‘rinadi)', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M4 jang IKKI QURILMA orasida (A→B va B→A HP/death avtoritar)', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M5 raund/ball/match holati ikki qurilmada bir xil', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M6 chat A→server→B va B→server→A ikki qurilmada', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M7 jismoniy uzilish (Device B brauzeri yopiladi) → tozalash, ghost yo‘q', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M8 Device B qayta ulanadi (mavjud hayot sikli doirasida)', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M9 tarmoq uzilishi (Wi-Fi o‘chirish/yoqish) xatti-harakati qayd etiladi', 'jismoniy tarmoq uzilishi kerak');
  manualRequired('P11.M10 join-in-progress: Device B kech qo‘shiladi va joriy holatni oladi', 'ikki qurilma jismoniy ishtiroki kerak');
  manualRequired('P11.M11 HAQIQIY LAN kechikishi (RTT) Device B’dan o‘lchanadi', 'o‘lchovni faqat ikkinchi qurilma bera oladi (bu hostda o‘lchangan qiymat LAN RTT EMAS)');

  // ---------------- hisobot ----------------
  const automatedPassed = results.filter((r) => r.ok).length;
  const automatedFailed = results.filter((r) => !r.ok).length;
  const verdict = (automatedFailed === 0 && manual.length === 0)
    ? 'P11 COMPLETE (avtomatik + jismoniy dalil)'
    : (automatedFailed === 0 ? 'P11 PARTIAL — TWO-DEVICE LAN QA BLOCKED' : 'P11 FAIL (avtomatik darvozalar)');

  const report = {
    generatedAt: new Date().toISOString(),
    phase: 11,
    subject: 'real-lan-qa',
    protocol: PROTOCOL_VERSION,
    mode: HEADLESS ? 'headless' : 'real-window',
    env,
    evidenceClasses: {
      AUTOMATED_LOCAL: 'bitta host, HAQIQIY LAN interfeys yo‘li (loopback emas) — lekin BITTA qurilma',
      MANUAL_REQUIRED: 'faqat IKKINCHI JISMONIY QURILMA bilan bajariladi — PASS deb yozilmaydi'
    },
    physicalLanQa: physical,
    firewall: fw,
    automated: { passed: automatedPassed, failed: automatedFailed, gates: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })) },
    manualRequired: manual,
    unit: { tests: uTests, pass: uPass, fail: uFail, exit: unitRun.code, files: UNIT_FILES.length },
    narrative: {
      phase11Scope: 'real LAN QA — yangi o‘yin tizimi EMAS, isbot/ishonchli dalil',
      deviceA: 'Ubuntu 24.04 LTS · Intel i7-13620H · enp2s0 (Ethernet) · server 0.0.0.0:PORT',
      deviceB: haveRemote
        ? `ULANDI — remote peer IP=[${remotes.map((r) => r.ip).join(', ')}] · playerId=[${remotes.map((r) => r.playerId).join(', ')}]`
        : 'MAVJUD EMAS — ikkinchi jismoniy qurilma bu muhitda yo‘q (P11.M1..M11 bajarilmagan)',
      filesNew: ['server/net.js', 'test/unit/lan-qa.test.js', 'tools/verify-phase11.mjs'],
      filesChanged: ['server/app.js', 'server/index.js', 'package.json', 'tools/verify-phase10.mjs'],
      regression: {
        'npm test': 270, phase2: 42, phase3: 25, phase4: 22, phase5: 18, phase6: 21,
        phase7: 33, phase8: 28, phase9: 34, phase10: 21, phase11Automated: results.filter((r) => r.ok).length
      },
      pointerLockNote: 'P5.7/P5.8 bir marta 0 o‘q ko‘rsatdi (pointer lock berilmadi: lockState=false, 144 FPS — kadr ochligi EMAS). ' +
        'Qayta o‘lchov: lock ushlangan holda 1.0 s ushlash AYNAN 10 o‘q / 4 hit berdi, harness qayta yurgizilganda 18/18 PASS. ' +
        'Kod/harness o‘zgartirilmadi — bu lock berilishining vaqtga sezgirligi.',
      boundaryNote: 'P10.19 va P11.13 P12 (deploy/cloud/account/hardening/spectator/replay/voice/matchmaking/ranking) ni tekshiradi — barchasi bo‘sh'
    },
    browser: { href: ready?.href ?? null, wsUrl: ready?.wsUrl ?? null, webgl2: ready?.gates?.webgl2 ?? null, gpu: ready?.gates?.renderer ?? null, connection: connState ?? null, exceptions: A.exceptions.length, consoleErrors: A.logs.filter((l) => l.level === 'error').length },
    serverSeen: { peers: allPeers(), classified: allPeers().map((p) => classifyPeer(p, locals)), tickErrors: server.telemetry().tickErrors },
    shotCount: shots.length,
    verdict,
    limitations: [
      'JISMONIY ikkinchi qurilma bu muhitda mavjud emas — P11.M1..M11 BAJARILMAGAN (MANUAL REQUIRED)',
      'LAN interfeys orqali o‘lchovlar bitta hostda: ular loopback EMAS, lekin IKKI QURILMA ham EMAS',
      'avtomatik reconnect yo‘q (P6/P7 qarori) — M8 mavjud hayot sikli doirasida bajarilishi kerak',
      'ufw holati faqat o‘qish uchun tekshirildi (o‘zgartirilmadi)'
    ],
    scopeConfirmation: 'P11 faqat LAN QA: yangi o‘yin/qurol/xarita/matchmaking/cloud/akkaunt/deploy YO‘Q (P11.13)'
  };
  fs.writeFileSync(path.join(ART, 'phase11-report.json'), JSON.stringify(report, null, 2));

  console.log('\n=== PHASE 11 VERIFICATION SUMMARY ===');
  console.log(`AUTOMATED: ${automatedPassed} PASS / ${automatedFailed} FAIL`);
  console.log(`PHYSICAL : ${manual.length} MANUAL REQUIRED (HAQIQIY ikki qurilma dalili YO‘Q)`);
  console.log(`DEVICE A : ${env.deviceA.os} · ${env.deviceA.hostname} · ${lanIp}:${port} (${ifaces[0]?.name || '—'})`);
  console.log(`DEVICE B : ${lanUrl} — ikkinchi jismoniy qurilmada oching (P11.M1..M11 uchun)`);
  console.log(`TASNIF   : ${JSON.stringify(physical.classification)} (remote=0 → ikki qurilma YO‘Q)`);
  console.log(`UNIT     : tests=${uTests} pass=${uPass} fail=${uFail}`);
  console.log(`STATUS   : ${verdict}`);
  console.log(`Artifacts: ${shots.length} screenshot + logs/phase11-report.json`);

  await cleanup();
  process.exit(automatedFailed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
  runCleanup();
  process.exit(2);
});
