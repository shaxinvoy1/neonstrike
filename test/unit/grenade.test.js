// ============================================================
// NEON STRIKE — PHASE 4: Energy Grenade testlari (minimal-real)
//  - createGrenade / fuse
//  - gravitatsiya + polga qo‘nish
//  - AABB sakrash (bounce)
//  - radial zarar (falloff) + self-damage
//  - LOS darvozasi (devor ortidagi nishon 0 zarar)
//  - portlashdan keyin holat
//  - HAQIQIY xarita: crate-2 ortidagi dummy-1 zarar olmaydi
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { GRENADE_RADIUS, createGrenade, stepGrenade, explodeGrenade, grenadeDamageAt, explosionLineOfSight }
  from '../../shared/grenade.js';
import { WEAPONS } from '../../shared/weapons.js';
import { TRAINING_DUMMIES } from '../../shared/map.js';
import { humanoidZones, TARGET_RADIUS } from '../../shared/hitdetect.js';
import { SOLID_BOXES } from '../../shared/map.js';

const CFG = WEAPONS['energy-grenade'].projectile;
const box = (x0, y0, z0, x1, y1, z1) => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

test('grenade: createGrenade — boshlang‘ich holat va fuse', () => {
  const g = createGrenade({ id: 3, origin: [1, 1.6, 1], dir: [0, 0, 1], cfg: CFG, now: 100 });
  assert.equal(g.id, 3);
  assert.equal(g.alive, true);
  assert.equal(g.exploded, false);
  assert.equal(g.explodesAt, 100 + CFG.fuseMs);
  assert.equal(g.pos[0], 1); assert.equal(g.pos[1], 1.6); assert.equal(g.pos[2], 1);
  const sp = Math.hypot(g.vel[0], g.vel[1], g.vel[2]);
  assert.ok(Math.abs(sp - CFG.speed) < 1e-6, `tezlik ${sp}`);
  // normallanmagan dir ham normallanadi
  const g2 = createGrenade({ origin: [0, 1, 0], dir: [0, 0, 5], cfg: CFG, now: 0 });
  assert.ok(Math.abs(g2.vel[2] - CFG.speed) < 1e-6);
});

test('grenade: gravitatsiya — tezlik pastga oshadi va polga qo‘nadi', () => {
  const g = createGrenade({ origin: [0, 2, 0], dir: [0, 0, 1], cfg: CFG, now: 0 });
  g.vel[0] = 0; g.vel[2] = 0;                        // faqat vertikal tushish
  const vy0 = g.vel[1];
  stepGrenade(g, 16, [], 0);
  assert.ok(g.vel[1] < vy0, 'gravitatsiya: vy kamayadi');
  // 9.6s simulyatsiya — to‘liq tinimlanadi (restitusiya 0.35)
  for (let i = 0; i < 600; i++) stepGrenade(g, 16, [], 0);
  assert.ok(Math.abs(g.pos[1] - GRENADE_RADIUS) < 0.02, `pol ustida: y=${g.pos[1].toFixed(3)}`);
  assert.ok(g.bounces >= 1, 'polga sakrash hisoblangan');
  assert.ok(Math.abs(g.vel[1]) < 1e-6, `vertikal tezlik nolga yaqin: ${g.vel[1]}`);
});

test('grenade: AABB sakrash — quti ichiga KIRMAYDI, tezlik aks etadi', () => {
  const colliders = [box(2, 0, 2, 3, 1, 3)];
  const g = createGrenade({ origin: [1, 0.5, 2.5], dir: [1, 0, 0], cfg: CFG, now: 0 });
  g.vel = [CFG.speed, 0, 0];
  let bounced = 0;
  for (let i = 0; i < 20 && bounced === 0; i++) bounced += stepGrenade(g, 16, colliders, 0);
  assert.ok(bounced >= 1, 'sakrash sodir bo‘ldi');
  assert.ok(g.pos[0] < 2 - GRENADE_RADIUS, `quti tashqarida: x=${g.pos[0].toFixed(3)}`);
  assert.ok(g.vel[0] < 0, 'tezlik aks etdi (−x)');
  assert.ok(Math.abs(g.vel[0]) < CFG.speed, 'restitsiya: tezlik kamaydi');
});

