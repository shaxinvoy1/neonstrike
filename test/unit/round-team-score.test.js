// ============================================================
// NEON STRIKE — PHASE 8: JAMOA / RAUND / BALL testlari
// HAQIQIY ishlab chiqarish modullari (mock YO'Q):
//   server/match.js (sof qoidalar) + server/session.js + server/app.js
//   + shared/combat.js (peer/PvP) + real WebSocket ulanishlar.
// Tekshiriladi: jamoa tayinlash (server) · raund holati/tartibi · g'olib ·
// ball (bir marta!) · spawn · o'lim → yo'q qilish → keyingi raund ·
// join-in-progress · uzilish · uydirma jamoa/ball/raund rad etilishi.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import {
  createMatch, resetMatch, assignTeam, teamOf, removePlayer, teamsComplete,
  startMatch, stepMatch, evaluateRound, endRound, matchSnapshot, beginRound,
  MATCH_PHASE, TEAM, MATCH_RULES, MATCH_REJECT
} from '../../server/match.js';
import { createSession, placePlayerAt, applyPeerTargets, setRoundHold } from '../../server/session.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, SIM, PROTOCOL_VERSION } from '../../shared/protocol-consts.js';
import { SPAWNS } from '../../shared/map.js';
import { PLAYER } from '../../shared/collision.js';

const EYE = PLAYER.EYE;
const quietLog = { info () {}, warn () {}, error () {} };

// ============================================================
// 1) SOF QOIDALAR (server/match.js) — HOLAT MASHINASI
// ============================================================
test('match: bo‘sh holat (none, 0 ball, jamoalar bo‘sh)', () => {
  const m = createMatch();
  assert.equal(m.state, MATCH_PHASE.NONE);
  assert.equal(m.roundState, MATCH_PHASE.NONE);
  assert.equal(m.roundNumber, 0);
  assert.equal(m.scores.A, 0);
  assert.equal(m.scores.B, 0);
  assert.equal(m.teams.A.length, 0);
  assert.equal(m.teams.B.length, 0);
  assert.equal(m.teamsAtRoundStart.A, 0);
});

test('match: jamoa tayinlash DETERMINISTIK va muvozanatli (A,B,A,B…)', () => {
  const m = createMatch();
  const order = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const teams = order.map((id) => assignTeam(m, id));
  assert.deepEqual(teams, [TEAM.A, TEAM.B, TEAM.A, TEAM.B, TEAM.A]);
  assert.equal(m.teams.A.length, 3);
  assert.equal(m.teams.B.length, 2, 'toq son → A bir kishi ko‘p (hujjatlashtirilgan)');
  // idempotent: qayta tayinlash jamoa o‘zgartirmaydi (dublikat a’zo YO‘Q)
  assert.equal(assignTeam(m, 'p2'), TEAM.B);
  assert.equal(m.teams.B.length, 2);
  assert.equal(m.teams.A.length, 3);
});

test('match: teamOf / removePlayer (dublikatga chidamli)', () => {
  const m = createMatch();
  assignTeam(m, 'p1');
  assignTeam(m, 'p2');
  assert.equal(teamOf(m, 'p1'), TEAM.A);
  assert.equal(teamOf(m, 'p2'), TEAM.B);
  assert.equal(teamOf(m, 'px'), null);
  assert.equal(removePlayer(m, 'p1'), true);
  assert.equal(removePlayer(m, 'p1'), false, 'takroriy chiqarish — yolg‘on');
  assert.equal(teamOf(m, 'p1'), null);
  assert.equal(m.teams.A.length, 0);
});

test('match: startMatch → STARTING, jamoalar qo‘shilish tartibida', () => {
  const m = createMatch();
  const res = startMatch(m, ['p1', 'p2', 'p3'], 1000);
  assert.equal(res.ok, true);
  assert.equal(m.state, MATCH_PHASE.STARTING);
  assert.equal(m.roundState, MATCH_PHASE.STARTING);
  assert.equal(m.liveAt, 1000 + SIM.STARTING_MS);
  assert.deepEqual(m.teams.A, ['p1', 'p3']);
  assert.deepEqual(m.teams.B, ['p2']);
});

