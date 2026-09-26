#!/usr/bin/env node
// ============================================================
// NEON STRIKE — PHASE 6 LAN LOBBY verifikatsiyasi (anti-fake)
// HAQIQIY Chrome + HAQIQIY server + IKKI MUSTAQIL KLIENT.
//
// Dalil manbalari:
//   1) SERVER XOTIRASI — harness serverni o'zi ishga tushiradi, shuning uchun
//      `server.state.lobby` ni TO'G'RIDAN-TO'G'RI o'qiydi (klient da'vosi EMAS).
//   2) IKKI SAHIFA — bitta Chrome'da ikki mustaqil page (ikki alohida WS
//      ulanish, ikki alohida window.__neon). Bitta sahifada "ikkinchi klient"
//      SIMULYATSIYA QILINMAYDI.
//   3) XOM WS KLIENTLAR — sig'im/malformed tekshiruvlari uchun haqiqiy ulanishlar.
//
// Ishga tushirish:  node tools/verify-phase6.mjs            (real oyna · real GPU)
//                   node tools/verify-phase6.mjs --headless (P6.1 FAIL — SwiftShader)
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createNeonServer } from '../server/app.js';
import { MSG, SERVER_DEFAULTS, PROTOCOL_VERSION } from '../shared/protocol-consts.js';
import { MAP } from '../shared/map.js';

const CHROME = process.env.CHROME_BIN || 'google-chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9377);
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

/** Xom WS klient (sig'im/malformed tekshiruvlari uchun haqiqiy ulanish) */
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
  next (type = null, timeout = 5000) {
    for (let i = 0; i < this.q.length; i++) {
      if (!type || this.q[i].type === type) return Promise.resolve(this.q.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`raw msg timeout (${type})`)), timeout);
      this.waiters.push({ type, resolve, to });
    });
  }
  send (obj) { this.ws.send(JSON.stringify(obj)); }
  close () { try { this.ws.close(); } catch {} }
}

async function launchChrome (base) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'neon6-chrome-'));
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
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});
  return { cdp, targetId: target.id };
}

const HELPERS = fs.readFileSync(new URL('./lib/shot-helpers.js', import.meta.url), 'utf8');

