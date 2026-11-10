// ============================================================
// NEON STRIKE — PHASE 4: combat testlari
//  - hit detection (sintetik + HAQIQIY xarita fixture'lari)
//  - devor nishonni to'sadi (wall blocking)
//  - damage/HP/o'lim/dublikat event
//  - respawn + spawn kolliziya validligi
//  - to'liq combat loop (fake clock, deterministik)
//  - kadr ichida allokatsiya yo'qligi + Phase 5 chegarasi
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveShot, humanoidZones, ringZone
} from '../../shared/hitdetect.js';
import { HEALTH, createHealth, applyDamage, resetHealth } from '../../shared/health.js';
import {
  validateSpawn, pickSpawn, defaultRespawnCandidates, applyRespawn, createPlayerSubject
} from '../../shared/respawn.js';
import {
  createCombatState, addTarget, removeTarget, getTarget, setPose, damagePlayer,
  respawnPlayer, stepCombat, combatSnapshot, TARGET_CENTRE_Y
} from '../../shared/combat.js';
import { MSG, SIM, TEAM, MATCH_PHASE } from '../../shared/protocol-consts.js';
import { SOLID_BOXES, COLLIDERS, SPAWNS, TRAINING_DUMMIES, MAP } from '../../shared/map.js';
import { WEAPONS, createLoadout } from '../../shared/weapons.js';

const EYE = 1.62;

/** origin → target yo'nalishi (normallangan) */
function aimAt (origin, target) {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const dz = target[2] - origin[2];
  const l = Math.hypot(dx, dy, dz);
  return { origin, dir: [dx / l, dy / l, dz / l], dist: l };
}

const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });
const shot = (o) => resolveShot(o);

// ---------------- 1) hit detection: sintetik ----------------
test('hitdetect: head/body/legs zonalari to‘g‘ri aniqlanadi', () => {
  const zones = humanoidZones(5, 0, 5);
  assert.equal(zones.length, 3);
  const o = [0, EYE, 5];
  for (const [y, expected] of [[1.61, 'head'], [1.15, 'body'], [0.4, 'legs']]) {
    const a = aimAt(o, [5, y, 5]);
    const r = shot({ ...a, maxDistance: 60, colliders: [], targets: [{ id: 't', alive: true, zones }] });
    assert.equal(r.kind, 'target', `y=${y}`);
    assert.equal(r.zone, expected, `y=${y}`);
    assert.ok(r.distance > 0 && r.distance <= a.dist + 0.05, `masofa y=${y}`);
  }
});

test('hitdetect: devor nishon ortidagi nishonni TO‘SADI', () => {
  const zones = humanoidZones(5, 0, 5);
  const colliders = [box(1.9, 0, 4.5, 2.1, 4, 5.5)];   // nishon oldida devor
  const a = aimAt([0, 1.2, 5], [5, 1.15, 5]);
  const r = shot({ ...a, maxDistance: 60, colliders, targets: [{ id: 't', alive: true, zones }] });
  assert.equal(r.kind, 'wall');
  assert.equal(r.blocked, true);
  assert.ok(r.distance < 2.5, `devor oldida to‘xtadi: ${r.distance}`);
});

test('hitdetect: valid hit / behind / range / o‘lgan nishon', () => {
  const zones = humanoidZones(5, 0, 5);
  const targets = [{ id: 't', alive: true, zones }];
  const a = aimAt([0, 1.2, 5], [5, 1.15, 5]);
  const r1 = shot({ ...a, maxDistance: 60, colliders: [], targets });
  assert.equal(r1.kind, 'target');
  assert.equal(r1.targetId, 't');
  const back = { origin: [6, 1.2, 5], dir: [1, 0, 0] };                    // orqasiga
  assert.equal(shot({ ...back, maxDistance: 60, colliders: [], targets }).kind, 'none');
  const far = { origin: [-3.9, 1.2, 5], dir: [1, 0, 0] };                  // range tashqarida
  assert.equal(shot({ ...far, maxDistance: 6, colliders: [], targets }).kind, 'none');
  const r2 = shot({ ...a, maxDistance: 60, colliders: [], targets: [{ id: 't', alive: false, zones }] });
  assert.equal(r2.kind, 'none');                                           // o'lgan nishon
});

test('hitdetect: origin quti ichida → blocked_origin', () => {
  const r = shot({
    origin: [2, 1, 2], dir: [1, 0, 0], maxDistance: 60,
    colliders: [box(1, 0, 1, 3, 2, 3)], targets: []
  });
  assert.equal(r.kind, 'blocked_origin');
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'origin_in_collider');
});