test('match: stepMatch STARTING → LIVE (faqat server vaqti bilan), raund 1', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  let ev = stepMatch(m, 10);
  assert.equal(ev.roundStarted, false, 'erta — hali STARTING');
  assert.equal(m.roundState, MATCH_PHASE.STARTING);
  ev = stepMatch(m, SIM.STARTING_MS + 1);
  assert.equal(ev.roundStarted, true);
  assert.equal(m.roundState, MATCH_PHASE.LIVE);
  assert.equal(m.roundNumber, 1);
  assert.deepEqual(m.teamsAtRoundStart, { A: 1, B: 1 });
});

test('match: g‘olib aniqlash — raund boshida IKKALA jamoa bo‘lishi shart', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2', 'p3'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);         // LIVE, jamoalar A=2 B=1
  // Raund boshida B a’zosi bor edi (teamsAtRoundStart.B=1) → B hammasi
  // o‘lgan bo‘lsa A g‘olib (a’zo soni emas, TIRIK a’zo muhim).
  assert.equal(evaluateRound(m, { A: 1, B: 0 }), TEAM.A);
  assert.equal(evaluateRound(m, { A: 2, B: 0 }), TEAM.A);
  assert.equal(evaluateRound(m, { A: 0, B: 1 }), TEAM.B);
  assert.equal(evaluateRound(m, { A: 1, B: 1 }), null);
  // bir kishilik match: boshida B yo‘q → hech qachon avtomatik g‘alaba YO'Q
  const solo = createMatch();
  startMatch(solo, ['p1'], 0);
  stepMatch(solo, SIM.STARTING_MS + 1);
  assert.equal(evaluateRound(solo, { A: 1, B: 0 }), null);
  assert.equal(evaluateRound(solo, { A: 0, B: 0 }), null, 'bir kishilik match g‘alaba bermaydi');
});

test('match: endRound — ball FAQAT bir marta (IDEMPOTENT)', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  const r1 = endRound(m, TEAM.A, 5000);
  assert.equal(r1.ok, true);
  assert.equal(m.scores.A, 1);
  assert.equal(m.scores.B, 0);
  assert.equal(m.roundWinner, TEAM.A);
  assert.equal(m.roundState, MATCH_PHASE.ROUND_END);
  // dublikat chaqiruv (takroriy o'lim/uzilish hodisasi) — ball oshmaydi
  const r2 = endRound(m, TEAM.A, 5100);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, MATCH_REJECT.ALREADY);
  assert.equal(m.scores.A, 1, 'dublikat ball YO‘Q');
  // LIVE bo'lmaganda ham rad
  const r3 = endRound(m, TEAM.B, 5200);
  assert.equal(r3.ok, false);
  assert.equal(m.scores.B, 0);
});

test('match: keyingi raund — raund raqami FAQAT bir marta oshadi, ball saqlanadi', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  endRound(m, TEAM.B, 5000);
  assert.equal(m.roundNumber, 1);
  assert.equal(m.scores.B, 1);
  let ev = stepMatch(m, 5000 + SIM.ROUND_END_MS - 1);
  assert.equal(ev.roundStarted, false);
  assert.equal(m.roundNumber, 1);
  ev = stepMatch(m, 5000 + SIM.ROUND_END_MS + 1);
  assert.equal(ev.roundStarted, true);
  assert.equal(m.roundNumber, 2, 'faqat bir marta oshdi');
  assert.equal(m.roundState, MATCH_PHASE.LIVE);
  assert.equal(m.roundWinner, null);
  assert.equal(m.scores.B, 1, 'ball SAQLANADI');
});

