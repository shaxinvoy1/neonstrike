#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 7 KO'P O'YINCHILI SINXRONIZATSIYA verifikatsiyasi
// (anti-fake: HAQIQIY Chrome + HAQIQIY server + IKKI MUSTAQIL KLIENT)
//
// Dalil manbalari (dalil DOM matni EMAS):
//   1) SERVER XOTIRASI — harness serverni o'zi ishga tushiradi, shu sababli
//      `server.state.sessions` ni TO'G'RIDAN-TO'G'RI o'qiydi (klient da'vosi
//      emas). Har bir pozitsiya/tick/ack server xotirasidan olinadi.
//   2) IKKI MUSTAQIL SAHIFA — bitta Chrome'da ikki alohida page target:
//      alohida WebSocket, alohida window.__neon, alohida o'yin tsikli.
//      Bitta sahifada "ikkinchi klient" SIMULYATSIYA QILINMAYDI.
//   3) XOM WS KLIENTLAR — join-in-progress/disconnect/forged sinovlari uchun
//      haqiqiy ulanishlar (ular ham server tomonida haqiqiy o'yinchi).
//   4) KLIENT TOMONI — masofaviy o'yinchilar/interpolatsiya/rekonsiliatsiya
//      faqat window.__neon.multiplayerQa() (haqiqiy ishlab chiqarish holati)
//      orqali o'qiladi.
//
// Ishga tushirish:  node tools/verify-phase7.mjs            (real oyna · real GPU)
//                   node tools/verify-phase7.mjs --headless (P7.1 — SwiftShader)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM } from '../shared/protocol-consts.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9381);
const HEADLESS = process.argv.includes('--headless') || process.env.NEON_HEADLESS === '1';
const ART = path.resolve('logs');
fs.mkdirSync(ART, { recursive: true });

const UNIT_FILES = [
  'test/unit/smoke.test.js', 'test/unit/collision.test.js', 'test/unit/map.test.js',
  'test/unit/weapons.test.js', 'test/unit/combat.test.js', 'test/unit/grenade.test.js',
  'test/unit/server-authority.test.js', 'test/unit/lobby.test.js',
  'test/unit/multiplayer.test.js'
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

/** Xom WS klient (haqiqiy ulanish — join-in-progress/disconnect/forged) */
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon7-chrome-'));
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--disable-search-engine-choice-screen', '--disable-translate',
    // fon/vochered tab'larda rAF va taymerlar to'xtamasin (ikki klient birga yurishi shart)
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
  // sahifa "fokusda" deb hisoblasin → fon tab bo'lsa ham o'yin tsikli ishlaydi
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  return cdp;
}

const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

/**
 * In-page prob: YANGI haqiqiy WebSocket ochib, hello → session, so'ng
 * berilgan xabarlarni yuboradi va javoblarni yig'adi. Server javoblarini
 * klientning o'z tarmog'i orqali ko'rish uchun (mock EMAS).
 */