test('hitdetect: katta dir normallanadi; nol/NaN dir/nol range → invalid', () => {
  const zones = humanoidZones(5, 0, 5);
  const targets = [{ id: 't', alive: true, zones }];
  const long = shot({ origin: [0, 1.2, 5], dir: [10, 0, 0], maxDistance: 60, colliders: [], targets });
  assert.equal(long.kind, 'target');
  const zero = shot({ origin: [0, 1.2, 5], dir: [0, 0, 0], maxDistance: 60, colliders: [], targets });
  assert.equal(zero.kind, 'invalid');
  const nan = shot({ origin: [0, 1.2, 5], dir: [NaN, 0, 0], maxDistance: 60, colliders: [], targets });
  assert.equal(nan.kind, 'invalid');
  const badRange = shot({ origin: [0, 1.2, 5], dir: [1, 0, 0], maxDistance: 0, colliders: [], targets });
  assert.equal(badRange.kind, 'invalid');
});

test('hitdetect: devor yuzasi nishon yuzasi bilan teng bo‘lsa — devor ustuvor', () => {
  // nishon zonasi devor HUDUDIDA boshlanadi (yuzalar ustma-ust) → konservativ: to'silgan
  const zones = [{ zone: 'body', box: box(2, 0.85, 4.7, 6, 1.45, 5.3) }];
  const r = shot({
    origin: [0, 1.15, 5], dir: [1, 0, 0], maxDistance: 20,
    colliders: [box(2, 0, 4.7, 5, 4, 5.3)], targets: [{ id: 't', alive: true, zones }]
  });
  assert.equal(r.kind, 'wall');
  assert.equal(r.blocked, true);
});

// ---------------- 2) HAQIQIY xarita LOS fixture'lari ----------------
test('hitdetect: xarita — SPAWN A dan dummy-1 TOZA hit (4.36m)', () => {
  const d = TRAINING_DUMMIES[0];                       // dummy-1 (-16, 0, -2.6)
  const a = aimAt([SPAWNS.A.x, SPAWNS.A.y + EYE, SPAWNS.A.z], [d.x, d.y + TARGET_CENTRE_Y, d.z]);
  assert.ok(Math.abs(a.dist - 4.36) < 0.05, `kutilgan 4.36, bor ${a.dist.toFixed(2)}`);
  const targets = [{ id: d.id, alive: true, zones: humanoidZones(d.x, d.y, d.z) }];
  const r = shot({ ...a, maxDistance: 60, colliders: SOLID_BOXES, targets });
  assert.equal(r.kind, 'target');
  assert.equal(r.targetId, 'dummy-1');
  assert.equal(r.zone, 'body');
  assert.equal(r.blocked, false);
});

test('hitdetect: xarita — (-13, 4.5) dan dummy-1 crate-2 tomonidan TO‘SILADI', () => {
  const d = TRAINING_DUMMIES[0];
  const a = aimAt([-13, EYE, 4.5], [d.x, d.y + TARGET_CENTRE_Y, d.z]);
  const targets = [{ id: d.id, alive: true, zones: humanoidZones(d.x, d.y, d.z) }];
  const r = shot({ ...a, maxDistance: 60, colliders: COLLIDERS, targets });
  assert.equal(r.kind, 'wall');
  assert.equal(r.blocked, true);
  assert.equal(r.colliderId, 'crate-2');
  assert.equal(r.colliderKind, 'crate');
  assert.ok(r.distance < 1.6, `devor yaqin: ${r.distance.toFixed(2)}`);
});

test('hitdetect: xarita — SPAWN A dan dummy-5 divider-nw tomonidan TO‘SILADI', () => {
  const d = TRAINING_DUMMIES[4];                       // dummy-5 (-8, 0, -12)
  const a = aimAt([SPAWNS.A.x, SPAWNS.A.y + EYE, SPAWNS.A.z], [d.x, d.y + TARGET_CENTRE_Y, d.z]);
  const targets = [{ id: d.id, alive: true, zones: humanoidZones(d.x, d.y, d.z) }];
  const r = shot({ ...a, maxDistance: 60, colliders: COLLIDERS, targets });
  assert.equal(r.kind, 'wall');
  assert.equal(r.colliderId, 'divider-nw');
});

test('hitdetect: xarita — (-13.5, 0.9) dan dummy-2 crate-4 USTIDAN o‘tadi (3D nur)', () => {
  const d = TRAINING_DUMMIES[1];                       // dummy-2 (-16, 0, 2.6)
  const a = aimAt([-13.5, EYE, 0.9], [d.x, d.y + TARGET_CENTRE_Y, d.z]);
  const targets = [{ id: d.id, alive: true, zones: humanoidZones(d.x, d.y, d.z) }];
  const r = shot({ ...a, maxDistance: 60, colliders: SOLID_BOXES, targets });
  assert.equal(r.kind, 'target', `kind=${r.kind} wall=${r.colliderId}`);
  assert.equal(r.targetId, 'dummy-2');
});