test('match: ROUNDS_TO_WIN ga yetganda MATCH_END (yangi raund boshlanmaydi)', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  let now = 1000;
  for (let i = 0; i < MATCH_RULES.ROUNDS_TO_WIN - 1; i++) {
    endRound(m, TEAM.A, now);
    now += SIM.ROUND_END_MS + 1;
    stepMatch(m, now);
  }
  assert.equal(m.scores.A, MATCH_RULES.ROUNDS_TO_WIN - 1);
  assert.equal(m.state, MATCH_PHASE.LIVE);
  const last = endRound(m, TEAM.A, now);
  assert.equal(last.matchEnded, true);
  assert.equal(m.state, MATCH_PHASE.MATCH_END);
  assert.equal(m.matchWinner, TEAM.A);
  assert.equal(m.roundState, MATCH_PHASE.ROUND_END);
  assert.equal(m.scores.A, MATCH_RULES.ROUNDS_TO_WIN);
  // MATCH_END da yangi raund BOSHLANMAYDI
  stepMatch(m, now + 999999);
  assert.equal(m.state, MATCH_PHASE.MATCH_END);
  assert.equal(m.roundNumber, MATCH_RULES.ROUNDS_TO_WIN - 1 + 1);
});

test('match: matchSnapshot — klientga ketadigan avtoritar ko‘rinish', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  endRound(m, TEAM.A, 2000);
  const snap = matchSnapshot(m, {}, 2100);
  assert.equal(snap.matchState, MATCH_PHASE.ROUND_END);
  assert.equal(snap.roundState, MATCH_PHASE.ROUND_END);
  assert.equal(snap.roundNumber, 1);
  assert.equal(snap.roundWinner, 'A');
  assert.deepEqual(snap.scores, { A: 1, B: 0 });
  assert.deepEqual(snap.teams, { A: ['p1'], B: ['p2'] });
  assert.equal(snap.roundEndsIn > 0, true);
  // `out` qayta ishlatiladi (obyekt identifikatori saqlanadi)
  assert.equal(matchSnapshot(m, snap, 2200), snap);
});

test('match: resetMatch — hech narsa qolmaydi (stale yo‘q)', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  endRound(m, TEAM.A, 3000);
  resetMatch(m);
  assert.equal(m.state, MATCH_PHASE.NONE);
  assert.equal(m.roundNumber, 0);
  assert.equal(m.scores.A, 0);
  assert.equal(m.teams.A.length, 0);
  assert.equal(m.teamsAtRoundStart.A, 0);
  assert.equal(m.roundWinner, null);
  assert.equal(m.matchWinner, null);
});

// ============================================================
// 2) REAL SERVER INTEGRATSIYASI (WebSocket)
// ============================================================
const server = createNeonServer({ host: '127.0.0.1', port: 0, log: quietLog });
await server.listen();
const PORT = server.httpServer.address().port;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Xom WS klient (haqiqiy ulanish — serverda haqiqiy o'yinchi) */
class Client {
  constructor (name) { this.name = name; this.q = []; this.waiters = []; this.seq = 0; }
  async open () {
    this.ws = new WebSocket(WS_URL);
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (!w.type || w.type === m.type) { this.waiters.splice(i, 1); clearTimeout(w.to); return w.resolve(m); }
      }
      this.q.push(m);
    });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.send({ type: MSG.HELLO, name: this.name });
    const s = await this.next(MSG.SESSION);
    this.sessionId = s.sessionId;
    this.playerId = s.playerId;
    return this;
  }
  next (type = null, timeout = 5000) {
    for (let i = 0; i < this.q.length; i++) {
      if (!type || this.q[i].type === type) return Promise.resolve(this.q.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`xabar kutilmadi (${type})`)), timeout);
      this.waiters.push({ type, resolve, to });
    });
  }
  send (obj) { this.ws.send(JSON.stringify(obj)); }
  /** Keyingi (yangi) SNAPSHOT xabari */
  async freshSnapshot () {
    this.q = this.q.filter((m) => m.type !== MSG.SNAPSHOT);
    return this.next(MSG.SNAPSHOT, 5000);
  }
  /** Aynan shu seq uchun INPUT_ACK (navbatda eskilari bo'lishi mumkin) */
  async ackFor (seq, timeout = 4000) {
    const end = Date.now() + timeout;
    for (;;) {
      const left = Math.max(200, end - Date.now());
      const m = await this.next(MSG.INPUT_ACK, left);
      if (m.seq === seq) return m;
      if (Date.now() > end) return m;
    }
  }
  input (over = {}) {
    this.seq += 1;
    this.send({
      type: MSG.INPUT, seq: this.seq,
      pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
      aim: { dir: [0, 0, 1] },
      ...over
    });
    return this.seq;
  }
  close () { try { this.ws.close(); } catch {} }
  terminate () { try { this.ws.terminate(); } catch {} }
}

