// ============================================================
// NEON STRIKE — PHASE 12: FINAL HARDENING testlari
//
// Ishlab chiqarish modullari ishlatiladi (mock YO'Q):
//   server/app.js (haqiqiy WebSocket oqimi) · server/session.js ·
//   server/lobby.js · server/chat.js · server/match.js ·
//   tools/lib/authority-scan.mjs (SOF statik skaner)
//
// Qoplanadi: statik avtoritet skaneri · taqiqlangan maydonlar to'liqligi ·
// runtime forged INPUT (damage/hp/ammo/cooldown/position/teamId/score/
// round/winner/kimlik) · NaN/Infinity · haddan tashqari uzun matn/payload ·
// noma'lum xabar/buzilgan JSON · dublikat/eski seq · takroriy HELLO (arvoh
// a'zo yo'q) · dublikat JOIN/LEAVE · keskin uzilish/qayta ulanish · raund
// idempotentligi · chat forgery/flood · takroriy hayot sikli (hisob
// saqlanadi: ochilgan − yopilgan).
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { createNeonServer } from '../../server/app.js';
import { MSG, SIM, CHAT, SERVER_DEFAULTS } from '../../shared/protocol-consts.js';
import { FORBIDDEN_FIELDS } from '../../server/session.js';
import { CHAT_FORBIDDEN_FIELDS } from '../../server/chat.js';
import { LOBBY_FORBIDDEN_FIELDS } from '../../server/lobby.js';
import { createMatch, startMatch, beginRound, endRound, evaluateRound, MATCH_PHASE, TEAM } from '../../server/match.js';
import { SPAWNS } from '../../shared/map.js';
import { scanFiles, scanSource, scanFutureScope, AUTHORITY_FIELDS } from '../../tools/lib/authority-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const WS_URL = `ws://127.0.0.1:${server.httpServer.address().port}/ws`;
// Suite tugagach server yopiladi (aks holda http listener jarayonni ushlab qoladi)
test.after(async () => { await server.close(); });

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
async function resetWorld () {
  for (const ws of [...server.state.connections]) { try { ws.terminate(); } catch {} }
  await at(() => server.state.connections.size === 0 && server.state.sessions.size === 0, 'tozalash');
}
const sessOf = (sid) => server.state.sessions.get(sid);

// haqiqiy INPUT niyati (standalone rejim: spawn pozasi validatsiyadan o'tadi)
let SEQ = 1000;
const spawnPose = () => ({ x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: SPAWNS.A.yaw, pitch: 0 });
const validInput = (extra = {}) => ({
  type: MSG.INPUT,
  seq: ++SEQ,
  pose: spawnPose(),
  aim: { dir: [1, 0, 0] },
  intents: {},
  ...extra
});
/** Giper: avtoritar holat "barmoq izi" (forged urinishdan keyin o'zgarmasligi) */
const fingerprint = (sid) => {
  const s = sessOf(sid);
  if (!s) return null;
  const st = s.state;
  return {
    hp: st.health.hp, alive: st.health.alive,
    mag: st.loadout ? (st.loadout.mag ?? null) : null,
    reserve: st.loadout ? (st.loadout.reserve ?? null) : null,
    x: st.position.x, y: st.position.y, z: st.position.z,
    teamId: s.teamId, lastSeq: s.lastSeq,
    shots: s.counters.shotsAccepted
    // Diqqat: `counters.inputs` — URINISH hisoblagichi (rad etilganlarni ham
    // sanaydi), avtoritar o'yin holati EMAS → barmoq iziga kirmaydi.
  };
};

// ============================================================
// 1) STATIK AVTORITET SKANERI (fake authority regressiyasi)
// ============================================================
test('P12 statik skaner: server/shared manbalarida klient→avtoritet yo‘li YO‘Q', () => {
  const files = [
    'server/app.js', 'server/session.js', 'server/lobby.js', 'server/chat.js',
    'server/match.js', 'server/metrics.js', 'server/net.js',
    'shared/combat.js', 'shared/weapons.js', 'shared/movement.js',
    'shared/health.js', 'shared/hitdetect.js', 'shared/grenade.js',
    'shared/respawn.js', 'shared/protocol-consts.js'
  ];
  const read = (f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };
  const findings = scanFiles(files, read);
  assert.deepEqual(findings, [], `avtoritet buzilishi: ${JSON.stringify(findings)}`);
});