// ---------------- 3) health / damage modeli ----------------
test('health: HP kamayadi, 0 da clamp, o‘lim bir marta', () => {
  const h = createHealth(100, { label: 't' });
  let r = applyDamage(h, { amount: 30, eventId: 'e1' });
  assert.equal(r.accepted, true);
  assert.equal(r.hp, 70);
  assert.equal(h.hp, 70);
  r = applyDamage(h, { amount: 500, eventId: 'e2' });
  assert.equal(r.accepted, true);
  assert.equal(r.hp, 0);
  assert.equal(r.died, true);
  assert.equal(h.alive, false);
  assert.equal(h.deaths, 1);
  // o'limdan keyin zarar YO'Q
  r = applyDamage(h, { amount: 10, eventId: 'e3' });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'dead');
  assert.equal(h.hp, 0);
});

test('health: NaN/Infinity/manfiy/nol zarar rad etiladi', () => {
  const h = createHealth(100);
  for (const amount of [NaN, Infinity, -Infinity, 0, -5]) {
    const r = applyDamage(h, { amount, eventId: `e-${amount}` });
    assert.equal(r.accepted, false, `amount=${amount}`);
    assert.equal(r.reason, 'invalid');
  }
  assert.equal(h.hp, 100);
  assert.equal(h.alive, true);
});

test('health: dublikat eventId rad etiladi (duplicate damage YO‘Q)', () => {
  const h = createHealth(100);
  // DIQQAT: applyDamage natijasi h._result — QAYTA ISHLATILADI, shu sababli
  // qiymatlarni chaqiruvdan keyin DARHOL o'qiymiz.
  const hpAfterFirst = applyDamage(h, { amount: 26, eventId: 'shot:1:0' }).hp;
  assert.equal(hpAfterFirst, 74);
  const r2 = applyDamage(h, { amount: 26, eventId: 'shot:1:0' });
  assert.equal(r2.accepted, false);
  assert.equal(r2.reason, 'duplicate');
  assert.equal(h.hp, 74, 'dublikat zarar qo‘llanilmadi');
});

test('health: resetHealth to‘liq tiklaydi (dedupe set ham)', () => {
  const h = createHealth(60);
  applyDamage(h, { amount: 20, eventId: 'x1' });
  applyDamage(h, { amount: 40, eventId: 'x2' });
  assert.equal(h.alive, false);
  resetHealth(h);
  assert.equal(h.hp, 60);
  assert.equal(h.alive, true);
  assert.equal(h.seen.size, 0);
  const r = applyDamage(h, { amount: 10, eventId: 'x1' });   // eski id qayta ishlatilishi mumkin
  assert.equal(r.accepted, true);
});

// ---------------- 4) respawn + spawn kolliziya validligi ----------------
test('respawn: SPAWNS.A va SPAWNS.B valid (xarita bo‘sh joy)', () => {
  for (const key of ['A', 'B']) {
    const v = validateSpawn(SPAWNS[key]);
    assert.equal(v.valid, true, `${key}: ${v.reason}`);
    assert.equal(v.reason, 'ok');
    assert.ok(Math.abs(v.groundY - SPAWNS[key].y) < 0.35, `groundY(${key})=${v.groundY}`);
  }
  // default nomzodlar tartibi A → B (deterministik)
  const cands = defaultRespawnCandidates();
  assert.equal(cands.length, 2);
  assert.equal(cands[0], SPAWNS.A);
  assert.equal(cands[1], SPAWNS.B);
});

test('respawn: yaroqsiz spawnlar rad etiladi', () => {
  // quti ichida (blocked)
  const boxes = [box(SPAWNS.A.x - 1, 0, -1, SPAWNS.A.x + 1, 3, 1)];
  let v = validateSpawn(SPAWNS.A, { boxes });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'blocked');
  // havoda (floating)
  v = validateSpawn({ ...SPAWNS.A, y: 3 }, {});
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'floating');
  // noto'g'ri ma'lumot
  v = validateSpawn(null, {});
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'bad_spawn');
});

test('respawn: pickSpawn — A bloklanganda B ga o‘tadi, ikkalasi bloklanganda null', () => {
  const onlyA = [box(SPAWNS.A.x - 1, 0, -1, SPAWNS.A.x + 1, 3, 1)];
  const p1 = pickSpawn(defaultRespawnCandidates(), { boxes: onlyA });
  assert.equal(p1.spawn, SPAWNS.B);
  assert.equal(p1.checks[0].valid, false);
  assert.equal(p1.checks[1].valid, true);
  const both = [...onlyA, box(SPAWNS.B.x - 1, 0, -1, SPAWNS.B.x + 1, 3, 1)];
  const p2 = pickSpawn(defaultRespawnCandidates(), { boxes: both });
  assert.equal(p2.spawn, null);
  assert.equal(p2.checks.length, 2);
});