async function poll (fn, label, timeout = 5000, step = 40) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`kutish tugadi: ${label}`);
    await sleep(step);
  }
}

const sessOf = (c) => server.state.sessions.get(c.sessionId);
const match = () => server.state.match;
const lobby = () => server.state.lobby.session;

async function resetWorld () {
  for (const ws of [...server.state.connections]) { try { ws.terminate(); } catch {} }
  await poll(() => server.state.connections.size === 0, 'ulanishlar yopildi');
  await poll(() => !server.state.lobby.session, 'lobby tozalandi');
  await poll(() => match().state === MATCH_PHASE.NONE, 'match tozalandi');
}

/** Host + N ta a'zo, host START bosadi, raund LIVE bo'lguncha kutadi */
async function startedMatch (n = 2, names = null) {
  await resetWorld();
  const list = [];
  const host = await new Client(names ? names[0] : 'host').open();
  list.push(host);
  host.send({ type: MSG.CREATE_SESSION });
  await host.next(MSG.LOBBY_STATE);
  for (let i = 1; i < n; i++) {
    const c = await new Client(names ? names[i] : `guest${i}`).open();
    list.push(c);
    c.send({ type: MSG.JOIN_SESSION });
    await poll(() => lobby() && lobby().players.length === i + 1, `join ${i}`);
  }
  host.send({ type: MSG.START_SESSION });
  await poll(() => sessOf(host) && sessOf(host).authoritativeMovement, 'authoritative');
  await poll(() => match().roundState === MATCH_PHASE.LIVE, 'raund LIVE');
  return list;
}

/** O'yinchini berilgan nuqtaga joylashtirish (server ishlab chiqarish API si) */
function place (c, x, z, yaw, y = 0) {
  const s = sessOf(c);
  placePlayerAt(s, { x, y, z, yaw }, Date.now());
  s.movement.pos = s.state.position;
  return s.state.position;
}

/** A → B ga qaratilgan nishon yo'nalishi (serverdagi AVTORITAR pozitsiyalardan) */
function aimDirFrom (shooter, tx, ty, tz) {
  const st = sessOf(shooter).state;
  const ox = st.position.x, oy = st.position.y + EYE, oz = st.position.z;
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}

// ------------------------------------------------------------
test('P8/server: host start → jamoalar SERVERDA tayinlanadi (klient da’vo qila olmaydi)', async () => {
  const [a, b] = await startedMatch(2);
  const m = match();
  assert.equal(m.state === MATCH_PHASE.LIVE || m.state === MATCH_PHASE.STARTING, true);
  assert.deepEqual(m.teams.A, [a.playerId], 'birinchi qo‘shilgan → A');
  assert.deepEqual(m.teams.B, [b.playerId], 'ikkinchi → B');
  assert.equal(sessOf(a).teamId, 'A');
  assert.equal(sessOf(b).teamId, 'B');
  // spawn: A g'arbiy (SPAWNS.A), B sharqiy (SPAWNS.B)
  assert.equal(Math.abs(sessOf(a).state.position.x - SPAWNS.A.x) < 0.01, true);
  assert.equal(Math.abs(sessOf(b).state.position.x - SPAWNS.B.x) < 0.01, true);
  // SNAPSHOT ham avtoritar jamoa va match holatini olib keladi
  const snap = await a.freshSnapshot();
  assert.equal(snap.match.roundState, 'live');
  assert.equal(snap.match.roundNumber, 1);
  assert.deepEqual(snap.match.scores, { A: 0, B: 0 });
  const pa = snap.players.find((p) => p.id === a.playerId);
  const pb = snap.players.find((p) => p.id === b.playerId);
  assert.equal(pa.teamId, 'A');
  assert.equal(pb.teamId, 'B');
  await resetWorld();
});