test('P12 statik skaner: plantatsiya qilingan buzilishni DARHOL ushlaydi', () => {
  const planted = 'function f(msg){ state.health.hp = msg.hp; state.scores.A = msg.score; }';
  const found = scanSource(planted, 'planted.js');
  assert.ok(found.length >= 2, 'skaner soxta avtoritet yozuvini ushlamadi');
  assert.ok(found.some((f) => f.kind === 'client-authority-read'));
  assert.ok(found.some((f) => f.kind === 'client-authority-write'));
  // toza manba → topilma yo'q
  assert.deepEqual(scanSource('const hp = 100; state.health.hp = hp;', 'clean.js'), []);
});

test('P12 chegara: protokol/__neon yuzasida kelgusi-faza (P13+) terminlari YO‘Q', () => {
  const keys = [...Object.values(MSG), 'phase10', 'phase11', 'phase12', 'hudView', 'chatState', 'perf'];
  assert.deepEqual(scanFutureScope(keys), []);
});

test('P12 taqiqlangan maydonlar ro‘yxati avtoritar maydonlarni qamrab olgan', () => {
  for (const f of ['damage', 'hp', 'ammo', 'cooldown', 'teamId', 'score', 'scores',
    'roundState', 'roundNumber', 'roundWinner', 'matchState', 'matchWinner',
    'position', 'alive', 'playerId']) {
    assert.ok(FORBIDDEN_FIELDS.includes(f), `INPUT FORBIDDEN_FIELDS da ${f} yo‘q`);
    assert.ok(AUTHORITY_FIELDS.includes(f), `skaner maydonlari da ${f} yo‘q`);
  }
  for (const f of ['playerId', 'senderId', 'name', 'sessionId', 'teamId', 'serverTick']) {
    assert.ok(CHAT_FORBIDDEN_FIELDS.includes(f), `CHAT FORBIDDEN_FIELDS da ${f} yo‘q`);
  }
  for (const f of ['playerId', 'hostId', 'isHost', 'state', 'capacity', 'players']) {
    assert.ok(LOBBY_FORBIDDEN_FIELDS.includes(f), `LOBBY FORBIDDEN_FIELDS da ${f} yo‘q`);
  }
});

// ============================================================
// 2) RUNTIME FORGED INPUT (haqiqiy WS) — holat O'ZGARMAYDI
// ============================================================
test('P12 forged INPUT: avtoritar maydonlar rad etiladi va holat barmoq izi o‘zgarmaydi', async () => {
  await resetWorld();
  const c = await hello('forge');
  send(c.ws, validInput());
  await next(c.ws, MSG.INPUT_ACK);
  const before = fingerprint(c.sessionId);
  assert.ok(before, 'sessiya topilmadi');

  const forged = ['damage', 'hp', 'health', 'targetHp', 'ammo', 'mag', 'reserve',
    'cooldown', 'alive', 'dead', 'hit', 'hits', 'kill', 'score', 'scores',
    'teamId', 'team', 'roundState', 'roundNumber', 'roundWinner', 'matchState',
    'matchWinner', 'position', 'velocity', 'spread', 'seed', 'tick', 'serverTick',
    'playerId', 'hostId', 'senderId', 'owner'];
  for (const f of forged) {
    send(c.ws, validInput({ [f]: 1 }));
    const ack = await next(c.ws, MSG.INPUT_ACK);
    assert.equal(ack.accepted, false, `${f} qabul qilindi`);
    assert.equal(ack.reason, 'forbidden_authority', `${f} sababi noto‘g‘ri`);
  }
  assert.deepEqual(fingerprint(c.sessionId), before, 'forged input holatni o‘zgartirdi');
  assert.equal(server.state.match.scores.A, 0, 'ball klientdan o‘zgardi');
  assert.equal(server.state.match.scores.B, 0);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c);
});

