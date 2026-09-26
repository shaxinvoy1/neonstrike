// ============================================================
// NEON STRIKE — PHASE 10: BARQARORLIK / RESURS HAYOTI testlari
//
// Ishlab chiqarish modullari: server/metrics.js (sof o'lchov),
// server/app.js (haqiqiy WebSocket oqimi), server/match.js (sof qoidalar),
// shared/combat.js (chegaralar). Mock YO'Q — hamma yo'l HAQIQIY server orqali.
//
// Qoplanadi: tick/xotira o'lchovi · resurs hayoti (create→use→remove) ·
// ulanish tozalash · dublikat close · takroriy HELLO · input navbat chegarasi ·
// seq validatsiyasi · buzg'unchi trafik · chat burst/tarix chegarasi ·
// snapshot chegarasi · raund idempotentligi · timer tozalash · xotira o'sishi.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import {
  createMetrics, createLeakProbe, activeResources, DEFAULT_BUDGET_MS, DEFAULT_WINDOW
} from '../../server/metrics.js';
import { createNeonServer } from '../../server/app.js';
import {
  createMatch, startMatch, stepMatch, evaluateRound, endRound,
  assignTeam, MATCH_PHASE, TEAM, MATCH_RULES, MATCH_REJECT
} from '../../server/match.js';
import { MSG, SIM, CHAT, SERVER_DEFAULTS } from '../../shared/protocol-consts.js';
import { EVENT_CAPACITY } from '../../shared/combat.js';
import { HEALTH } from '../../shared/health.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const WS_URL = `ws://127.0.0.1:${server.httpServer.address().port}/ws`;

// ---------------- klient yordamchilari (haqiqiy WS) ----------------
function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._q = []; ws._waiters = [];
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      for (let i = 0; i < ws._waiters.length; i++) {
        const w = ws._waiters[i];
        if (!w.type || w.type === m.type) { ws._waiters.splice(i, 1); clearTimeout(w.to); return w.resolve(m); }
      }
      ws._q.push(m);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function next (ws, type = null, timeout = 5000) {
  for (let i = 0; i < ws._q.length; i++) {
    if (!type || ws._q[i].type === type) return Promise.resolve(ws._q.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`msg timeout (${type})`)), timeout);
    ws._waiters.push({ type, resolve, to });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));

async function at (pred, label, tries = 200) {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(25); }
  throw new Error('timeout: ' + label);
}
async function hello (name) {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name });
  await next(ws, MSG.WELCOME);
  const session = await next(ws, MSG.SESSION);
  return { ws, session, playerId: session.playerId, sessionId: session.sessionId };
}
async function closeClient (c) { try { c.ws.terminate(); } catch {} }
async function emptyLobby (tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (!server.state.lobby.session) return true;
    await sleep(25);
  }
  return false;
}
async function resetWorld () {
  for (const ws of [...server.state.connections]) { try { ws.terminate(); } catch {} }
  await emptyLobby();
  await at(() => server.state.connections.size === 0 && server.state.sessions.size === 0, 'tozalash');
}
const sessOf = (sid) => server.state.sessions.get(sid);

// ============================================================
// 1) METRIKA (SOF) — HAQIQIY yozuvlardan foiz/overrun hisobi
// ============================================================
test('metrics: tick statistikasi haqiqiy yozuvlardan (avg/min/max/p50/p95 + overrun)', () => {
  const m = createMetrics({ budgetMs: 10, windowSize: 16 });
  for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20]) m.recordTick(ms);
  const s = m.snapshot();
  assert.equal(s.tick.count, 12);
  assert.equal(s.tick.minMs, 1);
  assert.equal(s.tick.maxMs, 20);
  assert.equal(s.tick.avgMs, 7.167, 'o‘rtacha noto‘g‘ri');
  // byudjet (10 ms) dan oshgan: 11 va 20 → 2 ta
  assert.equal(s.tick.overruns, 2);
  assert.equal(s.tick.overrunPct, 16.667);
  assert.equal(s.budgetMs, 10);
  assert.ok(s.tick.p50Ms >= 5 && s.tick.p50Ms <= 7, `p50=${s.tick.p50Ms}`);
  assert.ok(s.tick.p95Ms >= 11, `p95=${s.tick.p95Ms}`);
  assert.equal(s.tick.window, 12);
  // yaroqsiz qiymat hisobga olinmaydi
  const before = m.raw().tick.count;
  m.recordTick(NaN); m.recordTick(-5); m.recordTick(Infinity);
  assert.equal(m.raw().tick.count, before, 'yaroqsiz tick yozildi');
});