test('respawn: applyRespawn — HP/o‘lim/o‘q-dori/pozitsiya to‘liq tiklanadi', () => {
  const loadout = createLoadout({ seed: 7 });
  const st = loadout.slots['neon-rifle'];
  st.mag = 0; st.reserve = 3; st.reloading = true; st.reloadEndsAt = 9999;
  const health = createHealth(100, { label: 'player' });
  applyDamage(health, { amount: 65, eventId: 'pre-damage' });
  const subj = createPlayerSubject({ x: 5, y: 0, z: 5 });
  subj.health = health;
  subj.loadout = loadout;
  applyRespawn(subj, SPAWNS.A);
  assert.equal(health.hp, 100);
  assert.equal(health.alive, true);
  assert.equal(st.mag, WEAPONS['neon-rifle'].magSize);
  assert.equal(st.reserve, WEAPONS['neon-rifle'].startReserve);
  assert.equal(st.reloading, false);
  assert.equal(subj.position.x, SPAWNS.A.x);
  assert.equal(subj.position.y, SPAWNS.A.y);
  assert.equal(subj.position.z, SPAWNS.A.z);
  assert.equal(subj.yaw, SPAWNS.A.yaw);
  assert.equal(subj.respawns, 1);
});

// ---------------- 5) to'liq combat loop (engine, fake clock) ----------------
const D1 = TRAINING_DUMMIES[0];

function engineState (seed = 42) {
  const state = createCombatState({ seed });
  addTarget(state, D1);
  return state;
}

const spawnAim = () => aimAt([SPAWNS.A.x, EYE, SPAWNS.A.z], [D1.x, TARGET_CENTRE_Y, D1.z]);

test('engine: aim→fire→hit→damage→HP→o‘lim→respawn (to‘liq sikl)', () => {
  const state = engineState();
  const aim = spawnAim();
  const r0 = state.result;
  let now = 0;
  let frames = 0;
  const dummy = state.targetById.get('dummy-1');
  while (dummy.health.alive && frames < 200) {
    stepCombat(state, now, 50, { fire: true }, aim);
    now += 50;
    frames += 1;
  }
  assert.ok(!dummy.health.alive, 'dummy-1 o‘ldi');
  assert.equal(state.stats.shots, 4);              // 3×26 + 22 = 100
  assert.equal(state.stats.hits, 4);
  assert.equal(state.stats.kills, 1);
  assert.equal(r0.damageTotal, 22);                // oxirgi kadr: min(hp=22, 26)
  assert.equal(r0.kills, 1);
  assert.equal(r0.hits, 1);
  assert.ok(r0.eventCount > 0, 'oxirgi kadrda hodisalar bor');
  // deterministik o'lim: dummy.respawnAt qo'yildi
  assert.equal(dummy.respawnAt, (frames - 1) * 50 + 2500);
  // 2.5s dan keyin nishon qayta tiriladi
  stepCombat(state, now + 2500, 50, {}, aim);
  assert.equal(dummy.health.alive, true);
  assert.equal(dummy.health.hp, 100);
  assert.equal(dummy.health.deaths, 1);
});

test('engine: devor bloklaydi — blocked hisobga olinadi, HP O‘ZGARMAYDI', () => {
  const state = engineState();
  const d = D1;
  setPose(state, { x: -13, y: 0, z: 4.5 }, 0, 0);
  const aim = aimAt([-13, EYE, 4.5], [d.x, TARGET_CENTRE_Y, d.z]);
  const before = state.targetById.get('dummy-1').health.hp;
  const r = stepCombat(state, 0, 50, { fire: true }, aim);
  assert.equal(r.blockedHits, 1);
  assert.equal(r.hits, 0);
  assert.equal(state.stats.blocked, 1);
  assert.equal(state.targetById.get('dummy-1').health.hp, before, 'HP o‘zgarmadi');
  let sawBlocked = false;
  for (let i = 0; i < r.eventCount; i++) if (r.events[i].type === 'blocked') sawBlocked = true;
  assert.equal(sawBlocked, true);
});

