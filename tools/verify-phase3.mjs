#!/usr/bin/env node
// ============================================================
// NEON STRIKE — Phase 3 BROWSER verifikatsiyasi (anti-fake harness)
// NEON FACILITY mapini HAQIQIY Chrome'da tekshiradi:
//   map render (piksel dalil) · spawn A/B · harakat · gravitatsiya ·
//   zinapoya/step-up · catwalk (deck + OSTI) · kolliziya · 3 lane ·
//   reaktor platformasi · FPS · draw calls · console/network xatolar
// O'z serverini ephemeral portda o'zi ishga tushiradi (tashqi bog'liqlik yo'q).
// Ishga tushirish:  node tools/verify-phase3.mjs            (real oyna)
//                   node tools/verify-phase3.mjs --headless (CI uchun)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { SPAWNS, MAP } from '../shared/map.js';
import { MOVE } from '../shared/collision.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9344);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon3-chrome-'));
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
    if (/error|fail/i.test(s) && !/GPU|dbus|Fontconfig|gbm|vaapi|IsSandboxed/i.test(s)) {
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

// ---------------- CDP klaviatura yordamchilari ----------------
async function key (cdp, code, keyName, type, vk) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: type === 'down' ? 'keyDown' : 'keyUp',
    code, key: keyName,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
  });
}

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

async function releaseKey (cdp, code, keyName, vk) {
  await key(cdp, code, keyName, 'up', vk);
  for (let i = 0; i < 12; i++) {
    const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
    if (!keys.includes(code)) return true;
    await sleep(60);
  }
  return false;
}    const WALK = MOVE.WALK;