test('metrics: ring bufer chegaralangan (windowSize) — xotira o‘smaydi', () => {
  const m = createMetrics({ budgetMs: DEFAULT_BUDGET_MS, windowSize: 8 });
  for (let i = 0; i < 5000; i++) m.recordTick(1);
  const s = m.snapshot();
  assert.equal(s.tick.count, 5000, 'hisob butun bo‘lishi kerak');
  assert.equal(s.tick.window, 8, 'ring bufer chegaralanmadi');
  assert.equal(m.windowSize, 8);
});

test('metrics: snapshot/ops/lobby/chat hisoblari + reset', () => {
  const m = createMetrics();
  m.recordSnapshot(2, 4);
  m.recordSnapshot(4, 8);
  m.recordInput(true); m.recordInput(false); m.recordInput(true);
  m.recordChat(true); m.recordChat(false);
  m.recordLobby(true); m.recordLobby(false);
  m.recordMalformed(3);
  m.recordShots(1, 1);
  m.recordEvents(7);
  const s = m.snapshot();
  assert.equal(s.snapshot.count, 2);
  assert.equal(s.snapshot.avgMs, 3);
  assert.equal(s.snapshot.maxMs, 4);
  assert.equal(s.snapshot.playersMax, 8);
  assert.deepEqual(
    { i: s.ops.inputs, a: s.ops.inputsAccepted, r: s.ops.inputsRejected },
    { i: 3, a: 2, r: 1 });
  assert.equal(s.ops.chatAccepted, 1);
  assert.equal(s.ops.chatRejected, 1);
  assert.equal(s.ops.lobbyRejected, 1);
  assert.equal(s.ops.malformed, 3);
  assert.equal(s.ops.shotsAccepted, 1);
  assert.equal(s.ops.events, 7);
  m.reset();
  const z = m.snapshot();
  assert.equal(z.tick.count, 0);
  assert.equal(z.ops.inputs, 0);
  assert.equal(z.snapshot.count, 0);
});

test('metrics: resurs hayoti (lifecycle) → live = yaratilgan − yopilgan', () => {
  const m = createMetrics();
  m.lifecycle('connections'); m.lifecycle('connections'); m.lifecycle('connections');
  m.lifecycle('connectionsClosed');
  m.lifecycle('sessions', 2);
  m.lifecycle('sessionsClosed', 2);
  m.lifecycle('members', 3);
  m.lifecycle('membersRemoved');
  const s = m.snapshot();
  assert.deepEqual(s.life.live, { connections: 2, sessions: 0, members: 2, chatEntries: 0 });
  assert.equal(s.life.connections, 3);
  assert.equal(s.life.connectionsClosed, 1);
});

test('metrics: xotira namunasi (interval + force) va MB konversiya', () => {
  const m = createMetrics({ memSampleMs: 1000 });
  assert.equal(m.sampleMemory(1000, true), true, 'force namuna olinmadi');
  const s1 = m.snapshot();
  assert.ok(s1.memory.samples === 1);
  assert.ok(s1.memory.rssMb > 0, 'rss yo‘q');
  assert.ok(s1.memory.heapMb > 0, 'heap yo‘q');
  assert.equal(m.sampleMemory(1500), false, 'interval hurmat qilinmadi');
  assert.equal(m.sampleMemory(2200), true);
  const s2 = m.snapshot();
  assert.equal(s2.memory.samples, 2);
  assert.ok(Number.isFinite(s2.memory.rssDeltaMb));
  assert.ok(s2.memory.maxHeapMb >= s2.memory.heapMb * 0.99);
});

test('leak probe: yaratildi/yo‘q qilindi/live/max + leaks()', () => {
  const p = createLeakProbe();
  p.create('remoteMesh', 3);
  p.create('remoteMesh', 2);
  assert.equal(p.live('remoteMesh'), 5);
  assert.equal(p.destroy('remoteMesh', 4), 1);
  assert.equal(p.live('remoteMesh'), 1);
  const rep = p.report();
  assert.deepEqual(rep.remoteMesh, { created: 5, destroyed: 4, live: 1, max: 5 });
  assert.deepEqual(p.leaks('remoteMesh', 'chatNode'), { remoteMesh: 1, chatNode: 0 });
  p.clear();
  assert.deepEqual(p.report(), {});
});

test('aktiv resurslar hisobi (handle/timer) — ishlamaydigan muhitda null', () => {
  const r = activeResources();
  if (r === null) return;                        // Node < 20 — o'tkazib yuboriladi
  assert.ok(r.total > 0, 'aktiv resurs yo‘q');
  assert.ok(typeof r.byType === 'object');
});