test('P8/server: soxta jamoa/ball/raund da’volari RAD etiladi (holat o‘zgarmaydi)', async () => {
  const [a] = await startedMatch(2);
  const m = match();
  const before = { A: m.scores.A, B: m.scores.B, state: m.state, round: m.roundNumber };
  const teamBefore = m.teams.A.slice();
  const forged = [
    { teamId: 'B' },
    { score: 99, scores: { A: 99, B: 0 } },
    { roundState: 'match_end', roundWinner: 'B', matchWinner: 'B' },
    { roundNumber: 42 },
    { matchState: 'match_end', state: 'match_end' },
    { match: { scores: { A: 99, B: 0 } } }
  ];
  const reasons = [];
  for (const f of forged) {
    const seq = a.input(f);
    const ack = await a.ackFor(seq);
    assert.equal(ack.seq, seq);
    reasons.push(ack.reason);
  }
  assert.equal(reasons.every((r) => r === 'forbidden_authority'), true,
    `rad sabablari: ${reasons.join(', ')}`);
  assert.equal(m.scores.A, before.A);
  assert.equal(m.scores.B, before.B);
  assert.equal(m.state, before.state);
  assert.equal(m.roundNumber, before.round);
  assert.deepEqual(m.teams.A, teamBefore, 'jamoa o‘zgarmadi');
  assert.equal(sessOf(a).teamId, 'A');
  await resetWorld();
});

test('P8/server: DUSHMAN o‘qi zarar beradi, DO‘STONA o‘q zarar BERMAYDI', async () => {
  const [a, b, c] = await startedMatch(3);
  // jamoalar: a→A, b→B, c→A
  assert.deepEqual(match().teams.A, [a.playerId, c.playerId]);
  assert.deepEqual(match().teams.B, [b.playerId]);
  // LONG koridori (z=-9): dummy-5 (x=-8,z=-12) va devorlardan xoli ko'rish chizig'i
  place(a, -13, -9, Math.PI / 2);
  place(b, 13, -9, -Math.PI / 2);
  place(c, -13, -7.5, Math.PI / 2);
  await sleep(120);                      // peer nishonlar yangilansin

  const hpB0 = sessOf(b).state.health.hp;
  const hpC0 = sessOf(c).state.health.hp;

  // 1) do'stona o'q: a → c (bir jamoa) — zarar YO'Q
  const toC = aimDirFrom(a, sessOf(c).state.position.x, sessOf(c).state.position.y + 1.15, sessOf(c).state.position.z);
  for (let i = 0; i < 6; i++) {
    a.input({ aim: { dir: toC }, intents: { fire: true } });
    await sleep(110);
  }
  assert.equal(sessOf(c).state.health.hp, hpC0, 'do‘stona o‘q zarar berdi');
  assert.equal(sessOf(a).counters.shotsAccepted > 0, true, 'o‘q umuman qabul qilinmadi');

  // do'stona o'q HAQIQATAN nishonga tegdi (devorga emas) — server qayd etdi
  assert.equal(sessOf(a).counters.friendlyBlocked > 0, true,
    'do‘stona o‘q qayd etilmadi (nishonga tegmagan bo‘lishi mumkin)');

  // 2) dushman o'qi: a → b — zarar BOR
  const toB = () => aimDirFrom(a, sessOf(b).state.position.x, sessOf(b).state.position.y + 1.15, sessOf(b).state.position.z);
  for (let i = 0; i < 3; i++) {
    a.input({ aim: { dir: toB() }, intents: { fire: true } });
    await sleep(110);
  }
  const hpB1 = sessOf(b).state.health.hp;
  assert.equal(hpB1 < hpB0, true, `dushman o‘qi zarar bermadi (${hpB0} → ${hpB1})`);
  assert.equal(sessOf(b).state.health.alive, true, '3 o‘q bilan o‘lmasligi kerak');
  await resetWorld();
});

