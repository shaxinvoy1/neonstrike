// ============================================================
// NEON STRIKE — PHASE 1 (post-P12): CORE GAMEPLAY FOUNDATION TESTLARI
//   • kamera qo'l ramkasi (yaw ishorasi, ekran o'ngi, strafe)
//   • harakat bazisi (W/A/S/D ekran fazosida)
//   • AIM MODELI: crosshair ↔ avtoritativ o'q yo'nalishi konvergensiyasi
//   • qurol rollari + bloom + fire/reload holat mashinasi
//   • granata: dushmanga AVTORITATIV zarar
//   • avtoritar PvP hodisalari (damage-taken / death qutisi)
// Barchasi SOF modullar (three.js/DOM YO'Q) — server ham AYNAN shu kodni
// ishlatadi, shuning uchun bu testlar avtoritativ xatti-harakatni o'lchaydi.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  forwardFromYaw, rightFromYaw, basisFromYaw, moveWish, lookStep,
  convergeDirection, deviationAngle, cameraPose, solveAimAngles
} from '../../shared/aim.js';
import {
  WEAPONS, WEAPON_ORDER, createLoadout, activeWeapon, activeState, tryFire,
  startReload, stepLoadout, switchTo, currentSpreadDeg, bloomAt, addBloom,
  fireBlockReason, canFire, spreadDirections, computeDamage, FIRE_REASON,
  MAX_PELLETS, WEAPON_SWITCH_MS
} from '../../shared/weapons.js';
import {
  createCombatState, addTarget, setPeerTargets, stepCombat, combatSnapshot, respawnPlayer
} from '../../shared/combat.js';
import { createHealth } from '../../shared/health.js';
// PHASE 1: server sessiyasining AVTORITAR o'lim hisobi (production yo'li)
import { createSession, stepSession } from '../../server/session.js';
import { SIM } from '../../shared/protocol-consts.js';
import { createGrenade, stepGrenade, explodeGrenade, grenadeDamageAt } from '../../shared/grenade.js';
import { CAMERA, PLAYER } from '../../shared/collision.js';
import { SPAWNS, MAP, SOLID_BOXES } from '../../shared/map.js';

const RIFLE = WEAPONS['neon-rifle'];
const PISTOL = WEAPONS['pulse-pistol'];
const SCATTER = WEAPONS['scatter-shot'];
const GRENADE_W = WEAPONS['energy-grenade'];
const DEG = Math.PI / 180;
/** Tekshiruv uchun namunali ekran: 1280x720 (NDC ↔ piksel) */
const SCREEN = { w: 1280, h: 720, fovDeg: 74 };

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const len3 = (v) => Math.hypot(v[0], v[1], v[2]);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Nuqtani NDC ga proyeksiya qiladi (three.js PerspectiveCamera bilan bir xil
 * matematika: forward = kamera +Z o'qi, right/up ekran o'qlari).
 * @returns {{x:number,y:number}|null} null — nuqta kamera orqasida
 */
function projectNdc (camPos, camFwd, camRight, camUp, aspect, point) {
  const d = [point[0] - camPos[0], point[1] - camPos[1], point[2] - camPos[2]];
  const z = dot3(d, camFwd);
  if (!(z > 1e-6)) return null;
  const x = dot3(d, camRight);
  const y = dot3(d, camUp);
  const tanY = Math.tan(SCREEN.fovDeg * DEG / 2);
  const tanX = tanY * aspect;
  return { x: (x / z) / tanX, y: (y / z) / tanY };
}

/** `solveAimAngles` natijasidan kamera nuri asosini beradi (produksiya bilan bir xil) */
function cameraFrame (playerPos, yaw, pitch) {
  const pose = cameraPose(playerPos, yaw, pitch, CAMERA);
  const fwd = pose.fwd;
  const right = rightFromYaw(yaw, [0, 0, 0]);
  // up = right × fwd (o'ng qo'l ramkasi)
  const up = [
    right[1] * fwd[2] - right[2] * fwd[1],
    right[2] * fwd[0] - right[0] * fwd[2],
    right[0] * fwd[1] - right[1] * fwd[0]
  ];
  return { pose, fwd, right, up };
}

// ============================================================
// A) KAMERA / BAZIS (P0-1)
// ============================================================
test('aim/forward: yaw/pitch konvensiyasi — yaw 0 → +Z, musbat pitch → tepa', () => {
  assert.deepEqual(forwardFromYaw(0, 0).map((v) => +v.toFixed(9)), [0, 0, 1]);
  const f90 = forwardFromYaw(Math.PI / 2, 0);
  assert.ok(near(f90[0], 1, 1e-9) && near(f90[2], 0, 1e-9), `yaw 90 → +X: ${f90}`);
  const up = forwardFromYaw(0, 0.4);
  assert.ok(up[1] > 0 && near(len3(up), 1, 1e-12), 'pitch → tepa + birlik');
  const dn = forwardFromYaw(0, -0.4);
  assert.ok(dn[1] < 0, 'manfiy pitch → pastga');
  for (let i = 0; i < 64; i++) {
    const yaw = -Math.PI + (i / 64) * Math.PI * 2;
    const pitch = -0.9 + (i / 64) * 1.5;
    assert.ok(near(len3(forwardFromYaw(yaw, pitch)), 1, 1e-12), 'forward birlik emas');
  }
});