// ============================================================
// 2) RESURS HAYOTI (create → use → remove) — HAQIQIY server
// ============================================================
test('resurs hayoti: N klient ulanadi va yopiladi — ghost/leak YO‘Q', async () => {
  await resetWorld();
  const before = server.telemetry();
  const closedConn = before.resources.closed.connections;
  const closedSess = before.resources.closed.sessions;

  const clients = [];
  for (let i = 0; i < 12; i++) clients.push(await hello('st-connect-' + i));
  await at(() => server.state.connections.size === 12, 'ulanishlar');
  assert.equal(server.state.sessions.size, 12, 'sessiya yaratilmadi');
  const tel = server.telemetry();
  assert.equal(tel.resources.connections, 12);
  assert.equal(tel.resources.sessions, 12);
  assert.equal(tel.resources.opened.connections - closedConn, 12, 'ochilgan ulanish hisobi');
  assert.equal(tel.resources.opened.sessions - closedSess, 12, 'ochilgan sessiya hisobi');

  for (const c of clients) await closeClient(c);
  await at(() => server.state.connections.size === 0, 'ulanishlar yopilmadi');
  const after = server.telemetry();
  assert.equal(after.resources.connections, 0, 'ulanish qoldig‘i');
  assert.equal(after.resources.sessions, 0, 'sessiya qoldig‘i (ghost)');
  assert.equal(after.resources.lobbyMembers, 0);
  assert.equal(after.resources.chatEntries, 0);
  assert.equal(after.resources.opened.connections - after.resources.closed.connections, 0,
    'ochilgan ≠ yopilgan (ulanish leak)');
  assert.equal(after.resources.opened.sessions - after.resources.closed.sessions, 0,
    'ochilgan ≠ yopilgan (sessiya leak)');
  assert.equal(after.tickErrors, 0, 'tick xatosi');
});

test('resurs hayoti: dublikat close hodisalari xavfsiz (ikki marta terminate)', async () => {
  await resetWorld();
  const a = await hello('dup-close-a');
  const b = await hello('dup-close-b');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');

  const membersBefore = server.state.lobby.session.players.length;
  b.ws.terminate();
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'a’zo chiqarilmadi');
  // Qo'shimcha close/terminate — qo'shimcha a'zo o'chirilmasligi shart
  try { b.ws.terminate(); b.ws.close(); } catch {}
  await sleep(150);
  assert.equal(server.state.lobby.session.players.length, 1, 'dublikat close a’zoni yana o‘chirdi');
  assert.equal(server.state.lobby.session.players.length, membersBefore - 1);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a);
  await at(() => !server.state.lobby.session, 'sessiya yopilmadi');
});

test('resurs hayoti: bitta socketda takroriy HELLO sessiyani KO‘PAYTIRMAYDI', async () => {
  await resetWorld();
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'repeat' });
  await next(ws, MSG.WELCOME);
  const s1 = await next(ws, MSG.SESSION);
  const n1 = server.state.sessions.size;
  for (let i = 0; i < 5; i++) {
    send(ws, { type: MSG.HELLO, name: 'repeat' });
    await next(ws, MSG.WELCOME);
    await next(ws, MSG.SESSION);
  }
  assert.equal(server.state.sessions.size, n1, 'takroriy HELLO sessiya to‘pladi');
  assert.equal(server.state.sessions.size, 1);
  assert.ok(!server.state.sessions.has(s1.sessionId) || server.state.sessions.size === 1);
  assert.equal(server.state.connections.size, 1, 'ulanish ko‘paydi');
  ws.terminate();
  await at(() => server.state.sessions.size === 0 && server.state.connections.size === 0, 'tozalash');
});

// ============================================================
// 3) INPUT / SNAPSHOT CHEGARALARI (P7 yo‘lini buzmasdan)
// ============================================================
test('input navbati CHEGARALANGAN: bir tick ichida to‘planish bo‘lmaydi', async () => {
  await resetWorld();
  const c = await hello('burst-input');
  const s = sessOf(c.sessionId);
  const cap = SIM.MAX_INPUTS_PER_TICK;
  const n = cap * 5;
  // 30 Hz loop'ni TO'XTATAMIZ: bir tick ichida to'planish chegarasini
  // deterministik o'lchash uchun (loop ishlab tursa, navbat har tick'da
  // bo'shaydi va chegara ko'rinmaydi — bu o'zi to'g'ri xatti-harakat)
  server.stopLoop();
  const before = { acc: s.counters.accepted, rej: s.counters.rejected };
  for (let i = 0; i < n; i++) {
    send(c.ws, {
      type: MSG.INPUT, seq: i + 1,
      pose: { x: 0, y: 0, z: -13, yaw: 0, pitch: 0 },
      aim: { dir: [0, 0, 1] },
      intents: { fire: false, reload: false, switchTo: null, moving: true }
    });
  }
  await at(() => (s.counters.accepted + s.counters.rejected) - (before.acc + before.rej) === n,
    'barcha input qayta ishlanmadi');
  const acc = s.counters.accepted - before.acc;
  const rej = s.counters.rejected - before.rej;
  assert.equal(acc, cap, `bir tickda ${acc} input qabul qilindi (chegara ${cap})`);
  assert.equal(rej, n - cap, 'ortiqcha input rad etilmadi');
  assert.ok((s.rejections[SIM_TOO_MANY] || 0) > 0, 'too_many_inputs sababi yo‘q');
  assert.ok(s.pendingInputs <= cap, 'navbat chegaradan oshdi');
  // loop qayta yoqiladi → navbat BO'SHATILADI (chegara + tozalash)
  server.startLoop();
  await at(() => s.pendingInputs === 0, 'navbat bo‘shatilmadi');
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c);
  await at(() => server.state.connections.size === 0, 'tozalash');
});
const SIM_TOO_MANY = 'too_many_inputs';

