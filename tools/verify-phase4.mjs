#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 4 COMBAT BROWSER VERIFIKATSIYASI (anti-fake harness)
// HAQIQIY Chrome (real GPU) da PHASE 4 combatni tekshiradi:
//   WebGL2/GPU · modul yuklash · versiya · WS · real klik · Pointer Lock ·
//   crosshair (piksel) · qurol ko'rinishi (kadr farqi) · aim matematikasi ·
//   REAL sichqoncha o'q uzish · cooldown (600 RPM kadans) · o'q-dori ·
//   reload (real R) · nishonga tegish (HP) · devor to'sishi · nishon
//   o'lim/respawn · o'yinchi self-damage/o'lim/respawn · qurol almashtirish
//   + granata · xatosiz runtime · FPS/draw-call + PHASE 3 regressiya.
// O'z serverini ephemeral portda o'zi ishga tushiradi.
// Ishga tushirish:  node tools/verify-phase4.mjs            (real oyna · real GPU)
//                   node tools/verify-phase4.mjs --headless (CI; P4.1 SwiftShader da FAIL bo'ladi)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { SPAWNS, MAP, TRAINING_DUMMIES } from '../shared/map.js';
import { MOVE } from '../shared/collision.js';
import { WEAPONS } from '../shared/weapons.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9355);
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

// ---------------- minimal CDP klient (ws paketi bilan) ----------------
class CDP {
  constructor (url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.logs = [];
    this.exceptions = [];
  }

  async open () {
    this.ws = new WebSocket(this.url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async evaluate (expression, opts = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: opts.awaitPromise !== false,
      returnByValue: true,
      userGesture: !!opts.userGesture
    });
    if (res.exceptionDetails) {
      throw new Error('in-page xato: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result.value;
  }

  close () { try { this.ws.close(); } catch {} }
}

const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

async function launchChrome (base) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon4-chrome-'));
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
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
}

async function holdKey (cdp, code, keyName, vk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
    });
    for (let i = 0; i < 12; i++) {
      const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
      if (keys.includes(code)) return true;
      await sleep(80);
    }
  }
  return false;
}

async function releaseKey (cdp, code, keyName, vk) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
}

