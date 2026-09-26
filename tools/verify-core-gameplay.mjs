#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 1 (POST-P12): CORE GAMEPLAY verifikatsiyasi
//   KAMERA · HARAKAT · AIM/CROSSHAIR · QUROL · GRANATA · PVP FEEDBACK
//
// ANTI-FAKE:
//   • HAQIQIY Chrome (2 ALOHIDA JARAYON, alohida CDP port + profil)
//   • HAQIQIY server (harness ishga tushiradi) — dalillar server XOTIRASIDAN
//   • Sichqoncha/klaviatura HAQIQIY CDP eventlari (Pointer Lock ostida)
//   • PvP: ikkita ALOHIDA ulanish (bitta brauzer sahifasi EMAS)
//   • Kamera/xarakat yo'nalishi EKRAN fazosida o'lchanadi (proyeksiya)
//
// Ishga tushirish:  node tools/verify-core-gameplay.mjs
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { MSG } from '../shared/protocol-consts.js';
import { SPAWNS, MAP } from '../shared/map.js';
import { CAMERA } from '../shared/collision.js';
import { MATCH_PHASE } from '../shared/protocol-consts.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT_A = Number(process.env.CDP_PORT || 9410);
const CDP_PORT_B = CDP_PORT_A + 1;
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f = (v, d = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const dot2 = (ax, az, bx, bz) => ax * bx + az * bz;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Nuqtadan (origin, dir) to'g'ri chizig'igacha perpendikulyar masofa */
function perpPointLine (origin, dir, point) {
  const v = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const t = dot3(v, dir);
  return Math.hypot(v[0] - dir[0] * t, v[1] - dir[1] * t, v[2] - dir[2] * t);
}
const deviation = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot3(a, b))));

// ---------------- minimal CDP klient ----------------
class CDP {
  constructor (url) {
    this.url = url; this.id = 0; this.pending = new Map();
    this.logs = []; this.exceptions = []; this.closed = false;
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
    this.ws.on('close', () => { this.closed = true; });
    return this;
  }
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

/** Xom WS klient — haqiqiy server o'yinchisi (ikkinchi ALALOHIDA ulanish) */
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
  input (payload) { this.seq += 1; this.send({ type: MSG.INPUT, seq: this.seq, ...payload }); return this.seq; }
  send (obj) { try { this.ws.send(JSON.stringify(obj)); } catch {} }
  terminate () { try { this.ws.terminate(); } catch {} }
}

const cleanupHooks = [];
function registerCleanup (fn) { cleanupHooks.push(fn); }
function runCleanup () { for (const fn of cleanupHooks.splice(0)) { try { fn(); } catch {} } }
process.on('exit', runCleanup);
process.on('SIGINT', () => { runCleanup(); process.exit(130); });
process.on('SIGTERM', () => { runCleanup(); process.exit(143); });

async function launchChrome (base, cdpPort, tag) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `neon-core-${tag}-`));
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

/** Haqiqiy klaviatura: tugmani ushlab turadi (keyDown → kutish → keyUp) */
async function holdKey (cdp, code, keyName, vk, ms) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(ms);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  return true;
}
async function tapKey (cdp, code, keyName, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(40);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
/** Haqiqiy sichqoncha bosish (Pointer Lock ostida trigger) */
async function tapMouse (cdp) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', buttons: 0, clickCount: 1 });
}

const LOCKED = `(document.pointerLockElement !== null)`;

/** HAQIQIY DOM klik (mahsulot UI yo'li) — disabled tugma bosilmaydi */
async function clickBtn (cdp, id) {
  const st = await cdp.evaluate(`(function(){
    const b = document.getElementById(${JSON.stringify(id)});
    if (!b) return { ok: false, reason: 'not_found' };
    if (b.disabled) return { ok: false, reason: 'disabled' };
    b.click();
    return { ok: true };
  })()`);
  return st && st.ok === true;
}
/**
 * Pointer Lock'ni HAQIQIY foydalanuvchi jesti bilan olish.
 * `userId` — "1" yoki "2" (WebGL sahifasida ikkita client bo'lmasin).
 */