test('input seq: dublikat/eski/soxta avtoritar maydonlar RAD (holat o‘zgarmaydi)', async () => {
  await resetWorld();
  const c = await hello('seq-rules');
  const s = sessOf(c.sessionId);
  const okInput = (seq, extra = {}) => ({
    type: MSG.INPUT, seq,
    pose: { x: 0, y: 0, z: -13, yaw: 0, pitch: 0 },
    aim: { dir: [0, 0, 1] },
    intents: { fire: false, reload: false, switchTo: null, moving: false },
    ...extra
  });
  const hp0 = s.state.health.hp;
  const mag0 = s.state.loadout ? s.state.loadout.mag : null;

  send(c.ws, okInput(10));
  await at(() => s.lastSeq === 10, 'birinchi input');
  // dublikat
  send(c.ws, okInput(10));
  await at(() => (s.rejections.duplicate_seq || 0) > 0, 'dublikat rad etilmadi');
  // eski (out-of-order)
  send(c.ws, okInput(9));
  await at(() => (s.rejections.stale_seq || 0) > 0, 'eski seq rad etilmadi');
  assert.equal(s.lastSeq, 10, 'eski seq holatni o‘zgartirdi');
  // soxta avtoritar maydonlar
  send(c.ws, okInput(11, { damage: 999, hp: 1, targetHp: 0, teamId: 'A', score: 99 }));
  await at(() => (s.rejections.forbidden_authority || 0) > 0, 'soxta maydon rad etilmadi');
  send(c.ws, okInput(12, { seq: 'oops' }));
  await at(() => (s.rejections.bad_seq || 0) > 0, 'yaroqsiz seq rad etilmadi');
  send(c.ws, okInput(13, { pose: { x: NaN, y: 0, z: 0, yaw: 0, pitch: 0 } }));
  await at(() => (s.rejections.bad_pose || 0) > 0, 'NaN poza rad etilmadi');
  send(c.ws, okInput(14, { aim: { dir: [0, 0, 0] } }));
  await at(() => (s.rejections.bad_aim || 0) > 0, 'nol yo‘nalish rad etilmadi');

  assert.equal(s.state.health.hp, hp0, 'HP o‘zgardi (soxta zarar)');
  if (mag0 !== null) assert.equal(s.state.loadout.mag, mag0, 'o‘q-dori o‘zgardi');
  assert.equal(s.state.health.alive, true);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c);
  await at(() => server.state.connections.size === 0, 'tozalash');
});

test('snapshot chegarasi: o‘yinchi ro‘yxati sessiyalar sonidan oshmaydi', async () => {
  await resetWorld();
  const a = await hello('snap-bound-a');
  const b = await hello('snap-bound-b');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  send(a.ws, { type: MSG.START_SESSION });
  await at(() => sessOf(a.sessionId).authoritativeMovement && sessOf(b.sessionId).authoritativeMovement,
    'avtoritar rejim');

  const snap = await next(a.ws, MSG.SNAPSHOT, 5000);
  assert.ok(snap.players.length <= SIM.MAX_SNAPSHOT_PLAYERS, 'MAX_SNAPSHOT_PLAYERS buzildi');
  assert.equal(snap.players.length, server.state.sessions.size, 'snapshot ro‘yxati sessiya soniga mos emas');
  assert.equal(server.state._syncPlayers.length, server.state.sessions.size);

  // 60 s simulyatsiya: ro'yxat chegaradan oshmaydi
  let t = Date.now();
  for (let i = 0; i < 1800; i++) { t += SIM.TICK_MS; server.tickAll(t); }
  assert.ok(server.state._syncPlayers.length <= SIM.MAX_SNAPSHOT_PLAYERS, 'syncPlayers chegaradan oshdi');
  assert.equal(server.state._syncPlayers.length, server.state.sessions.size);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a); await closeClient(b);
  await at(() => !server.state.lobby.session, 'tozalash');
});

