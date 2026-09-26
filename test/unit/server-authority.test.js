// ============================================================
// NEON STRIKE — PHASE 5: AVTORITATIV SERVER testlari
// Haqiqiy ishlab chiqarish modullari ishlatiladi (mock YO'Q):
//   server/session.js + server/app.js + shared/combat.js + shared/weapons.js
// Tekshiriladi: klient FAQAT intent yubora oladi; cooldown/o'q-dori/reload/
// qurol almashish/hit/zarar/HP/o'lim/respawn/granata — SERVER qarori.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import {
  createSession, seedTrainingTargets, validateInput, applyInput, stepSession,
  resetSession, sessionSnapshot, targetHp,
  SESSION_REJECT, FORBIDDEN_FIELDS
} from '../../server/session.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, SIM, PROTOCOL_VERSION } from '../../shared/protocol-consts.js';
import { WEAPONS, computeDamage } from '../../shared/weapons.js';
import { SPAWNS, SOLID_BOXES, TRAINING_DUMMIES, MAP } from '../../shared/map.js';
import { PLAYER } from '../../shared/collision.js';

const EYE = PLAYER.EYE;
const RIFLE = WEAPONS['neon-rifle'];
const PISTOL = WEAPONS['pulse-pistol'];
const GRENADE = WEAPONS['energy-grenade'];

// ---------------- yordamchilar ----------------
let SEQ = 0;
const poseAt = (x, y, z, yaw = SPAWNS.A.yaw, pitch = 0) => ({ x, y, z, yaw, pitch });
const spawnPose = () => poseAt(SPAWNS.A.x, SPAWNS.A.y, SPAWNS.A.z);

function aimFrom (origin, target) {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const dz = target[2] - origin[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return [dx / l, dy / l, dz / l];
}
const spawnAim = (target) => aimFrom([SPAWNS.A.x, SPAWNS.A.y + EYE, SPAWNS.A.z], target);
const centre = (d, y = 1.15) => [d.x, d.y + y, d.z];

/** Intent xabari (klient FAQAT shu ko'rinishda yuboradi) */
function inputMsg ({ pose, dir, intents = {}, extra = {} } = {}) {
  return {
    seq: ++SEQ,
    pose: pose || spawnPose(),
    aim: { dir: dir || [0, 0, 1] },
    intents,
    ...extra
  };
}

/** `ms` davomida server tick'larini bajaradi (deterministik dt) */
function advance (session, from, ms, dt = 20) {
  let t = from;
  const end = t + ms;
  while (t < end) {
    t += dt;
    stepSession(session, t, dt);
  }
  return t;
}

const apply = (session, msg, now) => applyInput(session, msg, now);

// ============================================================
// 1) SESSIYA / HOLAT YARATILISHI
// ============================================================
test('server: sessiya yaratiladi — server o\'z holatiga EGA (HP/o\'q-dori/nishon/spawn)', () => {
  const s = createSession({ id: 7, name: 'tester', now: 1000 });
  assert.equal(s.playerId, 'p7');
  assert.equal(s.state.health.max, 100);
  assert.equal(s.state.health.hp, 100);
  assert.equal(s.state.health.alive, true);
  assert.equal(s.state.targets.length, 8, '5 dummy + 3 halqa');
  assert.equal(s.state.targetById.get('dummy-1').health.max, 100);
  assert.equal(s.state.targetById.get('ring-1').health.max, 60, 'halqa 60 HP');
  assert.equal(s.state.position.x, SPAWNS.A.x);
  assert.equal(s.state.position.z, SPAWNS.A.z);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize);
  assert.equal(s.state.loadout.slots['neon-rifle'].reserve, RIFLE.startReserve);
  assert.equal(s.lastSeq, -1);
});

test('server: seedTrainingTargets xarita bilan mos (qayta yuklash idempotent)', () => {
  const s = createSession({ id: 1 });
  const n = seedTrainingTargets(s.state);
  assert.equal(n, 8);
  assert.equal(s.state.targets.length, 8, 'dublikat nishon yo\'q');
  assert.equal(s.state.targets[0].id, TRAINING_DUMMIES[0].id);
});