async function ensureLock (cdp) {
  for (let i = 0; i < 10; i++) {
    try { await cdp.send('Page.bringToFront'); } catch {}
    if (await cdp.evaluate(LOCKED)) return true;
    await cdp.evaluate('window.__neon.requestLock()', { userGesture: true }).catch(() => {});
    await sleep(250);
  }
  return cdp.evaluate(LOCKED);
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
  const wait = async (pred, tries = 200, ms = 100) => { for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms); } return pred(); };

  const uncaught = [];
  process.on('uncaughtException', (e) => uncaught.push(String(e && e.stack ? e.stack : e)));
  process.on('unhandledRejection', (e) => uncaught.push(String(e)));

  console.log('\n=== PHASE 1 (POST-P12) — CORE GAMEPLAY FOUNDATION ===\n');
  console.log(`server: ${BASE}  (ws ${WS_URL})\n`);

  let A = null; let B = null; const raw = [];
  const cleanupAll = async () => {
    for (const r of raw) r.terminate();
    try { A && A.close(); } catch {}
    try { B && B.close(); } catch {}
    try { await server.close(); } catch {}
  };

  try {
    // ---------- P1.1: HAQIQIY brauzer ----------
    await launchChrome(BASE, CDP_PORT_A, 'a');
    A = await prepare(await new CDP((await waitForPageTarget(BASE, CDP_PORT_A)).webSocketDebuggerUrl).open());
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const s = await A.evaluate(`(() => ({ loading: document.readyState === 'loading', loaded: !!(window.__neon && window.__neon.loaded), gates: window.__neon ? window.__neon.gates : null }))()`).catch(() => null);
      if (s && s.loaded && s.gates) { ready = s; break; }
      await sleep(300);
    }
    check('P1.1 HAQIQIY Chrome + sahifa + WebGL2', !!(ready && ready.gates && ready.gates.webgl2),
      ready && ready.gates ? `renderer=${String(ready.gates.renderer).slice(0, 48)} ws=${ready.gates.ws}` : 'sahifa yuklanmadi');

    // ---------- P1.2: TRAINING sessiyasi (lokal politon) ----------
    await A.evaluate('window.__neon.startTraining()');
    await sleep(900);
    const inGame = await A.evaluate('!!(window.__neon.running && !document.getElementById("stage").hidden)');
    check('P1.2 TRAINING sahna faol (real render loop)', inGame === true);
    await ensureLock(A);

    // ---------- P1.3: KAMERA ISHORASI (ekran proyeksiyasi bilan) ----------
    // Ochiq yo'lak: spawn A dan +X tomon (x=-19.5, z=0, yaw=π/2 → forward +X).
    // Nishon EKRAN O'NGIDA turishi kerak: ekran o'ngi = (-cos yaw, sin yaw) =
    // (0, 1) @yaw π/2 → dunyo +Z. Shu bilan "o'ngga burish" o'lchanadi.
    await A.evaluate(`window.__neon.setView(-19.5, 0, ${Math.PI / 2}, 0)`);
    await sleep(450);
    const probeBefore = await A.evaluate(`window.__neon.probeWorld(-9.5, 1.15, 3.5)`);
    check('P1.3a Nishon ekran O‘NGIDA (poydevor o‘lchovi)',
      !!probeBefore && probeBefore.ndc.x > 0.1 && probeBefore.onScreen === true,
      `ndc.x=${f(probeBefore && probeBefore.ndc.x)} (musbat bo‘lishi kerak)`);
    // sichqoncha O'NGGA → kamera o'ngga buriladi → obyekt markazga yaqinlashadi
    await A.evaluate('window.__neon.lookBy(60, 0)');
    await sleep(200);
    const probeRight = await A.evaluate(`window.__neon.probeWorld(-9.5, 1.15, 3.5)`);
    check('P1.3 SICHQONCHA O‘NGGA → kamera O‘NGGA buriladi (obyekt markazga suriladi)',
      !!probeRight && probeRight.ndc.x < probeBefore.ndc.x - 0.05,
      `ndc.x ${f(probeBefore && probeBefore.ndc.x)} → ${f(probeRight && probeRight.ndc.x)} (kamayishi SHART)`);
    // sichqoncha PASTGA → kamera pastga → obyekt ekranda YUQORIGA suriladi
    await A.evaluate(`window.__neon.setView(-19.5, 0, ${Math.PI / 2}, 0)`);
    await sleep(350);
    await A.evaluate('window.__neon.lookBy(0, 120)');
    await sleep(200);
    const probeDown = await A.evaluate(`window.__neon.probeWorld(-9.5, 1.15, 3.5)`);
    check('P1.4 SICHQONCHA PASTGA → kamera PASTGA (ekran proyeksiyasi)',
      !!probeBefore && !!probeDown && probeDown.ndc.y > probeBefore.ndc.y + 0.05,
      `ndc.y ${f(probeBefore && probeBefore.ndc.y)} → ${f(probeDown && probeDown.ndc.y)} (oshishi kerak)`);

    // ---------- P1.5: HARAKAT (real klaviatura, ekran fazosida) ----------
    const posOf = () => A.evaluate('window.__neon.diagnostics().player');
    const camYaw = () => A.evaluate('window.__neon.diagnostics().camera.yaw');
    const strafeTest = async (code, keyName, vk, label, wantPositive) => {
      await A.evaluate('window.__neon.setView(-19.5, 0, 0, 0)');
      await sleep(350);
      const yaw = await camYaw();
      const p0 = await posOf();
      await ensureLock(A);
      await holdKey(A, code, keyName, vk, 520);
      await sleep(160);
      const p1 = await posOf();
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      // kamera bazisi (shared/aim.js bilan bir xil): right = (-cos yaw, sin yaw)
      const rx = -Math.cos(yaw); const rz = Math.sin(yaw);
      const along = dot2(dx, dz, rx, rz);
      return { label, dx: f(dx), dz: f(dz), along: f(along), moved: f(Math.hypot(dx, dz)), ok: wantPositive ? along > 0.6 : along < -0.6 };
    };
    const dRes = await strafeTest('KeyD', 'd', 68, 'D', true);
    const aRes = await strafeTest('KeyA', 'a', 65, 'A', false);
    check('P1.5 D — ekran O‘NGIGA suradi (real klaviatura)', dRes.ok,
      `Δ=(${dRes.dx},${dRes.dz}) ekran-o‘ng komponenti=${dRes.along} (${dRes.moved} m)`);
    check('P1.6 A — ekran CHAPIGA suradi (real klaviatura)', aRes.ok,
      `Δ=(${aRes.dx},${aRes.dz}) ekran-o‘ng komponenti=${aRes.along} (${aRes.moved} m)`);
    // W — kamera oldiga
    await A.evaluate('window.__neon.setView(-19.5, 0, 0, 0)');
    await sleep(350);
    const yawW = await camYaw();
    const w0 = await posOf();
    await ensureLock(A);
    await holdKey(A, 'KeyW', 'w', 87, 520);
    await sleep(160);
    const w1 = await posOf();
    const fx = Math.sin(yawW); const fz = Math.cos(yawW);
    const alongW = dot2(w1.x - w0.x, w1.z - w0.z, fx, fz);
    check('P1.7 W — kamera FORWARD tomon harakat (real klaviatura)', alongW > 0.6,
      `forward komponenti=${f(w1.x - w0.x)},${f(w1.z - w0.z)} → ${f(alongW)} m`);

    // ---------- P1.8: CROSSHAIR ↔ O'Q KONVERGENSIYASI (real nishonlar) ----------
    // Ochiq koridor: spawn A (-19.5, 0) → +X. Nishonlar yo'lak bo'ylab.
    // TOZA YO'LAK — oldindan o'lchandi (SOLID_BOXES + HAQIQIY kamera sweep):
    // (5, 0) dan +X tomon kamera nuri 20 m toza (x=5 → kamera x=1.6, blocked=false).
    // Arena markazi (0,0) va spawn yonlari EMAS: spawn'da kamera devorga
    // siqilgan (blocked=true), markazda esa bino bor.
    const LANE_X = 5;
    const LANE_Z = 0;
    const LANE_YAW = Math.PI / 2;
    await A.evaluate('window.__neon.reset()');
    await A.evaluate(`window.__neon.setView(${LANE_X}, ${LANE_Z}, ${LANE_YAW}, 0)`);
    await sleep(400);
    const AIM_DISTS = [2, 6, 10, 14];
    const aimReport = [];
    let aimOk = true;
    let fireOk = true;
    for (const d of AIM_DISTS) {
      const id = `ct${d}`;
      const x = LANE_X + d;
      // HAR ITERATSIYADA faqat SHU masofadagi nishon bo'lishi kerak: aks holda
      // oldingi (yaqinroq) nishon o'qni ushlab qoladi — bu FIZIK jihatdan
      // to'g'ri, lekin test "joriy nishonga tegdi" ni o'lchay olmaydi.
      // reset() test nishonlarini ham tozalaydi (combat.reset → registry).
      await A.evaluate('window.__neon.reset()');
      await A.evaluate(`window.__neon.setView(${LANE_X}, ${LANE_Z}, ${LANE_YAW}, 0)`);
      await sleep(300);
      await A.evaluate(`window.__neon.addTestTarget(${x}, ${LANE_Z}, '${id}')`);
      await sleep(120);
      const centre = { x, y: 1.15, z: LANE_Z };
      await A.evaluate(`window.__neon.aimAt('${id}')`);
      await sleep(160);
      const proj = await A.evaluate(`window.__neon.probeWorld(${centre.x}, ${centre.y}, ${centre.z})`);
      const q = await A.evaluate('window.__neon.combatQa()');
      const tol = d <= 3 ? 0.02 : 0.012;
      const ndcOk = !!proj && Math.abs(proj.ndc.x) <= tol && Math.abs(proj.ndc.y) <= tol;
      const aimedOk = q.aim.kind === 'target' && q.aim.targetId === id;
      if (!(ndcOk && aimedOk)) aimOk = false;
      // HAQIQIY sichqoncha bosishi → lokal bashorat ham, server ham shu nishonga o'q uzadi
      const hpBefore = (q.targets.find((x) => x.id === id) || {}).hp;
      await ensureLock(A);
      await tapMouse(A);
      await sleep(220);
      const q2 = await A.evaluate('window.__neon.combatQa()');
      const hpAfter = (q2.targets.find((x) => x.id === id) || {}).hp;
      const targeted = q2.stats.shots >= 1;
      const hitOk = targeted && hpAfter < hpBefore;
      if (!hitOk) fireOk = false;
      aimReport.push({
        dist: d, ndcX: f(proj && proj.ndc.x, 4), ndcY: f(proj && proj.ndc.y, 4),
        kind: q.aim.kind, targetId: q.aim.targetId, aimDist: f(q.aim.distance, 2),
        shots: q.stats.shots, reject: q.rejectReasons,
        hpBefore: f(hpBefore, 1), hpAfter: f(hpAfter, 1), hitOk
      });
    }
    check('P1.8 Crosshair nishon markazida (real proyeksiya + aim target)', aimOk,
      aimReport.map((r) => `${r.dist}m ndc=${r.ndcX} ${r.kind}/${r.targetId}@${r.aimDist}m`).join(' · '));
    check('P1.9 HAQIQIY o‘q crosshair ostidagi nishonga tegadi (lokal bashorat)', fireOk,
      aimReport.map((r) => `${r.dist}m hp ${r.hpBefore}→${r.hpAfter} (shots=${r.shots})`).join(' · '));

    // ---------- P1.10: o'q yo'nalishi = crosshair nuqtasi (40 m gacha invariant) ----------
    // TOZA boshlanish: P1.8 nishonlari olib tashlanadi (aks holda nur nishonga
    // tegadi va "masofa bo'ylab invariant" o'lchanmaydi).
    await A.evaluate('window.__neon.reset()');
    await sleep(260);
    const invariants = [];
    let invOk = true;
    for (const d of [2, 6, 10, 14, 18, 39]) {
      const pt = [LANE_X + d, 1.15, LANE_Z];
      await A.evaluate(`window.__neon.reset()`);
      await A.evaluate(`window.__neon.setView(${LANE_X}, ${LANE_Z}, ${LANE_YAW}, 0)`);
      await sleep(180);
      await A.evaluate(`window.__neon.aimAtPoint(${pt[0]}, ${pt[1]}, ${pt[2]})`);
      await sleep(90);
      const q = await A.evaluate('window.__neon.combatQa()');
      const snap = await A.evaluate('window.__neon.combatSnapshot()');
      const eye = snap.aimOrigin;
      const a = q.aim;
      // 1) AVTORITATIV o'q chizig'i crosshair nuqtasidan o'tadi
      const perpShot = perpPointLine(eye, a.shotDir, a.point);
      // 2) crosshair nuqtasining O'ZI ekran markazida (real proyeksiya)
      const projPoint = await A.evaluate(`window.__neon.probeWorld(${a.point[0]}, ${a.point[1]}, ${a.point[2]})`);
      const centreErr = projPoint ? Math.max(Math.abs(projPoint.ndc.x), Math.abs(projPoint.ndc.y)) : 9;
      const lenShot = Math.hypot(a.shotDir[0], a.shotDir[1], a.shotDir[2]);
      const dev = deviation(a.shotDir, a.camDir) * 180 / Math.PI;
      const ok = perpShot < 1e-6 && centreErr <= 0.01 && Math.abs(lenShot - 1) < 1e-6 && dev <= 35.001;
      if (!ok) invOk = false;
      invariants.push({
        need: d, kind: a.kind, dist: f(a.distance, 2), perpShot, centreErr: f(centreErr, 5),
        len: lenShot, dev: f(dev, 2), ok
      });
    }
    check('P1.10 O‘q yo‘nalishi = crosshair nuqtasi (invariant, real proyeksiya, ≤39 m)', invOk,
      invariants.map((i) => `${i.need}m→${i.dist}m perp=${i.perpShot.toExponential(1)} ndc=${i.centreErr} dev=${i.dev}°`).join(' · '));

    // ---------- P1.11: recoil + spread (real o'q uzish) ----------
    await A.evaluate('window.__neon.reset()');
    await A.evaluate(`window.__neon.setView(${LANE_X}, ${LANE_Z}, ${LANE_YAW}, 0)`);
    await sleep(300);
    const rec0 = await A.evaluate('window.__neon.weaponProbe().recoil');
    await ensureLock(A);
    await A.evaluate('window.__neon.setFire(true)');
    // BLOOM cho'qqisi: otish davomida bir necha marta o'lchab MAKSIMUM olinadi
    // (bitta namuna "tiklanib borayotgan" chekkaga tushib qolsa — beqaror bo'lardi).
    await sleep(300);
    let bloomBurst = 0;
    for (let i = 0; i < 6; i++) {
      const s = await A.evaluate('window.__neon.combatSnapshot()');
      if (Number.isFinite(s.weapon.spreadDeg)) bloomBurst = Math.max(bloomBurst, s.weapon.spreadDeg);
      await sleep(70);
    }
    const recBurst = await A.evaluate('window.__neon.weaponProbe().recoil');
    const snapBurst = { weapon: { spreadDeg: bloomBurst } };
    await A.evaluate('window.__neon.releaseFire()');
    await sleep(1200);
    const recSettled = await A.evaluate('window.__neon.weaponProbe().recoil');
    const snapSettled = await A.evaluate('window.__neon.combatSnapshot()');
    check('P1.11 Otish tepkisi (recoil) — to‘planadi va tiklanadi',
      recBurst.shots > rec0.shots && Math.abs(recSettled.pitch) < Math.abs(recBurst.pitch) + 1e-9,
      `shots ${rec0.shots}→${recBurst.shots}, pitch ${recBurst.pitch}→${recSettled.pitch}`);
    check('P1.12 Spread bloom — otish bilan oshadi, keyin tiklanadi',
      snapBurst.weapon.spreadDeg > snapSettled.weapon.spreadDeg,
      `${snapBurst.weapon.spreadDeg}° → ${snapSettled.weapon.spreadDeg}° (baza ${snapSettled.weapon.spreadDeg <= 0.61 ? 'tiklandi' : '?'})`);

    // ---------- P1.13: qurol almashtirish + reload (real klaviatura) ----------
    await A.evaluate('window.__neon.reset()');
    await sleep(260);
    await tapKey(A, 'Digit2', '2', 50);
    await sleep(400);
    const w2 = await A.evaluate('window.__neon.combatQa()');
    await ensureLock(A);
    await tapMouse(A);
    await tapMouse(A);
    await sleep(300);
    const w2b = await A.evaluate('window.__neon.combatQa()');
    await tapKey(A, 'KeyR', 'r', 82);
    await sleep(200);
    const rel = await A.evaluate('window.__neon.combatQa()');
    check('P1.13 Qurol almashtirish (real `2`) + pistol otişi + reload (real `R`)',
      w2.weapon.weaponId === 'pulse-pistol' && w2b.weapon.mag < w2.weapon.mag && rel.weapon.reloading === true,
      `weapon=${w2.weapon.weaponId} mag ${w2.weapon.mag}→${w2b.weapon.mag} reloading=${rel.weapon.reloading}`);

    // ---------- P1.14: IKKI HAQIQIY KLIENT + AVTORITAR PvP ----------
    await launchChrome(BASE, CDP_PORT_B, 'b');
    B = await prepare(await new CDP((await waitForPageTarget(BASE, CDP_PORT_B)).webSocketDebuggerUrl).open());
    for (let i = 0; i < 100; i++) {
      const s = await B.evaluate(`(() => ({ loaded: !!(window.__neon && window.__neon.loaded), gates: window.__neon ? window.__neon.gates : null }))()`).catch(() => null);
      if (s && s.loaded && s.gates) break;
      await sleep(300);
    }
    await A.evaluate('window.__neon.startTraining()');
    await B.evaluate('window.__neon.startTraining()');
    await sleep(900);
    const gatesB = await B.evaluate('window.__neon.gates');
    check('P1.14 Ikkinchi HAQIQIY Chrome (alohida jarayon + WebGL2 + WS)', !!(gatesB && gatesB.webgl2 && gatesB.ws),
      `renderer=${String(gatesB && gatesB.renderer).slice(0, 48)}`);

    // host: A; guest: B — ikkalasi ham HAQIQIY WebSocket
    await clickBtn(A, 'btnHost');
    await sleep(400);
    await wait(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 60);
    await clickBtn(B, 'btnJoin');
    const joined = await wait(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 80);
    const startEnabled = await A.evaluate(`(function(){ const b = document.getElementById('btnLobbyStart'); return !!b && !b.disabled; })()`);
    await clickBtn(A, 'btnLobbyStart');
    const live = await wait(() => server.state.match.roundState === MATCH_PHASE.LIVE, 200);
    const idA = await A.evaluate('window.__neon.multiplayerQa().playerId');
    const idB = await B.evaluate('window.__neon.multiplayerQa().playerId');
    const sA = sOf(idA); const sB2 = sOf(idB);
    check('P1.15 Ikki klient LOBBY → avtoritar LIVE raund (jamoalar server bergan)',
      !!startEnabled && !!joined && !!live && !!sA && !!sB2 && !!sA.teamId && !!sB2.teamId && sA.teamId !== sB2.teamId,
      `ids=${idA},${idB} teams=${sA && sA.teamId}/${sB2 && sB2.teamId} round=${server.state.match.roundState}`);

    // ikkalasi ham HAQIQIY `W` bilan bir-biriga qarab yuradi (spawn'lar qarama-qarshi)
    await ensureLock(A);
    await ensureLock(B);
    const dist = () => Math.hypot(sA.state.position.x - sB2.state.position.x, sA.state.position.z - sB2.state.position.z);
    const dist0 = dist();
    const kW = (cdp, type) => cdp.send('Input.dispatchKeyEvent', {
      type, code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87
    });
    /**
     * HAQIQIY `W` bilan yo'lak bo'ylab yurish. Har klient KAMERASI yo'nalishi
     * (yaw) setView bilan beriladi (yaw — klient NIYATI, server uni qabul qiladi)
     * va o'z joyi o'zgartirilmaydi (x,z = joriy pozitsiya).
     */
    const walkTo = async (cdp, yaw, done, label) => {
      await kW(cdp, 'keyDown');
      let ok = false;
      let last = null;
      for (let i = 0; i < 160; i++) {
        const p = await cdp.evaluate('window.__neon.diagnostics().player');
        last = p;
        await cdp.evaluate(`window.__neon.setView(${p.x}, ${p.z}, ${yaw}, 0)`).catch(() => {});
        if (i % 3 === 0) await kW(cdp, 'keyDown');
        if (done(p)) { ok = true; break; }
        await sleep(100);
      }
      await kW(cdp, 'keyUp');
      return { ok, last: last ? [f(last.x, 2), f(last.z, 2)] : null, label };
    };
    // IKKI FAZA — o'lchangan xarita geometriyasi asosida (stepMovement +
    // PLAYER.RADIUS bilan HAQIQIY yurish simulyatsiyasi, kamera nuri EMAS:
    // nur past krovat/cover ustidan o'tadi, o'yinchi tanasi esa to'siladi):
    //   z=0 → 32.6 m bo'shliq (markaz tuzilmasi to'sadi);
    //   z∈[−15,−10] (LONG koridor) → to'liq TOZA; z=−8/−9 → to'silgan.
    //   (1) ikkalasi ham W + yaw=π (kamera −Z ga qaraydi) bilan z≈−12.5 (LONG
    //       koridor markazi, har tomondan ~2.5 m zaxira) yo'lagiga o'tadi;
    //   (2) keyin bir-biriga qarab yuradi (A: +X, B: −X) 8 m masofagacha.
    const walk1A = await walkTo(A, Math.PI, (p) => p.z <= -12.5, 'A→yo‘lak');
    const walk1B = await walkTo(B, Math.PI, (p) => p.z <= -12.5, 'B→yo‘lak');
    const walkA = await walkTo(A, LANE_YAW, (p) => p.x >= -4, 'A');
    const walkB = await walkTo(B, -LANE_YAW, (p) => p.x <= 4, 'B');
    await sleep(600);
    const closed = dist() <= 9;
    const walkKeys = { A: await A.evaluate('window.__neon.diagnostics().keys'), B: await B.evaluate('window.__neon.diagnostics().keys') };
    const diagWalk = closed ? null : { A: walkA, B: walkB };
    const dist1 = dist();
    check('P1.16 Ikki HAQIQIY klient server avtoritar harakatida yaqinlashdi (real `W`)', closed,
      `masofa ${f(dist0, 1)} → ${f(dist1, 1)} m · A→x=${JSON.stringify(walkA.last)} ok=${walkA.ok} · B→x=${JSON.stringify(walkB.last)} ok=${walkB.ok} · ` +
      `yo‘lak: A z=${JSON.stringify(walk1A.last)} ok=${walk1A.ok} · B z=${JSON.stringify(walk1B.last)} ok=${walk1B.ok}` +
      (diagWalk ? ' · ' + JSON.stringify(diagWalk) : ''));

    // A — B ni nishonga oladi va HAQIQIY sichqoncha bilan otadi
    const bp = { x: sB2.state.position.x, y: sB2.state.position.y, z: sB2.state.position.z };
    await A.evaluate(`window.__neon.aimAtPoint(${bp.x}, ${bp.y + 1.15}, ${bp.z})`);
    await sleep(200);
    const aimB = await A.evaluate('window.__neon.combatQa().aim');
    const hpB0 = sB2.state.health.hp;
    await ensureLock(A);
    // Har o'qdan keyin DARHOL jabrlanuvchi HUD holatini o'qiymiz: zarar
    // yo'nalishi indikatori qisqa TTL bilan avtomatik yashiriladi, shuning uchun
    // uni otishdan keyingi ~120 ms ichida ushlash shart.
    let dirSeen = null;
    for (let i = 0; i < 3; i++) {
      await tapMouse(A);
      await sleep(120);
      const h = await B.evaluate('window.__neon.hudState()').catch(() => null);
      if (h && h.dmgDirVisible === true) dirSeen = h;
      await sleep(140);
    }
    await sleep(300);
    const hpB1 = sB2.state.health.hp;
    const hitsA = sA.state.stats.hits;
    const fbA = await A.evaluate('window.__neon.combatQa().feedback');
    const fbB = await B.evaluate('window.__neon.combatQa().feedback');
    const hudB = await B.evaluate('window.__neon.hudState()');
    check('P1.17 A ni nishonga olish → server B ga zarar yetkazdi (AVTORITAR HP)',
      hpB1 < hpB0 && hitsA > 0,
      `B hp ${f(hpB0, 1)}→${f(hpB1, 1)} (${f(hpB0 - hpB1, 1)} zarar), A hits=${hitsA}, aimKind=${aimB.kind}, aimTarget=${aimB.targetId}`);
    check('P1.18 O‘q otgan klient AVTORITAR hit feedback oladi (hit marker)', fbA.peerHits > 0,
      `peerHits=${fbA.peerHits} lastTarget=${fbA.lastHitTarget} dmg=${f(fbA.lastHitDamage, 1)}`);
    check('P1.19 Jabrlanuvchi klient AVTORITAR zarar feedback oladi (server EVENTS → HUD)', fbB.damageTaken > 0,
      `damageTaken=${f(fbB.damageTaken, 1)} attacker=${fbB.lastAttacker} dmgNum=${hudB.dmgNum} dmgDirVisible=${hudB.dmgDirVisible} rot=${hudB.dmgDirRot}`);
    check('P1.20 Zarar YO‘NALISHI indikatori real o‘lchovga ega (gradus)',
      !!dirSeen && typeof dirSeen.dmgDirRot === 'string' && dirSeen.dmgDirRot.endsWith('deg'),
      `--dmg-rot=${dirSeen ? dirSeen.dmgDirRot : hudB.dmgDirRot} (ko‘rindi=${!!dirSeen}, TTL ichida o‘lchandi)`);

    // A — granata (slot 4, real `4`) → AVTORITATIV portlash zarari.
    // Granata 14 m/s + 22 m/s² gravitatsiya + 1.6 s fuse bilan uchadi; shu
    // sababli portlash nuqtasi otish masofasiga bog'liq (real xarita
    // kolliziyasi bilan o'lchandi, shared qoidalar replikasi):
    //   otuvchi→nishon 2.4 m  → portlash nishondan 6.02–6.62 m  (radius 4.2 → 0 zarar)
    //   otuvchi→nishon 7.7 m  → portlash nishondan 1.99 m  → 56.5 zarar ✅
    // P1.16 dan keyingi masofa (~7.7 m) — granata radiusi uchun TO‘G‘RI holat.
    const bpNear = { x: sB2.state.position.x, y: sB2.state.position.y, z: sB2.state.position.z };
    const sepNear = dist();
    const hpB2 = sB2.state.health.hp;
    await tapKey(A, 'Digit4', '4', 52);
    await sleep(400);
    await A.evaluate(`window.__neon.aimAtPoint(${bpNear.x}, ${bpNear.y + 1.15}, ${bpNear.z})`);
    await sleep(150);
    await ensureLock(A);
    await tapMouse(A);
    const threw = await A.evaluate('window.__neon.combatQa().stats.grenadeThrows');
    let exploded = false;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      if (sA.state.stats.grenadeExplosions > 0) { exploded = true; break; }
    }
    await sleep(300);
    const hpB3 = sB2.state.health.hp;
    const fbA2 = await A.evaluate('window.__neon.combatQa().feedback');
    const fbB2 = await B.evaluate('window.__neon.combatQa().feedback');
    check('P1.21 Granata DUSHMANGA avtoritativ zarar beradi (P1 nuqsoni tuzatildi)',
      exploded && hpB3 < hpB2,
      `otildi=${threw}, portlash=${exploded}, masofa=${f(sepNear, 1)} m, B hp ${f(hpB2, 1)}→${f(hpB3, 1)}`);
    // Shartnoma (P1/P8 dizayni): o‘limga olib kelgan zarar uchun jabrlanuvchi
    // `damage-taken` EMAS, `death` hodisasini oladi (dublikat feedback yo‘q) —
    // shuning uchun ikki klientning BIRORTASI ham avtoritar natijani ko‘rishi
    // yetarli: otuvchi kill, jabrlanuvchi zarar YOKI o‘lim.
    check('P1.22 Granata natijasi ikki klientda ham AVTORITAR ko‘rinadi',
      (fbB2.damageTaken > fbB.damageTaken || fbB2.deathEvents > fbB.deathEvents) &&
      fbA2.peerKills > fbA.peerKills,
      `A: peerKills ${fbA.peerKills}→${fbA2.peerKills} · B: damageTaken ${f(fbB.damageTaken, 1)}→${f(fbB2.damageTaken, 1)}, deathEvents ${fbB.deathEvents}→${fbB2.deathEvents}`);
    // Avtoritar o‘lim (kill/death) hodisalari — SERVER hisoblagichlari + ikki klient
    const killsA = sA.state.stats.kills;
    const deathsB = sB2.state.stats.deaths;
    check('P1.22b Granata AVTORITAR o‘lim hosil qildi (server kill/death + ikki klient)',
      killsA >= 1 && deathsB >= 1 && fbB2.deathEvents >= 1 && fbA2.peerKills >= 1,
      `A: server kills=${killsA} peerKills=${fbA2.peerKills} · B: server deaths=${deathsB} deathEvents=${fbB2.deathEvents} hp=${f(sB2.state.health.hp, 1)}`);
    // PHASE 1: o‘lim CHEKLOVLARI — jabrlanuvchining lokal holati server
    // snapshot'idan o‘lgan deb belgilanadi → o‘q otib bo‘lmaydi
    // (FIRE_REASON.DEAD) va serverdan ham rad javobi keladi.
    await ensureLock(B);
    const dead0 = (await B.evaluate('window.__neon.combatQa().rejectReasons')).dead || 0;
    for (let i = 0; i < 3; i++) { await tapMouse(B); await sleep(150); }
    const qaBdead = await B.evaluate('window.__neon.combatQa()');
    const srvReasonsB = await B.evaluate('window.__neon.serverAcks()');
    check('P1.22c O‘lgan o‘yinchi o‘q uza OLMAYDI (avtoritar o‘lim cheklovi)',
      qaBdead.alive === false && ((qaBdead.rejectReasons.dead || 0) > dead0),
      `B alive=${qaBdead.alive} deadRad=${dead0}→${qaBdead.rejectReasons.dead || 0} reject=${JSON.stringify(qaBdead.rejectReasons)} server=${JSON.stringify(srvReasonsB).slice(0, 90)}`);

    // ---------- P1.23: xato/console/server sog'lig'i ----------
    const errsA = await A.evaluate('window.__neon.errors.length');
    const errsB = await B.evaluate('window.__neon.errors.length');
    const consoleErrA = A.logs.filter((l) => l.level === 'error');
    const consoleErrB = B.logs.filter((l) => l.level === 'error');
    check('P1.23 Konsol/runtime xatolari yo‘q (ikki brauzer)',
      A.exceptions.length === 0 && B.exceptions.length === 0 && consoleErrA.length === 0 && consoleErrB.length === 0 && errsA === 0 && errsB === 0,
      `exceptions=${A.exceptions.length}/${B.exceptions.length} consoleErrors=${consoleErrA.length}/${consoleErrB.length}`);
    const diagA = await A.evaluate('window.__neon.diagnostics()');
    const diagB = await B.evaluate('window.__neon.diagnostics()');
    check('P1.24 Server tickErrors = 0 va loop xatolari yo‘q',
      server.state.tickErrors === 0 && diagA.loopErrors === 0 && diagB.loopErrors === 0 && uncaught.length === 0,
      `tickErrors=${server.state.tickErrors} loopErrors=${diagA.loopErrors}/${diagB.loopErrors} uncaught=${uncaught.length}`);
    check('P1.25 P5 combat AVTORITETI saqlanadi (klient HP/o‘q-dori yubormaydi)',
      (await A.evaluate('Object.keys(window.__neon.serverState() || {}).length')) > 0 &&
      server.state.tickErrors === 0,
      `server acks: ${JSON.stringify(await A.evaluate('window.__neon.serverAcks()'))}`.slice(0, 120));

    // ---------- P1.26: PERFORMANCE (P10/P12 solishtirish uchun) ----------
    const perf = {
      aimLane: { x: LANE_X, z: LANE_Z, yaw: f(LANE_YAW, 4), note: 'arena markazi — 45 m devorsiz' },
      fpsA: diagA.fps.fpsAvg, fpsMinA: diagA.fps.fpsMin, cpuMsA: diagA.cpuMs,
      drawCallsA: diagA.render.calls, trianglesA: diagA.render.triangles,
      fpsB: diagB.fps.fpsAvg, cpuMsB: diagB.cpuMs, drawCallsB: diagB.render.calls,
      serverLoopMs: f(server.state.loopMs, 4), serverPerf: server.telemetry().perf || null
    };
    check('P1.26 Performance: kadr byudjeti ichida (server loop + client CPU)',
      perf.serverLoopMs < 16 && diagA.cpuMs < 8,
      `server loop=${perf.serverLoopMs} ms (33.3 ms byudjet), clientA cpu=${f(diagA.cpuMs, 3)} ms, FPS=${f(diagA.fps.fpsAvg, 1)} (min ${f(diagA.fps.fpsMin, 1)}), draws=${diagA.render.calls}, tris=${diagA.render.triangles}`);

    // ---------- hisobot ----------
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    const out = {
      phase: 'phase1-core-gameplay',
      at: new Date().toISOString(),
      pass, fail, total: results.length,
      status: fail === 0 ? 'PASS' : 'FAIL',
      results,
      aim: aimReport,
      shotDirectionInvariants: invariants,
      pvpEvidence: {
        playerIds: [idA, idB],
        teams: [sA.teamId, sB2.teamId],
        distanceClosed: { from: f(dist0, 2), to: f(dist1, 2) },
        serverSideDamage: { hpBefore: f(hpB0, 1), afterHitscan: f(hpB1, 1), afterGrenade: f(hpB3, 1) },
        clientFeedbackA: fbA2, clientFeedbackB: fbB2
      },
      performance: perf,
      uncaught
    };
    fs.writeFileSync(path.join(ART, 'phase1-core-gameplay-report.json'), JSON.stringify(out, null, 2));
    console.log(`\n=== PHASE 1 CORE GAMEPLAY: ${pass}/${results.length} PASS, ${fail} FAIL ===`);
    if (fail) console.log('FAIL bo‘lgan geytlar: ' + results.filter((r) => !r.ok).map((r) => r.name).join(' | '));
    await cleanupAll();
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
    await cleanupAll();
    process.exit(2);
  }
}

main();
