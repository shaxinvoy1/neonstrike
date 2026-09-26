// ============================================================
// NEON STRIKE — Phase 3: kolliziya sof-math testlari (real NEON FACILITY map)
// Eslatma: map MA'LUMOT testlari (60 kollayder, 180° simmetriya, spawn/lane/
// nishon joylashuvi, zina/clearance) Phase 3 da test/unit/map.test.js ga
// ko'chirildi — bu fayl sof matematika + real map fizikasini tekshiradi.
// Ishga tushirish: npm test  (node --test ...)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP, SPAWNS, SOLID_BOXES, FLOOR_BOX, CAMERA_BOXES, REACTOR } from '../../shared/map.js';
import {
  PLAYER, CAMERA, MOVE, moveAABB, sweepCamera, rayAABB, clamp, damp
} from '../../shared/collision.js';

const box = (min, max) => ({ min, max });
const WALL = box([-1.6, 0, 4], [1.6, 3.6, 6]);   // test uchun to'siq (x: -1.6..1.6, z: 4..6)

// ---------- (arena ma’lumoti testlari Phase 3 da map.test.js ga ko‘chdi) ----------
// Eski Phase 2 arena testlari: 12 quti / spawn+props kesishmasligi. Phase 3 dan
// boshlab ular NEON FACILITY mapi uchun test/unit/map.test.js da (60 kollayder,
// yaroqli AABB, 180° simmetriya, spawn/lane/nishon joylashuvi) tekshiriladi.

// ---------- moveAABB ----------
test('moveAABB: bo‘sh maydonda delta to‘liq qo‘llanadi', () => {
  const r = moveAABB({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: -0.25 }, PLAYER.RADIUS, PLAYER.HEIGHT, [WALL]);
  assert.equal(r.x, 0.5);
  assert.equal(r.z, -0.25);
  assert.equal(r.hitX, false);
  assert.equal(r.hitZ, false);
});

test('moveAABB: to‘siqqa urilib to‘xtaydi (X o‘qi)', () => {
  const r = moveAABB({ x: -4, y: 0, z: 5 }, { x: 2.5, y: 0, z: 0 }, PLAYER.RADIUS, PLAYER.HEIGHT, [WALL]);
  assert.equal(r.hitX, true);
  assert.equal(r.x, -(1.6 + PLAYER.RADIUS), 'to‘siq yuzasidan radius masofada to‘xtashi kerak');
});

test('moveAABB: to‘siq bo‘ylab slayd — Z harakat saqlanadi', () => {
  const r = moveAABB({ x: -4, y: 0, z: 5 }, { x: 2.5, y: 0, z: 0.4 }, PLAYER.RADIUS, PLAYER.HEIGHT, [WALL]);
  assert.equal(r.hitX, true);
  assert.equal(r.hitZ, false);
  assert.ok(Math.abs(r.x - -(1.6 + PLAYER.RADIUS)) < 1e-9, `x=${r.x}`);
  assert.ok(Math.abs(r.z - 5.4) < 1e-9, `slayd: tangensial harakat yo‘qolmasligi kerak (z=${r.z})`);
});

test('moveAABB: juda katta delta ham to‘siqdan o‘tib ketmaydi (substep)', () => {
  const r = moveAABB({ x: -4, y: 0, z: 5 }, { x: 20, y: 0, z: 0 }, PLAYER.RADIUS, PLAYER.HEIGHT, [WALL]);
  assert.ok(r.steps > 1, 'katta delta qadamlarga bo‘linishi kerak');
  assert.ok(r.x < WALL.min[0], `to‘siqdan o‘tib ketdi: x=${r.x}`);
});

// ---------- STEP-UP semantikasi (Phase 3: qadam ko'tarilish) ----------
test('moveAABB: STEP_HEIGHT dan past to‘siq — o‘yinchi ustiga chiqadi', () => {
  const low = box([-1.6, 0, 4], [1.6, 0.3, 6]);
  const r = moveAABB({ x: -4, y: 0, z: 5 }, { x: 5, y: 0, z: 0 }, PLAYER.RADIUS, PLAYER.HEIGHT, [low]);
  assert.equal(r.stepped, true, 'qadam ko‘tarilishi kerak');
  assert.ok(Math.abs(r.y - 0.3) < 1e-9, `y=${r.y}`);
  assert.ok(Math.abs(r.x - 1) < 1e-6, `to‘siq ustidan o‘tib davom etishi kerak: x=${r.x}`);
});

test('moveAABB: STEP_HEIGHT dan baland to‘siq — to‘xtaydi (chiqib ketmaydi)', () => {
  const tall = box([-1.6, 0, 4], [1.6, 0.8, 6]);
  const r = moveAABB({ x: -4, y: 0, z: 5 }, { x: 5, y: 0, z: 0 }, PLAYER.RADIUS, PLAYER.HEIGHT, [tall]);
  assert.equal(r.hitX, true, 'baland to‘siq to‘sishi kerak');
  assert.equal(r.y, 0, 'ko‘tarilmasligi kerak');
  assert.ok(Math.abs(r.x - (-1.6 - PLAYER.RADIUS)) < 1e-9, `x=${r.x}`);
});