// ============================================================
// 2) INPUT VALIDATSIYASI (buzilgan buyruqlar XAVFSIZ rad etiladi)
// ============================================================
test('server: buzilgan buyruq rad etiladi (null/seq/pose/aim/intents/weapon)', () => {
  const s = createSession({ id: 1 });
  const good = { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 };
  const cases = [
    [null, SESSION_REJECT.BAD_MSG, undefined, 'null'],
    ['salom', SESSION_REJECT.BAD_MSG, undefined, 'matn'],
    [[], SESSION_REJECT.BAD_MSG, undefined, 'massiv'],
    [{ pose: good, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.BAD_SEQ, undefined, 'seq yo\'q'],
    [{ seq: NaN, pose: good, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.BAD_SEQ, undefined, 'seq NaN'],
    [{ seq: 1.5, pose: good, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.BAD_SEQ, undefined, 'seq kasr'],
    [{ seq: 1, pose: { ...good, x: NaN }, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.BAD_POSE, undefined, 'pose NaN'],
    [{ seq: 1, pose: { ...good, x: 9999 }, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.POSE_BOUNDS, undefined, 'xaritadan tashqari'],
    [{ seq: 1, pose: { ...good, y: 999 }, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.POSE_BOUNDS, undefined, 'osmonda'],
    [{ seq: 1, pose: { ...good, x: 0, z: -16.3 }, aim: { dir: [0, 0, 1] } }, SESSION_REJECT.POSE_BLOCKED, undefined, 'kollayder ichida'],
    [{ seq: 1, pose: good, aim: { dir: [0, 0, 0] } }, SESSION_REJECT.BAD_AIM, undefined, 'nol yo\'nalish'],
    [{ seq: 1, pose: good, aim: { dir: [Infinity, 0, 1] } }, SESSION_REJECT.BAD_AIM, undefined, 'Infinity yo\'nalish'],
    [{ seq: 1, pose: good, aim: { dir: [0, 0, 1] }, intents: 'fire' }, SESSION_REJECT.BAD_INTENT, undefined, 'intents matn'],
    [{ seq: 1, pose: good, aim: { dir: [0, 0, 1] }, intents: { switchTo: 'railgun' } }, SESSION_REJECT.BAD_WEAPON, undefined, 'yo\'q qurol']
  ];
  for (const [msg, reason, field, label] of cases) {
    const r = validateInput(s, msg, 0);
    assert.equal(r.ok, false, `${label}: qabul qilindi`);
    assert.equal(r.reason, reason, `${label}: sabab ${r.reason}`);
    if (field) assert.equal(r.field, field);
  }
});

test('server: klient avtoritar maydonlarni (damage/hp/ammo/cooldown/...) yubora OLMAYDI', () => {
  const s = createSession({ id: 1 });
  const good = { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z, yaw: 0, pitch: 0 };
  for (const f of FORBIDDEN_FIELDS) {
    const msg = { seq: 1, pose: good, aim: { dir: [0, 0, 1] }, intents: {}, [f]: 9999 };
    const r = validateInput(s, msg, 0);
    assert.equal(r.ok, false, `${f} qabul qilindi`);
    assert.equal(r.reason, SESSION_REJECT.FORBIDDEN_AUTHORITY, `${f} sabab`);
    assert.equal(r.field, f, `${f} maydon`);
  }
  // "Cheat" paketi: zarar + o'lim + o'q-dori birga → butunlay rad etiladi
  const cheat = {
    seq: 1, pose: good, aim: { dir: [0, 0, 1] },
    intents: { fire: true }, damage: 500, targetHp: 0, hit: true, alive: false, ammo: 999
  };
  const r = applyInput(s, cheat, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, SESSION_REJECT.FORBIDDEN_AUTHORITY);
  assert.equal(s.state.targetById.get('dummy-1').health.hp, 100, 'nishon HP tegmadi');
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize, 'o\'q-dori o\'zgarmadi');
  assert.equal(s.state.health.alive, true, 'o\'yinchi o\'lmadi');
  assert.equal(s.state.health.hp, 100);
});

test('server: takroriy/eski seq rad etiladi (replay himoyasi)', () => {
  const s = createSession({ id: 1 });
  const m1 = inputMsg({});
  assert.equal(apply(s, m1, 0).ok, true);
  const again = { ...m1 };
  assert.equal(apply(s, again, 1).reason, SESSION_REJECT.DUPLICATE_SEQ);
  const older = inputMsg({});
  older.seq = 0;
  assert.equal(apply(s, older, 2).reason, SESSION_REJECT.STALE_SEQ);
  s.lastSeq = 50;
  const old2 = { ...inputMsg({}), seq: 10 };
  assert.equal(apply(s, old2, 3).reason, SESSION_REJECT.STALE_SEQ);
});

test('server: qabul qilingan buyruq pozani server holatiga yozadi + origin server tomonidan', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  const r = apply(s, inputMsg({ pose: poseAt(SPAWNS.A.x, SPAWNS.A.y, SPAWNS.A.z, 1.2, 0.3), dir }), 500);
  assert.equal(r.ok, true);
  assert.equal(s.state.position.x, SPAWNS.A.x);
  assert.equal(s.state.yaw, 1.2);
  assert.equal(s.state.pitch, 0.3);
  // origin klientdan EMAS — server o'zi hisoblaydi (ko'z balandligi)
  assert.equal(s.state.aimOrigin[1], SPAWNS.A.y + EYE);
  const l = Math.hypot(...s.state.aimDir);
  assert.ok(Math.abs(l - 1) < 1e-9, 'yo\'nalish normallashgan');
});

// ============================================================
// 3) SERVER: COOLDOWN / O'Q-DORI
// ============================================================
test('server: cooldown/o\'q-dori SERVER qarori (bir tick=1 o\'q, 100 ms oraliq)', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  let now = 1000;

  // 1) birinchi o'q
  assert.equal(apply(s, inputMsg({ dir, intents: { fire: true } }), now).ok, true);
  let R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 1);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize - 1);

  // 2) ayni vaqtda yana otish → cooldown rad (klient "cooldown" boshqara olmaydi)
  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 0);
  assert.equal(R.shotsRejected, 1);
  assert.equal(R.shot.reason, 'cooldown');
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize - 1, 'o\'q-dori kamaymadi');

  // 3) 100 ms dan keyin yana otadi
  now += RIFLE.intervalMs + 1;
  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 1);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize - 2);
});