test('P12 NaN/Infinity/-Infinity holatga KIRMAYDI (pose/aim/move)', async () => {
  await resetWorld();
  const c = await hello('nan');
  const before = fingerprint(c.sessionId);
  const bad = [
    validInput({ pose: { x: NaN, y: 1, z: 1, yaw: 0, pitch: 0 } }),
    validInput({ pose: { x: Infinity, y: 1, z: 1, yaw: 0, pitch: 0 } }),
    validInput({ pose: { x: 1, y: -Infinity, z: 1, yaw: 0, pitch: 0 } }),
    validInput({ aim: { dir: [NaN, 0, 0] } }),
    validInput({ aim: { dir: [0, 0, 0] } }),
    validInput({ aim: { dir: [Infinity, 0, 0] } }),
    validInput({ move: { forward: NaN, right: 0 } }),
    validInput({ move: { forward: Infinity, right: 0 } })
  ];
  for (const m of bad) {
    send(c.ws, m);
    const ack = await next(c.ws, MSG.INPUT_ACK);
    assert.equal(ack.accepted, false, 'yaroqsiz son qabul qilindi');
    assert.ok(['bad_pose', 'bad_aim', 'bad_move'].includes(ack.reason), `kutilmagan sabab: ${ack.reason}`);
  }
  assert.deepEqual(fingerprint(c.sessionId), before, 'NaN/Infinity holatga kirdi');
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c);
});

test('P12 input seq: dublikat va eski ketma-ketlik rad etiladi', async () => {
  await resetWorld();
  const c = await hello('seq');
  const m = validInput();
  send(c.ws, m);
  assert.equal((await next(c.ws, MSG.INPUT_ACK)).accepted, true);
  send(c.ws, { ...m });                                  // dublikat
  assert.equal((await next(c.ws, MSG.INPUT_ACK)).reason, 'duplicate_seq');
  send(c.ws, { ...m, seq: m.seq - 5 });                 // eski
  assert.equal((await next(c.ws, MSG.INPUT_ACK)).reason, 'stale_seq');
  send(c.ws, { ...m, seq: 1.5 });                       // butun emas
  assert.equal((await next(c.ws, MSG.INPUT_ACK)).reason, 'bad_seq');
  await closeClient(c);
});

test('P12 noma‘lum xabar / buzuq JSON / typesiz xabar — server TIRIK qoladi', async () => {
  await resetWorld();
  const c = await hello('hostile');
  const tickBefore = server.telemetry().tick;
  c.ws.send('{ this is not json');
  assert.equal((await next(c.ws, MSG.ERROR)).code, 'bad_json');
  send(c.ws, { nope: true });
  assert.equal((await next(c.ws, MSG.ERROR)).code, 'bad_msg');
  send(c.ws, { type: 'definitely-not-a-real-type' });
  assert.equal((await next(c.ws, MSG.ERROR)).code, 'unknown_type');
  send(c.ws, { type: MSG.PING, t: 1 });
  assert.equal((await next(c.ws, MSG.PONG)).type, MSG.PONG);   // server javob beradi
  assert.ok(server.telemetry().tick >= tickBefore);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c);
});

// ============================================================
// 3) PAYLOAD CHEGARALARI (ilova + protokol darajasi)
// ============================================================
test('P12 payload: 16 KiB dan katta xabar `too_big` bilan rad etiladi (ulanish OCHIQ)', async () => {
  await resetWorld();
  const c = await hello('big');
  c.ws.send('x'.repeat(SERVER_DEFAULTS.MAX_MSG_BYTES + 100));
  assert.equal((await next(c.ws, MSG.ERROR)).code, 'too_big');
  assert.equal(c.ws.readyState, 1, 'ulanish yopilib qoldi');
  await closeClient(c);
});

test('P12 payload: protokol chegarasidan (>64 KiB) katta xabar XOTIRAGA OLINMASDAN rad etiladi', async () => {
  await resetWorld();
  const ws = await connect();
  let closeCode = null;
  ws.once('close', (code) => { closeCode = code; });
  ws.send('x'.repeat(SERVER_DEFAULTS.WS_MAX_PAYLOAD_BYTES + 4096));
  await at(() => ws.readyState === 3, 'protokol chegarasi ishlamadi');
  assert.equal(closeCode, 1009, `kutilgan 1009 (message too big), keldi: ${closeCode}`);
  // server hali ham yangi mijozi xizmat qiladi
  const c2 = await hello('after-big');
  assert.equal(c2.playerId, server.state.sessions.get(c2.sessionId).playerId);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(c2);
});