test('engine: o‘lgan o‘yinchi o‘q olmaydi → respawn pozitsiya/HP/ammo tiklaydi', () => {
  const state = engineState();
  const aim = spawnAim();
  const diedAt = 100;
  stepCombat(state, diedAt, 50, {}, aim);
  const r = damagePlayer(state, 999, 'test', diedAt);
  assert.equal(r.accepted, true);
  assert.equal(r.died, true);
  assert.equal(state.health.alive, false);
  assert.equal(state.health.deaths, 1);
  assert.ok(state.respawnAt === diedAt + 2500);
  // o'lgan holda o'q uzish rad etiladi
  const rd = stepCombat(state, diedAt + 100, 50, { fire: true }, aim);
  assert.equal(rd.shot.accepted, false);
  assert.equal(rd.shot.reason, 'dead');
  // respawn vaqti kelganda AVTOMATIK qayta tug'iladi
  const rr = stepCombat(state, diedAt + 2600, 50, {}, aim);
  assert.equal(rr.respawned, true);
  assert.equal(state.health.alive, true);
  assert.equal(state.health.hp, 100);
  assert.equal(state.position.x, SPAWNS.A.x);
  assert.equal(state.position.y, SPAWNS.A.y);
  assert.equal(state.position.z, SPAWNS.A.z);
  assert.equal(state.yaw, SPAWNS.A.yaw);
  assert.equal(state.stats.respawns, 1);
  const snap = combatSnapshot(state, {});
  assert.equal(snap.weapon.mag, WEAPONS['neon-rifle'].magSize, 'o‘q-dori to‘liq');
  assert.equal(snap.weapon.reserve, WEAPONS['neon-rifle'].startReserve);
  // respawn'dan keyin o'q uzish mumkin (keyingi kadrda)
  const rFire = stepCombat(state, diedAt + 2650, 50, { fire: true }, aim);
  assert.equal(rFire.shot.accepted, true);
});

test('engine: reload — mag defitsit to‘ldiriladi, reserve kamayadi', () => {
  const state = engineState();
  const aim = spawnAim();
  // 3 o'q (cooldown 100ms)
  stepCombat(state, 0, 50, { fire: true }, aim);
  stepCombat(state, 100, 50, { fire: true }, aim);
  stepCombat(state, 200, 50, { fire: true }, aim);
  assert.equal(state.loadout.slots['neon-rifle'].mag, 27);
  // reload boshlash
  stepCombat(state, 300, 50, { reload: true }, aim);
  assert.equal(state.loadout.slots['neon-rifle'].reloading, true);
  // davomida o'q uzilmaydi
  const rMid = stepCombat(state, 1000, 50, { fire: true }, aim);
  assert.equal(rMid.shot.accepted, false);
  assert.equal(rMid.shot.reason, 'reloading');
  // 2200ms dan keyin tugaydi
  const rEnd = stepCombat(state, 300 + 2200, 50, {}, aim);
  assert.equal(rEnd.reloadCompleted, 3);
  const st = state.loadout.slots['neon-rifle'];
  assert.equal(st.mag, 30);
  assert.equal(st.reserve, 117);
  assert.equal(st.reloading, false);
});

test('engine: qurol almashtirish — draw vaqti bloklaydi, slot magi saqlanadi', () => {
  const state = engineState();
  const aim = spawnAim();
  stepCombat(state, 0, 50, { fire: true }, aim);            // rifle: mag 29
  stepCombat(state, 100, 50, { switchTo: 'pulse-pistol' }, aim);
  assert.equal(state.loadout.index, 1);
  assert.equal(state.result.weaponSwitched, true);
  const rEarly = stepCombat(state, 200, 50, { fire: true, firePressed: true }, aim);
  assert.equal(rEarly.shot.accepted, false);
  assert.equal(rEarly.shot.reason, 'switching');
  const rOk = stepCombat(state, 500, 50, { fire: true, firePressed: true }, aim);
  assert.equal(rOk.shot.accepted, true);
  assert.equal(rOk.shot.weaponId, 'pulse-pistol');
  assert.equal(state.loadout.slots['neon-rifle'].mag, 29, 'rifle magi saqlangan');
  assert.equal(state.loadout.slots['pulse-pistol'].mag, 11);
  // unknown id rad etiladi
  const rBad = stepCombat(state, 600, 50, { switchTo: 'no-such-weapon' }, aim);
  assert.equal(rBad.weaponSwitched, false);
});

test('engine: granata — otish, fuse, portlash (minimal-real)', () => {
  const state = engineState();
  const aim = spawnAim();
  stepCombat(state, 0, 50, { switchTo: 'energy-grenade' }, aim);
  stepCombat(state, 400, 50, { fire: true, firePressed: true }, aim);   // draw 300ms tugadi
  assert.equal(state.result.shot.accepted, true);
  assert.equal(state.grenades.length, 1);
  assert.equal(state.result.grenadesActive, 1);
  assert.equal(state.loadout.slots['energy-grenade'].mag, 0);
  assert.equal(state.stats.grenadeThrows, 1);
  let threw = false; let exploded = false;
  for (let i = 0; i < state.result.eventCount; i++) {
    if (state.result.events[i].type === 'grenade-throw') threw = true;
  }
  assert.equal(threw, true);
  // fuse (1600ms) tugaganda portlaydi
  const r = stepCombat(state, 400 + 1700, 50, {}, aim);
  assert.equal(state.grenades.length, 0);
  assert.equal(state.result.grenadesActive, 0);
  assert.equal(state.stats.grenadeExplosions, 1);
  for (let i = 0; i < r.eventCount; i++) if (r.events[i].type === 'grenade-explode') exploded = true;
  assert.equal(exploded, true);
  // portlash nuqtasi xarita ichida
  for (let i = 0; i < r.eventCount; i++) {
    const ev = r.events[i];
    if (ev.type !== 'grenade-explode') continue;
    assert.ok(Math.abs(ev.x) < 22 && Math.abs(ev.z) < 16, `xarita ichida: ${ev.x},${ev.z}`);
    assert.ok(ev.y > -0.5 && ev.y < 4, `y=${ev.y}`);
  }
  // reload → yangi granata
  stepCombat(state, 2200, 50, { reload: true }, aim);
  const r2 = stepCombat(state, 2200 + 1200, 50, {}, aim);
  assert.equal(r2.reloadCompleted, 1);
  assert.equal(state.loadout.slots['energy-grenade'].mag, 1);
  assert.equal(state.loadout.slots['energy-grenade'].reserve, 1);   // startReserve 2 − 1
});