// ---------------- asosiy oqim ----------------
async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;

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
    const entry = { name, file, bytes: Buffer.from(b64, 'base64').length, source: 'drawing-buffer' };
    shots.push(entry);
    return entry;
  };
  const shot = async (name) => {
    const dataUrl = await cdp.evaluate('window.__neon.captureFrame()');
    await saveShot(name, dataUrl);
    return { dataUrl };
  };
  const writeShot = (name, b64) => {
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    shots.push({ name, file, bytes: Buffer.from(b64, 'base64').length, source: 'page-screenshot' });
    return 'data:image/png;base64,' + b64;
  };
  /** data-URL'ning (o'ng-yuqoridan) piksel qiymatini o'qish (in-page) */
  const pixelOf = (url, dxFromRight, dy) => cdp.evaluate(`(async function () {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = ${JSON.stringify(url)}; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(img.width - ${dxFromRight}, ${dy}, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3], w: img.width, h: img.height };
  })()`);
  /** Sentinel — kompozitlangan DOM qatlam skrinshotga tushganini tasdiqlaydi */
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
  /**
   * DOM qatlamini o'z ichiga OLGAN kompozit skrinshot (tasdiqlab).
   * Page.captureScreenshot ba'zan overlay qatlamini tushirmaydi — sentinel
   * magenta pikseli ko'rinmaguncha qayta urinamiz (flaky dalilga yo'l qo'ymaymiz).
   */
  const domShot = async (name) => {
    await sentinel(true);
    let url = null;
    let domCaptured = false;
    for (let i = 0; i < 10 && !domCaptured; i++) {
      await settle();                                   // DOM o'zgarishi kompozitsiyaga tushsin (stale frame YO'Q)
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      url = 'data:image/png;base64,' + r.data;
      const p = await pixelOf(url, 8, 8);
      domCaptured = p.r > 180 && p.g < 90 && p.b > 180;
      if (domCaptured) writeShot(name, r.data);
      else await sleep(200);
    }
    return { url, domCaptured };
  };

  const diag = () => cdp.evaluate('window.__neon.diagnostics()');
  const qa = () => cdp.evaluate('window.__neon.combatQa()');
  const snap = () => cdp.evaluate('window.__neon.combatSnapshot()');
  const reset = async () => { await cdp.evaluate('window.__neon.reset()'); await sleep(120); };
  const setView = (x, z, yaw, pitch, y) => cdp.evaluate(
    `window.__neon.setView(${x}, ${z}, ${yaw}, ${pitch}, ${y === undefined ? 'undefined' : y})`);
  const aimAt = (id) => cdp.evaluate(`window.__neon.aimAt(${JSON.stringify(id)})`);

  let mouse = { x: 640, y: 400 };
  const moveMouse = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  const mouseDown = () => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button: 'left', clickCount: 1, buttons: 1 });
  const mouseUp = () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', clickCount: 1, buttons: 0 });
  /** REAL sichqoncha click: press → ushlash → release */
  const mouseFire = async (holdMs = 40) => { await mouseDown(); await sleep(holdMs); await mouseUp(); };

  /** DOM o'zgarishi → kompozitsiyaga tushishini kutish (2 rAF + pauza) */
  const settle = async (ms = 180) => {
    try {
      await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))');
    } catch {}
    await sleep(ms);
  };

  /**
   * REAL trigger ushlab turish: har ~100 ms da qayta mousePressed yuboriladi.
   * Sabab: oyna blur bo'lsa input.buttons tozalanadi va bitta pressdanoq
   * "ushlash" uzilib qoladi — qayta press qilish ishlab chiqarish yo'lini
   * saqlaydi (cooldown baribir 600 RPM ni ushlab turadi).
   */
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

  const targetHp = async (id) => {
    const q = await qa();
    const t = q.targets.find((x) => x.id === id);
    return t ? t.hp : null;
  };

  try {
    // ---------- 0) sahifa tayyor + modullar ----------
    let ready = null;
    for (let i = 0; i < 80; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          return {
            loading: false,
            loaded: !!(window.__neon && window.__neon.loaded),
            version: window.__neon ? window.__neon.version : null,
            phase: window.__neon ? window.__neon.phase : null,
            hasCombat: !!(window.__neon && window.__neon.combat),
            hasQa: typeof window.__neon.combatQa === 'function',
            hasAim: typeof window.__neon.aimAt === 'function',
            gates: window.__neon ? window.__neon.gates : null,
            ready: btn.dataset.ready === '1'
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) {
        ready = { error: String(e.message), loading: true };
      }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('Sahifa tayyor holatga kelmadi: ' + JSON.stringify(ready));
    await cdp.evaluate(HELPERS);
    const vp = await cdp.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
    mouse = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) };
    await moveMouse(mouse.x, mouse.y);

    // ---------- P4.1 real GPU ----------
    const renderer = ready.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software|ANGLE \(Google, Vulkan.*SwiftShader/i.test(renderer);
    check('P4.1 real WebGL2 + real GPU (SwiftShader EMAS)',
      ready.gates?.webgl2 === true && !software,
      `renderer="${renderer.slice(0, 96)}"${software ? ' [SOFTWARE RENDERING]' : ''}`);

    // ---------- P4.2 modul yuklash ----------
    check('P4.2 Phase 4 combat moduli yuklandi (Game.loaded + ready)',
      ready.loaded === true && ready.ready === true,
      `loaded=${ready.loaded} ready=${ready.ready}`);

    // ---------- P4.5 real klik bilan TRAINING (eng avval — combat shundan keyin) ----------
    const btn = await cdp.evaluate('window.__v.rect("btnTraining")');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(1300);
    const started = await cdp.evaluate('({ menu: window.__v.hidden("menu"), running: window.__neon.running })');
    const mods = await cdp.evaluate(`(function () {
      const el = document.getElementById('combatHud');
      return {
        hasCombat: !!(window.__neon && window.__neon.combat),
        hasQa: typeof window.__neon.combatQa === 'function',
        hasAim: typeof window.__neon.aimAt === 'function',
        hudActive: !!(el && !el.hidden)
      };
    })()`);
    check('P4.5 TRAINING real klik bilan boshlandi + combat HUD/API faol',
      started.menu === true && started.running === true && mods.hasCombat === true &&
      mods.hasQa === true && mods.hasAim === true && mods.hudActive === true,
      `running=${started.running} combat=${mods.hasCombat} QA=${mods.hasQa} HUD=${mods.hudActive}`);

    // ---------- P4.3 Phase 4 versiyasi ----------
    const dVer = await diag();
    check('P4.3 Phase 4 versiyasi (window.__neon.version=4 + combat engine)',
      ready.version === 4 && ready.phase === 'phase4-combat' &&
      dVer.combat && dVer.combat.version === 4,
      `version=${ready.version} phase=${ready.phase} combatEngine=v${dVer.combat?.version}`);

    // ---------- P4.4 WS baseline ----------
    check('P4.4 Phase 1 WS bazasi tirik (regressiya)',
      ready.gates?.ws === true, `protocol=v${ready.gates?.protocol} latency=${ready.gates?.latency}ms`);

    // ---------- P4.6 Pointer Lock ----------
    const locked = await ensureLock();
    check('P4.6 Pointer Lock olindi (sichqoncha o‘qi ishlaydi)', locked === true);

    // ---------- P4.7 crosshair (DOM + piksel) ----------
    await reset();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await sleep(250);
    const ch = await cdp.evaluate(`(function () {
      const el = document.getElementById('chCrosshair');
      if (!el) return { ok: false };
      const r = el.getBoundingClientRect();
      const bars = el.querySelectorAll('i').length;
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      return {
        ok: el.isConnected && !el.hidden && el.offsetParent !== null,
        bars,
        centered: Math.abs((r.x + r.width / 2) - cx) < 10 && Math.abs((r.y + r.height / 2) - cy) < 10,
        display: getComputedStyle(el).display
      };
    })()`);
    // crosshair — DOM qatlam (WebGL readback'da ko'rinmaydi). Ikki bosqichli
    // dalil: (1) DOM geometriyasi/markozi, (2) kompozit skrinshotda
    // yashirilganda butun HUD maydoni o'zgaradi (anti-fake piksel dalili).
    const chGeom = await cdp.evaluate(`(function () {
      const el = document.getElementById('chCrosshair');
      const bars = [...el.querySelectorAll('i')].map((b) => {
        const r = b.getBoundingClientRect();
        const c = getComputedStyle(b);
        return {
          x: +r.x.toFixed(1), y: +r.y.toFixed(1),
          w: +r.width.toFixed(1), h: +r.height.toFixed(1),
          bg: c.backgroundColor, disp: c.display, op: c.opacity, vis: c.visibility
        };
      });
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      const er = el.getBoundingClientRect();
      return {
        bars,
        gap: getComputedStyle(el).getPropertyValue('--gap').trim(),
        offCenter: Math.round(Math.hypot((er.x + er.width / 2) - cx, (er.y + er.height / 2) - cy))
      };
    })()`);
    const painted = (b) => b.disp !== 'none' && b.vis !== 'hidden' && b.op !== '0' && b.w > 0 && b.h > 0;
    const barsPainted = chGeom.bars.filter(painted).length;
    const barsCyan = chGeom.bars.filter((b) => /rgba?\(\s*5\d\s*,\s*20\d\s*,\s*25\d/.test(b.bg)).length;

    const hudOn = await domShot('p4-04-hud-on');
    await cdp.evaluate('(function(){ document.getElementById("chCrosshair").style.display="none"; return true; })()');
    const chOff = await domShot('p4-05-hud-crosshair-off');
    await cdp.evaluate('(function(){ document.getElementById("chCrosshair").style.display=""; return true; })()');
    const chDiff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(hudOn.url)},${JSON.stringify(chOff.url)})`);
    await cdp.evaluate('(function(){ document.getElementById("combatHud").style.display="none"; return true; })()');
    const hudOff = await domShot('p4-06-hud-all-off');
    await cdp.evaluate('(function(){ document.getElementById("combatHud").style.display=""; return true; })()');
    const hudDiff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(hudOn.url)},${JSON.stringify(hudOff.url)})`);
    await sentinel(false);

    const crosshairOk = ch.ok === true && ch.bars === 4 && ch.centered === true &&
      barsPainted === 4 && barsCyan === 4 && chGeom.offCenter <= 2 &&
      hudOn.domCaptured === true && chOff.domCaptured === true && hudOff.domCaptured === true &&
      chDiff.changedPixels > 20 && hudDiff.changedPixels > 400;
    check('P4.7 crosshair mavjud, markazda, sahifada HAQIQIY chizilgan',
      crosshairOk,
      `bars=${ch.bars}(chizilgan=${barsPainted}, cyan=${barsCyan}) gap=${chGeom.gap} markazdan=${chGeom.offCenter}px ` +
      `DOM-capture=${hudOn.domCaptured} crosshairΔ=${chDiff.changedPixels}px HUDΔ=${hudDiff.changedPixels}px`);

    // ---------- P4.8 qurol ko'rinishi (kadr farqi bilan) ----------
    await reset();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.08);
    await sleep(300);
    const wp = await cdp.evaluate('window.__neon.weaponProbe()');
    const onUrl = await cdp.evaluate('window.__neon.captureFrame()');
    const offUrl = await cdp.evaluate(`(function(){ window.__neon.combat.weaponView.setVisible(false); return window.__neon.captureFrame(); })()`);
    await saveShot('p4-01-weapon-on', onUrl);
    await saveShot('p4-02-weapon-off', offUrl);
    await cdp.evaluate('window.__neon.combat.weaponView.setVisible(true); window.__neon.combat.weaponView.setWeapon("neon-rifle")');
    const wDiff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(onUrl)},${JSON.stringify(offUrl)})`);
    // muzzle jahon nuqtasi ekranda ko'rinadimi (proyeksiya dalili)
    const mzProbe = Array.isArray(wp.muzzle)
      ? await cdp.evaluate(`window.__neon.probeWorld(${wp.muzzle[0]}, ${wp.muzzle[1]}, ${wp.muzzle[2]})`)
      : null;
    check('P4.8 procedural qurol ko‘rinadi (ekranda + yashirilganda kadr o‘zgaradi)',
      wp.visible === true && wp.weaponId === 'neon-rifle' && wp.models === 4 &&
      Array.isArray(wp.muzzle) && !!mzProbe && mzProbe.inFront === true && mzProbe.onScreen === true &&
      wDiff.changedPixels > 40,
      `weaponId=${wp.weaponId} visible=${wp.visible} muzzle ekranda=${!!mzProbe && mzProbe.onScreen} Δpiksel=${wDiff.changedPixels}`);

    // ---------- P4.9 aim matematikasi ----------
    await reset();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await sleep(220);
    const aimQ = await cdp.evaluate('window.__neon.weaponProbe()');
    const expDir = [Math.sin(Math.PI / 2) * Math.cos(-0.05), Math.sin(-0.05), Math.cos(Math.PI / 2) * Math.cos(-0.05)];
    const dot = expDir[0] * aimQ.aimDir[0] + expDir[1] * aimQ.aimDir[1] + expDir[2] * aimQ.aimDir[2];
    const aimLen = Math.hypot(aimQ.aimDir[0], aimQ.aimDir[1], aimQ.aimDir[2]);
    const mzDot = aimQ.muzzleDir
      ? aimQ.muzzleDir[0] * aimQ.aimDir[0] + aimQ.muzzleDir[1] * aimQ.aimDir[1] + aimQ.muzzleDir[2] * aimQ.aimDir[2]
      : -1;
    check('P4.9 aim matematikasi (kamera yaw/pitch → nur + qurol quvuri mos)',
      Math.abs(dot - 1) < 1e-3 && Math.abs(aimLen - 1) < 1e-6 && mzDot > 0.9,
      `dir=[${aimQ.aimDir.map((v) => v.toFixed(3))}] |dir|=${aimLen.toFixed(5)} dot=${dot.toFixed(5)} muzzleDot=${mzDot.toFixed(3)}`);

    // ---------- P4.10 REAL sichqoncha o'q uzish ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(220);
    const b10 = await qa();
    await mouseFire(70);
    await sleep(180);
    const a10 = await qa();
    const fired10 = a10.stats.shots - b10.stats.shots;
    check('P4.10 REAL LMB o‘q uzdi (o‘q-dori kamaydi, ishlab chiqarish yo‘li)',
      fired10 >= 1 && a10.weapon.mag < b10.weapon.mag && a10.weapon.mag < WEAPONS['neon-rifle'].magSize,
      `shots +${fired10}, mag ${b10.weapon.mag}→${a10.weapon.mag}`);

    // ---------- P4.11 cooldown (600 RPM kadans, real ushlab turish) ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(200);
    let fired11 = 0;
    let cdReject = 0;
    let b11 = null;
    let a11 = null;
    for (let attempt = 0; attempt < 3 && !(fired11 >= 9 && fired11 <= 13); attempt++) {
      await ensureLock();
      await reset();
      await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
      await aimAt('dummy-1');
      await sleep(200);
      b11 = await qa();
      await holdTrigger(1000);
      await sleep(180);
      a11 = await qa();
      fired11 = a11.stats.shots - b11.stats.shots;
      cdReject = a11.rejectReasons.cooldown || 0;
    }
    check('P4.11 cooldown: 1.0 s ushlashda ~11 o‘q (600 RPM) + oraliqda rad',
      fired11 >= 9 && fired11 <= 13 && cdReject >= 10,
      `1.0 s da ${fired11} o‘q (kutilgan 11), cooldown rad=${cdReject}`);

    // ---------- P4.12 o'q-dori hisobi ----------
    const s12 = await snap();
    const w12 = s12.weapon;
    const total12 = w12.mag + w12.reserve + w12.shotsFired;
    const totalExpected = WEAPONS['neon-rifle'].magSize + WEAPONS['neon-rifle'].startReserve;
    check('P4.12 o‘q-dori butunligi (mag+reserve+o‘q = const, manfiy yo‘q)',
      w12.mag >= 0 && w12.reserve >= 0 && total12 === totalExpected && w12.shotsFired === a11.stats.shots,
      `mag=${w12.mag} reserve=${w12.reserve} shotsFired=${w12.shotsFired} yig‘indi=${total12}/${totalExpected}`);

    // ---------- P4.13 reload (real R) ----------
    await ensureLock();
    await pressKey(cdp, 'KeyR', 'r', 82);
    await sleep(200);
    const mid13 = await qa();
    const reloadStarted = mid13.weapon.reloading === true;
    await holdTrigger(260);
    await sleep(140);
    const mid13b = await qa();
    const reloadReject = mid13b.rejectReasons.reloading || 0;
    await sleep(WEAPONS['neon-rifle'].reloadMs + 400);
    const a13 = await qa();
    check('P4.13 reload: R bilan boshlandi, davomida o‘q uzilmaydi, mag to‘ldi',
      reloadStarted && reloadReject >= 1 && a13.weapon.mag === WEAPONS['neon-rifle'].magSize &&
      a13.weapon.reserve < WEAPONS['neon-rifle'].startReserve && a13.weapon.reloading === false,
      `reloading=${reloadStarted}, rad=${reloadReject}, mag=${a13.weapon.mag}/${WEAPONS['neon-rifle'].magSize}, reserve=${a13.weapon.reserve}`);

    // ---------- P4.14 nishonga tegish (HP kamayadi) ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(220);
    const hp14a = await targetHp('dummy-1');
    await mouseFire(45);
    await sleep(200);
    const hp14b = await targetHp('dummy-1');
    const q14 = await qa();
    check('P4.14 nishonga HAQIQIY zarar (dummy-1 HP kamaydi)',
      hp14a === 100 && hp14b < hp14a && q14.stats.hits >= 1,
      `dummy-1 HP ${hp14a}→${hp14b}, hits=${q14.stats.hits}`);

    // ---------- P4.15 devor to'sishi ----------
    await reset();
    await ensureLock();
    await setView(-13, 4.5, 0, 0);
    await aimAt('dummy-1');
    await sleep(220);
    const b15 = await qa();
    const hp15a = await targetHp('dummy-1');
    await mouseFire(45);
    await sleep(200);
    const a15 = await qa();
    const hp15b = await targetHp('dummy-1');
    check('P4.15 devor nishonni to‘sadi (blocked sanaldi, HP O‘ZGARMADI)',
      a15.stats.blocked > b15.stats.blocked && hp15b === hp15a,
      `blocked ${b15.stats.blocked}→${a15.stats.blocked}, dummy-1 HP ${hp15b} (o‘zgarmadi)`);

    // ---------- P4.16 nishon o'limi + respawn ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(220);
    let killed = false;
    for (let i = 0; i < 26; i++) {
      await mouseDown();                            // trigger (re)assert
      await sleep(90);
      const q = await qa();
      const t = q.targets.find((x) => x.id === 'dummy-1');
      if (t && t.deaths >= 1) { killed = true; break; }
    }
    await mouseUp();
    await sleep(750);
    const q16 = await qa();
    const t16 = q16.targets.find((x) => x.id === 'dummy-1');
    const v16 = (q16.targetVisuals || []).find((x) => x.id === 'dummy-1');
    const deadOk = t16 && t16.alive === false && v16 && v16.dead === true && v16.visible === false;
    await sleep(2300);
    const q16b = await qa();
    const t16b = q16b.targets.find((x) => x.id === 'dummy-1');
    const v16b = (q16b.targetVisuals || []).find((x) => x.id === 'dummy-1');
    const respawnOk = t16b && t16b.alive === true && t16b.hp === 100 && v16b && v16b.visible === true;
    check('P4.16 nishon o‘ldi (600 ms so‘nish) va 2500 ms dan keyin tirildi',
      killed && deadOk && respawnOk,
      `deaths=${t16 ? t16.deaths : '?'}, so‘nish ko‘rindi=${!!(v16 && v16.visible === false)}, tirilgan=${!!(t16b && t16b.alive)} hp=${t16b ? t16b.hp : '?'}`);

    // ---------- P4.17 o'yinchi self-damage / o'lim / respawn ----------
    // (a) REAL granata: devor yonida pastga otilib o'z-o'zini yaralaydi
    await reset();
    await ensureLock();
    await setView(-21.5, 0, -Math.PI / 2, -0.5);
    await pressKey(cdp, 'Digit4', '4', 52);
    await sleep(450);                                  // draw (300 ms)
    await cdp.evaluate('window.__neon.aimAtPoint(-30, -5, 0)');
    await sleep(120);
    await mouseFire(40);
    await sleep(120);
    const qThrow = await qa();
    let selfQ = null;
    for (let i = 0; i < 30; i++) {
      await sleep(120);
      const q = await qa();
      if (q.stats.selfDamage > 0 && q.hp < 100) { selfQ = q; break; }
    }
    const selfOk = !!selfQ;
    check('P4.17a REAL granata o‘z zarari (self-damage ×0.6, HP kamaydi)',
      qThrow.stats.grenadeThrows >= 1 && selfOk,
      selfQ
        ? `granata otildi=${qThrow.stats.grenadeThrows}, selfDamage=${selfQ.stats.selfDamage}, HP=${selfQ.hp}`
        : `granata otildi=${qThrow.stats.grenadeThrows}, self-damage kuzatilmadi`);

    // (b) halokatli zarar → o'lim → avtomatik respawn (shared damagePlayer yo'li)
    await sleep(200);
    await cdp.evaluate(`window.__neon.damagePlayer(999, 'grenade')`);
    await sleep(200);
    const deadQ = await qa();
    const hudDead = deadQ.hud && deadQ.hud.dead === true;
    const deathOk = deadQ.alive === false && deadQ.deaths >= 1 && deadQ.respawnIn > 0 && hudDead;
    await sleep(2750);
    const backQ = await qa();
    const backSnap = await snap();
    const posOk = Math.abs(backSnap.position.x - SPAWNS.A.x) < 0.05 &&
      Math.abs(backSnap.position.z - SPAWNS.A.z) < 0.05 &&
      Math.abs(backSnap.position.y - SPAWNS.A.y) < 0.05;
    check('P4.17b o‘lim holati → avtomatik respawn (HP/o‘q-dori/spawn tiklandi)',
      deathOk && backQ.alive === true && backQ.hp === 100 &&
      backQ.weapon.mag === WEAPONS['neon-rifle'].magSize && posOk,
      `o‘lim: alive=${deadQ.alive} deaths=${deadQ.deaths} respawnIn=${deadQ.respawnIn.toFixed(2)}s HUD=${hudDead} → respawn hp=${backQ.hp} pos=(${backSnap.position.x},${backSnap.position.z})`);

    // ---------- P4.18 qurol almashtirish + granata ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await pressKey(cdp, 'Digit2', '2', 50);
    await sleep(120);
    const swQ = await qa();
    const switched = swQ.weapon.weaponId === 'pulse-pistol' && swQ.weapon.slot === 2;
    await holdTrigger(140);                           // draw davomida
    await sleep(120);
    const drawQ = await qa();
    await sleep(320);
    await aimAt('dummy-1');
    await sleep(120);
    await mouseFire(45);
    await sleep(160);
    const pistolQ = await qa();
    await pressKey(cdp, 'Digit4', '4', 52);
    await sleep(420);
    const grenQ = await qa();
    await aimAt('dummy-1');
    await sleep(120);
    await mouseFire(45);
    await sleep(160);
    const throwQ = await qa();
    let boom = null;
    for (let i = 0; i < 26; i++) {
      await sleep(120);
      const q = await qa();
      if (q.stats.grenadeExplosions >= 1 && q.grenadesActive === 0) { boom = q; break; }
    }
    check('P4.18 qurol almashtirish (draw bloklaydi) + granata otildi/portladi',
      switched && (drawQ.rejectReasons.switching || 0) >= 1 &&
      pistolQ.stats.shots >= 1 && grenQ.weapon.weaponId === 'energy-grenade' &&
      throwQ.stats.grenadeThrows >= 1 && !!boom,
      `switch→${swQ.weapon.weaponId} drawRad=${drawQ.rejectReasons.switching || 0} pistolShots=${pistolQ.stats.shots} ` +
      `grenade=${grenQ.weapon.weaponId} throws=${throwQ.stats.grenadeThrows} eksploziya=${boom ? boom.stats.grenadeExplosions : 0}`);

    // ---------- P4.19 xatosiz runtime ----------
    const pageErrors = await cdp.evaluate('window.__neon.errors || []');
    const consoleErrors = cdp.logs.filter((l) => l.level === 'error' &&
      !/favicon|DevTools|Autofill|net::ERR_NAME|PHONE_REGISTRATION|gcm|registration_request/i.test(l.text));
    const d19 = await diag();
    check('P4.19 konsol/runtime xatolari YO‘Q',
      consoleErrors.length === 0 && pageErrors.length === 0 && cdp.exceptions.length === 0 && d19.loopErrors === 0,
      `console=${consoleErrors.length}, window.error=${pageErrors.length}, exception=${cdp.exceptions.length}, loop=${d19.loopErrors}` +
      (consoleErrors.length ? ` -> ${consoleErrors.map((e) => e.text.slice(0, 90)).join(' | ')}` : ''));

    // ---------- P4.20 unumdorlik + PHASE 3 regressiya ----------
    await reset();
    await ensureLock();
    await setView(SPAWNS.A.x, SPAWNS.A.z, Math.PI / 2, -0.05);
    await aimAt('dummy-1');
    await sleep(200);
    await holdTrigger(3600);                           // "o'q ostida" o'lchov
    await sleep(120);
    const perf = await diag();
    const f = perf.fps;
    const perfOk = f.windowFrames > 60 && f.fpsAvg >= 30 && perf.cpuMs < 16.6 &&
      perf.render.calls <= 165 && perf.render.triangles <= 32000 && perf.render.shadowMap === false;
    check('P4.20a unumdorlik (FPS≥30 o‘q ostida, CPU<16.6 ms, calls≤165, tri≤32k, shadow OFF)',
      perfOk,
      `${f.fpsEma} FPS ema · o‘rt ${f.fpsAvg} · min ${f.fpsMin} · CPU ${perf.cpuMs} ms · ${perf.render.calls} calls · ${perf.render.triangles} tri · shadowMap=${perf.render.shadowMap}`);

    // PHASE 3 regressiya: xarita o'zgarmagan + harakat ishlaydi
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
    const p3Ok = perf.scene.map === 'NEON FACILITY' && MAP.WIDTH === 44 && MAP.DEPTH === 32 &&
      perf.scene.props === 60 && perf.scene.mapStats.meshes <= 40 &&
      dx > 1.5 && cruise > 3 && cruise <= MOVE.WALK + 0.5 && perf.scene.trainingGroup === true;
    check('P4.20b PHASE 3 regressiya (NEON FACILITY 44×32, 60 kollayder, WASD harakat)',
      p3Ok,
      `map=${perf.scene.map} ${MAP.WIDTH}×${MAP.DEPTH} kollayder=${perf.scene.props} mesh=${perf.scene.mapStats.meshes} ` +
      `Δx=+${dx} m (${cruise.toFixed(2)} m/s, walk=${MOVE.WALK})`);

    await cdp.evaluate('window.__neon.switchWeapon(1)');
    await sleep(400);
    await setView(-19.5, 0, Math.PI / 2, -0.05);
    await sleep(250);
    await shot('p4-03-final');

    // ---------- hisobot ----------
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 4,
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      gpu: { renderer, software, webgl2: ready.gates?.webgl2 === true },
      map: {
        name: MAP.NAME, width: MAP.WIDTH, depth: MAP.DEPTH,
        colliders: perf.scene.props, mapStats: perf.scene.mapStats
      },
      weapons: Object.fromEntries(Object.keys(WEAPONS).map((k) => [k, {
        rpm: WEAPONS[k].rpm, damage: WEAPONS[k].damage, damageMin: WEAPONS[k].damageMin,
        range: WEAPONS[k].range, magSize: WEAPONS[k].magSize, mode: WEAPONS[k].mode
      }])),
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      performance: { fps: perf.fps, cpuMs: perf.cpuMs, render: perf.render },
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes })),
      consoleErrors, pageErrors, exceptions: cdp.exceptions
    };
    fs.writeFileSync(path.join(ART, 'phase4-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== PHASE 4 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    console.log(`GPU: ${renderer.slice(0, 90)}${software ? ' (SOFTWARE!)' : ''}`);
    console.log(`PERF: ${perf.fps.fpsEma} FPS ema · avg ${perf.fps.fpsAvg} · CPU ${perf.cpuMs} ms · ${perf.render.calls} draw calls · ${perf.render.triangles} tri`);
    console.log(`ARTIFACTS: logs/phase4-report.json + ${shots.length} skrinshot`);
    return report.failed === 0;
  } finally {
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
      fs.writeFileSync(path.join(ART, 'phase4-report.json'), JSON.stringify({ fatal: String(err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