test('server: 1 soniyada 600 RPM kadans (server vaqti bilan, 30 Hz tick)', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  let now = 0;
  const shots = [];
  // har tick'da trigger ushlab turiladi (klient xatti-harakati)
  for (let i = 0; i < 30; i++) {
    apply(s, inputMsg({ dir, intents: { fire: true, firePressed: false } }), now);
    const R = stepSession(s, now, SIM.TICK_MS);
    if (R.shotsAccepted) shots.push(now);
    now += SIM.TICK_MS;
  }
  // 30 tick ≈ 1 s → 600 RPM = 10 o'q (tick kvantlanishi ±1)
  assert.ok(shots.length >= 9 && shots.length <= 11, `1 s da ${shots.length} o'q`);
  assert.ok(s.state.loadout.slots['neon-rifle'].mag <= RIFLE.magSize - 9);
});

// ============================================================
// 4) SERVER: RELOAD / QUROL ALMASHISH
// ============================================================
test('server: reload SERVER tomonidan boshqariladi (to\'liq mag rad, vaqt serverda)', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  let now = 0;

  // to'liq mag → reload boshlanmaydi
  apply(s, inputMsg({ dir, intents: { reload: true } }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(s.state.loadout.slots['neon-rifle'].reloading, false);

  // 3 o'q otib, keyin reload
  for (let i = 0; i < 3; i++) {
    apply(s, inputMsg({ dir, intents: { fire: true } }), now);
    stepSession(s, now, SIM.TICK_MS);
    now += RIFLE.intervalMs + 1;
  }
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize - 3);

  apply(s, inputMsg({ dir, intents: { reload: true } }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(s.state.loadout.slots['neon-rifle'].reloading, true);

  // reload davomida o'q uzib bo'lmaydi + o'q-dori hali to'lmagan
  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  const mid = stepSession(s, now, SIM.TICK_MS);
  assert.equal(mid.shot.reason, 'reloading');
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize - 3);

  // reload tugashi SERVER taymeri bilan
  now += RIFLE.reloadMs + 1;
  apply(s, inputMsg({ dir, intents: {} }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(s.state.loadout.slots['neon-rifle'].reloading, false);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize);
  assert.equal(s.state.loadout.slots['neon-rifle'].reserve, RIFLE.startReserve - 3);
});

test('server: qurol almashish SERVER qarori (draw bloklaydi, faqat mavjud qurol)', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  let now = 0;

  assert.equal(
    apply(s, inputMsg({ dir, intents: { switchTo: 'railgun' } }), now).reason,
    SESSION_REJECT.BAD_WEAPON);

  apply(s, inputMsg({ dir, intents: { switchTo: 'pulse-pistol' } }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(s.state.loadout.slots[PISTOL.id].id, 'pulse-pistol');

  // draw (300 ms) davomida otish bloklanadi
  apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
  const mid = stepSession(s, now, SIM.TICK_MS);
  assert.equal(mid.shot.accepted, false);
  assert.equal(mid.shot.reason, 'switching');

  now += 320;
  apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
  const after = stepSession(s, now, SIM.TICK_MS);
  assert.equal(after.shotsAccepted, 1);
  assert.equal(after.shot.weaponId, 'pulse-pistol');
});

// ============================================================
// 5) SERVER: HIT / ZARAR / DEVOR / HP
// ============================================================
test('server: hit natijasi va zarar SERVER tomonidan hisoblanadi (dummy-1)', () => {
  const s = createSession({ id: 1 });
  const d = TRAINING_DUMMIES[0];
  const dir = spawnAim(centre(d));
  const now = 1000;

  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  const R = stepSession(s, now, SIM.TICK_MS);

  assert.equal(R.shotsAccepted, 1);
  assert.equal(R.hits, 1);
  assert.equal(R.targetId, 'dummy-1');
  assert.equal(R.zone, 'body');

  const applied = targetHp(s, 'dummy-1');
  // zarar server formulasi bilan bir xil bo'lishi SHART (klient raqami EMAS)
  const expected = computeDamage(RIFLE, R.events.find((e) => e.type === 'hit').distance, 'body');
  assert.equal(applied, 100 - expected);
  assert.equal(applied, 74, '26 zarar (falloff boshida)');
  assert.equal(s.state.stats.damageDealt, expected);
  assert.equal(s.state.stats.shots, 1);
});

test('server: devor nishonni to\'sadi (HP o\'zgarmaydi, blocked sanaladi)', () => {
  const s = createSession({ id: 1 });
  const d = TRAINING_DUMMIES[0];
  // (-13, 4.5) → dummy-1 crate-2 bilan to'silgan (Phase 3/4 fixture)
  const pose = poseAt(-13, 0, 4.5, 0, 0);
  const dir = aimFrom([-13, EYE, 4.5], centre(d));
  const now = 1000;

  apply(s, inputMsg({ pose, dir, intents: { fire: true } }), now);
  const R = stepSession(s, now, SIM.TICK_MS);

  assert.equal(R.shotsAccepted, 1);
  assert.equal(R.hits, 0);
  assert.equal(R.blockedHits, 1);
  assert.equal(targetHp(s, 'dummy-1'), 100, 'devor ortidagi nishon zarar olmadi');
  const blocked = R.events.find((e) => e.type === 'blocked');
  assert.ok(blocked, 'blocked hodisasi yo\'q');
  assert.equal(blocked.blocked, true);
});

test('server: o\'q uzish o\'q-dorini tugatsa — quruq otish rad etiladi (target\'siz)', () => {
  const s = createSession({ id: 1, seed: 1 });
  // scatter-shot: 6 o'q, tez tugaydi
  const dir = [0, 0, -1];
  let now = 0;
  apply(s, inputMsg({ dir, intents: { switchTo: 'scatter-shot' } }), now);
  stepSession(s, now, SIM.TICK_MS);
  now += 320;
  for (let i = 0; i < 6; i++) {
    apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
    const R = stepSession(s, now, SIM.TICK_MS);
    assert.equal(R.shotsAccepted, 1, `o'q ${i + 1} qabul qilinmadi`);
    now += WEAPONS['scatter-shot'].intervalMs + 1;
  }
  assert.equal(s.state.loadout.slots['scatter-shot'].mag, 0);
  // semi-auto: yangi bosish (edge) bilan ham o'q yo'q → sabab 'empty'
  apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
  const R0 = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R0.shotsAccepted, 0);
  assert.equal(R0.shot.reason, 'empty');
  // trigger ushlab turilsa (edge yo'q) — semi-auto ustuvorligi 'semi-held'
  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  const R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 0);
  assert.equal(R.shot.reason, 'semi-held');
  assert.equal(s.state.loadout.slots['scatter-shot'].mag, 0, 'manfiy o\'q-dori YO\'Q');
});

test('server: o\'lik o\'yinchi o\'q uza olmaydi (holat o\'tishi serverda)', () => {
  const s = createSession({ id: 1 });
  const dir = spawnAim(centre(TRAINING_DUMMIES[0]));
  // server tomonda o'lim holati (avtoritar yo'l: shared applyDamage)
  s.state.health.hp = 0;
  s.state.health.alive = false;
  s.state.respawnAt = Number.POSITIVE_INFINITY;   // respawn hali yo'q
  const now = 500;
  apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
  const R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 0);
  assert.equal(R.shot.reason, 'dead');
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize, 'o\'q-dori tegmadi');
});