test('engine: o‘z granatasi — pastga otilgan granata o‘yinchiga self-damage beradi', () => {
  const state = engineState(7);
  const down = { origin: [SPAWNS.A.x, EYE, SPAWNS.A.z], dir: [0, -1, 0] };
  stepCombat(state, 0, 16, { switchTo: 'energy-grenade' }, down);
  stepCombat(state, 400, 16, { fire: true, firePressed: true }, down);
  assert.equal(state.grenades.length, 1, 'granata yaratilmadi');
  assert.equal(state.result.shot.accepted, true);
  let exploded = false;
  for (let t = 416; t <= 400 + 1800; t += 16) {
    const r = stepCombat(state, t, 16, {}, down);
    if (r.explosions > 0) exploded = true;
  }
  assert.equal(exploded, true, 'granata portlamadi');
  assert.equal(state.stats.grenadeExplosions, 1);
  assert.ok(state.health.hp < 100, `o‘yinchi zarar olmadi (hp=${state.health.hp})`);
  assert.ok(state.stats.selfDamage > 0, `selfDamage=${state.stats.selfDamage}`);
  assert.ok(Number.isFinite(state.stats.damageTaken) && state.stats.damageTaken > 0,
    `damageTaken=${state.stats.damageTaken} (NaN/manfiy bo‘lmasligi kerak)`);
  assert.equal(state.stats.selfDamage, state.stats.damageTaken,
    'self-damage hisobi damageTaken bilan mos emas');
});

test('engine: zarar hisobi — damageTaken/damageDealt sonlar (NaN emas)', () => {
  const state = engineState(9);
  const aim = spawnAim();
  const r = stepCombat(state, 0, 50, { fire: true }, aim);
  assert.equal(r.hits, 1);
  assert.ok(state.stats.damageDealt > 0);
  assert.ok(Number.isFinite(state.stats.damageTaken), `damageTaken=${state.stats.damageTaken}`);
  const dmg = damagePlayer(state, 25, 'grenade', 100);
  assert.equal(dmg.accepted, true);
  assert.equal(state.stats.damageTaken, 25);
  assert.equal(state.stats.selfDamage, 25);
  const dmg2 = damagePlayer(state, 30, 'test', 200);
  assert.equal(dmg2.accepted, true);
  assert.equal(state.stats.damageTaken, 55, 'damageTaken to‘planmadi');
  assert.equal(state.stats.selfDamage, 25, 'faqat grenata selfDamage ga yozilishi kerak');
});

// ---------------- 6) unumdorlik: kadr ichida allokatsiya yo'q ----------------
test('perf: 1000 kadr — result/events/shot obyektlari QAYTA ISHLATILADI', () => {
  const state = engineState();
  const aim = spawnAim();
  const r0 = state.result;
  const ev0 = r0.events;
  const shot0 = r0.shot;
  const firstEvent = ev0[0];
  let now = 0;
  for (let i = 0; i < 1000; i++) {
    stepCombat(state, now, 16.7, { fire: true }, aim);
    now += 16.7;
    assert.equal(state.result, r0, 'result obyekti bir xil');
    assert.equal(r0.events, ev0, 'events massivi bir xil');
    assert.equal(r0.shot, shot0, 'shot obyekti bir xil');
    assert.equal(r0.events[0], firstEvent, 'event elementlari qayta ishlatiladi');
  }
  // bounded: droppedEvents hisoblanadi, massiv o'smaydi
  assert.equal(r0.events.length, 64);
  assert.ok(state.stats.shots > 0);
  const snap = combatSnapshot(state, {});
  assert.equal(snap.targetCount, 1);
  assert.equal(snap.droppedEvents, r0.droppedEvents);
});

// ---------------- 7) FAZA CHEGARASI (scope leakage YO'Q) ----------------
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/.*$/gm, ' ');

