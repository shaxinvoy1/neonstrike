#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 5 AVTORITATIV SERVER verifikatsiyasi (anti-fake)
// HAQIQIY Chrome (real GPU) + HAQIQIY server (bir jarayonda, ephemeral port).
//
// Dalil manbalari:
//   1) SERVER XOTIRASI — harness server obyektini o'zi ishga tushiradi, shuning
//      uchun `server.state.sessions` ni TO'G'RIDAN-TO'G'RI o'qiydi. Bu klient
//      da'vosi EMAS — haqiqiy avtoritar holat.
//   2) BRAUZER — real klik, real Pointer Lock, real sichqoncha o'q uzish,
//      real klaviatura (R / 1-4). Klient FAQAT intent yuboradi.
//   3) SOXTA KLIENT — xom WebSocket ulanishi orqali damage/hp/ammo/NaN
//      yuborib rad etilishini isbotlaydi.
//
// Ishga tushirish:  node tools/verify-phase5.mjs            (real oyna · real GPU)
//                   node tools/verify-phase5.mjs --headless (P5.1 FAIL — SwiftShader)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { MSG, SIM } from '../shared/protocol-consts.js';
import { SPAWNS, MAP, TRAINING_DUMMIES } from '../shared/map.js';
import { MOVE } from '../shared/collision.js';
import { WEAPONS } from '../shared/weapons.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9366);
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

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
    this.listeners = []; this.logs = []; this.exceptions = [];
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

/** Xom (ishonchsiz) klient — soxta buyruqlar uchun */
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
  next (type = null, timeout = 4000) {
    for (let i = 0; i < this.q.length; i++) {
      if (!type || this.q[i].type === type) return Promise.resolve(this.q.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`forger msg timeout (${type})`)), timeout);
      this.waiters.push({ type, resolve, to });
    });
  }
  send (obj) { this.ws.send(JSON.stringify(obj)); }
  close () { try { this.ws.close(); } catch {} }
}

const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

async function launchChrome (base) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon5-chrome-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
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

async function waitForTarget (base) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(base));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome devtools target topilmadi');
}

async function pressKey (cdp, code, keyName, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
async function holdKey (cdp, code, keyName, vk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    for (let i = 0; i < 12; i++) {
      const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
      if (keys.includes(code)) return true;
      await sleep(80);
    }
  }
  return false;
}
async function releaseKey (cdp, code, keyName, vk) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