// ============================================================
// 6) SERVER: NISHON O'LIMI / RESPAWN
// ============================================================
test('server: nishon o\'limi va 2500 ms respawn SERVER taymeri bilan', () => {
  const s = createSession({ id: 1 });
  const d = TRAINING_DUMMIES[0];
  const dir = spawnAim(centre(d, 1.6));      // bosh zonasi (2.0x)
  let now = 0;

  // boshga 2 o'q → 100 HP tugaydi (26*2 = 52 har biri)
  for (let i = 0; i < 2; i++) {
    apply(s, inputMsg({ dir, intents: { fire: true, firePressed: true } }), now);
    stepSession(s, now, SIM.TICK_MS);
    now += RIFLE.intervalMs + 1;
  }
  const t = s.state.targetById.get('dummy-1');
  assert.equal(t.health.alive, false, 'nishon o\'lmadi');
  assert.equal(t.health.deaths, 1);
  assert.ok(Number.isFinite(t.respawnAt), 'respawnAt serverda belgilanmagan');
  assert.equal(t.respawnAt, now - RIFLE.intervalMs - 1 + t.respawnMs, 'respawn = o\'lim + 2500 ms');

  // respawn vaqti kelguncha o'lik qoladi (server taymeri)
  now = t.respawnAt - 100;
  apply(s, inputMsg({ dir, intents: {} }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(t.health.alive, false, 'respawn erta bo\'ldi');

  // vaqt kelgach tiriladi (server tomonidan)
  now = t.respawnAt + 50;
  apply(s, inputMsg({ dir, intents: {} }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(t.health.alive, true);
  assert.equal(t.health.hp, 100);
  assert.equal(t.respawnAt, Number.POSITIVE_INFINITY);
});

// ============================================================
// 7) SERVER: GRANATA (spawn/gravitatsiya/fuse/portlash/o'z zarari)
// ============================================================
test('server: granata SERVER tomonidan simulyatsiya qilinadi (spawn→portlash)', () => {
  const s = createSession({ id: 1 });
  let now = 0;
  const down = [0, -1, 0];

  apply(s, inputMsg({ dir: down, intents: { switchTo: 'energy-grenade' } }), now);
  stepSession(s, now, SIM.TICK_MS);
  now += 320;                                   // draw

  apply(s, inputMsg({ dir: down, intents: { fire: true, firePressed: true } }), now);
  const R = stepSession(s, now, SIM.TICK_MS);
  assert.equal(R.shotsAccepted, 1);
  assert.equal(s.state.grenades.length, 1, 'granata serverda yaratilmadi');
  assert.equal(s.state.stats.grenadeThrows, 1);

  const g = s.state.grenades[0];
  const startY = g.pos[1];
  assert.ok(startY > 1.5, 'granata ko\'z balandligida paydo bo\'ldi');

  // gravitatsiya: bir necha tick'dan keyin pastga tushgan
  now = advance(s, now, 300);
  assert.ok(s.state.grenades.length === 1 && s.state.grenades[0].pos[1] < startY,
    'granata gravitatsiya ta\'sirida tushmadi');

  // fuse → portlash (server vaqti)
  now = advance(s, now, GRENADE.projectile.fuseMs);
  assert.equal(s.state.grenades.length, 0, 'granata portlashdan keyin yo\'qolmadi');
  assert.equal(s.state.stats.grenadeExplosions, 1);
});

test('server: granata o\'z zarari 0.6 koeffitsient bilan SERVERDA qo\'llanadi', () => {
  const s = createSession({ id: 1 });
  let now = 0;
  const down = [0, -1, 0];
  apply(s, inputMsg({ dir: down, intents: { switchTo: 'energy-grenade' } }), now);
  stepSession(s, now, SIM.TICK_MS);
  now += 320;
  apply(s, inputMsg({ dir: down, intents: { fire: true, firePressed: true } }), now);
  stepSession(s, now, SIM.TICK_MS);
  now = advance(s, now, GRENADE.projectile.fuseMs + 200);

  assert.ok(s.state.stats.selfDamage > 0, `selfDamage=${s.state.stats.selfDamage}`);
  assert.ok(s.state.health.hp < 100, 'HP kamaymadi');
  assert.equal(s.state.stats.damageTaken, s.state.stats.selfDamage);
  // klient hech qanday zarar raqamini yubormagan — hammasi serverdan
  assert.equal(s.counters.rejected, 0);
});

test('server: o\'yinchini faqat SERVER o\'ldira oladi va server respawn qiladi', () => {
  const s = createSession({ id: 1 });
  let now = 0;
  const down = [0, -1, 0];

  // klient "o'ldirish"ga urinishi — RAD
  const cheat = inputMsg({ dir: down, intents: {}, extra: { hp: 0, alive: false, died: true } });
  assert.equal(apply(s, cheat, now).reason, SESSION_REJECT.FORBIDDEN_AUTHORITY);
  assert.equal(s.state.health.hp, 100);

  // avtoritar yo'l: granata bilan o'zini o'ldirish (3 ta granata)
  for (let n = 0; n < 3 && s.state.health.alive; n++) {
    apply(s, inputMsg({ dir: down, intents: { switchTo: 'energy-grenade' } }), now);
    stepSession(s, now, SIM.TICK_MS);
    now += 320;
    apply(s, inputMsg({ dir: down, intents: { fire: true, firePressed: true } }), now);
    stepSession(s, now, SIM.TICK_MS);
    now = advance(s, now, GRENADE.projectile.fuseMs + 200);
    if (s.state.health.alive) {
      apply(s, inputMsg({ dir: down, intents: { reload: true } }), now);
      stepSession(s, now, SIM.TICK_MS);
      now = advance(s, now, GRENADE.reloadMs + 60);
    }
  }
  assert.equal(s.state.health.alive, false, 'o\'yinchи o\'lmadi (self-damage yetarli emas)');
  assert.equal(s.state.health.deaths, 1);
  assert.ok(Number.isFinite(s.state.respawnAt), 'respawnAt serverda yo\'q');

  // respawn server taymeri bilan (2500 ms)
  now = advance(s, now, 2500 + 100);
  assert.equal(s.state.health.alive, true);
  assert.equal(s.state.health.hp, 100);
  assert.equal(s.state.position.x, SPAWNS.A.x);
  assert.equal(s.state.position.z, SPAWNS.A.z);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize, 'o\'q-dori tiklandi');
  assert.equal(s.state.stats.deaths, 1);
});

// ============================================================
// 8) SNAPSHOT / RESET
// ============================================================
test('server: snapshot faqat avtoritar qiymatlarni beradi (klient hisoblamaydi)', () => {
  const s = createSession({ id: 3 });
  const snap = sessionSnapshot(s, {});
  assert.equal(snap.sessionId, 3);
  assert.equal(snap.playerId, 'p3');
  assert.equal(snap.hp, 100);
  assert.equal(snap.weapon.weaponId, 'neon-rifle');
  assert.equal(snap.weapon.mag, RIFLE.magSize);
  assert.equal(snap.weapon.reserve, RIFLE.startReserve);
  assert.equal(snap.targets.length, 8);
  assert.equal(snap.targets[0].hp, 100);
  assert.equal(snap.authority.accepted, 0);
  assert.equal(snap.authority.rejected, 0);
});

test('server: resetSession spawn/HP/o\'q-dori/nishonlarni tiklaydi (seq saqlanadi)', () => {
  const s = createSession({ id: 1 });
  const d = TRAINING_DUMMIES[0];
  const dir = spawnAim(centre(d));
  let now = 0;
  apply(s, inputMsg({ dir, intents: { fire: true } }), now);
  stepSession(s, now, SIM.TICK_MS);
  assert.equal(targetHp(s, 'dummy-1'), 74);
  const seqBefore = s.lastSeq;

  resetSession(s, now);
  assert.equal(targetHp(s, 'dummy-1'), 100);
  assert.equal(s.state.loadout.slots['neon-rifle'].mag, RIFLE.magSize);
  assert.equal(s.state.stats.shots, 0);
  assert.equal(s.state.position.x, SPAWNS.A.x);
  assert.equal(s.resets, 1);
  assert.equal(s.lastSeq, seqBefore, 'replay himoyasi uchun seq saqlanadi');
});

// ============================================================
// 9) HAQIQIY WEBSOCKET: avtoritativ oqim + buzilgan trafik
// ============================================================
const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const PORT = server.httpServer.address().port;
const WS_URL = `ws://127.0.0.1:${PORT}${'/ws'}`;

function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._q = [];
    ws._waiters = [];
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
function next (ws, type = null) {
  for (let i = 0; i < ws._q.length; i++) {
    if (!type || ws._q[i].type === type) return Promise.resolve(ws._q.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`msg timeout (${type})`)), 4000);
    ws._waiters.push({ type, resolve, to });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));

test('WS: hello → welcome + session (server holat EGASI) + dastlabki state', async () => {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'authority-test' });
  const w = await next(ws, MSG.WELCOME);
  assert.equal(w.protocol, PROTOCOL_VERSION);
  const sess = await next(ws, MSG.SESSION);
  assert.equal(sess.map.name, MAP.NAME);
  assert.equal(sess.weapons.length, 4);
  const st = await next(ws, MSG.STATE);
  assert.equal(st.hp, 100);
  assert.equal(st.weapon.mag, RIFLE.magSize);
  assert.equal(st.targets.length, 8);
  assert.ok(server.state.sessions.has(sess.sessionId), 'serverda sessiya yo\'q');
  ws.close();
});