test('chegara: shared combat modullarida three/DOM/tarmoq YO‘Q', () => {
  const files = [
    'shared/combat.js', 'shared/weapons.js', 'shared/health.js',
    'shared/hitdetect.js', 'shared/respawn.js', 'shared/grenade.js',
    // PHASE 7: harakat yadrosi ham SOF bo'lishi shart (klient + server bir xil)
    'shared/movement.js', 'shared/protocol-consts.js'
  ];
  const forbidden = /\b(three|THREE|document|window|fetch|WebSocket|HTMLElement|requestAnimationFrame|localStorage|performance)\b/;
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    const code = stripComments(src);
    const m = code.match(forbidden);
    assert.equal(m, null, `${f}da taqiqlangan havola: ${m && m[0]}`);
  }
});

// FAZA CHEGARASI: har bir faza FAQAT o'z qatlamini qo'shadi.
//   Phase 1–4 turlari saqlanadi · Phase 5 (avtoritet) bor · Phase 6 (lobby) bor
//   Phase 7 (sinxronizatsiya) bor · Phase 8 (jamoa/raund/ball) bor ·
//   Phase 9 (HUD/chat) bor.  Phase 10+ (voip/ranking/matchmaking/
//   scoreboard/killfeed/inventory/spectator/replay) YO'Q.
test('chegara: protocol-consts — Phase 1–8 saqlangan + Phase 9 chat; Phase 10+ YO‘Q', () => {
  const keys = Object.keys(MSG).sort();
  for (const k of ['ERROR', 'GPU_REPORT', 'HELLO', 'PING', 'PONG', 'WELCOME']) {
    assert.ok(keys.includes(k), `Phase 1 xabar turi yo‘qoldi: ${k}`);
  }
  for (const k of ['INPUT', 'RESET', 'SESSION', 'STATE', 'EVENTS', 'INPUT_ACK']) {
    assert.ok(keys.includes(k), `Phase 5 xabar turi yo‘q: ${k}`);
  }
  for (const k of ['CREATE_SESSION', 'JOIN_SESSION', 'LEAVE_SESSION', 'START_SESSION', 'LOBBY_STATE']) {
    assert.ok(keys.includes(k), `Phase 6 xabar turi yo‘q: ${k}`);
  }
  // PHASE 7: sinxronizatsiya xabari BOR (additiv)
  assert.ok(keys.includes('SNAPSHOT'), 'Phase 7 snapshot xabari yo‘q');
  // PHASE 8: match holati MAVJUD xabarlar ichida (yangi xabar turi QO'SHILMAGAN —
  // ikkinchi sinxronizatsiya kanali yo'q). Sof qoidalar modulda saqlanadi.
  assert.equal(TEAM.A, 'A');
  assert.equal(TEAM.B, 'B');
  assert.equal(MATCH_PHASE.STARTING, 'starting');
  assert.equal(MATCH_PHASE.ROUND_END, 'round_end');
  assert.equal(MATCH_PHASE.MATCH_END, 'match_end');
  // PHASE 9: chat xabarlari BOR (additiv — HUD uchun yangi xabar turi YO'Q,
  // chunki HUD mavjud STATE/SNAPSHOT/LOBBY_STATE ni o'qiydi)
  assert.equal(MSG.CHAT, 'chat', 'Phase 9 chat so\u2019rovi yo\u2018q');
  assert.equal(MSG.CHAT_MSG, 'chat-msg', 'Phase 9 chat tarqatish xabari yo\u2018q');
  // PHASE 10+: voip/ranking/matchmaking/scoreboard/killfeed xabarlari YO'Q
  const p10 = /scoreboard|voice|voip|rank|matchmak|room|lobbybrowser|killfeed|friend|clan|spectat|replay|invit/i;
  for (const k of keys) assert.ok(!p10.test(k), `Phase 10+ xabar turi kirmagan: ${k}`);
  // interpolation/reconciliation PROTOKOL turi emas — ular klient ichida
  assert.ok(!/interp|reconcil|rollback|lagcomp/i.test(keys.join(' ')),
    'interp/reconciliation protokol turi sifatida qo\u2019shilgan (u klient ichida bo\u2019lishi kerak)');
  assert.equal(SIM.TICK_HZ, 30, 'server tick 30 Hz emas');
  assert.equal(SIM.SNAPSHOT_HZ, 20, 'snapshot 20 Hz emas');
});