test('aim/right: ekran o‘ngi = cross(forward, up) — THREE.js bilan bir xil qo‘l', () => {
  // yaw 0: kamera +Z ga qaraydi, yuqori +Y → ekran o'ngi -X bo'lishi SHART.
  // (P12 auditida bu teskari edi: right = cross(up, forward) → -X o'rniga +X)
  const r0 = rightFromYaw(0);
  assert.deepEqual(r0, [-1, 0, 0]);
  const up = [0, 1, 0];
  for (let i = 0; i < 32; i++) {
    const yaw = -Math.PI + (i / 32) * Math.PI * 2;
    const f = forwardFromYaw(yaw, 0);
    const cross = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    const r = rightFromYaw(yaw);
    assert.ok(near(len3(r), 1, 1e-12), 'right birlik emas');
    assert.ok(near(dot3(r, f), 0, 1e-12), 'right ⊥ forward emas');
    assert.ok(near(dot3(r, cross), 1, 1e-9), `cross(forward,up) ≠ right (yaw ${yaw})`);
  }
  // basisFromYaw — bir xil qiymatlar (XZ proyeksiyasi)
  const b = basisFromYaw(Math.PI / 2);
  assert.ok(near(b.forward.x, 1) && near(b.forward.z, 0), 'basis.forward');
  assert.ok(near(b.right.x, 0) && near(b.right.z, 1), 'basis.right');
});