// ---------------- asosiy oqim ----------------
async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;

  const liveSessions = () => [...server.state.sessions.values()];
  const live = () => liveSessions()[0] || null;

  const { child, profile } = await launchChrome(BASE);
  const target = await waitForTarget(BASE);
  const cdp = await new CDP(target.webSocketDebuggerUrl).open();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});

  const shots = [];
  const saveShot = async (name, dataUrl) => {
    const b64 = dataUrl.split(',')[1];
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    shots.push({ name, file, bytes: Buffer.from(b64, 'base64').length, source: 'drawing-buffer' });
  };
  const shot = async (name) => {
    const url = await cdp.evaluate('window.__neon.captureFrame()');
    await saveShot(name, url);
    return url;
  };
  const writeShot = (name, b64) => {
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    shots.push({ name, file, bytes: Buffer.from(b64, 'base64').length, source: 'page-screenshot' });
    return 'data:image/png;base64,' + b64;
  };
  const pixelOf = (url, dxFromRight, dy) => cdp.evaluate(`(async function () {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(url)}; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(img.width - ${dxFromRight}, ${dy}, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  })()`);
  const sentinel = (on) => cdp.evaluate(`(function () {
    let el = document.getElementById('__qaSentinel');
    if (!el) {
      el = document.createElement('div');
      el.id = '__qaSentinel';
      el.style.cssText = 'position:fixed;right:0;top:0;width:20px;height:20px;background:#ff00ff;z-index:2147483647;pointer-events:none';
      document.body.appendChild(el);
    }
    el.style.display = ${on ? "'block'" : "'none'"};
    return true;
  })()`);
  const domShot = async (name) => {
    await sentinel(true);
    let url = null;
    let captured = false;
    for (let i = 0; i < 10 && !captured; i++) {
      await settle();
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      url = 'data:image/png;base64,' + r.data;
      const p = await pixelOf(url, 8, 8);
      captured = p.r > 180 && p.g < 90 && p.b > 180;
      if (captured) writeShot(name, r.data);
      else await sleep(200);
    }
    return { url, captured };
  };

  const settle = async (ms = 180) => {
    try {
      await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))');
    } catch {}
    await sleep(ms);
  };

  const diag = () => cdp.evaluate('window.__neon.diagnostics()');
  const sSess = () => cdp.evaluate('window.__neon.serverSession()');
  const sState = () => cdp.evaluate('window.__neon.serverState()');
  const sAcks = () => cdp.evaluate('window.__neon.serverAcks()');
  const resetClient = async () => { await cdp.evaluate('window.__neon.reset()'); await sleep(120); };
  const resetBoth = async () => {
    await cdp.evaluate('window.__neon.requestServerReset()');
    await resetClient();
    for (let i = 0; i < 30; i++) {
      const s = live();
      if (s && s.state.loadout.slots['neon-rifle'].mag === WEAPONS['neon-rifle'].magSize &&
          s.state.targetById.get('dummy-1').health.hp === 100) return true;
      await sleep(80);
    }
    return false;
  };
  const setView = (x, z, yaw, pitch, y) => cdp.evaluate(
    `window.__neon.setView(${x}, ${z}, ${yaw}, ${pitch}, ${y === undefined ? 'undefined' : y})`);
  const aimAt = (id) => cdp.evaluate(`window.__neon.aimAt(${JSON.stringify(id)})`);

  let mouse = { x: 640, y: 400 };
  const moveMouse = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  const mouseDown = () => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button: 'left', clickCount: 1, buttons: 1 });
  const mouseUp = () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', clickCount: 1, buttons: 0 });
  const mouseFire = async (holdMs = 45) => { await mouseDown(); await sleep(holdMs); await mouseUp(); };
  const holdTrigger = async (ms, step = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await mouseDown();
      await sleep(Math.min(step, Math.max(20, ms - (Date.now() - t0))));
    }
    await mouseUp();
  };
  const ensureLock = async () => {
    for (let i = 0; i < 8; i++) {
      try { await cdp.send('Page.bringToFront'); } catch {}
      const s = await cdp.evaluate('window.__v.lockState()');
      if (s.locked) return true;
      await cdp.evaluate('window.__neon.requestLock()', { userGesture: true });
      await sleep(300);
    }
    return (await cdp.evaluate('window.__v.lockState()')).locked;
  };

  let forger = null;

  try {
    // ---------- 0) sahifa tayyor ----------
    let ready = null;
    for (let i = 0; i < 80; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          return {
            loading: false,
            loaded: !!(window.__neon && window.__neon.loaded),
            ready: btn.dataset.ready === '1',
            version: window.__neon ? window.__neon.version : null,
            authority: window.__neon ? window.__neon.serverAuthority : null,
            hasServerApi: !!(window.__neon && typeof window.__neon.serverState === 'function'),
            gates: window.__neon ? window.__neon.gates : null
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) { ready = { error: String(e.message), loading: true }; }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('Sahifa tayyor holatga kelmadi: ' + JSON.stringify(ready));
    await cdp.evaluate(HELPERS);
    const vp = await cdp.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
    mouse = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
    await moveMouse(mouse.x, mouse.y);

    // ---------- P5.1 real GPU ----------
    const renderer = ready.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software|ANGLE \(Google, Vulkan.*SwiftShader/i.test(renderer);
    check('P5.1 real WebGL2 + real GPU (SwiftShader EMAS)',
      ready.gates?.webgl2 === true && !software,
      `renderer="${renderer.slice(0, 96)}"${software ? ' [SOFTWARE RENDERING]' : ''}`);

    // ---------- P5.2 Phase 5 marker ----------
    check('P5.2 Phase 5 klient markeri + server QA API (Phase 4 qatlami saqlangan)',
      ready.authority?.version === 5 && ready.authority?.phase === 'phase5-authoritative-server' &&
      ready.version === 4 && ready.hasServerApi === true && ready.loaded === true,
      `authority=v${ready.authority?.version} phase4=v${ready.version} serverApi=${ready.hasServerApi}`);

    // ---------- P5.3 real klik + server sessiyasi ----------
    const btn = await cdp.evaluate('window.__v.rect("btnTraining")');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(1300);
    const started = await cdp.evaluate('({ menu: window.__v.hidden("menu"), running: window.__neon.running })');
    let sessionMsg = null;
    for (let i = 0; i < 40; i++) { sessionMsg = await sSess(); if (sessionMsg) break; await sleep(100); }
    let srvSession = null;
    for (let i = 0; i < 40; i++) { srvSession = live(); if (srvSession) break; await sleep(100); }
    check('P5.3 real klik TRAINING → SERVER xotirasida sessiya yaratildi',
      started.menu === true && started.running === true &&
      !!sessionMsg && !!srvSession && server.state.connections.size >= 1,
      `running=${started.running} sessionId=${sessionMsg?.sessionId} playerId=${sessionMsg?.playerId} serverSessions=${server.state.sessions.size}`);

    // ---------- P5.4 sessiya tarkibi (server xotirasi) ----------
    const srvTargets = srvSession ? srvSession.state.targets.map((t) => t.id) : [];
    const srvWeapons = srvSession ? srvSession.state.loadout.ids.slice() : [];
    check('P5.4 server sessiyasi: xarita + 8 nishon + 4 qurol + to\'liq o\'q-dori (server xotirasi)',
      !!srvSession && srvSession.state.targets.length === 8 &&
      srvTargets.includes('dummy-1') && srvTargets.includes('ring-1') &&
      srvWeapons.length === 4 && srvSession.state.health.max === 100 &&
      srvSession.state.loadout.slots['neon-rifle'].mag === WEAPONS['neon-rifle'].magSize,
      `nishon=${srvTargets.length} qurol=${srvWeapons.join(',')} HP=${srvSession?.state.health.max}`);

    // KLIENT FAQAT INTENT yuboradi (avtoritar maydon yo'q) — koddan dalil
    const clientPayload = await cdp.evaluate(`(function () {
      const src = window.__neon.combat ? 'ok' : 'no';
      return { hasCombat: src === 'ok' };
    })()`);
    await resetBoth();
    await ensureLock();

    // ---------- P5.5 klient real intent → server qabul qiladi ----------
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(250);
    const ackBefore = await sAcks();
    await mouseFire(70);
    await sleep(300);
    const ackAfter = await sAcks();
    const acceptedDelta = (ackAfter?.accepted || 0) - (ackBefore?.accepted || 0);
    check('P5.5 klient real intent yuboradi, SERVER qabul qiladi (INPUT_ACK + accepted hisobi)',
      clientPayload.hasCombat === true && acceptedDelta >= 1 &&
      (ackAfter?.rejected || 0) === 0 && (ackAfter?.sent || 0) > 0,
      `yuborilgan=${ackAfter?.sent} qabul=+${acceptedDelta} rad=${ackAfter?.rejected}`);

    // ---------- P5.6 server o'q-dorini boshqaradi ----------
    const s6 = await sState();
    const l6 = live();
    const rifle6 = l6.state.loadout.slots['neon-rifle'];
    check('P5.6 SERVER o\'q-dorini boshqaradi (mag = magSize − server shots; wire = server xotirasi)',
      rifle6.shotsFired >= 1 && rifle6.mag === WEAPONS['neon-rifle'].magSize - rifle6.shotsFired &&
      s6.weapon.mag === rifle6.mag && s6.stats.shots === l6.state.stats.shots &&
      rifle6.mag >= 0,
      `serverShots=${rifle6.shotsFired} mag=${rifle6.mag} wireMag=${s6.weapon.mag} reserve=${rifle6.reserve}`);

    // ---------- P5.7 server cooldown boshqaradi ----------
    await resetBoth();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(200);
    const shots7a = live().state.stats.shots;
    await holdTrigger(1000);
    await sleep(350);
    const shots7b = live().state.stats.shots;
    const cadence = shots7b - shots7a;
    const l7 = live();
    check('P5.7 SERVER cooldown boshqaradi (1.0 s ushlashda ~10 o\'q, 600 RPM)',
      cadence >= 8 && cadence <= 13 && l7.state.loadout.slots['neon-rifle'].mag === WEAPONS['neon-rifle'].magSize - l7.state.stats.shots,
      `server 1.0 s da ${cadence} o'q (kutilgan 10) · mag=${l7.state.loadout.slots['neon-rifle'].mag} · rad=${Object.entries(l7.rejections).map(([k, v]) => k + '=' + v).join(',') || '—'}`);

    // ---------- P5.8 server hit hal qiladi ----------
    const l8a = live();
    const hp8a = l8a.state.targetById.get('dummy-1').health.hp;
    await sleep(200);
    const wire8 = await sState();
    const wireT1 = wire8.targets.find((t) => t.id === 'dummy-1');
    check('P5.8 SERVER hit hal qiladi (dummy-1 HP server xotirasida kamaydi; wire mos)',
      hp8a < 100 && wireT1.hp === hp8a &&
      l8a.state.stats.hits >= 1 && l8a.state.stats.damageDealt > 0,
      `dummy-1 HP ${100}→${hp8a} (server) · wire=${wireT1.hp} · hits=${l8a.state.stats.hits} · zarar=${l8a.state.stats.damageDealt}`);

    // ---------- P5.9 devor server tomonda to'sadi ----------
    await resetBoth();
    await ensureLock();
    await setView(-13, 4.5, 0, 0);
    await aimAt('dummy-1');
    await sleep(250);
    const blockedA = live().state.stats.blocked;
    const hpA = live().state.targetById.get('dummy-1').health.hp;
    await mouseFire(50);
    await sleep(300);
    const l9 = live();
    const blockedB = l9.state.stats.blocked;
    const hpB = l9.state.targetById.get('dummy-1').health.hp;
    check('P5.9 devor nishonni SERVER tomonda to\'sadi (blocked↑, nishon HP o\'zgarmadi)',
      blockedB > blockedA && hpB === hpA,
      `server blocked ${blockedA}→${blockedB} · dummy-1 HP=${hpB} (o'zgarmadi)`);

    // ---------- P5.10 reload server boshqaruvida ----------
    await resetBoth();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(200);
    await holdTrigger(260);
    await sleep(200);
    const magBefore10 = live().state.loadout.slots['neon-rifle'].mag;
    await pressKey(cdp, 'KeyR', 'r', 82);
    await sleep(250);
    const reloading10 = live().state.loadout.slots['neon-rifle'].reloading;
    // reload davomida o'q uzish rad etilishi (server tomonda)
    await mouseFire(60);
    await sleep(200);
    const mid10 = live();
    await sleep(WEAPONS['neon-rifle'].reloadMs + 500);
    const l10 = live();
    const rifle10 = l10.state.loadout.slots['neon-rifle'];
    check('P5.10 SERVER reload boshqaradi (R → server reloading; server taymeri tugagach mag to\'ladi)',
      magBefore10 < WEAPONS['neon-rifle'].magSize && reloading10 === true &&
      (mid10.fireReasons.reloading || 0) >= 1 &&
      rifle10.mag === WEAPONS['neon-rifle'].magSize && rifle10.reserve < WEAPONS['neon-rifle'].startReserve,
      `mag ${magBefore10}→reloading=${reloading10} serverRad(reloading)=${mid10.fireReasons.reloading || 0} → mag=${rifle10.mag}/${WEAPONS['neon-rifle'].magSize} reserve=${rifle10.reserve}`);

    // ---------- P5.11 qurol almashish server boshqaruvida ----------
    await ensureLock();
    await pressKey(cdp, 'Digit2', '2', 50);
    await sleep(250);
    const switched11 = live().state.loadout.slots['pulse-pistol'].id;
    const activeSlot11 = live().state.loadout.ids[live().state.loadout.index];
    await mouseFire(60);                                 // draw davomida
    await sleep(200);
    const drawReject11 = live().fireReasons.switching || 0;
    await sleep(400);
    await aimAt('dummy-1');
    await sleep(150);
    const pistolShotsA = live().state.loadout.slots['pulse-pistol'].shotsFired;
    await mouseFire(60);
    await sleep(300);
    const pistolShotsB = live().state.loadout.slots['pulse-pistol'].shotsFired;
    const wire11 = await sState();
    check('P5.11 SERVER qurol almashishni boshqaradi (draw bloklaydi; faol qurol serverda)',
      activeSlot11 === 'pulse-pistol' && switched11 === 'pulse-pistol' &&
      drawReject11 >= 1 && pistolShotsB > pistolShotsA && wire11.weapon.weaponId === 'pulse-pistol',
      `faol=${activeSlot11} drawRad=${drawReject11} pistolShots ${pistolShotsA}→${pistolShotsB} wire=${wire11.weapon.weaponId}`);

    // ---------- P5.12 soxta (forged) input rad etiladi ----------
    forger = new RawClient(WS_URL);
    await forger.open();
    forger.send({ type: MSG.HELLO, name: 'forger' });
    const fSession = await forger.next(MSG.SESSION);
    forger.q.length = 0;
    const fLive = server.state.sessions.get(fSession.sessionId);
    const before12 = {
      hp: fLive.state.health.hp,
      alive: fLive.state.health.alive,
      mag: fLive.state.loadout.slots['neon-rifle'].mag,
      dummy: fLive.state.targetById.get('dummy-1').health.hp,
      rejected: fLive.counters.rejected
    };
    const forged = [
      ['damage+targetHp+hit+alive+ammo', {
        seq: 1, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 },
        aim: { dir: [0, 0, -1] }, intents: { fire: true },
        damage: 100, targetHp: 0, hit: true, alive: false, ammo: 9999
      }, 'forbidden_authority'],
      ['hp in\'ektsiyasi', {
        seq: 2, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 },
        aim: { dir: [0, 0, 1] }, intents: {}, hp: 0
      }, 'forbidden_authority'],
      ['cooldown bypass', {
        seq: 3, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 },
        aim: { dir: [0, 0, 1] }, intents: { fire: true }, cooldown: 0
      }, 'forbidden_authority'],
      ['NaN aim', {
        seq: 4, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 },
        aim: { dir: [NaN, 0, 1] }, intents: {}
      }, 'bad_aim'],
      ['Infinity pozitsiya', {
        seq: 5, pose: { x: Infinity, y: 0, z: 0, yaw: 0, pitch: 0 },
        aim: { dir: [0, 0, 1] }, intents: {}
      }, 'bad_pose'],
      ['mavjud bo\'lmagan qurol', {
        seq: 6, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 },
        aim: { dir: [0, 0, 1] }, intents: { switchTo: 'nuke' }
      }, 'bad_weapon']
    ];
    const forgedResults = [];
    for (const [label, msg, want] of forged) {
      forger.send({ type: MSG.INPUT, ...msg });
      const ack = await forger.next(MSG.INPUT_ACK);
      forgedResults.push({ label, accepted: ack.accepted, reason: ack.reason, want, ok: ack.accepted === false && ack.reason === want });
    }
    const after12 = {
      hp: fLive.state.health.hp,
      alive: fLive.state.health.alive,
      mag: fLive.state.loadout.slots['neon-rifle'].mag,
      dummy: fLive.state.targetById.get('dummy-1').health.hp,
      rejected: fLive.counters.rejected
    };
    check('P5.12 soxta combat buyruqlari RAD (zarar/HP/o\'q-dori/cooldown/NaN) — server holati o\'zgarmadi',
      forgedResults.every((r) => r.ok) &&
      after12.hp === before12.hp && after12.alive === before12.alive &&
      after12.mag === before12.mag && after12.dummy === before12.dummy &&
      after12.rejected > before12.rejected,
      forgedResults.map((r) => `${r.label}:${r.reason}${r.ok ? '' : ' [FAIL]'}`).join(' | ') +
      ` · HP ${before12.hp}→${after12.hp} · mag ${before12.mag}→${after12.mag} · dummy ${before12.dummy}→${after12.dummy}`);

    // ---------- P5.13 buzilgan trafikdan keyin server tirik ----------
    forger.send({ type: MSG.INPUT, seq: 7, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, intents: {} });
    const okAck = await forger.next(MSG.INPUT_ACK);
    forger.ws.send('{{{ bu json emas');
    const badJson = await forger.next(MSG.ERROR);
    forger.send({ type: 'cheat_give_damage', dmg: 99999 });
    const unknown = await forger.next(MSG.ERROR);
    forger.ws.send(JSON.stringify({ type: MSG.INPUT, pad: 'x'.repeat(40000) }));
    const tooBig = await forger.next(MSG.ERROR);
    // sessiyasiz klient
    const orphan = new RawClient(WS_URL);
    await orphan.open();
    orphan.send({ type: MSG.INPUT, seq: 1, pose: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, intents: {} });
    const noSession = await orphan.next(MSG.ERROR);
    orphan.close();
    forger.send({ type: MSG.PING, t: 777 });
    const pong = await forger.next(MSG.PONG);
    const tel = server.telemetry();
    check('P5.13 buzilgan/soxta trafikdan keyin SERVER TIRIK (bad_json/unknown/too_big/no_session + pong)',
      okAck.accepted === true && badJson.code === 'bad_json' && unknown.code === 'unknown_type' &&
      tooBig.code === 'too_big' && noSession.code === 'no_session' &&
      pong.t === 777 && tel.tickErrors === 0 && server.state.connections.size >= 2,
      `${badJson.code}/${unknown.code}/${tooBig.code}/${noSession.code} · pong=${pong.t} · tickErrors=${tel.tickErrors} · ulanish=${server.state.connections.size}`);

    // ---------- P5.14 granata server simulyatsiyasi (brauzer orqali) ----------
    await resetBoth();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await pressKey(cdp, 'Digit4', '4', 52);
    await sleep(450);                                    // draw
    await cdp.evaluate('window.__neon.aimAtPoint(-30, -5, 0)');   // pastga/uzoqqa
    await sleep(150);
    const throwsA = live().state.stats.grenadeThrows;
    await mouseFire(50);
    await sleep(250);
    const l14 = live();
    const throwsB = l14.state.stats.grenadeThrows;
    const grenadesActive = l14.state.grenades.length;
    let exploded = null;
    for (let i = 0; i < 30; i++) {
      await sleep(120);
      const s = live();
      if (s.state.stats.grenadeExplosions >= 1 && s.state.grenades.length === 0) { exploded = s; break; }
    }
    const wire14 = await sState();
    check('P5.14 SERVER granatani simulyatsiya qiladi (otish → parvoz → portlash, server xotirasida)',
      throwsB > throwsA && grenadesActive >= 1 && !!exploded &&
      wire14.grenades === 0 && wire14.weapon.weaponId === 'energy-grenade',
      `throw ${throwsA}→${throwsB} · faol granata=${grenadesActive} · portlash=${exploded ? exploded.state.stats.grenadeExplosions : 0} · wire=${wire14.weapon.weaponId}`);

    // ---------- P5.15 unumdorlik + Phase 3 regressiya ----------
    await resetBoth();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(200);
    const tickBefore = server.state.tick;
    await holdTrigger(3000);
    await sleep(150);
    const tickAfter = server.state.tick;
    const perf = await diag();
    const telPerf = server.telemetry();
    const f = perf.fps;
    const perfOk = f.windowFrames > 60 && f.fpsAvg >= 30 && perf.cpuMs < 16.6 &&
      perf.render.calls <= 165 && perf.render.triangles <= 32000 && perf.render.shadowMap === false;
    check('P5.15a unumdorlik (FPS≥30 o\'q ostida, CPU<16.6 ms, calls≤165, tri≤32k, shadow OFF)',
      perfOk,
      `${f.fpsEma} FPS ema · o'rt ${f.fpsAvg} · CPU ${perf.cpuMs} ms · ${perf.render.calls} calls · ${perf.render.triangles} tri · shadow=${perf.render.shadowMap}`);

    // server loop unumdorligi: 30 Hz, loop < 16 ms, xatosiz
    const ticks = tickAfter - tickBefore;
    const serverOk = ticks >= 60 && ticks <= 130 && telPerf.tickErrors === 0 && telPerf.loopMs < 16.6;
    check('P5.15b server 30 Hz loop sog\'lom (3 s da ~90 tick, tickErrors=0, loop < 16.6 ms)',
      serverOk,
      `3 s da ${ticks} tick · loop ${telPerf.loopMs} ms · tickErrors=${telPerf.tickErrors} · sessiya=${telPerf.sessions}`);

    // Phase 3 regressiya: map/harakat
    await cdp.evaluate('window.__neon.setView(-19.5, 0, Math.PI / 2, -0.05, 0)');
    await sleep(150);
    const mBefore = await diag();
    await holdKey(cdp, 'KeyW', 'w', 87);
    let cruise = 0;
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      const d = await diag();
      if (d.player.speed > cruise) cruise = d.player.speed;
      if (cruise > 4 && i >= 3) break;
    }
    await releaseKey(cdp, 'KeyW', 'w', 87);
    await sleep(150);
    const mAfter = await diag();
    const dx = +(mAfter.player.x - mBefore.player.x).toFixed(2);
    check('P5.15c PHASE 3 regressiya (NEON FACILITY 44×32, 60 kollayder, WASD harakat)',
      perf.scene.map === 'NEON FACILITY' && MAP.WIDTH === 44 && MAP.DEPTH === 32 &&
      perf.scene.props === 60 && dx > 1.5 && cruise > 3 && cruise <= MOVE.WALK + 0.5 &&
      perf.scene.trainingGroup === true,
      `map=${perf.scene.map} ${MAP.WIDTH}×${MAP.DEPTH} kollayder=${perf.scene.props} Δx=+${dx} m (${cruise.toFixed(2)} m/s, walk=${MOVE.WALK})`);

    // ---------- P5.16 xatosiz runtime ----------
    const pageErrors = await cdp.evaluate('window.__neon.errors || []');
    const consoleErrors = cdp.logs.filter((l) => l.level === 'error' &&
      !/favicon|DevTools|Autofill|net::ERR_NAME|PHONE_REGISTRATION|gcm|registration_request/i.test(l.text));
    const d16 = await diag();
    check('P5.16 konsol/runtime xatolari YO\'Q (brauzer + server)',
      consoleErrors.length === 0 && pageErrors.length === 0 && cdp.exceptions.length === 0 &&
      d16.loopErrors === 0 && server.state.tickErrors === 0,
      `console=${consoleErrors.length} window.error=${pageErrors.length} exception=${cdp.exceptions.length} loop=${d16.loopErrors} serverTick=${server.state.tickErrors}`);

    // ---------- artefaktlar ----------
    await cdp.evaluate('window.__neon.switchWeapon(1)');
    await sleep(400);
    await setView(-19.5, 0, Math.PI / 2, -0.05);
    await sleep(250);
    await shot('p5-01-final');
    const dom = await domShot('p5-02-hud-authority');
    await sentinel(false);

    // ---------- hisobot ----------
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 5,
      subject: 'authoritative-server',
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      protocol: ready.gates?.protocol,
      gpu: { renderer, software, webgl2: ready.gates?.webgl2 === true },
      simulation: { tickHz: SIM.TICK_HZ, snapshotHz: SIM.SNAPSHOT_HZ, tickMs: SIM.TICK_MS },
      serverTelemetry: telPerf,
      gateEvidence: {
        browserSession: sessionMsg,
        serverSession: srvSession ? {
          sessionId: srvSession.id, playerId: srvSession.playerId,
          targets: srvSession.state.targets.map((t) => t.id),
          weapons: srvSession.state.loadout.ids.slice(),
          counters: srvSession.counters, rejections: srvSession.rejections,
          fireReasons: srvSession.fireReasons
        } : null,
        forgedInputs: forgedResults,
        cadenceShotsPerSecond: cadence,
        serverTicks3s: ticks
      },
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      performance: { fps: perf.fps, cpuMs: perf.cpuMs, render: perf.render },
      domCaptured: dom.captured,
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes })),
      consoleErrors, pageErrors, exceptions: cdp.exceptions
    };
    fs.writeFileSync(path.join(ART, 'phase5-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== PHASE 5 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    console.log(`GPU: ${renderer.slice(0, 90)}${software ? ' (SOFTWARE!)' : ''}`);
    console.log(`SIM: ${SIM.TICK_HZ} Hz tick (loop ${telPerf.loopMs} ms) · ${telPerf.tick} tick · sessiya=${telPerf.sessions}`);
    console.log(`PERF: ${perf.fps.fpsEma} FPS ema · CPU ${perf.cpuMs} ms · ${perf.render.calls} draw calls · ${perf.render.triangles} tri`);
    console.log(`ARTIFACTS: logs/phase5-report.json + ${shots.length} skrinshot`);
    return report.failed === 0;
  } finally {
    try { if (forger) forger.close(); } catch {}
    cdp.close();
    try { child.kill('SIGTERM'); } catch {}
    await sleep(400);
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    try { await server.close(); } catch {}
  }
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
    try {
      fs.writeFileSync(path.join(ART, 'phase5-report.json'), JSON.stringify({ fatal: String(err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