test('P8/server: o‘lim → jamoa yo‘q qilindi → raund tugadi → ball FAQAT BIR MARTA', async () => {
  const [a, b] = await startedMatch(2);
  place(a, -13, -9, Math.PI / 2);
  place(b, 13, -9, -Math.PI / 2);
  await sleep(120);

  const hp0 = sessOf(b).state.health.hp;
  const toB = () => aimDirFrom(a, sessOf(b).state.position.x, sessOf(b).state.position.y + 1.15, sessOf(b).state.position.z);
  let shots = 0;
  while (sessOf(b).state.health.alive && shots < 60) {
    a.input({ aim: { dir: toB() }, intents: { fire: true } });
    shots += 1;
    await sleep(110);
  }
  assert.equal(sessOf(b).state.health.alive, false, `B o‘lmadi (HP ${hp0} → ${sessOf(b).state.health.hp}, ${shots} o‘q)`);

  // raund tugashi VA ball — SERVER qarori
  await poll(() => match().roundState === MATCH_PHASE.ROUND_END, 'round end');
  assert.equal(match().roundWinner, 'A');
  assert.equal(match().scores.A, 1);
  assert.equal(match().scores.B, 0);
  assert.equal(match().lives.B, 0, 'B jamoasida tirik yo‘q');

  // IDEMPOTENTLIK: takroriy o'lim/uzilish/ball hodisalari ballni oshirmaydi
  await sleep(300);
  for (let i = 0; i < 5; i++) a.input({ aim: { dir: [1, 0, 0] }, intents: { fire: true } });
  await sleep(400);
  assert.equal(match().scores.A, 1, 'dublikat ball aniqlandi');
  assert.equal(match().scores.B, 0);

  // keyingi raund: tiriklik/HP tiklanadi, ball saqlanadi
  await poll(() => match().roundState === MATCH_PHASE.LIVE, 'keyingi raund', 8000);
  assert.equal(match().roundNumber, 2);
  assert.equal(sessOf(b).state.health.alive, true, 'yangi raundda hamma tirik');
  assert.equal(sessOf(b).state.health.hp, 100);
  assert.equal(sessOf(a).state.health.hp, 100);
  assert.equal(match().scores.A, 1, 'ball saqlandi');
  // spawn'lar jamoa bo'yicha qaytariladi
  assert.equal(Math.abs(sessOf(a).state.position.x - SPAWNS.A.x) < 0.01, true);
  assert.equal(Math.abs(sessOf(b).state.position.x - SPAWNS.B.x) < 0.01, true);
  await resetWorld();
});

