// V-773 rebuild — 1-bosqich qoidalari: sakrash, cho'kkalash, pichoq, 10 raund,
// raund taymeri/durang, jamoa tanlash (prefer), umumiy kill-feed, animatsiya maydonlari.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createMovementState, stepMovement, JUMP_VELOCITY, CROUCH } from '../../shared/movement.js';
import { MOVE } from '../../shared/collision.js';
import { WEAPONS, createLoadout, switchTo, tryFire, activeState } from '../../shared/weapons.js';
import { createMatch, startMatch, beginRound, evaluateRoundTimeout, endRound, stepMatch, MATCH_RULES, MATCH_PHASE, TEAM, DRAW } from '../../server/match.js';
import { placePlayerAt } from '../../server/session.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, SIM } from '../../shared/protocol-consts.js';
import { PLAYER } from '../../shared/collision.js';

const OPEN = { x: -10, y: 0, z: 0, yaw: 0 };   // ochiq maydon (MID lane, reaktor zinalaridan g'arbda)
const flat = () => createMovementState({ spawn: { x: 0, y: 0, z: 0, yaw: 0 }, boxes: [] });

test('movement: sakrash ~0.9 m ko‘taradi va qo‘nadi; havoda qayta sakrab bo‘lmaydi', () => {
  const m = flat();
  stepMovement(m, 1 / 30, { forward: 0, right: 0 }, 0, false, { jump: true });
  assert.equal(m.airborne, true);
  let peak = 0;
  for (let i = 0; i < 60; i++) {
    stepMovement(m, 1 / 30, { forward: 0, right: 0 }, 0, false, { jump: i === 3 });
    peak = Math.max(peak, m.pos.y);
  }
  assert.ok(peak > 0.75 && peak < 1.0, `cho‘qqi ${peak}`);
  assert.equal(m.jumps, 1, 'havoda ikkinchi sakrash bo‘lmasligi kerak');
  assert.equal(m.airborne, false);
  assert.equal(m.pos.y, 0);
  assert.equal(m.landings, 1);
  assert.ok(Math.abs(JUMP_VELOCITY ** 2 / 44 - 0.9) < 0.05);
});

test('movement: shift ostida sakrash boshni urib to‘xtaydi', () => {
  const m = createMovementState({ spawn: { x: 0, y: 0, z: 0, yaw: 0 }, boxes: [{ min: [-2, 2.1, -2], max: [2, 2.4, 2] }] });
  for (let i = 0; i < 40; i++) stepMovement(m, 1 / 30, { forward: 0, right: 0 }, 0, false, { jump: i === 0 });
  assert.ok(m.pos.y < 2.1 - PLAYER.HEIGHT + 0.06, `bosh shiftdan o‘tdi: y=${m.pos.y}`);
});

test('movement: cho‘kkalash sekinlashtiradi, sprintni o‘chiradi, past shift ostida turib bo‘lmaydi', () => {
  const m = flat();
  for (let i = 0; i < 60; i++) stepMovement(m, 1 / 30, { forward: 1, right: 0 }, 0, true, { crouch: true });
  assert.equal(m.crouching, true);
  assert.equal(m.sprinting, false);
  assert.ok(Math.abs(m.speed - CROUCH.SPEED) < 0.05, `tezlik ${m.speed}`);
  assert.ok(CROUCH.SPEED < MOVE.WALK);
  // past shift (1.5 m) ostida: cho'kkalab kiriladi, turishga ruxsat yo'q
  const low = createMovementState({ spawn: { x: 0, y: 0, z: 0, yaw: 0 }, boxes: [{ min: [-3, 1.5, 1], max: [3, 1.8, 5] }] });
  for (let i = 0; i < 40; i++) stepMovement(low, 1 / 30, { forward: 1, right: 0 }, 0, false, { crouch: true });
  assert.ok(low.pos.z > 1.2, 'cho‘kkalab shift ostiga kirilmadi');
  stepMovement(low, 1 / 30, { forward: 0, right: 0 }, 0, false, { crouch: false });
  assert.equal(low.crouching, true, 'past shift ostida turib qoldi (boshi kirib ketardi)');
  // cho'kkalab sakrab bo'lmaydi
  stepMovement(m, 1 / 30, { forward: 0, right: 0 }, 0, false, { crouch: true, jump: true });
  assert.equal(m.airborne, false);
});

test('weapons: pichoq — o‘q-dori sarflamaydi, cooldown bor, 5-slot', () => {
  const k = WEAPONS['combat-knife'];
  assert.equal(k.mode, 'melee');
  assert.equal(k.slot, 5);
  assert.ok(k.range <= 2.5);
  const lo = createLoadout({ seed: 3 });
  switchTo(lo, 'combat-knife', 0);
  const t0 = 1000;
  assert.equal(tryFire(lo, t0, { triggerEdge: true, dir: [0, 0, 1] }).accepted, true);
  assert.equal(activeState(lo).mag, 1);
  assert.equal(tryFire(lo, t0 + 100, { triggerEdge: true, dir: [0, 0, 1] }).reason, 'cooldown');
  assert.equal(tryFire(lo, t0 + 700, { triggerEdge: true, dir: [0, 0, 1] }).accepted, true);
});