async function main () {
  const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await server.listen();
  const port = server.httpServer.address().port;
  const BASE = `http://127.0.0.1:${port}`;
  const WS_URL = `ws://127.0.0.1:${port}/ws`;

  const lobby = () => server.state.lobby;
  const lobbyCount = () => (lobby().session ? lobby().session.players.length : 0);

  const { child, profile } = await launchChrome(BASE);
  const first = await waitForPageTarget(BASE);
  const A = await new CDP(first.webSocketDebuggerUrl).open();
  await A.send('Runtime.enable'); await A.send('Log.enable'); await A.send('Page.enable');
  await A.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {});

  // ikkinchi mustaqil sahifa (o'yin yuklanishini kutmasdan ochamiz)
  const Bpage = await newPage(BASE);

  const shots = [];
  const saveShot = async (name, dataUrl) => {
    const b64 = dataUrl.split(',')[1];
    const file = path.join(ART, name + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    shots.push({ name, file, bytes: Buffer.from(b64, 'base64').length });
  };

  /** Sahifa tayyor bo'lguncha kutish + HELPERS in'ektsiya */
  const waitReady = async (cdp, tries = 90) => {
    let ready = null;
    for (let i = 0; i < tries; i++) {
      try {
        ready = await cdp.evaluate(`(function () {
          const btn = document.getElementById('btnTraining');
          if (document.readyState === 'loading' || !btn) return { loading: true };
          const hostBtn = document.getElementById('btnHost');
          return {
            loading: false,
            loaded: !!(window.__neon && window.__neon.loaded),
            ready: btn.dataset.ready === '1',
            version: window.__neon ? window.__neon.version : null,
            authority: window.__neon ? window.__neon.serverAuthority : null,
            lobbyApi: window.__neon ? window.__neon.lobby : null,
            hasLobbyApi: !!(window.__neon && typeof window.__neon.lobbyState === 'function'),
            hostBtn: !!hostBtn,
            gates: window.__neon ? window.__neon.gates : null
          };
        })()`);
        if (ready && !ready.loading && ready.gates && ready.gates.webgl2 && ready.ready) break;
      } catch (e) { ready = { error: String(e.message), loading: true }; }
      await sleep(250);
    }
    if (!ready || ready.loading) throw new Error('sahifa tayyor emas: ' + JSON.stringify(ready));
    await cdp.evaluate(HELPERS);
    return ready;
  };

  /** Serverdan kelgan lobby holatini kutish (klient tomonidagi nusxa) */
  const waitClientLobby = async (cdp, pred, tries = 60) => {
    let st = null;
    for (let i = 0; i < tries; i++) {
      st = await cdp.evaluate('window.__neon.lobbyState()');
      if (st && pred(st)) return st;
      await sleep(100);
    }
    return st;
  };
  /** Server xotirasidagi holatni kutish (ASOSIY dalil) */
  const waitServer = async (pred, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      const l = lobby();
      if (pred(l)) return l;
      await sleep(100);
    }
    return lobby();
  };

  /** HAQIQIY DOM klik (tugma disabled bo'lmasa). Sahifa oldinga olinadi —
   *  ikkinchi tab ochilganda fon sahifasiga sichqoncha eventi yetib bormaydi. */
  const clickBtn = async (cdp, id) => {
    try { await cdp.send('Page.bringToFront'); } catch {}
    await sleep(120);
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

  let rawGuests = [];
  let Bcdp = Bpage.cdp;
  let BAlive = true;
  let clickLastRect = null;

  try {
    // ---------- tayyorgarlik ----------
    const readyA = await waitReady(A);
    const readyB = await waitReady(Bcdp);

    // ---------- P6.1 real GPU ----------
    const renderer = readyA.gates?.renderer || '';
    const software = /SwiftShader|llvmpipe|softpipe|Software|ANGLE \(Google, Vulkan.*SwiftShader/i.test(renderer);
    check('P6.1 real WebGL2 + real GPU (SwiftShader EMAS)',
      readyA.gates?.webgl2 === true && !software,
      `renderer="${renderer.slice(0, 96)}"${software ? ' [SOFTWARE RENDERING]' : ''}`);

    // ---------- P6.2 network ----------
    let wsA = null; let wsB = null;
    for (let i = 0; i < 60; i++) {
      wsA = await A.evaluate('window.__neon.gates');
      wsB = await Bcdp.evaluate('window.__neon.gates');
      if (wsA?.ws && wsB?.ws) break;
      await sleep(200);
    }
    check('P6.2 ikki mustaqil klient tarmoqqa ulandi (2 × alohida WS)',
      wsA?.ws === true && wsB?.ws === true && server.state.connections.size >= 2,
      `A ws=${wsA?.ws} B ws=${wsB?.ws} · serverda ulanish=${server.state.connections.size} · protokol v${wsA?.protocol}`);

    const idA = await A.evaluate('window.__neon.lobbyPlayerId()');
    const idB = await Bcdp.evaluate('window.__neon.lobbyPlayerId()');
    check('P6.2b har bir klient SERVER bergan shaxsiy ID ga ega (ikki xil)',
      typeof idA === 'string' && typeof idB === 'string' && idA !== idB,
      `A=${idA} B=${idB}`);

    // ---------- P6.3 host sessiya yaratadi (real klik) ----------
    const hostBtnBefore = await A.evaluate(`(function () {
      const b = document.getElementById('btnHost');
      return b ? { disabled: !!b.disabled, hidden: b.hidden, w: Math.round(b.getBoundingClientRect().width) } : null;
    })()`);
    const hostClicked = await clickBtn(A, 'btnHost');
    const l3 = await waitServer((l) => !!l.session && l.session.hostId === idA);
    const clientErr3 = await A.evaluate('window.__neon.lobbyError()');
    check('P6.3 HOST real klik bilan LAN sessiya yaratdi (server xotirasida)',
      hostClicked === true && !!l3.session && l3.session.id >= 1 &&
      l3.session.state === 'lobby' && l3.session.players.length === 1,
      `klik=${hostClicked} rect=${JSON.stringify(clickLastRect)} tugma(oldin)=${JSON.stringify(hostBtnBefore)} · serverLobbyActions=${server.state.totals.lobbyActions} ` +
      `clientLobbyNet=${JSON.stringify(await A.evaluate('window.__neon.lobbyNet()'))} · ` +
      `sessionId=${l3.session?.id} state=${l3.session?.state} count=${l3.session?.players?.length} · UI xato=${JSON.stringify(clientErr3?.text || '')}`);
    if (!l3.session) throw new Error('P6.3: serverda sessiya yaratilmadi — davom etish mumkin emas');

    // ---------- P6.4 host identity serverda ----------
    const stA4 = await waitClientLobby(A, (s) => s.isHost === true);
    check('P6.4 host identity SERVER tayinlagan (klient da’vosi emas)',
      stA4?.isHost === true && stA4.hostId === idA && stA4.you === idA &&
      l3.session.hostId === idA && l3.session.players[0].id === idA,
      `server hostId=${l3.session.hostId} · A you=${stA4?.you} isHost=${stA4?.isHost}`);

    // ---------- P6.5 ikkinchi klient qo'shiladi (real klik) ----------
    const joinClicked = await clickBtn(Bcdp, 'btnJoin');
    const l5 = await waitServer((l) => l.session && l.session.players.length === 2);
    check('P6.5 ikkinchi MUSTAQIL klient real klik bilan qo‘shildi (server xotirasida 2 a’zo)',
      joinClicked === true && l5.session.players.length === 2 &&
      l5.session.players.some((p) => p.id === idA) && l5.session.players.some((p) => p.id === idB),
      `count=${l5.session.players.length} a’zolar=${l5.session.players.map((p) => p.id).join(',')}`);

    // ---------- P6.6 lobby ikkala klientda ham 2 o'yinchini ko'rsatadi ----------
    const stA6 = await waitClientLobby(A, (s) => s.count === 2);
    const stB6 = await waitClientLobby(Bcdp, (s) => s.count === 2);
    const rosterA = await A.evaluate('window.__neon.lobbyRoster()');
    const rosterB = await Bcdp.evaluate('window.__neon.lobbyRoster()');
    const rosterAtext = (rosterA || []).join(' | ');
    const rosterBtext = (rosterB || []).join(' | ');
    check('P6.6 lobby UI ikkala klientda ham ikkala o‘yinchini ko‘rsatadi',
      stA6?.count === 2 && stB6?.count === 2 &&
      rosterAtext.includes(idA) && rosterAtext.includes(idB) &&
      rosterBtext.includes(idA) && rosterBtext.includes(idB),
      `A roster="${rosterAtext}" · B roster="${rosterBtext}"`);

    // ---------- P6.7 o'yinchi soni / sig'im ----------
    const countText = await A.evaluate(`document.getElementById('lobbyCount').textContent`);
    check('P6.7 o‘yinchi soni va sig‘im to‘g‘ri ko‘rsatiladi (server bilan mos)',
      countText === `2 / ${SERVER_DEFAULTS.MAX_PLAYERS}` &&
      stA6.capacity === SERVER_DEFAULTS.MAX_PLAYERS && stA6.count === 2,
      `UI="${countText}" · server count=${stA6?.count} capacity=${stA6?.capacity}`);

    // ---------- P6.8 sig'im majburlanadi (xom klientlar bilan) ----------
    const cap = SERVER_DEFAULTS.MAX_PLAYERS;
    rawGuests = [];
    for (let i = 0; i < cap - 2; i++) {
      const g = new RawClient(WS_URL);
      await g.open();
      g.send({ type: MSG.HELLO, name: 'fill-' + i });
      await g.next(MSG.SESSION);
      g.send({ type: MSG.JOIN_SESSION, name: 'fill-' + i });
      await g.next(MSG.LOBBY_STATE);
      rawGuests.push(g);
    }
    const l8 = await waitServer((l) => l.session && l.session.players.length === cap);
    // to'la sessiyaga navbatdagi klient kira olmaydi
    const overflow = new RawClient(WS_URL);
    await overflow.open();
    overflow.send({ type: MSG.HELLO, name: 'overflow' });
    await overflow.next(MSG.SESSION);
    overflow.send({ type: MSG.JOIN_SESSION, name: 'overflow' });
    const ovErr = await overflow.next(MSG.ERROR);
    const afterOverflow = lobbyCount();
    const countTextFull = await waitClientLobby(A, (s) => s.count === cap).then((s) => s && `ok/${s.count}`);
    check('P6.8 sig‘im QAT’IY majburlanadi (to‘lganda join rad, serverdan oshmaydi)',
      l8.session.players.length === cap && ovErr.code === 'lobby_full' &&
      afterOverflow === cap && countTextFull === `ok/${cap}`,
      `to‘ldi=${l8.session.players.length}/${cap} · overflow=${ovErr.code} · keyin=${afterOverflow} · UI=${countTextFull}`);

    // sig'imni bo'shatish (xom klientlar uziladi)
    for (const g of rawGuests) g.close();
    rawGuests = [];
    overflow.close();
    const l8b = await waitServer((l) => l.session && l.session.players.length === 2);
    check('P6.8b uzilish sig‘imni bo‘shatadi (server holati tiklandi)',
      l8b.session.players.length === 2, `count=${l8b.session.players.length}`);

    // ---------- P6.9 ruxsatsiz amal rad (host bo'lmagan start) ----------
    // (a) UI himoyasi: guest'da START tugmasi o'chirilgan
    const guestBtnState = await Bcdp.evaluate(`(function () {
      const b = document.getElementById('btnLobbyStart');
      return b ? { disabled: !!b.disabled } : null;
    })()`);
    // (b) UI'ni chetlab o'tib serverga to'g'ridan-to'g'ri yuborilgan start — SERVER rad etadi
    await Bcdp.evaluate('window.__neon.startLobby()');
    let errB = null;
    for (let i = 0; i < 40; i++) {
      errB = await Bcdp.evaluate('window.__neon.lobbyError()');
      if (errB && errB.hidden === false && /not_host/.test(errB.text)) break;
      await sleep(100);
    }
    const l9 = await waitServer((l) => l.hostId === idA);
    check('P6.9 ruxsatsiz host amali RAD (guest START qila olmaydi; holat o‘zgarmadi)',
      guestBtnState?.disabled === true && l9.session.state === 'lobby' &&
      errB && errB.hidden === false && /not_host/.test(errB.text),
      `UI tugma o‘chiq=${guestBtnState?.disabled} · server rad="${errB?.text}" · holat=${l9.session.state}`);

    // (qo'shimcha) soxta identity da'vosi xom klientdan
    const forger = new RawClient(WS_URL);
    await forger.open();
    forger.send({ type: MSG.HELLO, name: 'forger' });
    await forger.next(MSG.SESSION);
    forger.send({ type: MSG.JOIN_SESSION, playerId: 'p999' });
    const forgeErr = await forger.next(MSG.ERROR);
    forger.send({ type: MSG.START_SESSION, hostId: 'p999', state: 'in_game' });
    const forgeErr2 = await forger.next(MSG.ERROR);
    forger.close();
    check('P6.9b soxta identity/host da’vosi rad (server hech narsani qabul qilmadi)',
      forgeErr.code === 'forbidden_authority' && forgeErr2.code === 'forbidden_authority' &&
      lobby().session.state === 'lobby',
      `${forgeErr.code} + ${forgeErr2.code} · holat=${lobby().session.state}`);

    // ---------- P6.10 host boshlaydi (real klik) ----------
    const startClicked = await clickBtn(A, 'btnLobbyStart');
    const l10 = await waitServer((l) => l.session && l.session.state === 'in_game');
    check('P6.10 HOST real klik bilan sessiyani boshladi (server qarori)',
      startClicked === true && l10.session.state === 'in_game' && l10.session.startedAt > 0,
      `state=${l10.session.state} startedAt=${l10.session.startedAt}`);

    // ---------- P6.11 holat o'zgarishi ikkala klientga yetadi ----------
    const stA11 = await waitClientLobby(A, (s) => s.state === 'in_game');
    const stB11 = await waitClientLobby(Bcdp, (s) => s.state === 'in_game');
    const gameA = await A.evaluate('window.__neon.running');
    check('P6.11 holat in_game ikkala klientga yetdi + o‘yin sessiyasi boshlandi',
      stA11?.state === 'in_game' && stB11?.state === 'in_game' && gameA === true,
      `A=${stA11?.state} B=${stB11?.state} A running=${gameA}`);

    // ---------- P6.12/13/14 uzilish: B sahifasi yopiladi ----------
    const bTarget = Bpage.targetId;
    let closedOk = false;
    try { await Bcdp.send('Page.close'); closedOk = true; } catch { closedOk = false; }
    if (!closedOk) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${bTarget}`); } catch {} }
    Bcdp.close();
    BAlive = false;

    const l12 = await waitServer((l) => l.session && l.session.players.length === 1);
    const bGone = !l12.session.players.some((p) => p.id === idB);
    check('P6.12 real klient uzildi → SERVER a’zoni o‘chirdi (stale state yo‘q)',
      bGone && l12.session.players.length === 1 && l12.session.hostId === idA,
      `count=${l12.session.players.length} a’zolar=${l12.session.players.map((p) => p.id).join(',')} host=${l12.session.hostId}`);

    check('P6.13 SERVER uzilishdan keyin ham tirik (tickErrors=0, loop davom etdi)',
      server.state.tickErrors === 0 && server.state.tick > 5 &&
      server.state.connections.size >= 1,
      `tick=${server.state.tick} tickErrors=${server.state.tickErrors} ulanish=${server.state.connections.size}`);

    // ---------- P6.14 qolgan klient yangilangan lobby oladi ----------
    const stA14 = await waitClientLobby(A, (s) => s.count === 1);
    const rosterA14 = (await A.evaluate('window.__neon.lobbyRoster()')).join(' | ');
    const countA14 = await A.evaluate(`document.getElementById('lobbyCount').textContent`);
    check('P6.14 qolgan klient yangilangan lobby holatini oldi (B ro‘yxatdan yo‘qoldi)',
      stA14?.count === 1 && !rosterA14.includes(idB) && rosterA14.includes(idA) &&
      countA14 === `1 / ${SERVER_DEFAULTS.MAX_PLAYERS}`,
      `count=${stA14?.count} roster="${rosterA14}" UI="${countA14}"`);

    // ---------- P6.15 server barqarorligi ----------
    const tickBefore = server.state.tick;
    await sleep(600);
    const tel = server.telemetry();
    check('P6.15 server 30 Hz loop barqaror (uzilish/malformed trafikdan keyin)',
      tel.tick - tickBefore >= 12 && tel.tickErrors === 0 && tel.loopMs < 16.6,
      `600 ms da ${tel.tick - tickBefore} tick · loop ${tel.loopMs} ms · tickErrors=${tel.tickErrors}`);

    // ---------- artefaktlar ----------
    try {
      const frame = await A.evaluate('window.__neon.captureFrame()');
      if (frame) await saveShot('p6-01-in-game', frame);
    } catch {}
    // lobby panelini ko'rsatish uchun menyuga qaytamiz
    await A.evaluate('window.__neon.stopTraining()').catch(() => {});
    await sleep(400);
    const dom = await A.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (dom?.data) { writeShot('p6-02-lobby-panel', dom.data); }
    const rosterFinal = await A.evaluate(`(function () {
      const el = document.getElementById('lobbyPlayers');
      const addr = document.getElementById('lobbyAddress');
      const st = document.getElementById('lobbyState');
      const you = document.getElementById('lobbyYou');
      return { players: el ? el.textContent.trim() : null, addr: addr ? addr.textContent : null,
        state: st ? st.textContent : null, you: you ? you.textContent : null };
    })()`);

    function writeShot (name, b64) {
      const file = path.join(ART, name + '.png');
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      shots.push({ name, file, bytes: Buffer.from(b64, 'base64').length });
      return 'data:image/png;base64,' + b64;
    }

    // ---------- P6.16 xatosiz runtime ----------
    const pageErrorsA = await A.evaluate('window.__neon.errors || []');
    const consoleErrors = A.logs.filter((l) => l.level === 'error' &&
      !/favicon|DevTools|Autofill|net::ERR_NAME|PHONE_REGISTRATION|gcm|registration_request/i.test(l.text));
    const diagA = await A.evaluate('window.__neon.diagnostics()');
    check('P6.16 konsol/runtime xatolari YO‘Q (klient + server)',
      consoleErrors.length === 0 && pageErrorsA.length === 0 &&
      A.exceptions.length === 0 && (diagA?.loopErrors || 0) === 0 &&
      server.state.tickErrors === 0,
      `console=${consoleErrors.length} window.error=${pageErrorsA.length} exception=${A.exceptions.length} loop=${diagA?.loopErrors} serverTick=${server.state.tickErrors}`);

    // ---------- P6.17 Phase 1–5 regressiya ----------
    const markers = await A.evaluate(`(function () {
      const n = window.__neon;
      return { v4: n.version, auth: n.serverAuthority, lobby: n.lobby,
        combat: !!n.combatQa, aim: !!n.aimAt, serverState: typeof n.serverState === 'function' };
    })()`);
    const d17 = diagA;
    const p17Ok = markers.v4 === 4 && markers.auth?.version === 5 && markers.lobby?.version === 6 &&
      markers.combat === true && markers.aim === true && markers.serverState === true &&
      wsA?.protocol === PROTOCOL_VERSION &&
      d17?.scene?.map === MAP.NAME && MAP.WIDTH === 44 && MAP.DEPTH === 32 &&
      d17?.scene?.props === 60 && d17?.render?.shadowMap === false;
    check('P6.17 Phase 1–5 regressiya (markerlar + NEON FACILITY + avtoritar API)',
      p17Ok,
      `P4=v${markers.v4} P5=v${markers.auth?.version} P6=v${markers.lobby?.version} protokol=v${wsA?.protocol} map=${d17?.scene?.map} ${MAP.WIDTH}×${MAP.DEPTH} kollayder=${d17?.scene?.props}`);

    // ---------- P6.18 LAN manzil dalili ----------
    const ifaces = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) ifaces.push(ni.address);
    }
    const lanIp = ifaces[0] || null;
    const probeHost = lanIp || '127.0.0.1';
    const probePort = Number(process.env.PORT || SERVER_DEFAULTS.PORT);
    let lanEvidence = 'unavailable';
    let lanDetail = `interfeyslar=${ifaces.join(',') || 'yo‘q'}`;
    if (!HEADLESS) {
      let lanServer = createNeonServer({ host: '0.0.0.0', port: probePort, log: { info () {}, warn () {}, error () {} } });
      let actualPort = probePort;
      let portNote = '';
      try {
        await lanServer.listen();
      } catch {
        // default port band — ephemeral portda bindni baribir isbotlaymiz
        lanServer = createNeonServer({ host: '0.0.0.0', port: 0, log: { info () {}, warn () {}, error () {} } });
        try { await lanServer.listen(); actualPort = lanServer.httpServer.address().port; }
        catch (e2) { lanEvidence = 'failed'; lanDetail = `bind xato: ${e2.message}`; }
        portNote = ` [${probePort} band edi → ${actualPort}]`;
      }
      try {
        if (lanEvidence === 'failed') throw new Error(lanDetail);
        const httpOk = await (await fetch(`http://${probeHost}:${actualPort}/`)).text()
          .then((t) => t.includes('NEON STRIKE')).catch(() => false);
        const lanClient = new RawClient(`ws://${probeHost}:${actualPort}/ws`);
        await lanClient.open();
        lanClient.send({ type: MSG.HELLO, name: 'lan-probe' });
        const w = await lanClient.next(MSG.WELCOME);
        const s = await lanClient.next(MSG.SESSION);
        lanClient.close();
        lanEvidence = lanIp ? 'lan-interface' : 'loopback-only';
        lanDetail = `0.0.0.0 bind · ${probeHost}:${actualPort} · http=${httpOk} · ws welcome id=${w.id} session=${s.sessionId}${portNote}` +
          (lanIp
            ? ' · LAN interfeys orqali ulanish ishladi'
            : ' · [E’TIROZ: bu muhitda loopbackdan boshqa IPv4 interfeys YO‘Q — haqiqiy ikkinchi qurilma LAN sinovi O‘TKAZILMADI]');
      } catch (err) {
        if (lanEvidence !== 'failed') { lanEvidence = 'failed'; lanDetail = `xato: ${err.message}`; }
      } finally {
        try { await lanServer.close(); } catch {}
      }
    } else {
      lanDetail += ' · headless rejimida LAN bind sinovi o‘tkazilmadi';
    }
    const lanCredible = lanEvidence === 'lan-interface';
    check('P6.18 LAN bind (0.0.0.0) + LAN manzil orqali real ulanish dalili',
      lanEvidence !== 'failed' && lanEvidence !== 'unavailable',
      `${lanEvidence} · ${lanDetail}${lanCredible ? '' : ' · DIQQAT: haqiqiy ikkinchi qurilma sinovi YO‘Q'}`);

    // ---------- hisobot ----------
    const report = {
      generatedAt: new Date().toISOString(),
      phase: 6,
      subject: 'lan-lobby',
      mode: HEADLESS ? 'headless' : 'real-window',
      url: BASE,
      protocol: PROTOCOL_VERSION,
      gpu: { renderer, software, webgl2: readyA.gates?.webgl2 === true },
      twoClient: {
        method: 'one Chrome process · two independent page targets (separate WS + separate window.__neon)',
        pageA: { playerId: idA, targetId: first.id },
        pageB: { playerId: idB, targetId: Bpage.targetId }
      },
      lan: { evidence: lanEvidence, detail: lanDetail, interfaces: ifaces },
      lobbyEvidence: {
        sessionId: l3.session?.id,
        hostId: l3.session?.hostId,
        capacity: SERVER_DEFAULTS.MAX_PLAYERS,
        capacityEnforcedAt: cap,
        startedAt: l10.session?.startedAt,
        finalState: lobby().session ? lobby().session.state : 'none',
        finalPlayers: lobby().session ? lobby().session.players.map((p) => p.id) : []
      },
      serverTelemetry: tel,
      uiAfterDisconnect: rosterFinal,
      markers,
      results,
      passed: results.filter((r) => r.ok === true).length,
      failed: results.filter((r) => r.ok === false).length,
      screenshots: shots.map((s) => ({ name: s.name, file: s.file, bytes: s.bytes })),
      consoleErrors, pageErrors: pageErrorsA, exceptions: A.exceptions
    };
    fs.writeFileSync(path.join(ART, 'phase6-report.json'), JSON.stringify(report, null, 2));

    console.log('\n=== PHASE 6 VERIFICATION SUMMARY ===');
    console.log(`PASS=${report.passed}  FAIL=${report.failed}`);
    console.log(`GPU: ${renderer.slice(0, 90)}${software ? ' (SOFTWARE!)' : ''}`);
    console.log(`IKKI KLIENT: A=${idA} (${first.id.slice(0, 8)}) · B=${idB} (${Bpage.targetId.slice(0, 8)})`);
    console.log(`LOBBY: session=${report.lobbyEvidence.sessionId} host=${report.lobbyEvidence.hostId} ` +
      `sig‘im=${report.lobbyEvidence.capacity} · yakuniy holat=${report.lobbyEvidence.finalState} ` +
      `a’zolar=[${report.lobbyEvidence.finalPlayers.join(',')}]`);
    console.log(`LAN: ${lanEvidence} · ${lanDetail}`);
    console.log(`ARTIFACTS: logs/phase6-report.json + ${shots.length} skrinshot`);
    return report.failed === 0;
  } finally {
    for (const g of rawGuests) { try { g.close(); } catch {} }
    if (BAlive) { try { Bcdp.close(); } catch {} }
    A.close();
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
      fs.writeFileSync(path.join(ART, 'phase6-report.json'), JSON.stringify({ fatal: String(err), results }, null, 2));
    } catch {}
    process.exit(2);
  });