test('P8/server: 2v2 — bitta o‘lim raundni tugatmaydi; o‘lik QAYTA TIRILMAYDI', async () => {
  const [a, b, c, d] = await startedMatch(4);
  assert.deepEqual(match().teams.A, [a.playerId, c.playerId]);
  assert.deepEqual(match().teams.B, [b.playerId, d.playerId]);
  place(a, -13, -9, Math.PI / 2);
  place(c, -13, -7.5, Math.PI / 2);
  place(b, 13, -9, -Math.PI / 2);
  place(d, 13, -7.5, -Math.PI / 2);
  await sleep(140);

  // a → d (B jamoasi): d o'ladi, LEKIN b tirik → raund davom etadi
  const to = (t) => aimDirFrom(a, sessOf(t).state.position.x, sessOf(t).state.position.y + 1.15, sessOf(t).state.position.z);
  let shots = 0;
  while (sessOf(d).state.health.alive && shots < 60) {
    a.input({ aim: { dir: to(d) }, intents: { fire: true } });
    shots += 1;
    await sleep(110);
  }
  assert.equal(sessOf(d).state.health.alive, false, `d o‘lmadi (${shots} o‘q)`);
  assert.equal(match().roundState, MATCH_PHASE.LIVE, 'bitta o‘lim raundni tugatdi (noto‘g‘ri)');
  assert.equal(match().scores.A, 0, 'o‘lim bilan ball yozildi (noto‘g‘ri)');
  assert.equal(match().lives.B, 1, 'jamoada 1 tirik qolishi kerak');
  assert.equal(sessOf(d).holdRespawn, true, 'raund LIVE — respawn ushlab turilishi kerak');

  // PLAYER_RESPAWN_MS dan ancha ko'p kutamiz — baribir tirilmasligi shart
  await sleep(3200);
  assert.equal(sessOf(d).state.health.alive, false, 'raund ichida qayta tirildi (noto‘g‘ri)');
  assert.equal(sessOf(d).holdRespawn, true);
  assert.equal(match().roundState, MATCH_PHASE.LIVE, 'raund hali davom etishi kerak');

  // b o'ldi → B jamoasi yo'q qilindi → raund tugadi, A ball oladi
  shots = 0;
  while (sessOf(b).state.health.alive && shots < 60) {
    a.input({ aim: { dir: to(b) }, intents: { fire: true } });
    shots += 1;
    await sleep(110);
  }
  await poll(() => match().roundState === MATCH_PHASE.ROUND_END, 'round end');
  assert.equal(match().scores.A, 1);
  assert.equal(match().roundWinner, 'A');
  await resetWorld();
});

test('P8/server: uzilish — jamoadan chiqariladi va raund natijasi qayta baholanadi', async () => {
  const [a, b] = await startedMatch(2);
  assert.deepEqual(match().teams.B, [b.playerId]);
  b.terminate();                                  // LIVE paytida uzilish
  await poll(() => match().teams.B.length === 0, 'jamoadan chiqarildi');
  await poll(() => match().roundState === MATCH_PHASE.ROUND_END, 'raund tugadi');
  assert.equal(match().roundWinner, 'A', 'qolgan jamoa yutdi');
  assert.equal(match().scores.A, 1);
  await sleep(400);
  assert.equal(match().scores.A, 1, 'uzilish takroriy ball bermadi');
  await resetWorld();
});

test('P8/server: join-in-progress — yangi a’zo jamoani, spawn’ni va JORIY match holatini oladi', async () => {
  const [a, b] = await startedMatch(2);
  const c = await new Client('late').open();
  c.send({ type: MSG.JOIN_SESSION });
  await poll(() => lobby() && lobby().players.length === 3, 'C qo‘shildi');
  await poll(() => sessOf(c) && sessOf(c).authoritativeMovement, 'C avtoritativ');

  assert.equal(teamOf(match(), c.playerId), 'A', 'muvozanat: A(1) vs B(1) → A');
  assert.equal(sessOf(c).teamId, 'A');
  assert.equal(Math.abs(sessOf(c).state.position.x - SPAWNS.A.x) < 0.01, true, 'jamoa spawn’ida');
  assert.equal(sessOf(c).state.health.hp, 100, 'to‘liq HP bilan');
  const snap = await c.freshSnapshot();
  assert.equal(snap.match.roundState, 'live');
  assert.equal(snap.match.roundNumber, match().roundNumber);
  assert.equal((snap.players || []).some((p) => p.id === a.playerId), true);
  assert.equal((snap.players || []).some((p) => p.id === b.playerId), true);
  await resetWorld();
});