test('match: 10 raundli tuzilma, 6 g‘alaba — muddatidan oldin; teng hisob → durang', () => {
  assert.equal(MATCH_RULES.MAX_ROUNDS, 10);
  assert.equal(MATCH_RULES.ROUNDS_TO_WIN, 6);
  const m = createMatch();
  startMatch(m, ['p1', 'p2'], 0);
  let now = 0;
  for (let r = 1; r <= 10; r++) {
    beginRound(m, r, now);
    const res = endRound(m, r <= 5 ? TEAM.A : TEAM.B, now);
    assert.equal(res.ok, true);
    now += MATCH_RULES.ROUND_END_MS + 1;
    stepMatch(m, now);
  }
  assert.equal(m.state, MATCH_PHASE.MATCH_END);
  assert.equal(m.matchWinner, DRAW, '5:5 → durang');
});

test('match: raund vaqti tugasa — tirik a’zolari ko‘p jamoa, teng bo‘lsa durang (ball yo‘q)', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2', 'p3', 'p4'], 0);
  beginRound(m, 1, 1000);
  assert.equal(evaluateRoundTimeout(m, { A: 2, B: 1 }, 1000 + MATCH_RULES.ROUND_TIME_MS - 1), null);
  assert.equal(evaluateRoundTimeout(m, { A: 2, B: 1 }, 1000 + MATCH_RULES.ROUND_TIME_MS), TEAM.A);
  assert.equal(evaluateRoundTimeout(m, { A: 1, B: 1 }, 1000 + MATCH_RULES.ROUND_TIME_MS), DRAW);
  endRound(m, DRAW, 2000);
  assert.deepEqual(m.scores, { A: 0, B: 0 });
  assert.equal(m.roundWinner, DRAW);
  assert.equal(endRound(m, TEAM.A, 2001).ok, false, 'dublikat yakun');
});

test('match: jamoa tanlovi qondiriladi, lekin farq 1 dan oshmaydi', () => {
  const m = createMatch();
  startMatch(m, ['p1', 'p2', 'p3', 'p4'], 0, { p1: 'B', p2: 'B', p3: 'B' });
  assert.deepEqual(m.teams.B, ['p1', 'p2']);
  assert.deepEqual(m.teams.A, ['p3', 'p4']);
});