// ============================================================
// 4) ERROR CONTAINMENT — buzg‘unchi/buzilgan trafik
// ============================================================
test('error containment: buzilgan/begona xabarlar serverni YIQITMAYDI', async () => {
  await resetWorld();
  const c = await hello('hostile');
  const s = sessOf(c.sessionId);
  const malformed0 = server.telemetry().perf.ops.malformed;

  c.ws.send('{ bu JSON emas');                                   // bad_json
  c.ws.send(JSON.stringify({ nope: 1 }));                        // bad_msg (type yo'q)
  c.ws.send(JSON.stringify({ type: 42 }));                       // bad_msg
  c.ws.send(JSON.stringify({ type: 'such-a-type' }));            // unknown_type
  c.ws.send(JSON.stringify({ type: MSG.INPUT }));                // seq yo'q
  c.ws.send(JSON.stringify({ type: MSG.INPUT, seq: Infinity })); // cheksiz
  c.ws.send(JSON.stringify({ type: MSG.INPUT, seq: -1 }));       // manfiy
  c.ws.send(JSON.stringify({ type: MSG.CHAT, text: 'x' }));      // sessiyasiz chat
  c.ws.send(JSON.stringify({ type: MSG.JOIN_SESSION, sessionId: 'nope' }));
  c.ws.send('x'.repeat(SERVER_DEFAULTS.MAX_MSG_BYTES + 100));    // too_big
  await at(() => server.telemetry().perf.ops.malformed >= malformed0 + 4, 'buzilgan xabar hisoblanmadi');
  await sleep(200);

  // Server hali ham ishlaydi: oddiy ping + input qabul qilinadi
  send(c.ws, { type: MSG.PING, t: 7 });
  const pong = await next(c.ws, MSG.PONG);
  assert.equal(pong.t, 7, 'server javob bermayapti');
  const mal = server.telemetry().perf.ops.malformed;
  assert.ok(mal >= malformed0 + 4, `buzilgan hisob ${mal}`);
  assert.equal(server.telemetry().tickErrors, 0, 'tick xatosi');
  assert.equal(s.state.health.hp, 100, 'buzilgan trafik holatni o‘zgartirdi');
  await closeClient(c);
  await at(() => server.state.connections.size === 0, 'tozalash');
});

test('error containment: yopilgandan keyin yuborish xavfsiz', async () => {
  await resetWorld();
  const c = await hello('after-close');
  const ws = c.ws;
  ws.terminate();
  await at(() => server.state.connections.size === 0, 'ulanish yopilmadi');
  let threw = false;
  try { ws.send(JSON.stringify({ type: MSG.PING, t: 1 })); } catch { threw = true; }
  await sleep(120);
  assert.equal(server.telemetry().tickErrors, 0);
  assert.equal(server.state.sessions.size, 0);
  // `threw` bo'lishi mumkin (ws kutubxonasi) — muhimi: server o'lgan sessiyani
  // qayta tiklamaydi va yiqilmaydi
  assert.ok(threw === true || threw === false);
  assert.equal(server.state.connections.size, 0);
});

// ============================================================
// 5) CHAT BURST / CHEGARA (P9 qoidalari o‘zgarmaydi)
// ============================================================
test('chat: burst chegarasi + tarix chegarasi + rad etilganlar tarqatilmaydi', async () => {
  await resetWorld();
  const a = await hello('burst-chat-a');
  const b = await hello('burst-chat-b');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');

  const accepted0 = server.telemetry().chat.accepted;
  // chegaradan ko'p yuboramiz: BURST = 5
  for (let i = 0; i < CHAT.BURST + 6; i++) send(a.ws, { type: MSG.CHAT, text: 'burst-' + i });
  await at(() => server.telemetry().chat.accepted - accepted0 >= CHAT.BURST, 'chat qabul qilinmadi');
  await sleep(250);
  const acc = server.telemetry().chat.accepted - accepted0;
  assert.equal(acc, CHAT.BURST, `burst chegarasi buzildi (${acc} qabul)`);
  assert.ok(server.telemetry().perf.ops.chatRejected >= 6, 'flood rad etilmadi');
  assert.ok(server.state.chat.entries.length <= CHAT.HISTORY, 'chat tarixi chegaradan oshdi');

  // uzoq tarix: chegaradan ko'p qabul qilsak ham tarix chegaralanadi
  await sleep(CHAT.WINDOW_MS + 200);
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < CHAT.BURST; i++) send(a.ws, { type: MSG.CHAT, text: 'hist-' + round + '-' + i });
    await sleep(CHAT.WINDOW_MS + 60);
  }
  await at(() => server.state.chat.entries.length >= CHAT.HISTORY, 'tarix to‘lmadi');
  assert.ok(server.state.chat.entries.length <= CHAT.HISTORY,
    `tarix chegaradan oshdi (${server.state.chat.entries.length})`);
  assert.equal(server.telemetry().tickErrors, 0);

  // rad etilgan xabar B ga YETIB KELMASLIGI: uzun xabar
  const bCount0 = b.ws._q.filter((m) => m.type === MSG.CHAT_MSG).length;
  send(a.ws, { type: MSG.CHAT, text: 'z'.repeat(CHAT.MAX_LEN + 50) });
  await sleep(250);
  const bCount1 = b.ws._q.filter((m) => m.type === MSG.CHAT_MSG).length;
  assert.equal(bCount1, bCount0, 'rad etilgan xabar tarqatildi');
  await closeClient(a); await closeClient(b);
  await at(() => !server.state.lobby.session, 'tozalash');
});

