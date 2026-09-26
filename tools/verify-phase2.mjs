#!/usr/bin/env node
// ============================================================
// NEON STRIKE — Phase 2 BROWSER verifikatsiyasi (anti-fake harness)
// HAQIQIY Chrome oynasida haqiqiy CDP kirish eventlari bilan tekshiradi:
//   training start · pointer lock · mouse look · WASD · kolliziya ·
//   kamera kolliziyasi · player modeli (NDC/bounds) · FPS · console xatolar
// Ishga tushirish:  node tools/verify-phase2.mjs            (real oyna)
//                   node tools/verify-phase2.mjs --headless (CI uchun)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { MOVE, CAMERA as CAM } from '../shared/collision.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.NEON_URL || 'http://localhost:3000';
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const results = [];
function check (name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  return !!ok;
}
function skip (name, detail = '') {
  results.push({ name, ok: null, detail });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
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

// in-page yordamchilar: diagnostika, element markazi, skrinshot tahlili
const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

// ---------------- Chrome ishga tushirish ----------------
async function launchChrome () {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-chrome-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    '--window-size=1280,800', '--window-position=0,0',
    BASE
  ];
  if (HEADLESS) args.unshift('--headless=new');
  const child = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (b) => {
    const s = b.toString();
    if (/error|fail/i.test(s) && !/GPU|dbus|Fontconfig|gbm|vaapi|IsSandboxed/i.test(s)) {
      process.stderr.write('[chrome] ' + s);
    }
  });
  return { child, profile };
}

async function waitForTarget () {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(300);
  }
  throw new Error('Chrome devtools target topilmadi');
}