// ---------------- jonli server ----------------
const quietLog = { info () {}, warn () {}, error () {} };
const server = createNeonServer({ host: '127.0.0.1', port: 0, log: quietLog });
await server.listen();
const URL_ = `ws://127.0.0.1:${server.httpServer.address().port}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll (fn, label, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('kutish: ' + label); await sleep(30); }
}
class C {
  constructor (name) { this.name = name; this.q = []; this.seq = 0; this.last = null; }
  async open () {
    this.ws = new WebSocket(URL_);
    this.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === MSG.SNAPSHOT) this.last = m; this.q.push(m); });
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j); });
    this.send({ type: MSG.HELLO, name: this.name });
    const s = await poll(() => this.q.find((m) => m.type === MSG.SESSION), 'session');
    this.sessionId = s.sessionId; this.playerId = s.playerId;
    return this;
  }
  send (o) { this.ws.send(JSON.stringify(o)); }
  input (over = {}) { this.seq += 1; this.send({ type: MSG.INPUT, seq: this.seq, pose: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] }, ...over }); }
  close () { try { this.ws.terminate(); } catch {} }
}
const sess = (c) => server.state.sessions.get(c.sessionId);

test('server: prefer (jamoa istagi) lobby’da, start’da hurmat qilinadi; snapshot animatsiya maydonlari', async () => {
  const a = await new C('Shaxin').open();
  a.send({ type: MSG.CREATE_SESSION });
  const b = await new C('Zoro').open();
  await poll(() => server.state.lobby.session, 'lobby');
  b.send({ type: MSG.JOIN_SESSION });
  await poll(() => server.state.lobby.session.players.length === 2, 'join');
  a.send({ type: MSG.SET_TEAM, prefer: 'B' });
  b.send({ type: MSG.SET_TEAM, prefer: 'nope' });
  await poll(() => b.q.some((m) => m.type === MSG.ERROR && m.code === 'bad_team'), 'bad_team rad');
  await poll(() => server.state.lobby.session.players.find((p) => p.id === a.playerId || p.prefer === 'B'), 'prefer');
  a.send({ type: MSG.START_SESSION });
  await poll(() => server.state.match.roundState === MATCH_PHASE.LIVE, 'LIVE');
  assert.equal(sess(a).teamId, 'B', 'host B ni tanlagan edi');
  assert.equal(sess(b).teamId, 'A');
  // start'dan keyin jamoa almashtirish rad etiladi
  a.send({ type: MSG.SET_TEAM, prefer: 'A' });
  await poll(() => a.q.some((m) => m.type === MSG.ERROR && m.code === 'bad_state'), 'bad_state');
  const snap = await poll(() => a.last && a.last.players.length === 2 && a.last, 'snapshot');
  const me = snap.players.find((p) => p.id === a.playerId);
  for (const k of ['weapon', 'crouch', 'reloading', 'switching', 'shots', 'kills', 'deaths', 'name', 'airborne']) assert.ok(k in me, `snapshot.${k}`);
  assert.equal(me.name, 'Shaxin');
  assert.equal(snap.match.maxRounds, 10);
  assert.ok(snap.match.roundTimeLeft > 90 && snap.match.roundTimeLeft <= 100);
  assert.ok(Array.isArray(snap.match.feed));

  // sakrash + cho'kkalash server simulyatsiyasida
  const sb = sess(b);
  placePlayerAt(sb, OPEN, Date.now()); sb.movement.pos = sb.state.position;
  b.input({ move: { forward: 0, right: 0, jump: true } });
  await poll(() => sb.movement.airborne && sb.state.position.y > 0.2, 'serverda sakradi');
  await poll(() => !sb.movement.airborne, 'qo‘ndi');
  b.input({ move: { forward: 0, right: 0, crouch: true } });
  await poll(() => b.last && b.last.players.find((p) => p.id === b.playerId).crouch === true, 'crouch snapshotda');
  b.input({ move: { forward: 0, right: 0, jump: 'yes' } });
  await poll(() => b.q.some((m) => m.type === MSG.INPUT_ACK && m.reason === 'bad_move'), 'jump turi tekshiriladi');

  // pichoq: 1.5 m — tegadi; o'q-dori yo'q; 2 ta zarbadan keyin o'ldiradi → kill-feed
  const sa = sess(a);
  b.input({ move: { forward: 0, right: 0, crouch: false } });
  placePlayerAt(sa, { x: -10, y: 0, z: -1.5, yaw: 0 }, Date.now()); sa.movement.pos = sa.state.position;
  placePlayerAt(sb, { x: -10, y: 0, z: 0, yaw: Math.PI }, Date.now()); sb.movement.pos = sb.state.position;
  await sleep(80);
  a.input({ intents: { switchTo: 'combat-knife' } });
  await poll(() => sa.state.loadout.ids[sa.state.loadout.index] === 'combat-knife', 'pichoq');
  await sleep(420);
  const dir = [0, -0.35, 1];
  for (let i = 0; i < 4 && sb.state.health.alive; i++) {
    a.input({ aim: { dir }, intents: { fire: true, firePressed: true } });
    await sleep(700);
  }
  assert.equal(sb.state.health.alive, false, `pichoq o‘ldirmadi (hp=${sb.state.health.hp})`);
  const feedSnap = await poll(() => a.last && a.last.match.feed.length && a.last, 'kill-feed');
  const f = feedSnap.match.feed.at(-1);
  assert.equal(f.killer, a.playerId);
  assert.equal(f.victim, b.playerId);
  assert.equal(f.weapon, 'combat-knife');
  a.close(); b.close();
  await poll(() => server.state.connections.size === 0, 'yopildi');
});

test('server: pichoq 4 m masofada tegmaydi', async () => {
  const a = await new C('a').open(); a.send({ type: MSG.CREATE_SESSION });
  await poll(() => server.state.lobby.session, 'lobby');
  const b = await new C('b').open(); b.send({ type: MSG.JOIN_SESSION });
  await poll(() => server.state.lobby.session.players.length === 2, 'join');
  a.send({ type: MSG.START_SESSION });
  await poll(() => server.state.match.roundState === MATCH_PHASE.LIVE, 'LIVE');
  const sa = sess(a), sb = sess(b);
  placePlayerAt(sa, { x: -10, y: 0, z: -3.8, yaw: 0 }, Date.now()); sa.movement.pos = sa.state.position;
  placePlayerAt(sb, { x: -10, y: 0, z: 0.2, yaw: Math.PI }, Date.now()); sb.movement.pos = sb.state.position;
  a.input({ intents: { switchTo: 'combat-knife' } });
  await sleep(500);
  a.input({ aim: { dir: [0, -0.1, 1] }, intents: { fire: true, firePressed: true } });
  await sleep(200);
  assert.equal(sb.state.health.hp, 100);
  a.close(); b.close();
  await poll(() => server.state.connections.size === 0, 'yopildi');
  await server.close();
});