test('chat: begona (sessiyasiz) yuboruvchi rad etiladi — cross-session leak YO‘Q', async () => {
  await resetWorld();
  const a = await hello('leak-chat-a');
  const outsider = await hello('outsider');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  const rejected0 = server.telemetry().perf.ops.chatRejected;
  send(outsider.ws, { type: MSG.CHAT, text: 'men a’zo emasman' });
  await at(() => server.telemetry().perf.ops.chatRejected > rejected0, 'begona chat rad etilmadi');
  await sleep(150);
  const got = a.ws._q.filter((m) => m.type === MSG.CHAT_MSG && /a’zo emasman/.test(m.text));
  assert.equal(got.length, 0, 'begona xabar sessiyaga oqib kirdi');
  const errs = outsider.ws._q.filter((m) => m.type === MSG.ERROR && m.code === 'chat_no_session');
  assert.ok(errs.length > 0, 'chat_no_session xatosi yo‘q');
  await closeClient(a); await closeClient(outsider);
  await at(() => !server.state.lobby.session, 'tozalash');
});

// ============================================================
// 6) RAUND / MATCH IDEMPOTENTLIGI (P8 qoidalari o‘zgarmaydi)
// ============================================================
test('match: dublikat endRound ballni IKKI MARTA oshirmaydi (sof qoidalar)', () => {
  const m = createMatch();
  const now = 1_000_000;
  startMatch(m, ['p1', 'p2'], now);
  assignTeam(m, 'p1'); assignTeam(m, 'p2');
  // STARTING → LIVE
  let ev = stepMatch(m, now + SIM.STARTING_MS + 10);
  assert.equal(ev.roundStarted, true, 'raund boshlanmadi');
  assert.equal(m.roundState, MATCH_PHASE.LIVE);

  assert.equal(evaluateRound(m, { A: 1, B: 1 }), null, 'tirik ikkala jamoa — g‘olib yo‘q');
  assert.equal(evaluateRound(m, { A: 1, B: 0 }), TEAM.A, 'A g‘olib emas');
  const r1 = endRound(m, TEAM.A, now + 2000);
  assert.equal(r1.ok, true);
  assert.equal(m.scores.A, 1);
  // DUBLIKAT: roundState endi ROUND_END → ball oshmaydi
  const r2 = endRound(m, TEAM.A, now + 2100);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, MATCH_REJECT.ALREADY);
  assert.equal(m.scores.A, 1, 'dublikat ball qo‘shdi');
  assert.equal(m.scores.B, 0);

  // ROUND_END → keyingi raund (bir marta)
  const ev2 = stepMatch(m, now + 2000 + MATCH_RULES.ROUND_END_MS + 10);
  assert.equal(ev2.roundStarted, true, 'keyingi raund boshlanmadi');
  assert.equal(m.roundNumber, 2);
  assert.equal(m.scores.A, 1, 'ball saqlanmadi');
  assert.equal(m.roundState, MATCH_PHASE.LIVE);
});