// ============================================================
// 4) A'ZOLIK / ULASHISH HAYOTI
// ============================================================
test('P12 takroriy HELLO: arvoh a’zo QOLMAYDI (kimlik va lobby mos)', async () => {
  await resetWorld();
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'r1' });
  await next(ws, MSG.WELCOME); await next(ws, MSG.SESSION);
  send(ws, { type: MSG.CREATE_SESSION, name: 'r1' });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'create');

  for (let i = 0; i < 3; i++) {
    send(ws, { type: MSG.HELLO, name: 'r1' });
    await next(ws, MSG.WELCOME); await next(ws, MSG.SESSION);
  }
  await sleep(120);
  // sessiya yagona; lobby'da ESKI playerId arvoh sifatida QOLMAGAN
  assert.equal(server.state.sessions.size, 1, 'takroriy HELLO sessiya ko‘paytirdi');
  const ls = server.state.lobby.session;
  const roster = ls ? ls.players.map((p) => p.id) : [];
  assert.ok(roster.length <= 1, `arvoh a’zo qoldi: ${JSON.stringify(roster)}`);
  // Agar a’zo qolgan bo'lsa, u JORIY sessiya kimligi bilan mos bo'lishi shart
  if (roster.length === 1) {
    const liveId = [...server.state.sessions.values()][0].playerId;
    assert.equal(roster[0], liveId, 'lobby eski playerId ni ko‘rsatmoqda (arvoh)');
  }
  await closeClient({ ws });
  await at(() => !server.state.lobby.session && server.state.sessions.size === 0, 'tozalanmadi');
});

test('P12 dublikat JOIN / LEAVE / uzilish — xavfsiz, arvoh yo‘q', async () => {
  await resetWorld();
  const a = await hello('dup-a');
  const b = await hello('dup-b');
  send(a.ws, { type: MSG.CREATE_SESSION, name: 'dup-a' });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION, name: 'dup-b' });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  // dublikat JOIN → idempotent (2 a'zo qoladi)
  send(b.ws, { type: MSG.JOIN_SESSION, name: 'dup-b' });
  await next(b.ws, MSG.LOBBY_STATE);
  assert.equal(server.state.lobby.session.players.length, 2, 'dublikat JOIN a’zo qo‘shdi');
  // dublikat LEAVE → ikkinchisi rad (NOT_IN), a’zo soni o‘zgarmaydi
  send(b.ws, { type: MSG.LEAVE_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'leave');
  send(b.ws, { type: MSG.LEAVE_SESSION });
  await next(b.ws, MSG.ERROR);
  assert.equal(server.state.lobby.session.players.length, 1);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a); await closeClient(b);
  await at(() => !server.state.lobby.session, 'tozalanmadi');
});

test('P12 hayot sikli: takroriy connect→join→leave→close hisobni SAQLAYDI', async () => {
  await resetWorld();
  for (let round = 0; round < 8; round++) {
    const host = await hello('lc-host-' + round);
    send(host.ws, { type: MSG.CREATE_SESSION, name: 'h' });
    await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'create');
    const guest = await hello('lc-g-' + round);
    send(guest.ws, { type: MSG.JOIN_SESSION, name: 'g' });
    await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join2');
    send(guest.ws, { type: MSG.LEAVE_SESSION });
    await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'leave2');
    await closeClient(guest);
    await closeClient(host);
    await at(() => !server.state.lobby.session && server.state.sessions.size === 0, 'cleanup');
  }
  const res = server.telemetry().resources;
  assert.equal(res.opened.connections - res.closed.connections, 0, 'ulanish hisobi saqlanmadi');
  assert.equal(res.opened.sessions - res.closed.sessions, 0, 'sessiya hisobi saqlanmadi');
  assert.equal(res.opened.members - res.closed.members, 0, 'a’zo hisobi saqlanmadi');
  assert.equal(server.telemetry().tickErrors, 0);
});

// ============================================================
// 5) MATCH / RAUND EDGE CASE (idempotentlik + forged)
// ============================================================
test('P12 raund: dublikat endRound ballni IKKI MARTA oshirmaydi', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  beginRound(m, 1, 0);
  const first = endRound(m, TEAM.A, 100);
  assert.equal(first.ok, true);
  assert.equal(m.scores.A, 1);
  const again = endRound(m, TEAM.A, 200);           // dublikat hodisa
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'round_already_ended');
  assert.equal(m.scores.A, 1, 'ball ikki marta oshdi');
  assert.equal(m.revision >= 1, true);
});