test('moveAABB: pol (max.y=0) o‘yinchini to‘sib qo‘ymaydi', () => {
  const r = moveAABB({ x: 0, y: MAP.FLOOR_Y, z: 0 }, { x: 0.3, y: 0, z: 0.3 }, PLAYER.RADIUS, PLAYER.HEIGHT, [FLOOR_BOX]);
  assert.equal(r.hitX, false);
  assert.equal(r.hitZ, false);
});

test('moveAABB: burchakka tiqilib qolsa ham xarita ichida', () => {
  let p = { x: -18, y: 0, z: -14 };
  for (let i = 0; i < 200; i++) {
    p = moveAABB(p, { x: -0.6, y: 0, z: -0.6 }, PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
  }
  assert.ok(p.x >= -MAP.HALF_X && p.z >= -MAP.HALF_Z, `devordan chiqib ketdi: ${JSON.stringify(p)}`);
});

// ---------- sweepCamera / rayAABB ----------
test('rayAABB: to‘g‘ridan-to‘g‘ri to‘siq → t topiladi', () => {
  const t = rayAABB([0, 1, 0], [0, 0, 5], WALL, CAMERA.RADIUS);
  assert.ok(t > 0 && t <= 1, `t=${t}`);
  assert.ok(Math.abs(t - (4 - CAMERA.RADIUS) / 5) < 1e-6, `t=${t}`);
});

test('rayAABB: yonidan o‘tuvchi nur → Infinity', () => {
  assert.equal(rayAABB([6, 1, 0], [0, 0, 5], WALL, CAMERA.RADIUS), Infinity);
});

test('sweepCamera: to‘siq yo‘q → to‘liq masofa, blocked=false', () => {
  const origin = { x: 0, y: 1.6, z: 0 };
  const target = { x: 0, y: 1.6, z: -3.4 };
  const r = sweepCamera(origin, target, [WALL], CAMERA.RADIUS);
  assert.equal(r.blocked, false);
  assert.ok(Math.abs(r.distance - 3.4) < 1e-9);
});

test('sweepCamera: to‘siq bor → masofa qisqaradi (kamera devorga kirmaydi)', () => {
  const origin = { x: 0, y: 1.6, z: 3.4 };
  const target = { x: 0, y: 1.6, z: 10 };  // oradagi WALL (z 4..6)
  const r = sweepCamera(origin, target, [WALL], CAMERA.RADIUS, CAMERA.MIN_DISTANCE);
  assert.equal(r.blocked, true);
  assert.ok(r.distance < 3.4, `qisqarmadi: ${r.distance}`);
  assert.ok(r.z < WALL.min[2], `kamera devor ichida: z=${r.z}`);
});

test('sweepCamera: pivot quti ichida bo‘lsa → cheksiz qisqartirish yo‘q', () => {
  const origin = { x: 0, y: 1.6, z: 5 }; // WALL ichida
  const r = sweepCamera(origin, { x: 0, y: 1.6, z: 12 }, [WALL], CAMERA.RADIUS);
  assert.equal(r.blocked, false);
});

// ---------- real map: kamera sweep ----------
test('sweepCamera: spawn A orqasidagi devor kamerani qisqartiradi (devor ichiga kirmaydi)', () => {
  const origin = { x: SPAWNS.A.x, y: CAMERA.PIVOT_Y, z: SPAWNS.A.z };
  const target = { x: SPAWNS.A.x - CAMERA.DISTANCE, y: CAMERA.PIVOT_Y, z: SPAWNS.A.z };
  const r = sweepCamera(origin, target, CAMERA_BOXES, CAMERA.RADIUS, CAMERA.MIN_DISTANCE);
  assert.equal(r.blocked, true, 'orqadagi g‘arb devori qisqartirmadi');
  assert.ok(r.distance < CAMERA.DISTANCE, `qisqarmadi: ${r.distance}`);
  assert.ok(r.x > -MAP.HALF_X, `kamera devor ichida: x=${r.x}`);
});

test('rayAABB: pol plastinkasi kamerani pol ostiga o‘tkazmaydi', () => {
  const t = rayAABB([0, CAMERA.PIVOT_Y, 0], [0, -2.5, 0], FLOOR_BOX, CAMERA.RADIUS);
  assert.ok(t > 0 && t <= 1, `pol to‘smadi: t=${t}`);
  const below = rayAABB([0, CAMERA.PIVOT_Y, 0], [0, -0.5, 0], FLOOR_BOX, CAMERA.RADIUS);
  assert.equal(below, Infinity, 'pol plastinkasi (max.y=0) nurni to‘smasligi kerak');
});

// ---------- yordamchilar ----------
test('clamp / damp: chegaralar va dt-independent silliqlash', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  const a = damp(14, 1 / 60);
  assert.ok(a > 0 && a < 1, `damp=${a}`);
  assert.ok(damp(14, 0.1) > damp(14, 0.016), 'katta dt → katta qadam');
});

test('MOVE / CAMERA konstantalari rejadagi budjetga mos', () => {
  assert.ok(MOVE.WALK > 0 && MOVE.SPRINT > MOVE.WALK);
  assert.ok(CAMERA.DISTANCE > CAMERA.MIN_DISTANCE);
  assert.ok(CAMERA.PITCH_MIN < 0 && CAMERA.PITCH_MAX > 0);
});