test('chegara: server/app.js Phase 5 avtoritet + Phase 6 lobby + Phase 7 sinxronizatsiya + Phase 8 match; Phase 9+ YO‘Q', () => {
  const src = fs.readFileSync(new URL('../../server/app.js', import.meta.url), 'utf8');
  const code = stripComments(src);
  // Phase 5: server combatni BILADI (avtoritar simulyatsiya)
  assert.match(code, /stepSession/, 'server avtoritar sessiya qadamini ishlatmaydi');
  assert.match(code, /sessionSnapshot/, 'server avtoritar snapshot yubormaydi');
  assert.match(code, /MSG\.INPUT/, 'server intent qabul qilmaydi');
  // Phase 6: lobby qatlami ulangan
  assert.match(code, /MSG\.CREATE_SESSION/);
  assert.match(code, /MSG\.JOIN_SESSION/);
  assert.match(code, /broadcastLobby/);
  // Phase 7: avtoritar harakat + 20 Hz SNAPSHOT tarqatish
  assert.match(code, /setAuthoritativeMovement/, 'server avtoritativ harakatni yoqmaydi');
  assert.match(code, /sendSnapshots/, 'server sinxronizatsiya snapshotini yubormaydi');
  assert.match(code, /MSG\.SNAPSHOT/);
  // Phase 8: jamoa/raund/ball qatlami serverda (SOF qoidalar server/match.js da)
  assert.match(code, /startMatch/, 'server matchni boshlamaydi');
  assert.match(code, /evaluateRound/, 'server raund natijasini baholamaydi');
  assert.match(code, /endRound/, 'server raundni tugatmaydi (ball yozmaydi)');
  assert.match(code, /matchSnapshot/, 'server match holatini yubormaydi');
  assert.match(code, /assignTeam/, 'server jamoani tayinlamaydi');
  // Phase 9: chat SERVERDA tarqatiladi (klient klientga to'g'ridan-to'g'ri
  // yozmaydi). Kimlik/chegara server/chat.js da — bu yerda faqat ulanish.
  assert.match(code, /MSG\.CHAT\b/, 'server chat so\u2019rovini qabul qilmaydi');
  assert.match(code, /acceptChat/, 'server chatni validatsiya qilmaydi (kimlik serverda)');
  assert.match(code, /broadcastChat/, 'server chatni tarqatmaydi');
  // Phase 10+: voip/ranking/matchmaking/scoreboard YO'Q
  // (interpolatsiya/rekonsiliatsiya KLIENTDA — serverda bo'lmasligi kerak)
  // V-773 rebuild: umumiy kill-feed va scoreboard endi talab qilinadi (mission §8/§10) — ro'yxatdan chiqarildi.
  const forbidden = /\b(interpolat\w*|reconcil\w*|rollback|lagComp\w*|voiceChat|voip|matchmak\w*|ranking|inventory|spectat\w*|replay)\b/i;
  const m = code.match(forbidden);
  assert.equal(m, null, `server/app.jsda Phase 10+ termini: ${m && m[0]}`);
});

// PHASE 8: match mantig'i BITTA modulda (parallel tizimlar YO'Q) va u SOF.
test('chegara: server/match.js — SOF match qoidalari (combat/interp/reconciliation YO‘Q)', () => {
  const src = fs.readFileSync(new URL('../../server/match.js', import.meta.url), 'utf8');
  const code = stripComments(src);
  // SOF: three.js/DOM/socket YO'Q
  assert.equal(/from\s+['"].*three/.test(code), false, 'match.js three.js import qilyapti');
  assert.equal(/\bdocument\b|\bwindow\b|WebSocket/.test(code), false, 'match.js DOM/socket ga bog\u2019langan');
  // combat mantig'i bu yerda EMAS (u shared/combat.js + server/session.js da)
  const forbiddenLogic = /\b(resolveShot|computeDamage|applyDamage|stepCombat|stepGrenade|damage|hp\b|interpolat\w*|reconcil\w*|rollback|lagComp\w*|chat|voiceChat|scoreboard|killfeed|matchmak\w*)\b/i;
  // (chat match.js ichida EMAS — u server/chat.js da)
  const m = code.match(forbiddenLogic);
  assert.equal(m, null, `server/match.jsda taqiqlangan mantiq: ${m && m[0]}`);
  // match qarorlari SHU YERDA
  assert.match(code, /evaluateRound/);
  assert.match(code, /endRound/);
  assert.match(code, /assignTeam/);
});

test('chegara: server/lobby.js — FAQAT lobby (combat/sinxronizatsiya QO‘SHILMAGAN)', () => {
  const src = fs.readFileSync(new URL('../../server/lobby.js', import.meta.url), 'utf8');
  const code = stripComments(src);
  // Lobby combat mantig'ini BILMAYDI (u shared/combat.js + server/session.js da)
  const forbidden = /\b(resolveShot|computeDamage|applyDamage|stepCombat|stepGrenade|damage|hp\b|interpolat\w*|reconcil\w*|teams?|rounds?|scores?|scoreboard|voiceChat)/i;
  const m = code.match(forbidden);
  assert.equal(m, null, `server/lobby.jsda taqiqlangan mantiq: ${m && m[0]}`);
  assert.match(code, /LOBBY_PHASE/);
  assert.match(code, /pickHost/);
});