test('aim/lookStep: sichqoncha O‘NGGA → yaw kamayadi (PointerLockControls), pitch klamp', () => {
  const s = lookStep(0, 0, +100, 0, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.ok(s.yaw < 0, `dx>0 → yaw kamayishi kerak: ${s.yaw}`);
  assert.ok(near(s.yaw, -100 * CAMERA.SENSITIVITY, 1e-12));
  const l = lookStep(0, 0, -100, 0, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.ok(l.yaw > 0, 'dx<0 → yaw oshadi');
  const d = lookStep(0, 0, 0, +100, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.ok(d.pitch < 0, 'dy>0 (pastga) → pitch kamayadi');
  const u = lookStep(0, 0, 0, -100, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.ok(u.pitch > 0, 'dy<0 (tepa) → pitch oshadi');
  const cl = lookStep(0, 0, 0, -100000, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.equal(cl.pitch, CAMERA.PITCH_MAX);
  const cl2 = lookStep(0, 0, 0, 100000, CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
  assert.equal(cl2.pitch, CAMERA.PITCH_MIN);
});

test('movement/basis: W/A/S/D EKRAN fazosida to‘g‘ri (yaw 0/90/180/270)', () => {
  // W — kamera forward, S — orqaga, D — ekran o‘ngi, A — ekran chap
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const f = forwardFromYaw(yaw, 0);
    const r = rightFromYaw(yaw);
    const cases = [
      { axis: [1, 0], fwd: +1, right: 0, name: 'W' },
      { axis: [-1, 0], fwd: -1, right: 0, name: 'S' },
      { axis: [0, 1], fwd: 0, right: +1, name: 'D' },
      { axis: [0, -1], fwd: 0, right: -1, name: 'A' }
    ];
    for (const c of cases) {
      const w = moveWish(yaw, c.axis[0], c.axis[1], [0, 0, 0]);
      const alongF = w[0] * f[0] + w[1] * f[2];
      const alongR = w[0] * r[0] + w[1] * r[2];
      assert.ok(near(alongF, c.fwd, 1e-12), `${c.name} @yaw ${yaw.toFixed(2)}: forward komponenti`);
      assert.ok(near(alongR, c.right, 1e-12), `${c.name} @yaw ${yaw.toFixed(2)}: ekran-o'ng komponenti`);
    }
  }
});

test('movement/basis: D — ekran o‘ngiga, A — chapga (piksel proyeksiyasi bilan)', () => {
  // Kamera yaw 0 da +Z ga qaraydi (ekran o'ngi = -X). D bosilsa o'yinchi
  // EKRANDA o'ngga siljishi kerak → dunyo X kamayadi.
  const p0 = { x: 0, y: 0, z: 0 };
  const frame = cameraFrame(p0, 0, 0);
  const before = projectNdc(frame.pose.pos, frame.fwd, frame.right, frame.up, SCREEN.w / SCREEN.h, [0, 1.2, 3]);
  const dw = moveWish(0, 0, 1, [0, 0, 0]);
  const dpos = [dw[0] * 1, 1.2, 3 + dw[1] * 1];
  const afterD = projectNdc(frame.pose.pos, frame.fwd, frame.right, frame.up, SCREEN.w / SCREEN.h, dpos);
  assert.ok(afterD.x > before.x, `D ekran o'ngiga surmadi: ${before.x} → ${afterD.x}`);
  const aw = moveWish(0, 0, -1, [0, 0, 0]);
  const apos = [aw[0] * 1, 1.2, 3 + aw[1] * 1];
  const afterA = projectNdc(frame.pose.pos, frame.fwd, frame.right, frame.up, SCREEN.w / SCREEN.h, apos);
  assert.ok(afterA.x < before.x, `A ekran chapiga surmadi: ${before.x} → ${afterA.x}`);
});

test('movement/basis: diagonal tezlik oshmaydi (normalizatsiya)', () => {
  const diag = moveWish(0.7, 1, 1, [0, 0, 0]);
  const straight = moveWish(0.7, 1, 0, [0, 0, 0]);
  assert.ok(near(Math.hypot(diag[0], diag[1]), 1, 1e-12), 'diagonal uzunlik 1 emas');
  assert.ok(near(Math.hypot(straight[0], straight[1]), 1, 1e-12), 'to‘g‘ri uzunlik 1 emas');
  const half = moveWish(0.3, 0.5, 0, [0, 0, 0]);
  assert.ok(near(Math.hypot(half[0], half[1]), 0.5, 1e-12), 'yarim tezlik buzildi');
});

// ============================================================
// B) AIM MODELI (P0-2 / P0-3)
// ============================================================
test('aim/converge: ko‘z nuri nishon nuqtasidan ANIQ o‘tadi (parallel siljish yo‘q)', () => {
  const playerPos = { x: SPAWNS.A.x, y: 0, z: SPAWNS.A.z };
  const eye = [playerPos.x, playerPos.y + PLAYER.EYE, playerPos.z];
  for (const dist of [2, 10, 20, 40]) {
    const target = [SPAWNS.A.x + dist, 1.15, SPAWNS.A.z];
    const solved = solveAimAngles(playerPos, target, CAMERA);
    const { pose, fwd, right, up } = cameraFrame(playerPos, solved.yaw, solved.pitch);
    // 1) crosshair (kamera nuri) nishonga tushadimi
    const ndc = projectNdc(pose.pos, fwd, right, up, SCREEN.w / SCREEN.h, target);
    assert.ok(ndc, `${dist} m: nishon kamera orqasida`);
    // 2) AVTORITATIV o'q yo'nalishi — ko'z nuqtasidan o'sha nuqtaga
    const dir = convergeDirection(target, eye, [0, 0, 0], { minDistance: 1.2 });
    assert.ok(dir, `${dist} m: konvergensiya null`);
    assert.ok(near(len3(dir), 1, 1e-12), 'dir birlik emas');
    // 3) nur nishondan o'tadi (lateral masofa ~0 — masofa bilan O'SMAYDI)
    const toT = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const cross = [
      toT[1] * dir[2] - toT[2] * dir[1],
      toT[2] * dir[0] - toT[0] * dir[2],
      toT[0] * dir[1] - toT[1] * dir[0]
    ];
    assert.ok(len3(cross) < 1e-9, `${dist} m: nur nishondan o'tmadi (${len3(cross)})`);
    // 4) konvergensiya kamera yo'nalishidan kichik burchakda (xavfsizlik darvozasi)
    assert.ok(deviationAngle(dir, fwd) < 35 * DEG, `${dist} m: og‘ish juda katta`);
  }
});

test('aim/crosshair: 2/10/20/40 m — NDC xatosi toleransda (doimiy lateral siljish YO‘Q)', () => {
  // P12 auditida: crosshair va o'q PARALLEL edi → 0.55 m lateral siljish,
  // ya'ni nishon markazi NDC x ≈ +0.5 da ko'rinardi. Endi xato ~0.
  const playerPos = { x: SPAWNS.A.x, y: 0, z: SPAWNS.A.z };
  const tol = { 2: 0.02, 10: 0.01, 20: 0.01, 40: 0.015 };
  const report = [];
  for (const dist of [2, 10, 20, 40]) {
    const target = [SPAWNS.A.x + dist, 1.15, SPAWNS.A.z];
    const solved = solveAimAngles(playerPos, target, CAMERA);
    const { pose, fwd, right, up } = cameraFrame(playerPos, solved.yaw, solved.pitch);
    const ndc = projectNdc(pose.pos, fwd, right, up, SCREEN.w / SCREEN.h, target);
    report.push({ dist, x: ndc.x, y: ndc.y });
    assert.ok(Math.abs(ndc.x) <= tol[dist], `${dist} m: NDC x ${ndc.x} > ${tol[dist]}`);
    assert.ok(Math.abs(ndc.y) <= tol[dist], `${dist} m: NDC y ${ndc.y} > ${tol[dist]}`);
  }
  // xato masofa bilan o'smaydi (doimiy parallaks siljishi yo'qligini isbotlaydi):
  // eng katta xato ENG YAQIN nishonda (2 m) — uzoqda deyarli 0.
  const byDist = report.map((r) => ({ d: r.dist, e: Math.abs(r.x), ey: Math.abs(r.y) }));
  for (let i = 1; i < byDist.length; i++) {
    assert.ok(byDist[i].e <= byDist[0].e + 1e-9, `masofa bilan xato o‘sdi: ${JSON.stringify(byDist)}`);
  }
  assert.ok(byDist[0].e <= tol[2], `2 m xatosi ${byDist[0].e} > ${tol[2]}`);
  const far = byDist[byDist.length - 1];
  assert.ok(far.e < 1e-3 && far.ey < 1e-3, `40 m da xato ~0 bo‘lishi kerak: ${JSON.stringify(far)}`);
});

test('aim/geometry: kamera modeli — yelka O‘NGDA, orqada DISTANCE, nishon nuri kamera nuriga mos', () => {
  const playerPos = { x: SPAWNS.A.x, y: 0, z: SPAWNS.A.z };
  const solved = solveAimAngles(playerPos, [SPAWNS.A.x + 10, 1.15, SPAWNS.A.z], CAMERA);
  const pose = cameraPose(playerPos, solved.yaw, solved.pitch, CAMERA);
  const r = rightFromYaw(solved.yaw);
  // pivot o'yinchining O'NG tomonida (ekran o'ngi = -X @yaw≈π/2)
  const dpx = pose.pivot[0] - playerPos.x;
  const dpz = pose.pivot[2] - playerPos.z;
  assert.ok(near(dpx * r[0] + dpz * r[2], CAMERA.SHOULDER, 1e-9), 'pivot yelkada emas');
  assert.ok(near(pose.pivot[1], playerPos.y + CAMERA.PIVOT_Y, 1e-9), 'pivot balandligi');
  // kamera pivotdan DISTANCE orqada
  const back = Math.hypot(pose.pos[0] - pose.pivot[0], pose.pos[1] - pose.pivot[1], pose.pos[2] - pose.pivot[2]);
  assert.ok(near(back, CAMERA.DISTANCE, 1e-9), `kamera masofasi ${back}`);
  // konvergensiya: ko'z→nishon yo'nalishi kamera yo'nalishiga YAQIN (parallel emas)
  const eye = [playerPos.x, playerPos.y + PLAYER.EYE, playerPos.z];
  const target = [SPAWNS.A.x + 10, 1.15, SPAWNS.A.z];
  const dir = convergeDirection(target, eye, [0, 0, 0], { minDistance: 1.2 });
  assert.ok(deviationAngle(dir, pose.fwd) < 6 * DEG, 'kamera va o‘q yo‘nalishi juda farq qiladi');

  // BEFORE/AFTER dalili — ESKI (konvergensiyasiz) model: yaw/pitch KO'ZDAN
  // hisoblanadi va o'q kamera yo'nalishi bo'ylab PARALLEL ketadi → doimiy
  // lateral siljish. Pastdagi o'lchov shu siljishni (≈0.5 m) ko'rsatadi.
  const eyeYaw = Math.atan2(target[0] - eye[0], target[2] - eye[2]);
  const eyePitch = Math.atan2(target[1] - eye[1], Math.hypot(target[0] - eye[0], target[2] - eye[2]));
  const oldPose = cameraPose(playerPos, eyeYaw, eyePitch, CAMERA);
  const perpOld = perpDistance(oldPose.pos, oldPose.fwd, target);
  assert.ok(perpOld > 0.3, `eski modelda lateral siljish kutilgan: ${perpOld}`);
  const perpNew = perpDistance(pose.pos, pose.fwd, target);
  assert.ok(perpNew < 1e-3, `yangi modelda crosshair nishondan o‘tmadi: ${perpNew}`);
  assert.ok(perpOld - perpNew > 0.3, 'konvergensiya siljishni yo‘qotmadi');
});

/** Nuqtadan nur (origin, dir) to'g'ri chizig'igacha perpendikulyar masofa */
function perpDistance (origin, dir, point) {
  const v = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
  const t = dot3(v, dir);
  const proj = [dir[0] * t, dir[1] * t, dir[2] * t];
  return Math.hypot(v[0] - proj[0], v[1] - proj[1], v[2] - proj[2]);
}

test('aim/converge: degenerativ holatda null (juda yaqin nuqta) + deviationAngle', () => {
  assert.equal(convergeDirection([0, 1.6, 0.1], [0, 1.62, 0], [0, 0, 0], { minDistance: 1.2 }), null);
  assert.equal(convergeDirection([NaN, 0, 0], [0, 0, 0], [0, 0, 0]), null);
  const a = [0, 0, 1];
  const b = [1, 0, 0];
  assert.ok(near(deviationAngle(a, b), Math.PI / 2, 1e-12));
  assert.ok(near(deviationAngle(a, a), 0, 1e-12));
});

// ============================================================
// C) QUROLLAR / HOLAT MASHINASI
// ============================================================
test('weapons/roles: 5 qurol — o‘zaro FARQLI rol, har birida spread/recoil konfiguratsiyasi', () => {
  const sig = new Set();
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    sig.add(`${w.damage}|${w.rpm}|${w.magSize}|${w.range}`);
    assert.ok(w.recoil && Number.isFinite(w.recoil.pitch) && Number.isFinite(w.recoil.yaw), `${id}: recoil`);
    assert.ok(Number.isFinite(w.spreadDeg.bloom) && Number.isFinite(w.spreadDeg.bloomMax) &&
      Number.isFinite(w.spreadDeg.recover), `${id}: bloom konfiguratsiyasi`);
    assert.ok(w.spreadDeg.bloomMax >= 0 && w.spreadDeg.bloom >= 0, `${id}: bloom manfiy`);
  }
  assert.equal(sig.size, 5, 'qurollar bir xil — rollar ajralmagan');
  assert.equal(RIFLE.auto, true, 'rifle avtomat');
  assert.equal(PISTOL.auto, false, 'pistol yarim-avtomat');
  assert.equal(SCATTER.pellets, 9, 'scatter pelletlar');
  assert.ok(SCATTER.spreadDeg.base > RIFLE.spreadDeg.base * 4, 'scatter konusi katta');
  assert.equal(GRENADE_W.spreadDeg.base, 0, 'granata spread 0');
  assert.equal((GRENADE_W.recoil.pitch || 0) + (GRENADE_W.recoil.yaw || 0), 0, 'granata tepkisi 0');
});

test('weapons/bloom: birinchi o‘q = baza, to‘planadi, chegaralanadi, tiklanadi (deterministik)', () => {
  const l = createLoadout({ seed: 5 });
  const st = activeState(l);
  assert.equal(st.bloom, 0);
  let now = 1000;
  const first = tryFire(l, now, { dir: [0, 0, 1], triggerEdge: true });
  assert.equal(first.accepted, true);
  assert.equal(first.spreadDeg, RIFLE.spreadDeg.base, 'birinchi o‘q bazadan farq qildi');
  let prev = st.bloom;
  for (let i = 2; i <= 8; i++) {
    now += RIFLE.intervalMs + 1;
    tryFire(l, now, { dir: [0, 0, 1], triggerEdge: true });
    assert.ok(st.bloom >= prev, 'bloom pasaydi (o‘q paytida)');
    prev = st.bloom;
  }
  assert.ok(st.bloom > 0 && st.bloom <= RIFLE.spreadDeg.bloomMax, `bloom chegarasi: ${st.bloom}`);
  assert.equal(st.maxBloom, st.bloom, 'maxBloom qayd etilmadi');
  const peak = st.bloom;
  // o'q uzmasdan kutish → tiklanish (login faqat vaqtga bog'liq, yozmasdan)
  assert.ok(near(bloomAt(RIFLE, st, now + 10000), 0, 1e-9), 'bloom tiklanmadi');
  assert.equal(st.bloom, peak, 'bloomAt holatni o‘zgartirdi (pure emas)');
  // determinizm: bir xil `now` → bir xil joriy konus
  assert.equal(currentSpreadDeg(RIFLE, st, false, now), currentSpreadDeg(RIFLE, st, false, now));
  const l2 = createLoadout({ seed: 5 });
  const st2 = activeState(l2);
  addBloom(RIFLE, st2, 1000);
  addBloom(RIFLE, st2, 1000 + RIFLE.intervalMs);
  assert.ok(near(st2.bloom, st.bloom, 1e-12), 'bloom deterministik emas');
});

test('weapons/spread: `deg` bilan joriy konus ishlatiladi; usiz baza saqlanadi', () => {
  const out = Array.from({ length: MAX_PELLETS }, () => [0, 0, 0]);
  const dir = [0, 0, 1];
  const wide = spreadDirections(dir, RIFLE, { seed: 1, shotId: 1, deg: 6 }, out);
  let maxAng = 0;
  for (let i = 0; i < wide; i++) {
    maxAng = Math.max(maxAng, Math.atan2(Math.hypot(out[i][0], out[i][1]), out[i][2]));
  }
  assert.ok(maxAng <= 6 * DEG + 1e-9 && maxAng > 2 * DEG, `deg parametri ishlamadi: ${maxAng / DEG}`);
  // deg berilmasa — Phase 4 xatti-harakati (baza)
  spreadDirections(dir, RIFLE, { seed: 1, shotId: 1 }, out);
  let baseAng = 0;
  for (let i = 0; i < 1; i++) baseAng = Math.atan2(Math.hypot(out[i][0], out[i][1]), out[i][2]);
  assert.ok(baseAng <= RIFLE.spreadDeg.base * DEG + 1e-9, 'baza konus buzildi');
});

test('weapons/state-machine: o‘likda reload BO‘LMAYDI, raund tugaganda o‘q uzilmaydi', () => {
  const l = createLoadout({ seed: 3 });
  activeState(l).mag = 10;
  const dead = startReload(l, 1000, { alive: false });
  assert.equal(dead.started, false);
  assert.equal(dead.reason, FIRE_REASON.DEAD);
  assert.equal(activeState(l).reloading, false, 'o‘likda reload boshlanib qoldi');
  const ok = startReload(l, 1000, { alive: true });
  assert.equal(ok.started, true);

  const l2 = createLoadout({ seed: 3 });
  stepLoadout(l2, 1000);
  const blocked = tryFire(l2, 1000, { dir: [0, 0, 1], triggerEdge: true, roundActive: false });
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.reason, FIRE_REASON.ROUND_OVER);
  assert.equal(activeState(l2).mag, RIFLE.magSize, 'rad etilgan o‘q o‘q-dorini sarfladi');
  const allowed = tryFire(l2, 1000, { dir: [0, 0, 1], triggerEdge: true, roundActive: true });
  assert.equal(allowed.accepted, true);
  // `roundActive` berilmasa — cheklov YO'Q (standalone xatti-harakati)
  assert.equal(fireBlockReason(createLoadout({ seed: 3 }), 0, {}), '');
});

test('weapons/state-machine: dublikat reload, kadens, o‘q-dori manfiy bo‘lmaydi', () => {
  const l = createLoadout({ seed: 9 });
  const st = activeState(l);
  st.mag = 5;
  assert.equal(startReload(l, 100).started, true);
  assert.equal(startReload(l, 150).started, false, 'dublikat reload');
  assert.equal(startReload(l, 150).reason, 'already');
  assert.equal(tryFire(l, 200, { dir: [0, 0, 1], triggerEdge: true }).reason, FIRE_REASON.RELOADING);
  stepLoadout(l, 100 + RIFLE.reloadMs);
  assert.equal(st.mag, RIFLE.magSize, 'reload to‘ldirmadi');
  // kadens: interval ichida ikkinchi o'q rad
  let now = 5000;
  assert.equal(tryFire(l, now, { dir: [0, 0, 1], triggerEdge: true }).accepted, true);
  assert.equal(tryFire(l, now + 10, { dir: [0, 0, 1], triggerEdge: true }).reason, FIRE_REASON.COOLDOWN);
  const magBefore = st.mag;
  const firedBefore = st.shotsFired;
  const reserveBefore = st.reserve;
  let shots = 0;
  for (let i = 0; i < 200; i++) {
    now += 5;
    if (tryFire(l, now, { dir: [0, 0, 1], triggerEdge: true }).accepted) shots += 1;
  }
  assert.ok(st.mag >= 0 && st.reserve >= 0, 'ammo manfiy');
  assert.ok(shots <= Math.ceil(1000 / RIFLE.intervalMs) + 1, `kadens buzildi: ${shots} o‘q / 1 s`);
  assert.equal(st.shotsFired, firedBefore + shots, 'shotsFired hisobi');
  assert.equal(st.mag, magBefore - shots, 'mag = oldingi mag − o‘qlar');
  assert.equal(st.reserve, reserveBefore, 'reserve o‘q paytida o‘zgarmadi');
});

// ============================================================
// D) GRANATA — dushman zarari (P1)
// ============================================================
test('grenade: `peer` sub' + 'ekti TO‘LIQ zarar, `self` — jazo koeffitsiyenti bilan', () => {
  const cfg = GRENADE_W.projectile;
  const near0 = grenadeDamageAt(cfg, 0, 'peer');
  assert.equal(near0, cfg.maxDamage, 'peer markazda to‘liq zarar emas');
  assert.equal(grenadeDamageAt(cfg, 0, 'self'), Math.round(cfg.maxDamage * cfg.selfDamageScale * 100) / 100);
  assert.ok(grenadeDamageAt(cfg, 0, 'peer') > grenadeDamageAt(cfg, 0, 'self'), 'peer > self');
  assert.equal(grenadeDamageAt(cfg, cfg.radius + 0.001, 'peer'), 0, 'radius tashqarisida zarar');
  assert.equal(grenadeDamageAt(cfg, NaN, 'peer'), 0);
  // masofa oshgani sari kamayadi
  let prev = Infinity;
  for (let d = 0; d <= cfg.radius; d += 0.25) {
    const v = grenadeDamageAt(cfg, d, 'peer');
    assert.ok(v <= prev + 1e-9, `masofa bilan oshdi: ${d}`);
    prev = v;
  }
});

test('grenade/explode: peer sub‘ektlar radius ichida olinadi, do‘stona — zarar 0', () => {
  const cfg = GRENADE_W.projectile;
  const g = createGrenade({ id: 1, ownerId: 'p1', origin: [0, 1, 0], dir: [0, 0, 0], cfg, now: 0 });
  const subjects = [
    { id: 'p1', kind: 'peer', x: 1.5, y: 1, z: 0 },     // dushman (1.5 m)
    { id: 'p3', kind: 'peer', x: 40, y: 1, z: 0 },      // radiusdan tashqari
    { id: 'target', kind: 'target', x: 3, y: 1, z: 0 }  // nishon (3 m — uzoqroq)
  ];
  const n = explodeGrenade(g, subjects, []);
  assert.equal(n, 2, 'radius ichidagi sub‘ektlar soni');
  const byId = {};
  for (let i = 0; i < n; i++) byId[g.results[i].id] = g.results[i];
  assert.equal(byId.p1.kind, 'peer');
  assert.ok(byId.p1.amount > 0 && byId.p1.amount <= cfg.maxDamage, 'dushman zarari 0');
  // peer TO'LIQ zarar oladi (self-jazo YO'Q); masofaga qarab kamayadi
  assert.equal(byId.p1.amount, grenadeDamageAt(cfg, 1.5, 'peer'));
  assert.equal(byId.target.amount, grenadeDamageAt(cfg, 3, 'target'));
  assert.ok(byId.p1.amount > byId.target.amount, 'yaqinroq sub‘ekt ko‘proq zarar olishi kerak');
  assert.equal(explodeGrenade(g, subjects, []), 0, 'qayta portlash mumkin bo‘ldi (idempotent emas)');
});

test('grenade/LOS: devor to‘ssa zarar 0 (mavjud kolliziya qoidasi saqlanadi)', () => {
  const cfg = GRENADE_W.projectile;
  const g = createGrenade({ id: 2, ownerId: 'p1', origin: [0, 1, 0], dir: [0, 0, 0], cfg, now: 0 });
  const wall = { min: [1.5, 0, -2], max: [1.6, 3, 2] };
  const n = explodeGrenade(g, [{ id: 'p2', kind: 'peer', x: 2.5, y: 1, z: 0 }], [wall]);
  assert.equal(n, 1);
  assert.equal(g.results[0].los, false, 'LOS false emas');
  assert.equal(g.results[0].amount, 0, 'devor ortidagi o‘yinchiga zarar berildi');
});

test('grenade/combat: otilgan granata dushmanga AVTORITATIV zarar beradi + jabrlanuvchi hodisasi', () => {
  const st = createCombatState({ boxes: [], floorY: 0, seed: 11, position: { x: 0, y: 0, z: 0 } });
  const victim = { incoming: [] };
  const ph = createHealth(100, { label: 'p2' });
  setPeerTargets(st, [{
    id: 'p2', x: 6, y: 0, z: 0, health: ph, alive: true, teamId: 'B', friendly: false, owner: victim
  }]);
  // granata to'g'ridan-to'g'ri dushman yonida portlaydi
  activeWeapon(st.loadout); // rifle
  switchTo(st.loadout, 'energy-grenade', 0);
  stepLoadout(st.loadout, 300);
  const now = 1000;
  const R0 = stepCombat(st, now, 33, { fire: true, firePressed: true }, { origin: [0, 1.6, 0], dir: [1, 0, 0] });
  assert.equal(R0.shotsAccepted, 1, 'granata otilmadi');
  assert.equal(st.grenades.length, 1, 'snaryad yaratilmadi');
  const g = st.grenades[0];
  // snaryadni portlash vaqtiga yaqinlashtiramiz (fuse)
  let t = now;
  let damageEvents = 0;
  for (let i = 0; i < 120 && st.grenades.length; i++) {
    t += 33;
    stepGrenade(g, 33, [], 0);
    const R = stepCombat(st, t, 33, {});
    for (let e = 0; e < R.eventCount; e++) {
      if (R.events[e].type === 'blast-hit' && R.events[e].targetId === 'p2') damageEvents += 1;
    }
  }
  assert.ok(damageEvents >= 1, 'granata dushmanga blast-hit bermadi');
  assert.ok(ph.hp < 100, `dushman HP o‘zgarmadi: ${ph.hp}`);
  assert.ok(victim.incoming.length >= 1, 'jabrlanuvchi avtoritar hodisa olmadi');
  const ev = victim.incoming[0];
  assert.equal(ev.attackerId, 'player', 'hujumchi kimligi');
  assert.equal(ev.weaponId, 'energy-grenade');
  assert.ok(ev.damage > 0 && ev.from.length === 3, 'zarar/yo‘nalish maydonlari');
});

test('pvp/death-accounting: dushman o‘ldirsa jabrlanuvchining O‘Z sessiyasi hisoblaydi (bir marta)', () => {
  // MUAMMO (P1 dan oldin): `onPlayerDeath` faqat self-damage yo‘lida chaqirilardi,
  // shu sababli dushman o‘ldirganda jabrlanuvchining `stats.deaths` 0 bo‘lib
  // qolardi (snapshot/HUD esa SERVER qiymatini ko‘rsatadi).
  const victim = createSession({ id: 2, now: 1000 });
  let now = 1000;
  const fatal = () => ({
    type: 'death', damage: 26, attackerId: 'p1', weaponId: 'neon-rifle',
    zone: 'body', fatal: true, from: [0, PLAYER.EYE, 0]
  });
  const d0 = victim.state.stats.deaths;
  victim.incoming.push(fatal());
  stepSession(victim, (now += SIM.TICK_MS), SIM.TICK_MS);
  assert.equal(victim.state.stats.deaths, d0 + 1, 'peer o‘limi hisoblanmadi');
  assert.ok(Number.isFinite(victim.state.respawnAt), 'respawnAt belgilanmadi');

  // IDEMPOTENT: bir raund ichida qo‘shimcha fatal hodisa hisobni oshirmaydi
  victim.incoming.push(fatal());
  stepSession(victim, (now += SIM.TICK_MS), SIM.TICK_MS);
  assert.equal(victim.state.stats.deaths, d0 + 1, 'o‘lim ikki marta hisoblandi');

  // RAUND QAYTA BOSHLANDI (respawn) → yangi o‘lim yana hisoblanadi
  respawnPlayer(victim.state, now);
  victim.incoming.push(fatal());
  stepSession(victim, (now += SIM.TICK_MS), SIM.TICK_MS);
  assert.equal(victim.state.stats.deaths, d0 + 2, 'yangi raundda o‘lim hisoblanmadi');

  // O‘lim hodisasi QAYTA chiqarilmaydi (dublikat feedback bo‘lmasin):
  // EVENTS oqimida aynan bitta `death` (bizning fatal hodisa)
  const deaths = victim.events.filter((e) => e.type === 'death').length;
  assert.ok(deaths <= 1, `death hodisasi dublikat: ${deaths}`);
});

// ============================================================
// E) AVTORITAR PvP HODISALARI (P1)
// ============================================================
function pvpState ({ peerFriendly = false, peerX = 3.5, peerY = 0 } = {}) {
  const st = createCombatState({
    boxes: [], floorY: 0, seed: 4, position: { x: 0, y: 0, z: 0 }
  });
  const victim = { incoming: [], playerId: 'p2' };
  const health = createHealth(100, { label: 'p2' });
  setPeerTargets(st, [{
    id: 'p2', x: peerX, y: peerY, z: 0, health, alive: true,
    teamId: peerFriendly ? 'A' : 'B', friendly: peerFriendly, owner: victim
  }]);
  const eye = [0, PLAYER.EYE, 0];
  const target = [peerX, peerY + 1.15, 0];
  const dir = convergeDirection(target, eye, [0, 0, 0], { minDistance: 1.2 });
  return { st, victim, health, eye, dir, target };
}

test('pvp/hitscan: konvergent o‘q dushmanga zarar beradi + jabrlanuvchi damage-taken oladi', () => {
  const { st, victim, health, eye, dir } = pvpState();
  const now = 2000;
  const R = stepCombat(st, now, 33, { fire: true, firePressed: true, moving: false },
    { origin: eye, dir });
  assert.equal(R.shotsAccepted, 1, 'o‘q qabul qilinmadi');
  assert.ok(R.hits >= 1, 'dushmanga tegilmadi');
  assert.ok(health.hp < 100, `dushman HP o‘zgarmadi: ${health.hp}`);
  assert.equal(victim.incoming.length, 1, 'jabrlanuvchi hodisasi');
  const ev = victim.incoming[0];
  assert.equal(ev.type, 'damage-taken');
  assert.equal(ev.attackerId, 'player', 'hujumchi ID (server o‘zi yozadi)');
  assert.equal(ev.weaponId, 'neon-rifle');
  assert.ok(ev.damage > 0, 'zarar 0');
  assert.deepEqual(ev.from, eye, 'zarar yo‘nalishi (otuvchi pozasi)');
  assert.equal(ev.fatal, false);
  // o'q otgan tomonda ham AVTORITAR 'hit' hodisasi
  let hitEvents = 0;
  for (let i = 0; i < R.eventCount; i++) if (R.events[i].type === 'hit' && R.events[i].targetId === 'p2') hitEvents += 1;
  assert.equal(hitEvents, 1, 'otuvchi hit hodisasi olmadi');
  // HP hech qachon manfiy bo'lmaydi
  assert.ok(health.hp >= 0);
});

test('pvp/kill: o‘lim AVTORITAR — death hodisasi + o‘q otish statistikasi', () => {
  const { st, victim, health, eye, dir } = pvpState();
  let now = 2000;
  let shots = 0;
  for (let i = 0; i < 12 && health.alive; i++) {
    const R = stepCombat(st, now, 33, { fire: true, firePressed: true }, { origin: eye, dir });
    if (R.shotsAccepted) shots += 1;
    now += RIFLE.intervalMs + 1;
  }
  assert.equal(health.alive, false, `dushman o‘lmadi (${shots} o‘q, hp ${health.hp})`);
  assert.ok(shots >= 4, `o‘lim uchun kutilgan o‘q soni: ${shots}`);
  const types = victim.incoming.map((e) => e.type);
  assert.ok(types.includes('death'), `death hodisasi yo‘q: ${types}`);
  const death = victim.incoming.find((e) => e.type === 'death');
  assert.equal(death.attackerId, 'player');
  assert.equal(death.fatal, true);
  assert.ok(st.stats.kills >= 1, 'kill statistikasi');
  // o'lgan dushman endi nishon EMAS (o'q o'tib ketadi)
  const t2 = now + RIFLE.intervalMs + 2;
  const R2 = stepCombat(st, t2, 33, { fire: true, firePressed: true }, { origin: eye, dir });
  assert.equal(R2.kills, 0, 'o‘lik nishon qayta o‘ldirildi');
});

test('pvp/friendly-fire: jamoadoshga zarar YO‘Q (avtoritar qoida)', () => {
  const { st, victim, health, eye, dir } = pvpState({ peerFriendly: true });
  const R = stepCombat(st, 2000, 33, { fire: true, firePressed: true }, { origin: eye, dir });
  assert.equal(R.shotsAccepted, 1);
  assert.equal(health.hp, 100, 'jamoadoshga zarar berildi');
  assert.equal(R.friendlyBlocked, 1, 'friendly-blocked qayd etilmadi');
  assert.equal(victim.incoming.length, 0, 'jamoadoshga hodisa yuborildi');
});

test('pvp/aim: 2/10/20/40 m — konvergent yo‘nalish AYNAN o‘sha nishonga tegadi', () => {
  for (const dist of [2, 10, 20, 40]) {
    const { st, health, eye, dir } = pvpState({ peerX: dist });
    const R = stepCombat(st, 3000, 33, { fire: true, firePressed: true }, { origin: eye, dir });
    assert.ok(R.hits >= 1, `${dist} m: o‘q nishonga tegmadi (kind=${R.targetId})`);
    assert.equal(R.targetId, 'p2', `${dist} m: boshqa nishonga tegdi`);
    assert.ok(health.hp < 100, `${dist} m: zarar 0`);
    // zarar AVTORITAR formula bo'yicha (zona × falloff) — head 2× bo'lishi mumkin
    // `resolveShot` zonaga KIRISH nuqtasidagi masofani beradi (markaz emas),
    // shuning uchun chegara zona kengligi (0.35 m) hisobga olinadi.
    const dmg = 100 - health.hp;
    assert.ok(dmg >= computeDamage(RIFLE, dist, 'legs') - 1e-9, `${dist} m: zarar juda kichik (${dmg})`);
    assert.ok(dmg <= computeDamage(RIFLE, Math.max(0, dist - 0.35), 'head') + 1e-9, `${dist} m: zarar juda katta (${dmg})`);
  }
});

// ============================================================
// F) SNAPSHOT / DIAGNOSTIKA
// ============================================================
test('combat/snapshot: spreadDeg (bloom bilan) va stats maydonlari mavjud', () => {
  const st = createCombatState({ seed: 4 });
  const s = combatSnapshot(st, {});
  assert.ok(Number.isFinite(s.weapon.spreadDeg), 'snapshot.spreadDeg yo‘q');
  assert.ok(Number.isFinite(s.weapon.bloom), 'snapshot.bloom yo‘q');
  assert.equal(s.weapon.spreadDeg, RIFLE.spreadDeg.base, 'boshlang‘ich konus bazadan farq qiladi');
  assert.ok(s.stats && typeof s.stats.hits === 'number');
});

test('combat/no-targets: nishonsiz ham qoida buzilmaydi (poligon bo‘sh)', () => {
  const st = createCombatState({ boxes: [], floorY: 0, seed: 1, position: { x: 0, y: 0, z: 0 } });
  const R = stepCombat(st, 500, 33, { fire: true, firePressed: true }, { origin: [0, 1.62, 0], dir: [0, 0, 1] });
  assert.equal(R.shotsAccepted, 1);
  assert.equal(R.hits, 0);
  assert.equal(st.stats.shots, 1);
});