test('match: raund sikllari cheksiz o‘sib ketmaydi (RAUNDS_TO_WIN → MATCH_END)', () => {
  const m = createMatch();
  let now = 2_000_000;
  startMatch(m, ['p1', 'p2'], now);
  assignTeam(m, 'p1'); assignTeam(m, 'p2');
  stepMatch(m, now + SIM.STARTING_MS + 10);
  let rounds = 0;
  while (m.state !== MATCH_PHASE.MATCH_END && rounds < 20) {
    rounds += 1;
    now += 5000;
    endRound(m, TEAM.A, now);
    assert.equal(m.scores.A, rounds, 'ball bir marta oshmadi');
    assert.equal(m.scores.B, 0);
    now += MATCH_RULES.ROUND_END_MS + 10;
    stepMatch(m, now);
  }
  assert.equal(m.state, MATCH_PHASE.MATCH_END);
  assert.equal(rounds, MATCH_RULES.ROUNDS_TO_WIN, 'MATCH_END chegarasi noto‘g‘ri');
  assert.equal(m.matchWinner, TEAM.A);
  // MATCH_END dan keyin qo'shimcha ball YO'Q
  const r = endRound(m, TEAM.A, now + 1000);
  assert.equal(r.ok, false);
  assert.equal(m.scores.A, MATCH_RULES.ROUNDS_TO_WIN);
});

test('server: uzilish raund natijasini IKKI MARTA hisoblamaydi (ghost ball yo‘q)', async () => {
  await resetWorld();
  const a = await hello('idem-a');
  const b = await hello('idem-b');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  send(a.ws, { type: MSG.START_SESSION });
  await at(() => server.state.match.roundState === MATCH_PHASE.LIVE, 'raund LIVE emas');

  // B uziladi → A jamoasi qoladi → server raundni baholaydi (BIR marta)
  b.ws.terminate();
  await at(() => server.state.match.roundState !== MATCH_PHASE.LIVE, 'raund baholanmadi');
  const s1 = { ...server.state.match.scores };
  assert.equal(s1.A + s1.B, 1, 'birinchi baholashda ball noto‘g‘ri');
  // takroriy tick'lar ballni oshirmaydi
  let t = Date.now();
  for (let i = 0; i < 200; i++) { t += SIM.TICK_MS; server.tickAll(t); }
  const s2 = { ...server.state.match.scores };
  assert.deepEqual(s2, s1, 'takroriy tick ballni oshirdi');
  assert.equal(server.state.match.teams.B.length, 0, 'ghost jamoa a’zosi qoldi');
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a);
  await at(() => !server.state.lobby.session, 'tozalash');
});

// ============================================================
// 7) TIMER / LOOP TOZALASH
// ============================================================
test('timer: startLoop idempotent, stopLoop/close ikki marta xavfsiz', async () => {
  const srv = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await srv.listen();
  const l1 = srv.startLoop();
  const l2 = srv.startLoop();
  assert.equal(l1, l2, 'startLoop ikkinchi timer yaratdi');
  srv.stopLoop();
  srv.stopLoop();                       // ikkinchi marta — xavfsiz
  assert.equal(srv.startLoop() !== null, true, 'qayta ishga tushmadi');
  await srv.close();
  await srv.close();                    // ikkinchi close — xavfsiz
  assert.equal(srv.telemetry().tickErrors, 0);
});

test('timer: yopilgandan keyin tick to‘xtaydi (tick soni o‘smaydi)', async () => {
  const srv = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
  await srv.listen();
  await sleep(150);
  const t1 = srv.telemetry().tick;
  assert.ok(t1 > 0, 'tick umuman ishlamadi');
  await srv.close();
  await sleep(200);
  const t2 = srv.telemetry().tick;
  assert.equal(t2, t1, 'yopilgandan keyin tick davom etdi (runaway timer)');
});