test('grenade: radial falloff — markazda max, chetda min, radiusdan tashqarida 0', () => {
  assert.equal(grenadeDamageAt(CFG, 0), CFG.maxDamage);
  assert.equal(grenadeDamageAt(CFG, CFG.radius), CFG.minDamage);
  assert.equal(grenadeDamageAt(CFG, CFG.radius + 0.01), 0);
  assert.equal(grenadeDamageAt(CFG, NaN), 0);
  assert.equal(grenadeDamageAt(CFG, -1), 0);
  // monoton kamayish
  const d1 = grenadeDamageAt(CFG, 1);
  const d2 = grenadeDamageAt(CFG, 2);
  assert.ok(d1 > d2, `${d1} > ${d2}`);
});

test('grenade: self-damage ×0.6 (o‘yinchiga kamroq zarar)', () => {
  const target = grenadeDamageAt(CFG, 1, 'target');
  const player = grenadeDamageAt(CFG, 1, 'player');
  assert.ok(Math.abs(player - target * CFG.selfDamageScale) < 0.02, `${player} ≈ ${target}×0.6`);
});

test('grenade: explodeGrenade — LOS bloklangan subyekt 0 zarar oladi', () => {
  const g = createGrenade({ origin: [0, 0.8, 5], dir: [1, 0, 0], cfg: CFG, now: 0 });
  g.pos = [0, 0.8, 5];                                // portlash nuqtasi
  const colliders = [box(1.9, 0, 4.5, 2.1, 4, 5.5)];  // devor
  const subjects = [
    { id: 't-behind', kind: 'target', x: 3.5, y: 1.15, z: 5 },    // devor ortida (3.5m, radius ichida)
    { id: 't-clear', kind: 'target', x: 1.0, y: 0.8, z: 5 }       // toza (1m, devorsiz yo‘l)
  ];
  const n = explodeGrenade(g, subjects, colliders);
  assert.equal(n, 2);
  const behind = g.results.find((e) => e.id === 't-behind');
  const clear = g.results.find((e) => e.id === 't-clear');
  assert.equal(behind.los, false);
  assert.equal(behind.amount, 0, 'devor ortidagi nishon 0 zarar');
  assert.equal(clear.los, true);
  assert.ok(clear.amount >= grenadeDamageAt(CFG, 1) - 0.02, `toza zarar ${clear.amount}`);
  assert.equal(g.alive, false);
  assert.equal(g.exploded, true);
  assert.equal(g.hitCount, 2);
});

test('grenade: portlashdan keyin stepGrenade hech narsa qilmaydi', () => {
  const g = createGrenade({ origin: [0, 1, 0], dir: [0, 0, 1], cfg: CFG, now: 0 });
  explodeGrenade(g, [], []);
  const pos = [...g.pos];
  const bounces = g.bounces;
  assert.equal(stepGrenade(g, 16, [], 0), 0);
  assert.deepEqual(g.pos, pos);
  assert.equal(g.bounces, bounces);
  // qayta portlash holati buzilmaydi
  assert.equal(explodeGrenade(g, [{ id: 'x', kind: 'target', x: 0, y: 1, z: 0 }], []), 0);
  assert.equal(g.hitCount, 0);
});

test('grenade: HAQIQIY xarita — crate-2 ortidagi dummy-2 zarar OLmaydi', () => {
  // granata crate-2 (x[-14.3,-12.7], z[1.8,3.4], h=1.6) SHARQ tomonida portlaydi,
  // dummy-2 (-16, 2.6) crate G‘ARBIDA (3.5m, radius ichida) → LOS to‘silgan → 0 zarar.
  const g = createGrenade({ origin: [-12.5, 0.8, 2.6], dir: [0, 0, 1], cfg: CFG, now: 0 });
  g.pos = [-12.5, 0.8, 2.6];
  const d = TRAINING_DUMMIES[1];                       // dummy-2 (-16, 2.6)
  const subjects = [{ id: d.id, kind: 'target', x: d.x, y: 1.15, z: d.z }];
  const n = explodeGrenade(g, subjects, SOLID_BOXES);
  assert.equal(n, 1);
  assert.equal(g.results[0].los, false, 'crate-2 nur to‘sqin');
  assert.equal(g.results[0].amount, 0);
  // Qarama-qarshi holat: portlash dummy-1 yonida (1m, toza) → to‘liq LOS zarar
  const g2 = createGrenade({ origin: [0, 1, 0], dir: [0, 0, 1], cfg: CFG, now: 0 });
  g2.pos = [d.x + 1, 1.15, d.z];
  const n2 = explodeGrenade(g2, subjects, SOLID_BOXES);
  assert.equal(n2, 1);
  assert.equal(g2.results[0].los, true);
  assert.ok(g2.results[0].amount >= 70, `yaqin portlash zarari ${g2.results[0].amount}`);
});