test('P12 raund: forged score/winner INPUT orqali BOSIB o‘tilmaydi', async () => {
  await resetWorld();
  const a = await hello('fr-a');
  const b = await hello('fr-b');
  send(a.ws, { type: MSG.CREATE_SESSION, name: 'a' });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION, name: 'b' });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  send(a.ws, { type: MSG.START_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.state === 'in_game', 'start');
  // raund LIVE bo'lishini kutamiz
  await at(() => server.state.match.roundState === MATCH_PHASE.LIVE, 'live', 400);

  const scoresBefore = { ...server.state.match.scores };
  for (const payload of [{ score: 99 }, { scores: { A: 99, B: 99 } }, { roundWinner: TEAM.A },
    { matchWinner: TEAM.B }, { roundState: 'match_end' }, { teamId: TEAM.B }]) {
    send(a.ws, { type: MSG.INPUT, seq: ++SEQ, pose: spawnPose(), aim: { dir: [1, 0, 0] }, intents: {}, ...payload });
    const ack = await next(a.ws, MSG.INPUT_ACK);
    assert.equal(ack.accepted, false, `forged ${Object.keys(payload)[0]} qabul qilindi`);
    assert.equal(ack.reason, 'forbidden_authority');
  }
  assert.deepEqual(server.state.match.scores, scoresBefore, 'klient ballni o‘zgartirdi');
  assert.equal(server.state.match.matchWinner, null);
  await closeClient(a); await closeClient(b);
  await at(() => !server.state.lobby.session, 'tozalanmadi');
});

// ============================================================
// 6) CHAT HARDENING (runtime)
// ============================================================
test('P12 chat: juda uzun matn/flood/forged kimlik rad etiladi, sessiya-ichida qoladi', async () => {
  await resetWorld();
  const a = await hello('ch-a');
  const b = await hello('ch-b');
  send(a.ws, { type: MSG.CREATE_SESSION, name: 'a' });
  await next(a.ws, MSG.LOBBY_STATE);
  send(b.ws, { type: MSG.JOIN_SESSION, name: 'b' });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');

  // haddan uzun matn
  send(a.ws, { type: MSG.CHAT, text: 'z'.repeat(CHAT.MAX_LEN + 1) });
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'chat_too_long');
  // forged yuboruvchi kimligi
  send(a.ws, { type: MSG.CHAT, text: 'hi', playerId: 'p999' });
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'forbidden_authority');
  // bo'sh / probel
  send(a.ws, { type: MSG.CHAT, text: '   ' });
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'chat_empty');
  // haqiqiy xabar B ga yetib boradi, kimlik SERVERDAN
  send(a.ws, { type: MSG.CHAT, text: 'salom' });
  const msg = await next(b.ws, MSG.CHAT_MSG);
  assert.equal(msg.text, 'salom');
  assert.equal(msg.playerId, a.playerId, 'yuboruvchi kimligi serverdan emas');
  // flood: burst chegarasi
  let limited = 0;
  for (let i = 0; i < CHAT.BURST + 8; i++) {
    send(a.ws, { type: MSG.CHAT, text: 'flood ' + i });
    await sleep(5);
  }
  await sleep(150);
  limited = server.state.chat.rejections['chat_rate_limited'] || 0;
  assert.ok(limited > 0, 'flood himoyasi ishlamadi');
  // sessiyasiz mijoz chatni yubora olmaydi
  const out = await hello('outsider');
  send(out.ws, { type: MSG.CHAT, text: 'hack' });
  assert.equal((await next(out.ws, MSG.ERROR)).code, 'chat_no_session');
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a); await closeClient(b); await closeClient(out);
  await at(() => !server.state.lobby.session, 'tozalanmadi');
});

// ============================================================
// 7) TOPLU TOZALASH
// ============================================================
test('P12 yakuniy: server yopiladi va resurslar bo‘sh (osilib qolmaydi)', async () => {
  await resetWorld();
  const t = server.telemetry();
  assert.equal(t.tickErrors, 0);
  assert.equal(t.resources.opened.sessions - t.resources.closed.sessions, 0);
});