test('WS: server avtoritar oqim — ammo/cooldown/hit/HP server qarori bilan', async () => {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'authority-flow' });
  const sess = await next(ws, MSG.SESSION);
  await next(ws, MSG.STATE);

  const d = TRAINING_DUMMIES[0];
  const dir = spawnAim(centre(d));
  const base = { pose: spawnPose(), aim: { dir } };

  // 1) o'q uzish intentini yuboramiz (faqat intent!)
  send(ws, { type: MSG.INPUT, ...base, seq: 1, intents: { fire: true, firePressed: true } });
  const ack = await next(ws, MSG.INPUT_ACK);
  assert.equal(ack.accepted, true);

  // avtoritar natija STATE'da (bir nechta snapshot kutamiz)
  let st = null;
  for (let i = 0; i < 30; i++) {
    st = await next(ws, MSG.STATE);
    if (st.stats.shots >= 1 && st.targets.find((t) => t.id === 'dummy-1').hp < 100) break;
  }
  const t1 = st.targets.find((t) => t.id === 'dummy-1');
  assert.ok(st.stats.shots >= 1, 'server o\'q uzmadi');
  assert.equal(st.weapon.mag, RIFLE.magSize - st.stats.shots, 'o\'q-dori server hisobi');
  assert.ok(t1.hp < 100, `nishon HP kamaymadi: ${t1.hp}`);
  assert.ok(st.stats.damageDealt > 0);

  // 2) SERVER xotirasidagi haqiqat wire bilan AYNAN bir xil (fake EMAS)
  const live = server.state.sessions.get(sess.sessionId);
  assert.ok(live, 'server sessiyasi topilmadi');
  assert.equal(live.state.health.hp, st.hp);
  assert.equal(live.state.loadout.slots['neon-rifle'].mag, st.weapon.mag);
  assert.equal(live.state.targetById.get('dummy-1').health.hp, t1.hp);
  assert.ok(live.counters.accepted >= 1, 'server input qabul qilmadi');
  assert.equal(live.lastSeq, 1, 'server seq kuzatuvi');

  ws.close();
});