const P7_PROBE = `
window.__p7probe = function (msgs, waitMs) {
  return new Promise(function (resolve) {
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    var ws = new WebSocket(url);
    var out = [];
    var sent = false;
    var t = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      resolve({ ok: true, out: out });
    }, waitMs);
    ws.onopen = function () { ws.send(JSON.stringify({ type: 'hello', name: 'p7-probe' })); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { out.push({ type: 'raw', text: String(ev.data).slice(0, 90) }); return; }
      out.push(m);
      if (m.type === 'session' && !sent) {
        sent = true;
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
  const sessById = (id) => server.state.sessions.get(id);
  const lobbySess = () => server.state.lobby.session;

  const { child, profile } = await launchChrome(BASE);
  const first = await waitForPageTarget(BASE);
  const A = await prepare(await new CDP(first.webSocketDebuggerUrl).open());
  const Bpage = await newPage(BASE);
  const B = Bpage.cdp;

  const shots = [];
  const saveShot = async (cdp, name) => {
    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(ART, name + '.png');
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      shots.push({ name, file, bytes: Buffer.from(r.data, 'base64').length });
      return true;
    } catch { return false; }
  };

  let Cpage = null;
  let C = null;
  const rawClients = [];
  let clickLastRect = null;

  /** Sahifa tayyor (WebGL2 + __neon + Phase 7 API) */
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
            authority: window.__neon ? window.__neon.serverAuthority : null,
            lobbyApi: window.__neon ? window.__neon.lobby : null,
            multiplayerApi: window.__neon ? window.__neon.multiplayer : null,
            hasMpQa: !!(window.__neon && typeof window.__neon.multiplayerQa === 'function'),
            hasSnapshots: !!(window.__neon && typeof window.__neon.serverSnapshots === 'function'),
            gates: window.__neon ? window.__neon.gates : null
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) { ready = { error: String(e.message), loading: true }; }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('sahifa tayyor emas: ' + JSON.stringify(ready));
    await cdp.evaluate(HELPERS);
    await cdp.evaluate(P7_PROBE);
    return ready;
  };

  const front = async (cdp) => { try { await cdp.send('Page.bringToFront'); } catch {} await sleep(200); };

  /** HAQIQIY DOM klik (koordinata bo'yicha; fon tab'da ishlamaydi → oldinga olamiz) */
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
        clickLastRect = info;
        return true;
      }
      await sleep(100);
    }
    clickLastRect = null;
    return false;
  };

  /** HAQIQIY klaviatura (CDP) — ushlab turish; input manager Set ga tushganini tekshiradi */
  const holdKey = async (cdp, code, keyName, vk) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
      });
      for (let i = 0; i < 10; i++) {
        try {
          const keys = await cdp.evaluate('window.__neon.diagnostics().keys');
          if (Array.isArray(keys) && keys.includes(code)) return true;
        } catch {}
        await sleep(70);
      }
    }
    return false;
  };
  const releaseKey = async (cdp, code, keyName, vk) => {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk
    });
  };

  const mpQa = (cdp) => cdp.evaluate('window.__neon.multiplayerQa()');
  const serverSnaps = (cdp) => cdp.evaluate('window.__neon.serverSnapshots()');
  const frames = async (cdp) => {
    const d = await cdp.evaluate('window.__neon.diagnostics()');
    return d && d.fps && typeof d.fps.frames === 'number' ? d.fps.frames : -1;
  };
  const consoleErrors = (cdp) => (cdp.logs || []).filter((l) =>
    l.level === 'error' && !/favicon|Failed to load resource|net::ERR/i.test(l.text || ''));

  /** Server xotirasi bo'yicha kutish */
  const waitServer = async (pred, tries = 80, ms = 100) => {
    for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms); }
    return pred();
  };
  /** Klient holatini kutish */
  const waitClient = async (cdp, expr, pred, tries = 60) => {
    let v = null;
    for (let i = 0; i < tries; i++) {
      try { v = await cdp.evaluate(expr); } catch { v = null; }
      if (v && pred(v)) return v;
      await sleep(120);
    }
    return v;
  };
  /** raw klientda YANGI snapshotni kutish (navbatdagi eskisini emas) */
  const rawFreshSnap = async (rc, pred, tries = 60) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      try { last = await rc.next(MSG.SNAPSHOT, 2500); } catch { return last; }
      if (pred(last)) return last;
    }
    return last;
  };

  try {
    // ================= TAYYORGARLIK =================
    const readyA = await waitReady(A);
    const readyB = await waitReady(B);

    // ---------- P7.1 server + simulyatsiya ----------
    const tel0 = server.telemetry();
    check('P7.1 server ishga tushdi (30 Hz tick · 20 Hz snapshot · protokol v' + PROTOCOL_VERSION + ')',
      tel0.tickHz === SIM.TICK_HZ && tel0.snapshotHz === SIM.SNAPSHOT_HZ &&
      tel0.protocol === PROTOCOL_VERSION && server.state.connections.size >= 2,
      `tickHz=${tel0.tickHz} snapshotHz=${tel0.snapshotHz} protocol=v${tel0.protocol} ulanish=${server.state.connections.size}`);

    // ---------- P7.2 Phase 1–6 unit to'plamlari (HAQIQIY subprocess) ----------
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
    check('P7.2 Phase 1–6 unit to‘plamlari (npm test ekvivalenti) hali ham PASS',
      unit.code === 0 && uFail === '0' && Number(uPass) === Number(uTests),
      `tests=${uTests} pass=${uPass} fail=${uFail} exit=${unit.code}`);

    // ---------- P7.3 ikki mustaqil klient ----------
    let gatesA = null; let gatesB = null;
    for (let i = 0; i < 60; i++) {
      gatesA = await A.evaluate('window.__neon.gates');
      gatesB = await B.evaluate('window.__neon.gates');
      if (gatesA && gatesA.ws && gatesB && gatesB.ws) break;
      await sleep(200);
    }
    const renderer = readyA.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software/i.test(renderer);
    check('P7.3 ikki mustaqil klient tarmoqqa ulandi (2 × alohida sahifa + alohida WS)',
      gatesA?.ws === true && gatesB?.ws === true && server.state.connections.size >= 2,
      `A ws=${gatesA?.ws} B ws=${gatesB?.ws} · serverda=${server.state.connections.size} · GPU="${renderer.slice(0, 70)}"${software ? ' [SOFTWARE!]' : ''}`);

    // ---------- P7.4 server bergan playerId ----------
    const idA = await A.evaluate('window.__neon.lobbyPlayerId()');
    const idB = await B.evaluate('window.__neon.lobbyPlayerId()');
    check('P7.4 server HAR BIR klientga alohida playerId berdi',
      typeof idA === 'string' && typeof idB === 'string' && idA !== idB,
      `A=${idA} B=${idB}`);

    // ---------- host / join (real klik) ----------
    const hostClicked = await clickBtn(A, 'btnHost');
    const joinedA = await waitServer(() => lobbySess() && lobbySess().players.length === 1);
    const joinClicked = await clickBtn(B, 'btnJoin');
    const joinedB = await waitServer(() => lobbySess() && lobbySess().players.length === 2);

    // ---------- P7.5 bir sessiyada ----------
    const ids = lobbySess() ? lobbySess().players.map((p) => p.id) : [];
    check('P7.5 ikki klient BITTA LAN sessiyada (server xotirasida)',
      hostClicked && joinClicked && joinedA && joinedB && ids.length === 2 &&
      ids.includes(idA) && ids.includes(idB),
      `sessiya=${lobbySess() ? lobbySess().id : '—'} a’zolar=[${ids.join(',')}]`);

    // ---------- P7.6 host start (real klik) ----------
    const startClicked = await clickBtn(A, 'btnLobbyStart');
    const inGame = await waitServer(() => lobbySess() && lobbySess().state === 'in_game');
    check('P7.6 host REAL DOM klik bilan sessiyani boshladi (lobby → in_game)',
      startClicked && inGame,
      `state=${lobbySess() ? lobbySess().state : '—'} startedAt=${lobbySess() ? lobbySess().startedAt : 0}`);

    // ---------- P7.7 server avtoritativ harakatni yoqdi ----------
    const sA = await waitServer(() => {
      const x = sessions().find((s) => s.playerId === idA);
      const y = sessions().find((s) => s.playerId === idB);
      return !!(x && y && x.authoritativeMovement && y.authoritativeMovement);
    });
    const sessA = sessions().find((s) => s.playerId === idA);
    const sessB = sessions().find((s) => s.playerId === idB);
    check('P7.7 server holati in_game + ikki sessiyada avtoritativ harakat YOQILDI (server qarori)',
      sA && sessA && sessB && sessA.authoritativeMovement === true && sessB.authoritativeMovement === true,
      `A.sess=${sessA ? sessA.id : '—'} B.sess=${sessB ? sessB.id : '—'} sync.mode=${server.telemetry().sync.mode}`);

    // ---------- o'yin tsikli: in_game boshlangach klient o'zi kiradi ----------
    // (renderLobby: state === in_game → startSession() — bu HAQIQIY ishlab
    //  chiqarish yo'li; host start ni P7.6 real DOM klik bilan isbotladi)
    const runningA = await waitClient(A, 'window.__neon.running', (v) => v === true);
    const runningB = await waitClient(B, 'window.__neon.running', (v) => v === true);
    check('P7.7b ikkala klientda o‘yin tsikli ishga tushdi (in_game → avtomatik start)',
      runningA === true && runningB === true,
      `A running=${runningA} B running=${runningB} · trigger=server lobby-state in_game`);

    // ---------- render tsikllari fon tab'da ham yuradi (anti-throttle) ----------
    const fA0 = await frames(A); const fB0 = await frames(B);
    await sleep(1200);
    const fA1 = await frames(A); const fB1 = await frames(B);
    const loopsAdvance = (fA1 - fA0) > 5 && (fB1 - fB0) > 5;
    check('P7.3b ikkala sahifaning render tsikli BIR VAQTDA yuradi (fon tab throttle EMAS)',
      loopsAdvance,
      `A +${fA1 - fA0} kadr · B +${fB1 - fB0} kadr (~1.2 s) · ikkalasi ham > 5`);

    // ================= A HARAKATI → B KO'RADI =================
    const posA0 = { ...sessA.state.position };
    const posB0 = { ...sessB.state.position };

    // B oldinda (u kuzatuvchi), tugmalar A sahifasiga yuboriladi
    await front(B);
    const keyWA = await holdKey(A, 'KeyW', 'w', 87);
    await sleep(1700);
    const duringA = await mpQa(B);
    const seqA1 = (await mpQa(A))?.local?.seq ?? 0;
    const snapsB = await serverSnaps(B);
    await releaseKey(A, 'KeyW', 'w', 87);
    await sleep(250);

    // ---------- P7.8 A harakat kiritmasini yubordi ----------
    check('P7.8 A HAQIQIY klaviatura (W) orqali harakat kiritmasini yubordi',
      keyWA === true && seqA1 > 0,
      `klaviatura ushlandi=${keyWA} · A yuborgan seq=${seqA1} · serverga yetgan lastSeq=${sessA.lastSeq}`);

    // ---------- P7.9 server A ning kiritmasini qayta ishladi ----------
    check('P7.9 SERVER A ning kiritmasini qayta ishladi (o‘zi simulyatsiya qildi)',
      sessA.counters.accepted > 0 && sessA.lastSeq >= 1 && sessA.counters.movedTicks > 0,
      `qabul=${sessA.counters.accepted} rad=${sessA.counters.rejected} · lastSeq=${sessA.lastSeq} · harakat ticklari=${sessA.counters.movedTicks}`);

    // ---------- P7.10 server A ning avtoritar pozitsiyasini o'zgartirdi ----------
    const movedA = Math.hypot(sessA.state.position.x - posA0.x, sessA.state.position.z - posA0.z);
    const movedBserver = Math.hypot(sessB.state.position.x - posB0.x, sessB.state.position.z - posB0.z);
    check('P7.10 SERVER avtoritar pozitsiyasi A uchun o‘zgardi (faqat A; B joyida qoldi)',
      movedA > 1 && movedBserver < 0.05,
      `A siljish=${movedA.toFixed(2)} m · B siljish=${movedBserver.toFixed(3)} m · movedTicks=${sessA.counters.movedTicks}`);

    // ---------- P7.11 B A ning avtoritar holatini oldi (snapshot) ----------
    const remoteAinB = (duringA?.remotes || []).find((r) => r.id === idA);
    const snapLagsA = Math.hypot((remoteAinB?.x ?? 1e9) - sessA.state.position.x,
      (remoteAinB?.z ?? 1e9) - sessA.state.position.z);
    check('P7.11b B A ning avtoritar holatini SNAPSHOT orqali oldi (server qiymatiga mos)',
      !!remoteAinB && snapLagsA < 1.5,
      remoteAinB
        ? `B ko‘rgan A=(${remoteAinB.x.toFixed(2)},${remoteAinB.z.toFixed(2)}) server=(${sessA.state.position.x.toFixed(2)},${sessA.state.position.z.toFixed(2)}) farq=${snapLagsA.toFixed(2)} m`
        : 'B da masofaviy A YO‘Q');

    // ---------- P7.13 B masofaviy A ni KO'RSATDI ----------
    const bShot = await saveShot(B, 'p7-12-remote-A-in-B');
    check('P7.12 B masofaviy A ni RENDER qildi (mesh faol + skrinshot)',
      remoteAinB?.visible === true && bShot,
      `visible=${remoteAinB?.visible} · buffer=${remoteAinB?.buffer} snapshot · skrinshot=${bShot}`);

    // ================= B HARAKATI → A KO'RADI =================
    await front(A);
    const keyDB = await holdKey(B, 'KeyD', 'd', 68);
    await sleep(1700);
    const duringB = await mpQa(A);
    const snapsA = await serverSnaps(A);
    await releaseKey(B, 'KeyD', 'd', 68);
    await sleep(250);

    // ---------- P7.13 B harakat kiritmasini yubordi ----------
    check('P7.13 B HAQIQIY klaviatura (D) orqali harakat kiritmasini yubordi',
      keyDB === true && sessB.counters.accepted > 0 && sessB.lastSeq >= 1,
      `klaviatura ushlandi=${keyDB} · server qabul qilgan buyruq=${sessB.counters.accepted} · lastSeq=${sessB.lastSeq}`);

    const movedB2 = Math.hypot(sessB.state.position.x - posB0.x, sessB.state.position.z - posB0.z);
    const remoteBinA = (duringB?.remotes || []).find((r) => r.id === idB);
    const snapLagB = Math.hypot((remoteBinA?.x ?? 1e9) - sessB.state.position.x,
      (remoteBinA?.z ?? 1e9) - sessB.state.position.z);
    check('P7.14 A B ning avtoritar holatini oldi (B server tomonda harakatlandi)',
      movedB2 > 1 && !!remoteBinA && snapLagB < 1.5,
      remoteBinA
        ? `B siljish=${movedB2.toFixed(2)} m · A ko‘rgan B=(${remoteBinA.x.toFixed(2)},${remoteBinA.z.toFixed(2)}) server=(${sessB.state.position.x.toFixed(2)},${sessB.state.position.z.toFixed(2)}) farq=${snapLagB.toFixed(2)} m`
        : `B siljish=${movedB2.toFixed(2)} m · A da masofaviy B YO‘Q`);

    const aShot = await saveShot(A, 'p7-15-remote-B-in-A');
    check('P7.15 A masofaviy B ni RENDER qildi (mesh faol + skrinshot)',
      remoteBinA?.visible === true && aShot,
      `visible=${remoteBinA?.visible} · buffer=${remoteBinA?.buffer} snapshot · skrinshot=${aShot}`);

    // ---------- P7.16 snapshot server tick ----------
    const tickOk = (snapsA?.serverTick > 0) && (snapsB?.serverTick > 0) &&
      Number.isFinite(server.telemetry().tick) && server.telemetry().tick > 0;
    check('P7.16 snapshot AVTORITAR server tick ni o‘z ichiga oladi',
      tickOk,
      `A snapshot serverTick=${snapsA?.serverTick} · B snapshot serverTick=${snapsB?.serverTick} · server.tick=${server.telemetry().tick}`);

    // ---------- P7.17 snapshot input ack ----------
    const qaA = await mpQa(A);
    check('P7.17 snapshot input tasdiqini (ackSeq) o‘z ichiga oladi',
      Number.isFinite(qaA?.ackSeq) && qaA.ackSeq >= 1 && snapsA?.ackSeq >= 1,
      `A ackSeq=${qaA?.ackSeq} · A snapshot ackSeq=${snapsA?.ackSeq} · B snapshot ackSeq=${snapsB?.ackSeq} (B o‘zi yubormagan → -1 bo‘lishi mumkin)`);

    // ---------- P7.18 ketma-ketlik o'sadi ----------
    const s1 = (await serverSnaps(A))?.ackSeq ?? -1;
    await sleep(600);
    const s2 = (await serverSnaps(A))?.ackSeq ?? -1;
    check('P7.18 input ketma-ketligi (seq/ack) monotonik o‘sadi',
      s2 > s1 && s1 >= 0 && (serverSnaps(A) !== null),
      `A ackSeq: ${s1} → ${s2} · A lastSeq=${sessA.lastSeq} B lastSeq=${sessB.lastSeq}`);

    // ---------- P7.19 soxta avtoritar holat rad ----------
    let msgSeq = 100000;
    // JOIN_SESSION birinchi — prob ham in_game a'zosi bo'ladi (avtoritativ rejim)
    const forged = [
      { type: MSG.JOIN_SESSION },
      { type: MSG.INPUT, seq: ++msgSeq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, position: { x: -13, z: -11 }, tick: 999999 },
      { type: MSG.INPUT, seq: ++msgSeq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, hp: 5, damage: 100 },
      { type: MSG.INPUT, seq: ++msgSeq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, vx: 50, vz: -50 },
      { type: MSG.INPUT, seq: ++msgSeq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, move: { forward: NaN, right: 0 } }
    ];
    const probePromise = A.evaluate(`window.__p7probe(${JSON.stringify(forged)}, 3000)`);
    // Prob hali OCHIQ — server xotirasidagi sessiyasini shu paytda o'qiymiz
    // (u yopilgach server sessiyani o'chiradi → poyga bo'lmasin).
    let probeServerSess = null;
    for (let i = 0; i < 50; i++) {
      probeServerSess = sessions().find((s) =>
        s.playerId !== idA && s.playerId !== idB && s.authoritativeMovement);
      if (probeServerSess) break;
      await sleep(80);
    }
    const probePos = probeServerSess ? { ...probeServerSess.state.position } : null;
    const probeAccepted = probeServerSess ? probeServerSess.counters.accepted : -1;
    const probe = await probePromise;
    const acks = (probe?.out || []).filter((m) => m.type === MSG.INPUT_ACK);
    const reasons = acks.map((a) => a.reason);
    const forbiddenCount = reasons.filter((r) => r === 'forbidden_authority').length;
    const probeSess = (probe?.out || []).find((m) => m.type === MSG.SESSION);
    // Soxta pozitsiya qo'llanmadi: server pozitsiyasi jo'natgan (-13,-11) dan
    // uzoq va HECH QANDAY buyruq qabul qilinmagan (accepted === 0).
    const probeUnchanged = !!probePos && probeAccepted === 0 &&
      Math.hypot(probePos.x - (-13), probePos.z - (-11)) > 5;
    check('P7.19 soxta pozitsiya/HP/zarar/tezlik da’volari RAD etildi, holat o‘zgarmadi',
      probe?.ok === true && forbiddenCount >= 3 && reasons.includes('bad_move') && probeUnchanged,
      `rad sabablari=[${reasons.slice(0, 6).join(', ')}] · soxta playerId=${probeSess?.playerId || '—'} · qabul qilingan buyruq=${probeAccepted} · server pozitsiyasi=(${probePos ? probePos.x.toFixed(2) : '—'},${probePos ? probePos.z.toFixed(2) : '—'}) ≠ (-13,-11)`);

    // ---------- P7.20 buzilgan xabar serverni yiqitmaydi ----------
    const malformed = [
      '{ bu json emas',
      { type: 'snapshot', players: [{ id: 'p1', x: 1, y: 2, z: 3 }] },
      { type: 'lobby-cheat', hostId: 'p1', state: 'in_game' },
      JSON.stringify({ type: MSG.INPUT, pad: 'x'.repeat(40000) }),
      { type: MSG.INPUT, seq: 'salom', pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] } },
      { type: MSG.INPUT, seq: 5, pose: { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] } },
      { type: MSG.INPUT, seq: 6, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [NaN, 0, 0] } }
    ];
    const probeBad = await B.evaluate(`window.__p7probe(${JSON.stringify(malformed)}, 2600)`);
    const badOut = probeBad?.out || [];
    const errCodes = badOut.filter((m) => m.type === MSG.ERROR).map((m) => m.code);
    const stillAlive = server.telemetry().tickErrors === 0 && server.state.connections.size >= 2;
    const tickBefore = server.telemetry().tick;
    await sleep(400);
    const tickAfter = server.telemetry().tick;
    check('P7.20 buzilgan/noma’lum juda katta xabarlar serverni yiqitmadi (tick davom etdi)',
      probeBad?.ok === true && stillAlive && tickAfter > tickBefore &&
      errCodes.includes('bad_json') && errCodes.includes('unknown_type') && errCodes.includes('too_big'),
      `xato kodlari=[${errCodes.join(', ')}] · tickErrors=${server.telemetry().tickErrors} · tick ${tickBefore}→${tickAfter}`);

    // ---------- P7.23 join-in-progress (HAQIQIY brauzer sahifasi C) ----------
    Cpage = await newPage(BASE);
    C = Cpage.cdp;
    const readyC = await waitReady(C);
    const cBtnBefore = await C.evaluate(`(function () {
      const b = document.getElementById('btnJoin');
      return b ? { disabled: !!b.disabled, w: Math.round(b.getBoundingClientRect().width) } : null;
    })()`);
    const joinC = await clickBtn(C, 'btnJoin');
    const cJoined = await waitServer(() => lobbySess() && lobbySess().players.length === 3);
    const idC = await C.evaluate('window.__neon.lobbyPlayerId()');
    const cSnap = await waitClient(C, 'window.__neon.serverSnapshots()',
      (v) => v && v.players >= 3, 80);
    const cC0 = await mpQa(C);
    const cSeesA = (cSnap?.ids || []).includes(idA) && (cSnap?.ids || []).includes(idB);
    check('P7.23 join-in-progress: yangi (3-) o‘yinchi JORIY avtoritar holatni oldi',
      readyC?.version === 4 && joinC && cJoined && cSeesA && (cSnap?.players >= 3),
      `C=${idC} · JOIN tugmasi(klikdan oldin)=${JSON.stringify(cBtnBefore)} · C snapshot xabarlari=${cSnap?.messages} playerlar=${cSnap?.players} ids=[${(cSnap?.ids || []).join(',')}]`);

    // C ham (in_game tufayli avtomatik) o'yin tsikliga kiradi → A/B C ni ko'rishi kerak
    await waitServer(() => lobbySess() && lobbySess().players.length === 3);
    const runningC = await waitClient(C, 'window.__neon.running', (v) => v === true);
    await front(A);
    const aSeesC = await waitClient(A, 'window.__neon.multiplayerQa()',
      (v) => v && (v.remoteIds || []).includes(idC), 80);
    const cRemote = (aSeesC?.remoteIds || []).includes(idC);
    const authCount = sessions().filter((s) => s.authoritativeMovement).length;
    const aRemotes = aSeesC?.remoteIds || [];
    check('P7.24 mavjud o‘yinchi (A) yangi o‘yinchini (C) masofaviy ko‘rdi — DUBLIKATSIZ',
      runningC === true && cRemote &&
      new Set(aRemotes).size === aRemotes.length &&
      !aRemotes.includes(idA) &&
      aRemotes.includes(idB) && aRemotes.includes(idC) &&
      aRemotes.length === authCount - 1,
      `A remoteIds=[${aRemotes.join(',')}] (o‘zi YO‘Q, dublikat YO‘Q) · serverda avtoritativ sessiya=${authCount} · kutilgan ro‘yxat uzunligi=${authCount - 1}`);

    // ---------- P7.21 uzilish → masofaviy holat olib tashlanadi (brauzer + raw) ----------
    const aHadC = (aSeesC?.remoteIds || []).includes(idC);
    const cShot = await saveShot(A, 'p7-23b-remote-C-in-A');
    try { await C.send('Page.close'); } catch {}
    try { C.close(); } catch {}
    const aLostC = await waitClient(A, 'window.__neon.multiplayerQa()',
      (v) => v && !(v.remoteIds || []).includes(idC), 80);
    const memberGone = await waitServer(() => lobbySess() && !lobbySess().players.some((p) => p.id === idC));
    const sessGone = await waitServer(() => !sessions().some((s) => s.playerId === idC));

    // raw juftlik: D va E (ikkalasi ham in_game ga qo'shiladi)
    const D = new RawClient(WS_URL); rawClients.push(D); await D.open();
    D.send({ type: MSG.HELLO, name: 'raw-d' });
    const dSess = await D.next(MSG.SESSION);
    D.send({ type: MSG.JOIN_SESSION });
    const dSnap = await rawFreshSnap(D, (s) => (s.players || []).some((p) => p.id === idA));
    check('P7.21b uzilgan brauzer klienti (C) A sinxron holatidan va server ro‘yxatidan chiqarildi (masofaviy mesh yo‘qoldi)',
      aHadC && !(aLostC?.remoteIds || []).includes(idC) && memberGone && sessGone && cShot,
      `A oldin C ni ko‘rgan=${aHadC} · hozir A remoteIds=[${(aLostC?.remoteIds || []).join(',')}] · C ro‘yxatdan chiqdi=${memberGone} · C sessiyasi serverdan o‘chdi=${sessGone} · skrinshot=${cShot}`);

    const E = new RawClient(WS_URL); rawClients.push(E); await E.open();
    E.send({ type: MSG.HELLO, name: 'raw-e' });
    const eSess = await E.next(MSG.SESSION);
    E.send({ type: MSG.JOIN_SESSION });
    const eSnap0 = await rawFreshSnap(E, (s) => (s.players || []).some((p) => p.id === dSess.playerId));
    check('P7.23b join-in-progress (xom WS klient): D in_game paytida qo‘shilib, joriy holatni oldi',
      !!dSnap && (dSnap.players || []).some((p) => p.id === idA) &&
      (dSnap.players || []).some((p) => p.id === idB),
      `D=${dSess.playerId} snapshot playerlar=[${((dSnap?.players) || []).map((p) => p.id).join(',')}]`);

    // D uziladi → E D ni ko'rmaydi
    D.terminate();
    const eSnap1 = await rawFreshSnap(E, (s) => !(s.players || []).some((p) => p.id === dSess.playerId));
    check('P7.21 uzilgan o‘yinchi (D) boshqa klientning (E) sinxron holatidan OLIB TASHLANDI',
      !!eSnap0 && !!eSnap1 && !(eSnap1.players || []).some((p) => p.id === dSess.playerId) &&
      (eSnap1.players || []).some((p) => p.id === eSess.playerId),
      `E snapshot: avval=[${((eSnap0?.players) || []).map((p) => p.id).join(',')}] keyin=[${((eSnap1?.players) || []).map((p) => p.id).join(',')}]`);

    // F qo'shiladi → E F ni ko'radi; F uziladi → E F ni ko'rmaydi (teskari yo'nalish)
    const F = new RawClient(WS_URL); rawClients.push(F); await F.open();
    F.send({ type: MSG.HELLO, name: 'raw-f' });
    const fSess = await F.next(MSG.SESSION);
    F.send({ type: MSG.JOIN_SESSION });
    const eSnap2 = await rawFreshSnap(E, (s) => (s.players || []).some((p) => p.id === fSess.playerId));
    F.terminate();
    const eSnap3 = await rawFreshSnap(E, (s) => !(s.players || []).some((p) => p.id === fSess.playerId));
    check('P7.22 teskari yo‘nalish: F qo‘shildi (E ko‘rdi) → F uzildi (E dan olib tashlandi)',
      !!eSnap2 && !!eSnap3 &&
      (eSnap2.players || []).some((p) => p.id === fSess.playerId) &&
      !(eSnap3.players || []).some((p) => p.id === fSess.playerId),
      `E ko‘rgan F=${((eSnap2?.players) || []).some((p) => p.id === fSess.playerId)} · uzilgach=${!((eSnap3?.players) || []).some((p) => p.id === fSess.playerId)}`);
    E.close();

    // ---------- P7.25 interpolatsiya HAQIQATAN ishladi ----------
    const qaB = await mpQa(B);
    const qaA2 = await mpQa(A);
    const interpB = qaB?.interpolation || { samples: 0, active: false };
    const interpA = qaA2?.interpolation || { samples: 0, active: false };
    check('P7.25 interpolatsiya yo‘li HAQIQATAN ishladi (snapshot orasida silliqlash)',
      interpB.samples > 0 && interpA.samples > 0 && interpB.active === true,
      `A interp namunalari=${interpA.samples} · B interp namunalari=${interpB.samples} · kechikish=${interpB.delayMs} ms`);

    // ---------- P7.26 rekonsiliatsiya HAQIQATAN ishladi ----------
    const recA = qaA2?.reconciliation || { samples: 0, corrections: 0, smoothings: 0 };
    const recB = qaB?.reconciliation || { samples: 0, corrections: 0, smoothings: 0 };
    const recTotal = (recA.corrections + recA.smoothings + recB.corrections + recB.smoothings);
    check('P7.26 lokal rekonsiliatsiya yo‘li HAQIQATAN ishladi (server holati ustun)',
      recA.samples > 0 && recB.samples > 0 && recTotal > 0,
      `A: namuna=${recA.samples} snap=${recA.corrections} yumshoq=${recA.smoothings} maks xato=${recA.maxError} m · ` +
      `B: namuna=${recB.samples} snap=${recB.corrections} yumshoq=${recB.smoothings} maks xato=${recB.maxError} m`);

    // ---------- P7.27 Phase 5 combat avtoriteti saqlangan ----------
    await front(A);
    const hpBefore = (sessA.state.targets || []).find((t) => t.id === 'dummy-1')?.health?.hp ?? null;
    const shotsBefore = sessA.counters.shotsAccepted;
    // real pointer lock + real sichqoncha
    const lockInfo = await A.evaluate(`(function () {
      const c = document.getElementById('gl');
      if (c) { c.click(); }
      return { locked: document.pointerLockElement !== null };
    })()`, { userGesture: true });
    await sleep(500);
    let firePath = 'real-mouse';
    for (let i = 0; i < 3; i++) {
      await A.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(120);
      await A.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 400, button: 'left', clickCount: 1, buttons: 0 });
      await sleep(120);
    }
    if (sessA.counters.shotsAccepted === shotsBefore) {
      // pointer lock mavjud bo'lmasa — HAQIQIY input manager yo'li (mock EMAS)
      firePath = 'input-manager (pointer lock yo`q)';
      await A.evaluate('window.__neon.setFire(true)');
      await sleep(700);
      await A.evaluate('window.__neon.releaseFire()');
    }
    await sleep(300);
    const shotsAfter = sessA.counters.shotsAccepted;
    const magAfter = (await A.evaluate('window.__neon.serverState()'))?.weapon?.mag ?? null;
    check('P7.27 Phase 5 combat avtoriteti saqlangan (server o‘q-dorini va otishni boshqaradi)',
      shotsAfter > shotsBefore && magAfter !== null && magAfter < 30,
      `otish qabul=${shotsBefore}→${shotsAfter} (yo‘l: ${firePath}) · server mag=${magAfter} · nishon HP ${hpBefore} · lock=${JSON.stringify(lockInfo?.locked)}`);

    // ---------- P7.28 Phase 10+ kirmagan ----------
    // Chegara HAR FAZADA bir marta suriladi (Phase 8 da "Phase 8+" → "Phase 9+"
    // bo'lgan edi). PHASE 9 (HUD/chat) endi RUXSAT ETILGAN — chegara Phase 10+
    // (spectator/replay/voip/ranking/matchmaking/scoreboard/killfeed) ga o'tdi.
    // Tekshiruv KUCHI va YUZALARI bir xil: uchta sirt (xabar turlari, snapshot
    // o'yinchi maydonlari, lobby a'zo kalitlari) tekshiriladi.
    // Diqqat: voice/voip Phase 9 da ham TAQIQLANGAN (spetsifikatsiya).
    const snapShape = await A.evaluate('window.__neon.serverSnapshots().shape');
    const p9 = /spectat|replay|voip|voice|rank|matchmak|killfeed|scoreboard|inventory|room|friend|clan|achievement|profile|account/i;
    const lobbyPlayers = lobbySess() ? lobbySess().players : [];
    const p9InLobby = lobbyPlayers.some((p) => Object.keys(p).some((k) => p9.test(k)));
    const forbiddenKinds = Object.keys(MSG).filter((k) => p9.test(k));
    check('P7.28 Phase 10+ o‘yin tizimlari YO‘Q (spectator/replay/voice/ranking/matchmaking/scoreboard)',
      Array.isArray(snapShape) && snapShape.length >= 8 && !p9InLobby &&
      forbiddenKinds.length === 0 && !snapShape.some((k) => p9.test(k)),
      `snapshot o‘yinchi maydonlari=[${(snapShape || []).join(',')}] · taqiqlangan xabar turlari=[${forbiddenKinds.join(',')}]`);

    // ---------- P7.29 runtime xatolar yo'q ----------
    const exceptions = [...A.exceptions, ...B.exceptions];
    const consoleErrs = [...consoleErrors(A), ...consoleErrors(B)];
    const neonErrorsA = await A.evaluate('window.__neon.errors.length');
    const neonErrorsB = await B.evaluate('window.__neon.errors.length');
    const loopErrors = await A.evaluate('window.__neon.diagnostics().loopErrors');
    check('P7.29 runtime/console xatolari YO‘Q (istisno, unhandled, loop xatosi, server tick)',
      exceptions.length === 0 && consoleErrs.length === 0 && neonErrorsA === 0 && neonErrorsB === 0 &&
      loopErrors === 0 && server.telemetry().tickErrors === 0,
      `CDP istisno=${exceptions.length} · console.error=${consoleErrs.length} · __neonErrors A=${neonErrorsA} B=${neonErrorsB} · loop xatosi=${loopErrors} · server tickErrors=${server.telemetry().tickErrors}`);

    // ---------- hisobot ----------
    const tel = server.telemetry();
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 7,
      subject: 'multiplayer-synchronization',
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      protocol: PROTOCOL_VERSION,
      gpu: { renderer, software, webgl2: readyA.gates?.webgl2 === true },
      cadence: { tickHz: SIM.TICK_HZ, snapshotHz: SIM.SNAPSHOT_HZ, interpDelayMs: SIM.INTERP_DELAY_MS },
      twoClient: {
        method: 'one Chrome process · independent page targets (separate WS + separate window.__neon + separate loop)',
        pageA: { playerId: idA, targetId: first.id, sessionId: sessA?.id },
        pageB: { playerId: idB, targetId: Bpage.targetId, sessionId: sessB?.id },
        pageC: { playerId: idC, targetId: Cpage?.targetId }
      },
      serverAuthority: {
        authoritativeMovement: [sessA?.authoritativeMovement, sessB?.authoritativeMovement],
        serverTick: tel.tick,
        positions: {
          A: { x: +sessA.state.position.x.toFixed(3), z: +sessA.state.position.z.toFixed(3) },
          B: { x: +sessB.state.position.x.toFixed(3), z: +sessB.state.position.z.toFixed(3) }
        }
      },
      sync: {
        A: { remotes: qaA2?.remoteIds, ackSeq: qaA2?.ackSeq, seq: qaA2?.local?.seq, interpolation: qaA2?.interpolation, reconciliation: qaA2?.reconciliation },
        B: { remotes: qaB?.remoteIds, ackSeq: qaB?.ackSeq, seq: qaB?.local?.seq, interpolation: qaB?.interpolation, reconciliation: qaB?.reconciliation }
      },
      forged: { reasons, forbiddenCount, probePlayerId: probeSess?.playerId, stateUnchanged: probeUnchanged, errorCodes: errCodes },
      unitSuites: { tests: Number(uTests), pass: Number(uPass), fail: Number(uFail), exit: unit.code },
      loops: { AAdvanced: fA1 - fA0, BAdvanced: fB1 - fB0 },
      telemetry: tel,
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes })),
      exceptions, consoleErrors: consoleErrs.length, neonErrors: { A: neonErrorsA, B: neonErrorsB },
      gateMap: 'P7.1–P7.28 — spetsifikatsiya ro‘yxati; b3/7b/11b/21b/23b — qo‘shimcha dalil darvozalari'
    };
    fs.writeFileSync(path.join(ART, 'phase7-report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== PHASE 7 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    console.log(`GPU: ${renderer.slice(0, 90)}${software ? ' (SOFTWARE!)' : ''}`);
    console.log(`IKKI KLIENT: A=${idA} sess=${sessA?.id} (${first.id.slice(0, 8)}) · B=${idB} sess=${sessB?.id} (${Bpage.targetId.slice(0, 8)}) · C=${idC}`);
    console.log(`AVTORITATIV HARAKAT: A=(${report.serverAuthority.positions.A.x},${report.serverAuthority.positions.A.z}) ` +
      `B=(${report.serverAuthority.positions.B.x},${report.serverAuthority.positions.B.z}) · server tick=${tel.tick}`);
    console.log(`SINXRONIZATSIYA: A remotes=[${(qaA2?.remoteIds || []).join(',')}] ack=${qaA2?.ackSeq} · B remotes=[${(qaB?.remoteIds || []).join(',')}] ack=${qaB?.ackSeq}`);
    console.log(`INTERPOLATSIYA: A=${qaA2?.interpolation?.samples} B=${qaB?.interpolation?.samples} namuna · ` +
      `REKONSILIATSIYA: A snap=${qaA2?.reconciliation?.corrections}/smooth=${qaA2?.reconciliation?.smoothings} B snap=${qaB?.reconciliation?.corrections}/smooth=${qaB?.reconciliation?.smoothings}`);
    console.log(`UNIT (Phase 1–6 + 7): tests=${uTests} pass=${uPass} fail=${uFail}`);
    console.log(`ARTIFACTS: logs/phase7-report.json + ${shots.length} skrinshot`);
    return report.failed === 0;
  } finally {
    for (const rc of rawClients) { try { rc.close(); } catch {} }
    if (C) { try { C.close(); } catch {} }
    try { B.close(); } catch {}
    A.close();
    try { child.kill('SIGTERM'); } catch {}
    await sleep(500);
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
      fs.writeFileSync(path.join(ART, 'phase7-report.json'),
        JSON.stringify({ fatal: String(err && err.stack ? err.stack : err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