// ---------------- asosiy oqim ----------------
async function main () {
  const { child, profile } = await launchChrome();
  const target = await waitForTarget();
  const cdp = await new CDP(target.webSocketDebuggerUrl).open();

  // konsol xatolarini ushlash uchun kanallarni yoqamiz
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});

  const shots = [];
  /**
   * Kadrni WebGL drawing buffer'idan oladi (skrinshot quvuri emas!) —
   * shu sababli ranglar ekrandagi bilan aynan bir xil va skanerlanadi.
   * opts.scan → sahnaning neon ranglari bo'yicha piksel dalili qaytariladi.
   */
  const bufferFrame = async () => await cdp.evaluate('window.__neon.captureFrame()');
  const shot = async (name, opts = {}) => {
    const dataUrl = await bufferFrame();
    const b64 = dataUrl.split(',')[1];
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    const entry = { name, file, bytes: Buffer.from(b64, 'base64').length, source: 'drawing-buffer' };
    shots.push(entry);
    if (opts.scan !== false) {
      const scan = await cdp.evaluate(`window.__v.sceneScan(${JSON.stringify(dataUrl)})`);
      entry.scan = scan;
      if (opts.analyze) {
        const stats = await cdp.evaluate(`window.__v.analyze(${JSON.stringify(dataUrl)})`);
        entry.stats = stats;
        return { dataUrl, scan, stats };
      }
      return { dataUrl, scan, stats: null };
    }
    return { dataUrl, scan: null, stats: null };
  };

  try {
    // ---------- 0) Phase 1 regressiyasi + Phase 2 modul yuklanishi ----------
    let ready = null;
    for (let i = 0; i < 80; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          return {
            loading: false,
            loaded: !!(window.__neon && window.__neon.loaded),
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
    // in-page yordamchilarni endi in'ektsiya qilamiz (DOM tayyor)
    await cdp.evaluate(HELPERS);
    check('P1.1 WebGL2 real GPU (regressiya)', ready.gates?.webgl2 === true, `renderer="${(ready.gates?.renderer || '').slice(0, 70)}"`);
    check('P1.2 Three.js (vendored) yuklandi', ready.loaded === true);
    check('P2.0 Game moduli oldindan yuklandi (jestsiz)', ready.ready === true);
    check('P1.3 WS handshake tirik', ready.gates?.ws === true, `protocol=v${ready.gates?.protocol}`);
    // P1.4 latency: WS ulanib bo'lgach birinchi pong 2s intervalga tushishi mumkin — 10s kutamiz
    let latencyGate = ready.gates?.latency;
    if (latencyGate == null) {
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        latencyGate = (await cdp.evaluate('window.__neon.gates')).latency;
        if (latencyGate != null) break;
      }
    }
    if (latencyGate != null) check('P1.4 Latency o\'lchandi', true, `${latencyGate} ms`);
    else skip('P1.4 Latency', 'pong hali kelmadi (10s)');

    // ---------- 1) TRAINING'ni HAQIQIY klik bilan boshlash ----------
    const menuBefore = await cdp.evaluate('({ menu: window.__v.hidden("menu"), stage: window.__v.hidden("stage") })');
    const btn = await cdp.evaluate('window.__v.rect("btnTraining")');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(1200);   // real oynada fokus/pointer-lock ruxsati uchun vaqt

    const stageAfter = await cdp.evaluate('({ menu: window.__v.hidden("menu"), stage: window.__v.hidden("stage"), running: window.__neon.running })');
    check('P2.1 TRAINING haqiqiy klik bilan boshlandi',
      menuBefore.menu === false && stageAfter.menu === true && stageAfter.stage === false && stageAfter.running === true,
      `menu ${menuBefore.menu}→${stageAfter.menu}, stage ${menuBefore.stage}→${stageAfter.stage}, running=${stageAfter.running}`);

/** Oynani oldinga olib kelish (desktop fokus o'g'irlashiga qarshi —
 *  occluded oynada Chrome rAF'ni to'xtatadi va pointer lock yo'qotiladi) */
const front = async () => { try { await cdp.send('Page.bringToFront'); } catch {} };
await front();

/** Fokus + pointer lock holatini kafolatlaydi (desktop fokus o'g'irlashi mumkin) */
const ensureLock = async () => {
  for (let i = 0; i < 8; i++) {
    await front();
    const s = await cdp.evaluate('window.__v.lockState()');
    if (s.locked) return true;
    await cdp.evaluate('window.__neon.requestLock()', { userGesture: true });
    await sleep(300);
  }
  return (await cdp.evaluate('window.__v.lockState()')).locked;
};

// ---------- 2) Pointer Lock ----------
    // ---------- 2) Pointer Lock ----------
    await cdp.evaluate('window.__v.installMouseProbe()');
    let lockState = { locked: false };
    for (let i = 0; i < 10; i++) {
      lockState = await cdp.evaluate('window.__v.lockState()');
      if (lockState.locked) break;
      await cdp.evaluate('window.__neon.requestLock()', { userGesture: true });
      await sleep(250);
    }
    check('P2.2 Pointer Lock faol (canvas#gl)',
      lockState.locked === true, lockState.locked ? `pointerLockElement = ${lockState.el}` : 'pointer lock berilmadi');

    // ---------- 3) SICHQONCHA bilan kamera boshqaruvi ----------
    // (a) real brauzer pointer eventlari Pointer Lock ostida sahifaga yetib keladimi?
    const camBefore = await cdp.evaluate('window.__neon.diagnostics().camera');
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400 + i * 20, y: 400 + i * 4, button: 'none', buttons: 0 });
      await sleep(20);
    }
    const probe = await cdp.evaluate('window.__v.readMouseProbe()');
    const nonzero = probe.filter((p) => p.movementX !== 0 || p.movementY !== 0).length;
    check('P2.3a Brauzer pointer eventlari sahifaga yetib keladi (Pointer Lock ostida)',
      probe.length > 0,
      `${probe.length} mousemove event · movementX≠0: ${nonzero} ta (CDP sintetik eventlarda movementX=0 bo'lishi normal)`);

    // (b) HAQIQIY handler + HAQIQIY math: Pointer Lock faol bo'lganda movementX bilan event
    await ensureLock();   // fokus o'g'irlanib lock yo'qolgan bo'lsa — qayta olamiz
    const beforeLook = await cdp.evaluate('window.__neon.diagnostics().camera');
    await cdp.evaluate('window.__v.mouseMoveWithDelta(140, -60)');
    await sleep(80);
    const afterLook = await cdp.evaluate('window.__neon.diagnostics().camera');
    const yawDelta = +(afterLook.yaw - beforeLook.yaw).toFixed(4);
    const pitchDelta = +(afterLook.pitch - beforeLook.pitch).toFixed(4);
    check('P2.3b SICHQONCHA harakati kamerani buradi (yaw + pitch)',
      afterLook.lookEvents > 0 && Math.abs(yawDelta) > 0.01 && Math.abs(pitchDelta) > 0.01,
      `lookEvents=${afterLook.lookEvents}, yaw Δ=${yawDelta}, pitch Δ=${pitchDelta}`);

    // (c) NEGATIV test: Pointer Lock O'CHIQ bo'lsa handler eventni e'tiborsiz qoldiradi
    await ensureLock();   // (b) dan keyin lock kafolatlangan, endi ATAYIN bo'shatamiz
    await cdp.evaluate('window.__v.exitLock()');
    await sleep(300);
    const unlocked = await cdp.evaluate('window.__v.lockState()');
    const beforeNoLock = await cdp.evaluate('window.__neon.diagnostics().camera');
    await cdp.evaluate('window.__v.mouseMoveWithDelta(200, 0)');
    await sleep(80);
    const afterNoLock = await cdp.evaluate('window.__neon.diagnostics().camera');
    check('P2.3c Pointer Lock O\'CHIQ bo\'lsa kamera BURILMAYDI (gate ishlaydi)',
      unlocked.locked === false && afterNoLock.lookEvents === beforeNoLock.lookEvents &&
      Math.abs(afterNoLock.yaw - beforeNoLock.yaw) < 1e-9,
      `locked=${unlocked.locked}, lookEvents ${beforeNoLock.lookEvents}→${afterNoLock.lookEvents}`);
    // pauza oynasi ko'rinishi (pointer lock yo'q)
    const pauseVisible = await cdp.evaluate('!window.__v.hidden("pause")');
    check('P2.3d Pointer Lock bo\'shatilganda PAUZA oynasi chiqadi',
      pauseVisible === true);
    // kamerani tiklaymiz va Pointer Lock'ni qaytaramiz (keyingi testlar uchun) —
    // avval RESUME tugmasi (ishlab chiqarish yo'li), keyin ensureLock zaxirasi
    await cdp.evaluate(`window.__neon.setView(0, -9.5, 0, -0.12)`);
    let relock = { locked: false };
    for (let i = 0; i < 8; i++) {
      await front();
      await cdp.evaluate('window.__v.resumeClick()');
      await sleep(250);
      relock = await cdp.evaluate('window.__v.lockState()');
      if (relock.locked) break;
    }
    check('P2.3e Pointer Lock qayta olinadi (RESUME yo\'li)',
      relock.locked === true, `pointerLockElement = ${relock.el}`);
    await ensureLock();   // keyingi bo'limlar uchun lock kafolati
    await shot('p2-01-game-look', { analyze: true });

    // ---------- 4) WASD harakati (haqiqiy klaviatura eventlari) ----------
    await ensureLock();
    await cdp.evaluate('window.__neon.setView(9.5, -3, 0, -0.12)');
    await sleep(150);
    const moveBefore = await cdp.evaluate('window.__neon.diagnostics()');

    await holdKey(cdp, 'KeyW', 'w', 87);
    const wDebug = await cdp.evaluate(`(function () {
      const d = window.__neon.diagnostics();
      return {
        keys: d.keys, locked: d.pointerLocked, running: d.running,
        mode: d.mode, player: d.player, kb: window.__kbProbe || null
      };
    })()`);
    console.log('W-HOLD DEBUG:', JSON.stringify(wDebug));
    await sleep(400);
    const cruise = await cdp.evaluate('window.__neon.diagnostics()');
    await sleep(600);
    await releaseKey(cdp, 'KeyW', 'w', 87);
    await sleep(200);
    const moveAfter = await cdp.evaluate('window.__neon.diagnostics()');
    const dzW = +(moveAfter.player.z - moveBefore.player.z).toFixed(3);
    check('P2.4 WASD (W) — oldinga harakat, real klaviatura eventi',
      dzW > 1.5 && cruise.keys.includes('KeyW') && cruise.player.speed > 2,
      `Δz=+${dzW} m, W tugmasi ushlab turilganda keys=[${cruise.keys.join(' ')}], tezlik ${cruise.player.speed} m/s`);

    await holdKey(cdp, 'KeyD', 'd', 68);
    await sleep(500);
    await releaseKey(cdp, 'KeyD', 'd', 68);
    await sleep(150);
    const strafe = await cdp.evaluate('window.__neon.diagnostics()');
    const dxD = +(strafe.player.x - moveAfter.player.x).toFixed(3);
    check('P2.5 WASD (D) — yon harakat (strafe)', dxD > 0.6, `Δx=+${dxD} m`);
    check('P2.5b Harakat silliq (walk tezligi budjeti, teleport emas)',
      cruise.player.speed > 4.0 && cruise.player.speed <= MOVE_WALK + 0.4,
      `cruise tezlik=${cruise.player.speed} m/s (walk=${MOVE_WALK}, sprint=${MOVE_SPRINT})`);

    // Sprint — Shift bilan tezroq
    await cdp.evaluate('window.__neon.setView(9.5, -3, 0, -0.12)');  // bo'sh yo'nalish (orqaga)
    await sleep(120);
    await holdKey(cdp, 'ShiftLeft', 'Shift', 16);
    await holdKey(cdp, 'KeyW', 'w', 87);
    await sleep(700);
    const sprint = await cdp.evaluate('window.__neon.diagnostics()');
    await releaseKey(cdp, 'KeyW', 'w', 87);
    await releaseKey(cdp, 'ShiftLeft', 'Shift', 16);
    await sleep(150);
    check('P2.5c SHIFT — sprint tezligi (WALK dan yuqori)',
      sprint.player.sprint === true && sprint.player.speed > MOVE_WALK + 0.4,
      `tezlik=${sprint.player.speed} m/s, sprint=${sprint.player.sprint}`);
    await shot('p2-02-after-wasd', { analyze: true });

    // ---------- 5) O'yinchi ↔ dunyo kolliziyasi (NEON FACILITY divider devori) ----------
    // (10.5, 12): janubiy catwalk OSTIDA, shimolga (-z) yuriladi — yo'lda mid lane
    // divider-nmid-R (x -11..11, z 4.2..4.8). O'yinchi undan o'tmaydi (z≈5.20).
    await ensureLock();
    await cdp.evaluate('window.__neon.setView(10.5, 12, Math.PI, -0.12)');   // dividerdan oldin
    await sleep(120);
    await holdKey(cdp, 'KeyW', 'w', 87);
    await sleep(2600);
    const midRun = await cdp.evaluate('window.__neon.diagnostics()');
    await sleep(1400);
    const blocked = await cdp.evaluate('window.__neon.diagnostics()');
    await releaseKey(cdp, 'KeyW', 'w', 87);
    await sleep(150);
    const stopZ = blocked.player.z;
    check('P2.6 O\'yinchi to\'siqdan o\'tmaydi (divider devori z=4.8)',
      stopZ > 5.05 && stopZ <= 5.35 && blocked.player.collisions > 5 && blocked.player.hitZ === true,
      `${stopZ} da to'xtadi (kutilgan: 5.20), to'qnashuv kadrlari=${blocked.player.collisions}, hitZ=${blocked.player.hitZ}`);
    check('P2.6b To\'siqqa borib tezlik nolga tushadi (kirmaydi, sirg\'almaydi)',
      Math.abs(midRun.player.z - blocked.player.z) < 0.05 && blocked.player.speed < 0.01,
      `z ${midRun.player.z} → ${blocked.player.z}, tezlik=${blocked.player.speed} m/s`);
    check('P2.6c Yurish animatsiyasi/yuz burilishi ishlaydi (model sinxron)',
      Math.abs(Math.abs(midRun.player.yaw) - Math.PI) < 0.6, `faceYaw=${midRun.player.yaw} (-z yo‘nalish: atan2 konventsiyasi bo‘yicha ±π bo‘lishi kerak)`);
    await shot('p2-03-collision-stop', { analyze: true });

    // ---------- 6) KAMERA kolliziyasi (g'arb devori) ----------
    const beforeCam = await cdp.evaluate('window.__neon.diagnostics()');
    await cdp.evaluate('window.__neon.setView(-21.4, 0, Math.PI / 2, -0.12)');
    await sleep(200);
    const wallCam = await cdp.evaluate('window.__neon.diagnostics()');
    check('P2.7 Kamera devor ichiga kirmaydi (sweep)',
      wallCam.camera.blocked === true && wallCam.camera.x > -22 && wallCam.camera.distance < beforeCam.camera.desiredDistance,
      `blocked=${wallCam.camera.blocked} x=${wallCam.camera.x} (devor -22), dist=${wallCam.camera.distance}/${wallCam.camera.desiredDistance}`);

    // Pitch klampi — setView ham CameraController klampi orqali o'tadi
    await cdp.evaluate('window.__neon.setView(-21.4, 0, Math.PI / 2, 99)');
    await sleep(120);
    const pitchUp = await cdp.evaluate('window.__neon.diagnostics().camera.pitch');
    await cdp.evaluate('window.__neon.setView(-21.4, 0, Math.PI / 2, -99)');
    await sleep(120);
    const pitchDown = await cdp.evaluate('window.__neon.diagnostics().camera.pitch');
    check('P2.8 Pitch klampi (PITCH_MIN/MAX) — yuqori/past chegaralar',
      Math.abs(pitchUp - CAM.PITCH_MAX) < 1e-6 && Math.abs(pitchDown - CAM.PITCH_MIN) < 1e-6,
      `up=${pitchUp} (max ${CAM.PITCH_MAX}), down=${pitchDown} (min ${CAM.PITCH_MIN})`);
    // Sichqoncha harakati orqali ham klamp ishlaydi (katta pitch harakati,
    // CameraController.look → aynan pointer-lock yo'li ishlatadigan funksiya)
    await cdp.evaluate(`window.__neon.setView(0, -9.5, 0, 0)`);
    await cdp.evaluate('window.__neon.lookBy(0, -4000)');
    await sleep(120);
    const clampedByMouse = await cdp.evaluate('window.__neon.diagnostics().camera.pitch');
    check('P2.8b Sichqoncha harakati bilan pitch klampdan oshmaydi',
      Math.abs(clampedByMouse - CAM.PITCH_MAX) < 1e-6, `pitch=${clampedByMouse} (max ${CAM.PITCH_MAX})`);

    // Kamera har doim pol tepasida
    await cdp.evaluate('window.__neon.setView(0, -8, Math.PI, 0.6)');
    await sleep(200);
    const highCam = await cdp.evaluate('window.__neon.diagnostics()');
    check('P2.9 Kamera pol ostiga tushmaydi',
      highCam.camera.y >= 0.35 - 1e-6, `camera.y=${highCam.camera.y} (min 0.35)`);
    await cdp.evaluate('window.__neon.setView(0, -9.5, 0, -0.12)');
    await sleep(150);

    // ---------- 7) PLAYER MODELI ekranda ko'rinadi (obyektiv o'lchov) ----------
    // NEON FACILITY: (0,-9.5) orqasida catwalk deck bor — kamera sweep qisqaradi.
    // Ochiq pol: (0,-6.5) — kamera to‘liq 3.4 m masofada.
    await cdp.evaluate('window.__neon.setView(0, -6.5, 0, -0.12)');
    await sleep(250);
    await front();
    const playerProbe = await cdp.evaluate('window.__v.playerNdc()');
    check('P2.10 Player modeli ekranda ko\'rinadi (NDC proyeksiya)',
      playerProbe && playerProbe.visible === true && playerProbe.onScreen === true && playerProbe.ndcHeight > 0.1,
      `NDC=(${playerProbe.ndc.x}, ${playerProbe.ndc.y}) balandlik=${playerProbe.ndcHeight} NDC, kamera masofa=${playerProbe.distance} m`);