test('WS: soxta (forged) combat buyruqlari rad etiladi, server tirik qoladi', async () => {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'forger' });
  const sess = await next(ws, MSG.SESSION);
  await next(ws, MSG.STATE);
  const live = server.state.sessions.get(sess.sessionId);
  const before = {
    rejected: live.counters.rejected,
    hp: live.state.health.hp,
    mag: live.state.loadout.slots['neon-rifle'].mag,
    dummy: live.state.targetById.get('dummy-1').health.hp
  };

  // (a) to'g'ridan-to'g'ri zarar/o'lim/o'q-dori in'ektsiyasi
  send(ws, {
    type: MSG.INPUT, seq: 1, pose: spawnPose(), aim: { dir: [0, 0, -1] },
    intents: { fire: true }, damage: 100, targetHp: 0, hit: true, alive: false, ammo: 9999
  });
  const a1 = await next(ws, MSG.INPUT_ACK);
  assert.equal(a1.accepted, false);
  assert.equal(a1.reason, SESSION_REJECT.FORBIDDEN_AUTHORITY);
  assert.equal(a1.field, 'damage');

  // (b) NaN/Infinity bilan cheats
  send(ws, { type: MSG.INPUT, seq: 2, pose: spawnPose(), aim: { dir: [NaN, 0, 1] }, intents: {} });
  assert.equal((await next(ws, MSG.INPUT_ACK)).reason, SESSION_REJECT.BAD_AIM);
  send(ws, { type: MSG.INPUT, seq: 3, pose: { ...spawnPose(), x: Infinity }, aim: { dir: [0, 0, 1] }, intents: {} });
  assert.equal((await next(ws, MSG.INPUT_ACK)).reason, SESSION_REJECT.BAD_POSE);

  // (c) mavjud bo'lmagan qurol / noto'g'ri intent turi
  send(ws, { type: MSG.INPUT, seq: 4, pose: spawnPose(), aim: { dir: [0, 0, 1] }, intents: { switchTo: 'nuke' } });
  assert.equal((await next(ws, MSG.INPUT_ACK)).reason, SESSION_REJECT.BAD_WEAPON);
  send(ws, { type: MSG.INPUT, seq: 5, pose: spawnPose(), aim: { dir: [0, 0, 1] }, intents: 'fire' });
  assert.equal((await next(ws, MSG.INPUT_ACK)).reason, SESSION_REJECT.BAD_INTENT);

  // (d) takroriy seq (replay)
  send(ws, { type: MSG.INPUT, seq: 6, pose: spawnPose(), aim: { dir: [0, 0, 1] }, intents: {} });
  assert.equal((await next(ws, MSG.INPUT_ACK)).accepted, true);
  send(ws, { type: MSG.INPUT, seq: 6, pose: spawnPose(), aim: { dir: [0, 0, 1] }, intents: {} });
  assert.equal((await next(ws, MSG.INPUT_ACK)).reason, SESSION_REJECT.DUPLICATE_SEQ);

  // HOLAT o'zgarmagan (hech bir soxta raqam qabul qilinmadi)
  assert.equal(live.state.health.hp, before.hp, 'HP o\'zgardi!');
  assert.equal(live.state.health.alive, true, 'o\'yinchi "o\'ldi"!');
  assert.equal(live.state.loadout.slots['neon-rifle'].mag, before.mag, 'o\'q-dori o\'zgardi!');
  assert.equal(live.state.targetById.get('dummy-1').health.hp, before.dummy, 'nishon HP o\'zgardi!');
  assert.ok(live.counters.rejected > before.rejected);

  // (e) buzilgan JSON / noma'lum tur / katta xabar → xato, ulanish tirik
  ws.send('{{{ bu json emas');
  assert.equal((await next(ws, MSG.ERROR)).code, 'bad_json');
  send(ws, { type: 'cheat_give_damage', dmg: 9999 });
  assert.equal((await next(ws, MSG.ERROR)).code, 'unknown_type');
  ws.send(JSON.stringify({ type: MSG.INPUT, pad: 'x'.repeat(20000) }));
  assert.equal((await next(ws, MSG.ERROR)).code, 'too_big');

  // server hali ham javob beradi (crash EMAS)
  send(ws, { type: MSG.PING, t: 42 });
  const pong = await next(ws, MSG.PONG);
  assert.equal(pong.t, 42);
  assert.equal(server.state.tickErrors, 0, 'server tick xatosi');
  assert.equal(server.state.connections.size, 1);

  ws.close();
});