// ============================================================
// 8) UZOQ YUK OSTIDA BARQARORLIK + XOTIRA
// ============================================================
test('uzoq yuk: 2 klient + tick/input/chat → tickErrors 0, konteynerlar o‘smaydi', async () => {
  await resetWorld();
  const a = await hello('long-a');
  const b = await hello('long-b');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  send(a.ws, { type: MSG.START_SESSION });
  await at(() => sessOf(a.sessionId).authoritativeMovement, 'avtoritar');

  server.metrics.reset();
  server.metrics.sampleMemory(Date.now(), true);
  const before = server.telemetry();
  let seq = 0;
  let t = Date.now();
  for (let i = 0; i < 3000; i++) {
    t += SIM.TICK_MS;
    if (i % 3 === 0) {
      for (const c of [a, b]) {
        send(c.ws, {
          type: MSG.INPUT, seq: ++seq + (c === b ? 100000 : 0),
          pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
          aim: { dir: [0, 0, 1] },
          move: { forward: i % 2 ? 1 : -1, right: i % 3 ? 0.5 : -0.5, sprint: i % 5 === 0 },
          intents: { fire: i % 4 === 0, reload: false, switchTo: null, moving: true }
        });
      }
    }
    if (i % 400 === 0) send(a.ws, { type: MSG.CHAT, text: 'long-' + i });
    server.tickAll(t);
    if (i % 300 === 299) await sleep(2);
  }
  await sleep(200);
  server.metrics.sampleMemory(Date.now(), true);
  const tel = server.telemetry();
  assert.equal(tel.tickErrors, 0, 'uzoq yukda tick xatosi');
  assert.equal(tel.resources.connections, 2, 'ulanish soni o‘zgardi');
  assert.equal(tel.resources.sessions, 2, 'sessiya soni o‘zgardi (leak)');
  assert.ok(tel.resources.chatEntries <= CHAT.HISTORY, 'chat tarixi o‘sdi');
  assert.equal(server.state._syncPlayers.length, 2, 'sync ro‘yxati o‘sdi');
  assert.ok(server.state.chat.entries.length <= CHAT.HISTORY);
  assert.ok(server.state.match.teams.A.length + server.state.match.teams.B.length <= 2,
    'jamoa a’zolari to‘plandi');
  // HAQIQIY xotira o'lchovi: o'sish chegaralangan (runaway YO'Q)
  assert.ok(tel.perf.memory.heapMb > 0, 'heap o‘lchanmadi');
  assert.ok(tel.perf.memory.heapDeltaMb < 120,
    `heap o‘sishi juda katta: ${tel.perf.memory.heapDeltaMb} MB`);
  assert.ok(tel.perf.tick.count >= 3000, 'tick o‘lchanmadi');
  assert.ok(tel.perf.tick.avgMs < SIM.TICK_MS,
    `o‘rtacha tick byudjetdan oshdi: ${tel.perf.tick.avgMs} ms`);
  assert.ok(tel.perf.ops.inputs > 0 && tel.perf.ops.inputsAccepted > 0, 'input o‘lchanmadi');
  assert.equal(before.resources.lobbyMembers, tel.resources.lobbyMembers, 'a’zolar soni o‘zgardi');

  await closeClient(a); await closeClient(b);
  await at(() => !server.state.lobby.session, 'tozalash');
  await at(() => server.state.sessions.size === 0, 'sessiya qoldig‘i');
});

test('metrika: telemetriyada HAQIQIY qiymatlar (P11/P12 tizimi EMAS)', () => {
  const tel = server.telemetry();
  assert.ok(tel.perf && tel.perf.tick, 'perf bloki yo‘q');
  assert.ok(tel.resources, 'resources bloki yo‘q');
  assert.ok(typeof tel.perf.tick.avgMs === 'number');
  assert.ok(typeof tel.perf.tick.p95Ms === 'number');
  assert.ok(typeof tel.perf.memory.heapMb === 'number');
  assert.ok(tel.perf.ops.inputs >= 0);
  assert.equal(typeof tel.resources.activeResources, 'object');
  // P11/P12 (kelgusi fazalar) tizimlari bo'lmasligi shart — chegara darvozasi
  const forbidden = /spectat|replay|voip|voice|matchmak|ranking|scoreboard|killfeed|inventory|lobbybrowser|friend|clan|achievement|profile|account|lanqa|two-device|hardening|deploy|cloud/i;
  const keys = [...Object.keys(tel), ...Object.keys(tel.perf), ...Object.keys(tel.resources)];
  const hit = keys.filter((k) => forbidden.test(k));
  assert.deepEqual(hit, [], `taqiqlangan kalit: ${hit.join(',')}`);
  // chegaralar (o'lchov o'zgarmaganini tasdiqlaydi)
  assert.equal(typeof EVENT_CAPACITY, 'number');
  assert.ok(EVENT_CAPACITY > 0);
  assert.equal(HEALTH.DEDUPE_CAPACITY > 0, true);
  assert.equal(DEFAULT_WINDOW >= 8, true);
});

test('yakuniy tozalash: barcha konteynerlar bo‘sh, ghost YO‘Q', async () => {
  await resetWorld();
  const tel = server.telemetry();
  assert.equal(tel.resources.connections, 0, 'ulanish qoldig‘i');
  assert.equal(tel.resources.sessions, 0, 'sessiya qoldig‘i');
  assert.equal(tel.resources.lobbyMembers, 0, 'lobby a’zosi qoldig‘i');
  assert.equal(tel.resources.chatEntries, 0, 'chat qoldig‘i');
  assert.equal(tel.resources.opened.connections - tel.resources.closed.connections, 0);
  assert.equal(tel.resources.opened.sessions - tel.resources.closed.sessions, 0);
  assert.equal(tel.resources.opened.members - tel.resources.closed.members, 0, 'a’zo leak');
  assert.equal(tel.tickErrors, 0);
  await server.close();
  assert.equal(server.telemetry().perf.tick.avgMs >= 0, true);
});