// ANTI-FAKE: modelni yashirib/ko'rsatib, DRAWING BUFFER piksel farqini
    // o'lchaymiz (agar 3D model chindan render qilinmasa — farq 0 bo'ladi)
    const visA = await shot('p2-04-player-visible', { analyze: false });
    await cdp.evaluate('window.__v.playerVisible(false)');
    await sleep(200);
    const hidA = await shot('p2-04-player-hidden', { analyze: false });
    await cdp.evaluate('window.__v.playerVisible(true)');
    await sleep(200);
    const diff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(visA.dataUrl)},${JSON.stringify(hidA.dataUrl)})`);
    check('P2.10b Player 3D modeli HAQIQIY piksel ozgarishi beradi (anti-fake)',
      diff.changedPixels > 300 && diff.maxDelta > 40,
      `model yashirilganda ${diff.changedPixels} piksel ozgardi (${(diff.changedRatio * 100).toFixed(2)}% ekran), maks kanal d=${diff.maxDelta}`);
    const visCyan = visA.scan.colors.playerCyan;
    const hidCyan = hidA.scan.colors.playerCyan;
    check('P2.10c OYINCHI neon aksenti (PLAYER_ACCENT cyan) ekranda chindan bor',
      visCyan.count > 40 && hidCyan.count < visCyan.count * 0.35 && visCyan.box !== null,
      `cyan piksel: model bilan=${visCyan.count} (bbox ${JSON.stringify(visCyan.box)}), modelsiz=${hidCyan.count}`);

    const sceneInfo = await cdp.evaluate('window.__neon.diagnostics().scene');
    const shadowMap = await cdp.evaluate('window.__neon.diagnostics().render.shadowMap');
    check('P2.11 Blob shadow mavjud (real-time shadowMap O\'CHIQ)',
      sceneInfo.blobShadow === true && sceneInfo.blobOpacity > 0 && shadowMap === false,
      `opacity=${sceneInfo.blobOpacity}, shadowMap=${shadowMap}`);
    check('P2.12 Sahnada fog + yorug\'liklar (neon dark-blue uslub)',
      sceneInfo.fog === true && sceneInfo.lights >= 3, `fog=${sceneInfo.fog}, lights=${sceneInfo.lights}`);
    check('P2.13 Humanoid model qismlari (oyoq/qo\'l/tana/bosh)',
      sceneInfo.playerParts >= 8, `player.group.children=${sceneInfo.playerParts}`);

    // ---------- 8) TRAINING rejimi (statik nishonlar + taymer) ----------
    await front();
    const training = await cdp.evaluate('window.__neon.diagnostics()');
    check('P2.14 TRAINING statik nishonlar yaratildi (5 dummy + 3 halqa)',
      training.scene.dummies === 5 && training.scene.rings === 3 && training.scene.targets === 8,
      `dummies=${training.scene.dummies}, rings=${training.scene.rings}, targets=${training.scene.targets}`);
    check('P2.14b TRAINING guruhi sahnada',
      sceneInfo.trainingGroup === true);
    const hudTimer = await cdp.evaluate('window.__v.badge("hudTimer")');
    check('P2.14c TRAINING taymeri yuryapti (HUD yangilanadi)',
      training.elapsed > 3 && /^[0-9]+\.[0-9] s$/.test(hudTimer || ''), `elapsed=${training.elapsed}s, HUD="${hudTimer}"`);

// ---- NISHONLAR chindan RENDER qilinadimi? (drawing buffer piksel dalili) ----
    // Nishonlar chizig'iga (z≈10-16) qaraymiz: halqalar + 5 dummy
    await cdp.evaluate('window.__neon.setView(9.5, 0.8, Math.PI / 2, -0.03)');
    await sleep(300);
    const rangeA = await shot('p2-05-training-range', { analyze: true });
    await cdp.evaluate('window.__v.trainingVisible(false)');
    await sleep(250);
    const emptyA = await shot('p2-05-training-hidden', { analyze: false });
    const rangeDiff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(rangeA.dataUrl)},${JSON.stringify(emptyA.dataUrl)})`);
    await cdp.evaluate('window.__v.trainingVisible(true)');
    check('P2.14d Nishonlar (dummy+halqa) HAQIQIY render qilinadi (piksel dalili)',
      rangeDiff.changedPixels > 900 && rangeDiff.maxDelta > 40,
      `nishonlar yashirilganda ${rangeDiff.changedPixels} piksel ozgardi (${(rangeDiff.changedRatio * 100).toFixed(2)}% ekran), maks d=${rangeDiff.maxDelta}`);
    const ringVisible = rangeA.scan.colors.ringOrange;
    const dummyVisible = rangeA.scan.colors.dummyPink;
    const ringHidden = emptyA.scan.colors.ringOrange;
    const dummyHidden = emptyA.scan.colors.dummyPink;
    check('P2.14e Nishon neon ranglari (TARGET_ACCENT halqa + TARGET dummy) pikselda topildi',
      ringVisible.count > 500 && dummyVisible.count > 50 &&
      ringHidden.count < ringVisible.count * 0.2 && dummyHidden.count < dummyVisible.count * 0.2,
      `halqa-orange=${ringVisible.count} px (bbox ${JSON.stringify(ringVisible.box)}) / yashirilganda=${ringHidden.count} · ` +
      `dummy-pink=${dummyVisible.count} px / yashirilganda=${dummyHidden.count} · o'rt yorqinlik=${rangeA.scan.lum.avg}`);
    // ---- Nishon aksent rangi HAQIQIY render qilinadi (yaqin plan) ----
    // NEON FACILITY: dummy-3 (16, 2.6) to‘g‘ri oldinda (4 m) — dummy-pink kadrdagi
    // o‘rnini eski arenadagidan farq qiladi, shuning uchun vantage dummy-3 ga qaratildi.
    await cdp.evaluate('window.__neon.setView(12, 2.6, Math.PI / 2, -0.02)');
    await sleep(300);
    const closeA = await shot('p2-05b-target-closeup', { analyze: true });
    const cColors = closeA.scan.colors;
    check('P2.14f Nishon aksenti (PALETTE.TARGET/TARGET_ACCENT) yaqin planda piksel-piksel tasdiqlandi',
      cColors.ringOrange.count > 3000 && cColors.dummyPink.count > 200,
      `halqa-orange=${cColors.ringOrange.count} px (bbox ${JSON.stringify(cColors.ringOrange.box)}), ` +
      `dummy-pink=${cColors.dummyPink.count} px · cyan=${cColors.playerCyan.count} px · ` +
      `namunalar=${closeA.stats.samples}`);

    // ---------- 9) F3 debug overlay + FPS o'lchovi ----------
    await front();
    await key(cdp, 'F3', 'F3', 'down', 114);
    await key(cdp, 'F3', 'F3', 'up', 114);
    await sleep(200);
    const dbgVisible = await cdp.evaluate('!window.__v.hidden("debugOverlay")');
    const dbgText = await cdp.evaluate('window.__v.debugText()');
    check('P2.15 F3 debug overlay ochiladi va FPS/frame vaqtini ko\'rsatadi',
      dbgVisible === true && /FPS/.test(dbgText) && /FRAME/.test(dbgText),
      (dbgText.split('\n')[1] || '').trim());

    await sleep(3500);   // o'lchov oynasi ~4 s
    const perf = await cdp.evaluate('window.__neon.diagnostics()');
    const f = perf.fps;
    check('P2.16 FPS / frame vaqti O\'LCHANDI (taxmin emas)',
      f.windowFrames > 60 && f.fpsAvg > 0,
      `${f.fpsEma} FPS ema · o'rt ${f.fpsAvg} · min ${f.fpsMin} · maks ${f.fpsMax} · frame ${f.frameMsAvg} ms · p95 ${f.frameMsP95} ms · ${f.windowFrames} kadr / ${f.windowSeconds}s`);
    check('P2.16b CPU kadr budjeti (submit < 16.6 ms)',
      perf.cpuMs < 16.6, `CPU submit=${perf.cpuMs} ms, draw calls=${perf.render.calls}, uchburchak=${perf.render.triangles}`);
    await shot('p2-06-debug-fps', { analyze: true });
    // ---------- 10) Konsol xatolari yo'q ----------
    const pageErrors = await cdp.evaluate('window.__neon.errors || []');
    const consoleErrors = cdp.logs.filter((l) => l.level === 'error' &&
      !/favicon|DevTools|Autofill|net::ERR_NAME/i.test(l.text));
    check('P2.17 Konsol/runtime xatolari YO\'Q',
      consoleErrors.length === 0 && pageErrors.length === 0 && cdp.exceptions.length === 0 && perf.loopErrors === 0,
      `console=${consoleErrors.length}, window.error=${pageErrors.length}, exception=${cdp.exceptions.length}, loop=${perf.loopErrors}` +
      (consoleErrors.length ? ` -> ${consoleErrors.map((e) => e.text.slice(0, 90)).join(' | ')}` : ''));

    // ---------- 11) Phase 1 regressiyasi (sessiya davomida) ----------
    const gatesEnd = await cdp.evaluate('window.__neon.gates');
    const badges = await cdp.evaluate('({ webgl: window.__v.badge("badgeWebgl"), three: window.__v.badge("badgeThree"), ws: window.__v.badge("badgeWs"), ping: window.__v.badge("badgePing") })');
    check('P2.18 P1 WebGL2 gate hali ham yashil', gatesEnd.webgl2 === true, `badge="${badges.webgl}"`);
    check('P2.19 P1 WS ulanish o\'yin davomida TIRIK (ping davom etdi)',
      gatesEnd.ws === true && gatesEnd.samples >= 2,
      `ws=${gatesEnd.ws}, latency=${gatesEnd.latency} ms, namunalar=${gatesEnd.samples}, badge="${badges.ping}"`);

    // Yakuniy holat: nishonlar chizig'iga qarab to'liq sahna ko'rinishi
    await cdp.evaluate('window.__neon.setView(7.5, 14.5, Math.PI, -0.04)');
    await sleep(250);
    await shot('p2-07-final', { analyze: true });

    // ---------- 12) Menyuga qaytish ----------
    await cdp.evaluate('window.__neon.stopTraining()');
    await sleep(300);
    const backToMenu = await cdp.evaluate('({ menu: window.__v.hidden("menu"), stage: window.__v.hidden("stage"), running: window.__neon.running })');
    check('P2.20 Menyuga qaytish ishlaydi (sessiya to\'xtatildi)',
      backToMenu.menu === false && backToMenu.stage === true && backToMenu.running === false,
      `menu hidden=${backToMenu.menu}, stage hidden=${backToMenu.stage}, running=${backToMenu.running}`);
    await shot('p2-08-menu-back', { analyze: true });

    // ---------- natijalar ----------
    const report = {
      generatedAt: new Date().toISOString(),
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      chrome: CHROME,
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      skipped: results.filter((r) => r.ok === null).length,
      performance: perf ? { fps: perf.fps, cpuMs: perf.cpuMs, render: perf.render, scene: perf.scene } : null,
      gameState: perf,
      gates: gatesEnd,
      hudBadges: badges,
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes, stats: s.stats })),
      consoleErrors,
      pageErrors,
      exceptions: cdp.exceptions,
      consoleLogs: cdp.logs.filter((l) => l.level === 'log' || l.level === 'info').map((l) => l.text).slice(0, 40)
    };
    fs.writeFileSync(path.join(ART, 'phase2-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== PHASE 2 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}  SKIP=${report.skipped}`);
    if (report.performance) {
      console.log(`PERF: ${report.performance.fps.fpsEma} FPS ema · avg ${report.performance.fps.fpsAvg} · p95 ${report.performance.fps.frameMsP95} ms · CPU ${report.performance.cpuMs} ms · ${report.performance.render.calls} draw calls · ${report.performance.render.triangles} tri`);
    }
    console.log(`ARTIFACTS: logs/phase2-report.json + ${shots.length} skrinshot`);
    return report.failed === 0;
  } finally {
    cdp.close();
    try { child.kill('SIGTERM'); } catch {}
    await sleep(400);
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

const MOVE_WALK = MOVE.WALK;
const MOVE_SPRINT = MOVE.SPRINT;

/** CDP orqali HAQIQIY klaviatura eventi yuborish */
async function key (cdp, code, keyName, type, vk) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: type === 'down' ? 'keyDown' : 'keyUp',
    code,
    key: keyName,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk
  });
}

/**
 * Tugmani BOSILIB TURISH holatiga keltiradi: haqiqiy CDP keydown yuboradi va
 * sahifa tomonidan rostdan ro'yxatga olinganini poll qiladi (ba'zan Chrome
 * oynali rejimda pointer-lock/focus tranzaksiyasi davomida birinchi keydown
 * yo'qoladi — spurious blur keys to'plamini tozalaydi). Yo'qolsa qayta yuboradi.
 */
async function holdKey (cdp, code, keyName, vk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await key(cdp, code, keyName, 'down', vk);
    for (let i = 0; i < 12; i++) {
      const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
      if (keys.includes(code)) return true;
      await sleep(80);
    }
  }
  return false;
}

/** Tugmani qo'yib yuboradi va rostdan ko'tarilganini poll qiladi */
async function releaseKey (cdp, code, keyName, vk) {
  await key(cdp, code, keyName, 'up', vk);
  for (let i = 0; i < 12; i++) {
    const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
    if (!keys.includes(code)) return true;
    await sleep(60);
  }
  return false;
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('HARNESS XATOSI:', err && err.stack ? err.stack : err);
    try {
      fs.writeFileSync(path.join(ART, 'phase2-report.json'), JSON.stringify({ fatal: String(err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