test('WS: sessiyasiz INPUT rad etiladi (hello yo\'q)', async () => {
  const ws = await connect();
  send(ws, { type: MSG.INPUT, seq: 1, pose: spawnPose(), aim: { dir: [0, 0, 1] }, intents: {} });
  const err = await next(ws, MSG.ERROR);
  assert.equal(err.code, 'no_session');
  ws.close();
});

test('WS: uzilganda server sessiyasi tozalanadi', async () => {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name: 'cleanup' });
  const sess = await next(ws, MSG.SESSION);
  assert.ok(server.state.sessions.has(sess.sessionId));
  ws.close();
  for (let i = 0; i < 40 && server.state.sessions.has(sess.sessionId); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(server.state.sessions.has(sess.sessionId), false, 'sessiya o\'chirilmadi');
});

test('server: 30 Hz tick loop ishlaydi (unumdorlik + tickErrors=0)', async () => {
  const t0 = server.state.tick;
  await new Promise((r) => setTimeout(r, 350));
  const t1 = server.state.tick;
  const delta = t1 - t0;
  assert.ok(delta >= 6 && delta <= 20, `350 ms da ${delta} tick (kutilgan ~10)`);
  assert.equal(server.state.tickErrors, 0);
  const tel = server.telemetry();
  assert.equal(tel.tickHz, SIM.TICK_HZ);
  assert.equal(tel.snapshotHz, SIM.SNAPSHOT_HZ);
  assert.ok(tel.loopMs < 16.6, `loop ${tel.loopMs} ms`);
});

test.after(() => server.close());