// ---------------- asosiy oqim ----------------
async function main () {
  // 0) O'z serverimiz — ephemeral port (tashqi holatga bog'liq emas)
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
  const shot = async (name) => {
    const dataUrl = await cdp.evaluate('window.__neon.captureFrame()');
    const b64 = dataUrl.split(',')[1];
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    const entry = { name, file, bytes: Buffer.from(b64, 'base64').length, source: 'drawing-buffer' };
    shots.push(entry);
    return { dataUrl, bytes: entry.bytes };
  };

  try {
    // ---------- 1) sahifa tayyor + modul yuklandi ----------
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
    await cdp.evaluate(HELPERS);
    check('P3.1 WebGL2 real GPU', ready.gates?.webgl2 === true, `renderer="${(ready.gates?.renderer || '').slice(0, 70)}"`);
    check('P3.2 Game moduli (map + mapview) yuklandi', ready.loaded === true && ready.ready === true);
    check('P3.3 WS ulanish tirik (network xato yo‘q)', ready.gates?.ws === true, `protocol=v${ready.gates?.protocol}`);

    // ---------- 2) TRAINING real klik bilan ----------
    const btn = await cdp.evaluate('window.__v.rect("btnTraining")');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
    await sleep(1200);
    const started = await cdp.evaluate('({ menu: window.__v.hidden("menu"), running: window.__neon.running })');
    check('P3.4 TRAINING haqiqiy klik bilan boshlandi', started.menu === true && started.running === true);

    // Pointer lock kafolati (keyingi WASD testlari uchun)
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
    await ensureLock();

    /** Yurish bo'limini ishonchli bajaradi: har urinishda lock kafolatlanadi,
     *  'until' sharti bajarilmagicha poll qilinadi, bo'lmasa qayta uriniladi
     *  (desktop fokus o'g'irlashi CDP keydown'ni yo'qotishi mumkin). */
    const walkUntil = async ({ view, keyDef = ['KeyW', 'w', 87], until, maxMs = 3000, tries = 3 }) => {
      let last = null;
      for (let t = 0; t < tries; t++) {
        await ensureLock();
        await cdp.evaluate(view);
        await sleep(150);
        await holdKey(cdp, keyDef[0], keyDef[1], keyDef[2]);
        const t0 = Date.now();
        while (Date.now() - t0 < maxMs) {
          await sleep(150);
          last = await cdp.evaluate('window.__neon.diagnostics()');
          if (until(last)) break;
        }
        await releaseKey(cdp, keyDef[0], keyDef[1], keyDef[2]);
        await sleep(200);
        if (last && until(last)) return last;
      }
      return last;
    };

    // ---------- 3) MAP identifikasi + budjetlar ----------
    const d0 = await cdp.evaluate('window.__neon.diagnostics()');
    check('P3.5 NEON FACILITY map sahna bolasi va KO‘RINADI',
      d0.scene.map === 'NEON FACILITY' && d0.scene.mapVisible === true,
      `map=${d0.scene.map}, mapStats=${JSON.stringify(d0.scene.mapStats)}`);
    check('P3.6 Kollayder budjeti ≤120 (real sahnadan)',
      d0.scene.props <= 120, `colliders=${d0.scene.props}`);
    check('P3.7 Map o‘lchami 44×32 m', MAP.WIDTH === 44 && MAP.DEPTH === 32 && d0.scene.map === 'NEON FACILITY');

    // ---------- 4) MAP HAQIQIY render (anti-fake piksel dalil) ----------
    await cdp.evaluate('window.__neon.setView(-19.5, 0, 0, -0.05)');
    await sleep(300);
    const mapOn = await shot('p3-01-map-on');
    await cdp.evaluate('window.__neon.setMapVisible(false)');
    await sleep(250);
    const mapOff = await shot('p3-02-map-off');
    const mapDiff = await cdp.evaluate(
      `window.__v.diff(${JSON.stringify(mapOn.dataUrl)},${JSON.stringify(mapOff.dataUrl)})`);
    await cdp.evaluate('window.__neon.setMapVisible(true)');
    check('P3.8 Map HAQIQIY render qilinadi (yashirilganda kadrlar farq qiladi)',
      mapDiff.changedPixels > 5000 && mapDiff.maxDelta > 40,
      `${mapDiff.changedPixels} piksel o‘zgardi (${(mapDiff.changedRatio * 100).toFixed(1)}% ekran), maks d=${mapDiff.maxDelta}`);
    const mapScan = await cdp.evaluate(`window.__v.sceneScan(${JSON.stringify(mapOn.dataUrl)})`);
    check('P3.9 Map neon palitrasi ekranda (floorBlue + cyan trim)',
      mapScan.colors.floorBlue.count > 2000 && mapScan.colors.playerCyan.count > 100,
      `floorBlue=${mapScan.colors.floorBlue.count}px, cyan=${mapScan.colors.playerCyan.count}px`);

    // ---------- 5) SPAWN A / SPAWN B yaroqliligi ----------
    const spawnA = await cdp.evaluate(`window.__neon.setView(${SPAWNS.A.x}, ${SPAWNS.A.z}, 0, -0.05)`);
    check('P3.10 SPAWN A (g‘arb) — pol ustida, model ko‘rinadi',
      Math.abs(spawnA.player.y - MAP.FLOOR_Y) < 0.05 && spawnA.player.x === SPAWNS.A.x);
    await cdp.evaluate(`window.__neon.setView(${SPAWNS.B.x}, ${SPAWNS.B.z}, Math.PI, -0.05)`);
    await sleep(150);
    const spawnB = await cdp.evaluate('window.__neon.diagnostics()');
    check('P3.11 SPAWN B (sharq) — pol ustida, to‘siq yo‘q',
      Math.abs(spawnB.player.y - MAP.FLOOR_Y) < 0.05 && spawnB.player.collisions === 0,
      `y=${spawnB.player.y}, to‘qnashuv=${spawnB.player.collisions}`);

    // ---------- 6) HARAKAT (WASD real klaviatura) — focus o‘g‘irlashiga qarshi retry ----------
    let moveOk = false;
    let moveDetail = '';
    let dx = 0;
    for (let attempt = 0; attempt < 3 && !moveOk; attempt++) {
      await ensureLock();
      await cdp.evaluate('window.__neon.setView(-19.5, 0, Math.PI / 2, -0.05, 0)');
      await sleep(150);
      const mBefore = await cdp.evaluate('window.__neon.diagnostics()');
      await holdKey(cdp, 'KeyW', 'w', 87);
      let cruiseSpeed = 0;
      let keysHeld = false;
      for (let i = 0; i < 8; i++) {
        await sleep(150);
        const d = await cdp.evaluate('window.__neon.diagnostics()');
        if (d.player.speed > cruiseSpeed) cruiseSpeed = d.player.speed;
        if (d.keys.includes('KeyW')) keysHeld = true;
        if (cruiseSpeed > 4 && i >= 3) break;
      }
      await releaseKey(cdp, 'KeyW', 'w', 87);
      await sleep(150);
      const mAfter = await cdp.evaluate('window.__neon.diagnostics()');
      dx = +(mAfter.player.x - mBefore.player.x).toFixed(2);
      moveOk = dx > 1.5 && cruiseSpeed > 3 && cruiseSpeed <= WALK + 0.5 && keysHeld;
      moveDetail = `Δx=+${dx} m, maks tezlik=${cruiseSpeed.toFixed(2)} m/s (walk=${WALK}), W ushlangan=${keysHeld}, urinish=${attempt + 1}`;
    }
    check('P3.12 WASD (W) harakati + walk tezligi (teleport emas)', moveOk, moveDetail);

    // ---------- 7) REAKTOR ZINASI: step-up bilan platformaga chiqish ----------
    const onPlat = await walkUntil({
      view: 'window.__neon.setView(-8.5, 0, Math.PI / 2, -0.05, 0)',
      until: (d) => d.player.y > 1.15 && d.player.y < 1.25 && Math.abs(d.player.x) < 4.6,
      maxMs: 3000
    });
    check('P3.13 ZINAPYA (step-up ≤0.55) — reaktor platformasiga chiqildi (y=1.2)',
      onPlat && onPlat.player.y > 1.15 && Math.abs(onPlat.player.x) < 4.6,
      onPlat ? `y=${onPlat.player.y}, x=${onPlat.player.x} (platforma x[-4.5,4.5] y=1.2)` : 'yurish natijasi yo‘q');

    // ---------- 8) GRAVITATSIYA: platformadan tushish (sharq chetidan, MID lane poliga) ----------
    await cdp.evaluate('window.__neon.setView(3.8, 0, Math.PI / 2, -0.1, 1.2)');
    await sleep(120);
    const beforeFall = await cdp.evaluate('window.__neon.diagnostics()');
    check('P3.14a Platforma chetida yuqorida turadi (y=1.2, yurish oldi)',
      Math.abs(beforeFall.player.y - 1.2) < 0.08, `y=${beforeFall.player.y}`);
    const afterFall = await walkUntil({
      view: 'window.__neon.setView(3.8, 0, Math.PI / 2, -0.1, 1.2)',
      until: (d) => d.player.y < 0.05,
      maxMs: 3000
    });
    check('P3.14 GRAVITATSIYA — platformadan tushib polga qo‘ndi (y→0)',
      beforeFall.player.y > 1.0 && afterFall && Math.abs(afterFall.player.y) < 0.05,
      `y ${beforeFall.player.y} → ${afterFall ? afterFall.player.y : 'yo‘q'}`);

    // ---------- 9) CATWALK: zina bilan deck (y=2.2) + OSTIDA yurish ----------
    const onDeck = await walkUntil({
      view: 'window.__neon.setView(-17.2, -12, Math.PI / 2, -0.02, 0)',
      until: (d) => d.player.y > 2.15 && d.player.y < 2.25 && Math.abs(d.player.z + 12) < 1.6,
      maxMs: 3500
    });
    check('P3.15 CATWALK zinasi bilan deck ustiga chiqildi (y=2.2)',
      onDeck && onDeck.player.y > 2.15,
      onDeck ? `y=${onDeck.player.y}, x=${onDeck.player.x} (deck x[-14,14] y=2.2)` : 'yurish natijasi yo‘q');
    const under1 = await cdp.evaluate('window.__neon.setView(-10.5, -11, Math.PI / 2, -0.02, 0)');
    const under2 = await walkUntil({
      view: 'window.__neon.setView(-10.5, -11, Math.PI / 2, -0.02, 0)',
      until: (d) => d.player.x > -7.4 && !d.player.hitX && d.player.y < 0.05,
      maxMs: 2500
    });
    check('P3.16 CATWALK OSTIDAN yurib bo‘ladi (LONG koridor, y=0, to‘siq yo‘q)',
      under1.player.y < 0.05 && under2 && under2.player.x > -7.4 && under2.player.hitX === false,
      `x ${under1.player.x} → ${under2 ? under2.player.x : 'yo‘q'}, hitX=${under2 ? under2.player.hitX : '-'}`);

    // ---------- 10) KOLLIZIYA: reaktor o‘zagi va divider ----------
    const coreStop = await walkUntil({
      view: 'window.__neon.setView(-2.9, 0, Math.PI / 2, -0.05, 1.2)',
      until: (d) => d.player.hitX === true && d.player.x < -1.45,
      maxMs: 2500
    });
    check('P3.17 REAKTOR o‘zagiga kirib bo‘lmaydi (kolliziya)',
      coreStop && coreStop.player.hitX === true && coreStop.player.x < -1.45,
      coreStop ? `x=${coreStop.player.x}, hitX=${coreStop.player.hitX} (o‘zak x[-1.1,1.1], radius 0.4)` : 'yurish natijasi yo‘q');

    // ---------- 11) 3 LANE navigatsiya (har biri ichida yurish) ----------
    const lanes = await cdp.evaluate(`(async function () {
      const out = [];
      const walk = async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      };
      // MID lane: g‘arb tomondan markazga qarab (z=0, pol)
      window.__neon.setView(-17, 0, Math.PI / 2, -0.05, 0);
      await walk(100);
      out.push({ lane: 'mid', from: window.__neon.diagnostics().player });
      // LONG koridor (deck osti, z=-11 — pillar/krat chiziqlaridan toza)
      window.__neon.setView(-8, -11, Math.PI / 2, -0.02, 0);
      await walk(100);
      out.push({ lane: 'long', from: window.__neon.diagnostics().player });
      // CATWALK lane (deck ustida, y=2.2)
      window.__neon.setView(-13, -12, 0, -0.02, 2.2);
      await walk(100);
      out.push({ lane: 'catwalk', from: window.__neon.diagnostics().player });
      return out;
    })()`);
    const midOk = lanes.find((l) => l.lane === 'mid');
    const longOk = lanes.find((l) => l.lane === 'long');
    const catOk = lanes.find((l) => l.lane === 'catwalk');
    check('P3.18 3 LANE ham ochiq (MID + LONG + CATWALK pozitsiyalari yaroqli)',
      Math.abs(midOk.from.y - 0) < 0.05 && Math.abs(longOk.from.y - 0) < 0.05 &&
      Math.abs(catOk.from.y - 2.2) < 0.05 && Math.abs(midOk.from.z) < 4.3 && Math.abs(longOk.from.z + 12) < 2.1,
      `mid y=${midOk.from.y} z=${midOk.from.z}, long y=${longOk.from.y}, catwalk y=${catOk.from.y}`);

    // ---------- 12) REAKTOR PLATFORMASI yetib boriladi (zinadan, real yurish) ----------
    check('P3.19 REACTOR platformasi zinadan real yurib olingan (P3.13 y=1.2 dalili)',
      onPlat.player.y > 1.15 && Math.abs(onPlat.player.x) < 4.6,
      `oxirgi platforma holati: y=${onPlat.player.y}, x=${onPlat.player.x}`);

    // ---------- 13) PERF: FPS + draw calls ----------
    await ensureLock();
    await cdp.evaluate('window.__neon.setView(-19.5, 0, Math.PI / 2, -0.05, 0)');
    await sleep(3500);   // o'lchov oynasi
    const perf = await cdp.evaluate('window.__neon.diagnostics()');
    const f = perf.fps;
    check('P3.20 FPS o‘lchandi va o‘ynashga yetarli (≥30 FPS o‘rt)',
      f.windowFrames > 60 && f.fpsAvg >= 30,
      `${f.fpsEma} FPS ema · o‘rt ${f.fpsAvg} · min ${f.fpsMin} · frame ${f.frameMsAvg} ms · p95 ${f.frameMsP95} ms · ${f.windowFrames} kadr`);
    check('P3.21 CPU kadr budjeti (submit < 16.6 ms)',
      perf.cpuMs < 16.6, `CPU=${perf.cpuMs} ms, draw calls=${perf.render.calls}, tri=${perf.render.triangles}`);
    check('P3.22 Map draw-call budjeti: mapa meshlari ≤40 (InstancedMesh bilan)',
      perf.scene.mapStats.meshes <= 40,
      `map meshlar=${perf.scene.mapStats.meshes} (instanced=${perf.scene.mapStats.instanced}), sahna jami draw calls=${perf.render.calls}`);
    check('P3.23 Real-time shadow O‘CHIQ (blob shadow rejimi)',
      perf.render.shadowMap === false && perf.scene.blobShadow === true);

    await shot('p3-03-final');

    // ---------- 14) Console/runtime xatolari ----------
    const pageErrors = await cdp.evaluate('window.__neon.errors || []');
    const consoleErrors = cdp.logs.filter((l) => l.level === 'error' &&
      !/favicon|DevTools|Autofill|net::ERR_NAME/i.test(l.text));
    check('P3.24 Konsol/runtime xatolari YO‘Q',
      consoleErrors.length === 0 && pageErrors.length === 0 && cdp.exceptions.length === 0 && perf.loopErrors === 0,
      `console=${consoleErrors.length}, window.error=${pageErrors.length}, exception=${cdp.exceptions.length}, loop=${perf.loopErrors}` +
      (consoleErrors.length ? ` -> ${consoleErrors.map((e) => e.text.slice(0, 90)).join(' | ')}` : ''));

    // ---------- hisobot ----------
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 3,
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      map: {
        name: MAP.NAME, width: MAP.WIDTH, depth: MAP.DEPTH,
        colliders: perf.scene.props, mapStats: perf.scene.mapStats
      },
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      performance: { fps: perf.fps, cpuMs: perf.cpuMs, render: perf.render, scene: perf.scene },
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes })),
      consoleErrors, pageErrors, exceptions: cdp.exceptions
    };
    fs.writeFileSync(path.join(ART, 'phase3-report.json'), JSON.stringify(report, null, 2));
    console.log('\n=== PHASE 3 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    if (report.performance) {
      console.log(`PERF: ${report.performance.fps.fpsEma} FPS ema · avg ${report.performance.fps.fpsAvg} · CPU ${report.performance.cpuMs} ms · ${report.performance.render.calls} draw calls · ${report.performance.render.triangles} tri`);
      console.log(`MAP: ${report.map.name} ${report.map.width}x${report.map.depth} m · ${report.map.colliders} kollayder · ${report.map.mapStats.meshes} mesh · ${report.map.mapStats.instanced} instanced`);
    }
    console.log(`ARTIFACTS: logs/phase3-report.json + ${shots.length} skrinshot`);
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
      fs.writeFileSync(path.join(ART, 'phase3-report.json'), JSON.stringify({ fatal: String(err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