test('P8/server: Phase 5 combat avtoriteti SAQLANGAN (o‘q-dori/cooldown serverda)', async () => {
  const [a, b] = await startedMatch(2);
  const mag0 = sessOf(a).state.loadout.slots['neon-rifle'].mag;
  for (let i = 0; i < 4; i++) { a.input({ aim: { dir: [0, 0, 1] }, intents: { fire: true } }); await sleep(110); }
  const mag1 = sessOf(a).state.loadout.slots['neon-rifle'].mag;
  assert.equal(mag1 < mag0, true, 'server o‘q-dorini boshqarmayapti');
  // raketa: bir sekundda 600 RPM ≈ 10 o'q (server cooldown)
  const before = sessOf(a).counters.shotsAccepted;
  const t0 = Date.now();
  while (Date.now() - t0 < 1000) { a.input({ aim: { dir: [0, 0, 1] }, intents: { fire: true } }); await sleep(25); }
  const fired = sessOf(a).counters.shotsAccepted - before;
  assert.equal(fired <= 12 && fired >= 7, true, `server cadence buzilgan: ${fired} o‘q/s`);
  // klient zarar/HP yubora olmaydi (Phase 5 qoidasi o'zgarmagan)
  const hpB = sessOf(b).state.health.hp;
  const seq = a.input({ damage: 1000, hp: 0, targetHp: 0 });
  const ack = await a.ackFor(seq);
  assert.equal(ack.seq, seq);
  assert.equal(ack.reason, 'forbidden_authority');
  assert.equal(sessOf(b).state.health.hp, hpB);
  await resetWorld();
});

test('P8/server: buzilgan match buyruqlari serverni yiqitmaydi', async () => {
  const [a] = await startedMatch(2);
  const tick0 = server.telemetry().tick;
  const bad = [
    '{ bu json emas',
    { type: 'match-command', teamId: 'B', score: 5 },
    { type: MSG.INPUT, seq: 'x', team: 'B' },
    { type: MSG.INPUT, seq: 1, match: { scores: { A: 9 } } },
    { type: MSG.START_SESSION, roundState: 'match_end' },
    JSON.stringify({ type: MSG.INPUT, pad: 'y'.repeat(40000) })
  ];
  for (const m of bad) {
    if (typeof m === 'string') a.ws.send(m); else a.send(m);
    await sleep(60);
  }
  await sleep(600);
  assert.equal(server.telemetry().tick > tick0, true, 'server tick to‘xtadi');
  assert.equal(server.telemetry().tickErrors, 0, 'server tick xatosi');
  assert.equal(match().scores.A, 0);
  assert.equal(match().scores.B, 0);
  await resetWorld();
});

test('P8/server: match tugagach (MATCH_END) yangi raund boshlanmaydi', async () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  stepMatch(m, SIM.STARTING_MS + 1);
  let now = 1000;
  for (let i = 0; i < MATCH_RULES.ROUNDS_TO_WIN; i++) {
    endRound(m, TEAM.B, now);
    now += SIM.ROUND_END_MS + 1;
    stepMatch(m, now);
  }
  assert.equal(m.state, MATCH_PHASE.MATCH_END);
  assert.equal(m.matchWinner, TEAM.B);
  assert.equal(m.scores.B, MATCH_RULES.ROUNDS_TO_WIN);
  assert.equal(m.scores.A, 0);
  const snap = matchSnapshot(m, {}, now);
  assert.equal(snap.matchState, 'match_end');
  assert.equal(snap.matchWinner, 'B');
  assert.deepEqual(snap.scores, { A: 0, B: MATCH_RULES.ROUNDS_TO_WIN });
});

test('P8/server: telemetriya match holatini ko‘rsatadi (server xotirasi)', async () => {
  const [a, b] = await startedMatch(2);
  const t = server.telemetry();
  assert.equal(t.match.roundState, 'live');
  assert.equal(t.match.state, 'live');
  assert.equal(t.match.roundNumber, 1);
  assert.deepEqual(t.match.scores, { A: 0, B: 0 });
  assert.deepEqual(t.match.teams.A, [a.playerId]);
  assert.deepEqual(t.match.teams.B, [b.playerId]);
  assert.equal(t.match.roundsToWin, SIM.ROUNDS_TO_WIN);
  assert.equal(t.protocol, PROTOCOL_VERSION);
  await resetWorld();
  const t2 = server.telemetry();
  assert.equal(t2.match.state, 'none');
  assert.deepEqual(t2.match.teams, { A: [], B: [] });
  assert.equal(t2.tickErrors, 0);
});

test.after(() => server.close());
