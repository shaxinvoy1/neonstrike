// ============================================================
// NEON STRIKE — PHASE 4: qurol tizimi testlari (SOF qoidalar)
// Vaqt (now) qo'lda boshqariladi → cooldown/reload deterministik.
// Har test HAQIQIY xatti-harakatni tekshiradi (raqam uchun test emas).
// Ishga tushirish: npm test
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEAPONS, WEAPON_ORDER, WEAPON_SWITCH_MS, MAX_PELLETS, FIRE_REASON, HIT_ZONES,
  getWeapon, computeDamage, spreadDirections, mulberry32,
  createLoadout, activeWeapon, activeState, fireBlockReason, canFire, tryFire,
  startReload, stepLoadout, switchTo, refillLoadout, loadoutSnapshot
} from '../../shared/weapons.js';

const RIFLE = WEAPONS['neon-rifle'];
const PISTOL = WEAPONS['pulse-pistol'];
const SCATTER = WEAPONS['scatter-shot'];
const GRENADE = WEAPONS['energy-grenade'];
const speed = (v) => Math.hypot(v[0], v[1], v[2]);
const angleBetween = (a, b) => Math.acos(Math.min(1, Math.max(-1,
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

/** Bir marta o'q uzib, darhol qabul qilindi/rad etildi + sababni qaytaradi */
function fireOnce (loadout, now, flags = {}) {
  const s = tryFire(loadout, now, flags);
  return { accepted: s.accepted, reason: s.reason, shotId: s.shotId, pellets: s.pellets };
}

/** Konusdagi maksimal burchak (radian) */
function maxCone (out, count, dir) {
  let m = 0;
  for (let i = 0; i < count; i++) m = Math.max(m, angleBetween(dir, out[i]));
  return m;
}

// ---------------- 1) konfiguratsiya ----------------
test('weapons: 4 qurol, muzlatilgan, slot/tartib izchil', () => {
  assert.equal(WEAPON_ORDER.length, 4);
  assert.deepEqual([...WEAPON_ORDER], ['neon-rifle', 'pulse-pistol', 'scatter-shot', 'energy-grenade']);
  assert.equal(Object.keys(WEAPONS).length, 4);
  for (const id of WEAPON_ORDER) {
    const w = getWeapon(id);
    assert.ok(w, `${id} yo‘q`);
    assert.equal(w.id, id, `${id}: id mos emas`);
    assert.ok(Object.isFrozen(w), `${id} muzlatilmagan`);
    assert.ok(Object.isFrozen(w.falloff) && Object.isFrozen(w.spreadDeg), `${id} nested muzlatilmagan`);
    assert.equal(typeof w.name, 'string');
    assert.ok(w.name.length > 3, `${id}: nom yo‘q`);
    assert.ok([1, 2, 3, 4].includes(w.slot), `${id}: slot`);
    assert.ok(['hitscan', 'projectile'].includes(w.mode), `${id}: mode`);
    assert.equal(typeof w.auto, 'boolean', `${id}: auto belgilanmagan`);
    assert.ok(w.rpm > 0 && w.rpm <= 1200, `${id}: rpm=${w.rpm}`);
    assert.ok(w.damage > 0 && w.damageMin > 0 && w.damageMin <= w.damage, `${id}: damage`);
    assert.ok(w.range > 0, `${id}: range`);
    assert.ok(w.magSize >= 1, `${id}: magSize`);
    assert.ok(w.startReserve >= 0, `${id}: reserve`);
    assert.ok(w.reloadMs >= 200 && w.reloadMs <= 5000, `${id}: reloadMs`);
    assert.ok(w.spreadDeg.base >= 0 && w.spreadDeg.moving >= w.spreadDeg.base, `${id}: spread`);
    assert.ok(w.falloff.end >= w.falloff.start, `${id}: falloff`);
    assert.ok(w.pellets >= 1 && w.pellets <= MAX_PELLETS, `${id}: pellets`);
    assert.equal(w.intervalMs, 60000 / w.rpm);
    if (w.mode === 'projectile') {
      assert.ok(w.projectile && w.projectile.speed > 0 && w.projectile.fuseMs > 0, `${id}: projectile config`);
    } else {
      assert.equal(w.projectile, null, `${id}: hitscan projectile config bo‘lmasligi kerak`);
    }
  }
  assert.equal(getWeapon('nope'), null);
  assert.ok(!('nope' in WEAPONS));
  assert.equal(HIT_ZONES.head, 2.0);
  assert.equal(HIT_ZONES.body, 1.0);
  assert.equal(HIT_ZONES.legs, 0.75);
});

test('weapons: interval va pellet budjeti rejadagi qiymatlar', () => {
  assert.equal(RIFLE.intervalMs, 100);
  assert.equal(PISTOL.intervalMs, 150);
  assert.equal(SCATTER.intervalMs, 800);
  assert.equal(GRENADE.intervalMs, 1000);
  assert.equal(RIFLE.pellets, 1);
  assert.equal(SCATTER.pellets, 9);
  assert.equal(GRENADE.magSize, 1);
  assert.equal(GRENADE.projectile.radius, 4.2);
});

// ---------------- 2) cooldown / fire-rate ----------------
test('cooldown: interval tugamaguncha o‘q uzilmaydi, tugagach uziladi', () => {
  const l = createLoadout({ seed: 1 });
  const dir = [0, 0, -1];
  const first = fireOnce(l, 1000, { dir, triggerEdge: true });
  assert.equal(first.accepted, true, 'birinchi o‘q qabul qilinmadi');
  assert.equal(first.reason, 'ok');
  assert.equal(l.slots['neon-rifle'].nextFireAt, 1100, 'nextFireAt = now + interval');

  const early = fireOnce(l, 1099, { dir, triggerEdge: true });
  assert.equal(early.accepted, false, 'cooldown ichida o‘q uzildi');
  assert.equal(early.reason, FIRE_REASON.COOLDOWN);
  assert.equal(l.slots['neon-rifle'].mag, 29, 'rad etilgan o‘q o‘q-dorini yemasligi kerak');

  const at = fireOnce(l, 1100, { dir, triggerEdge: true });
  assert.equal(at.accepted, true, 'interval tugagach o‘q uzilmadi');
  assert.equal(l.slots['neon-rifle'].mag, 28);
  assert.equal(l.slots['neon-rifle'].shotsFired, 2);
});

test('cooldown: bitta kadrda 10 marta bosilsa — aynan 1 o‘q (RIFLE auto)', () => {
  const l = createLoadout({ seed: 3 });
  const dir = [0, 0, -1];
  let accepted = 0;
  let cooldown = 0;
  for (let i = 0; i < 10; i++) {
    const r = fireOnce(l, 5000, { dir, triggerEdge: true });
    if (r.accepted) accepted++;
    else if (r.reason === FIRE_REASON.COOLDOWN) cooldown++;
  }
  assert.equal(accepted, 1, `qabul qilingan: ${accepted}`);
  assert.equal(cooldown, 9, `cooldown rad: ${cooldown}`);
  assert.equal(l.slots['neon-rifle'].mag, 29);
  assert.equal(l.slots['neon-rifle'].shotsFired, 1);
});

test('auto RIFLE: trigger ushlab turilsa 1 s da ~11 o‘q (600 rpm), magSize dan oshmaydi', () => {
  const l = createLoadout({ seed: 4 });
  const dir = [0, 0, -1];
  let accepted = 0;
  for (let t = 0; t <= 1000; t += 10) {
    if (fireOnce(l, t, { dir }).accepted) accepted++;
  }
  assert.equal(accepted, 11, `1.0 s uchun o‘q soni: ${accepted} (600 rpm → 11)`);
  assert.ok(accepted <= Math.ceil(1000 / RIFLE.intervalMs) + 1);
  for (let t = 1010; t <= 5000; t += 10) fireOnce(l, t, { dir });
  const st = l.slots['neon-rifle'];
  assert.equal(st.mag, 0, 'mag 0 ga tushmadi');
  assert.equal(st.shotsFired, 30, `jami o‘q: ${st.shotsFired} (magSize 30)`);
  assert.equal(fireBlockReason(l, 6000, { dir }), FIRE_REASON.EMPTY);
});

test('semi-auto PISTOL: edge bo‘lmasa otmaydi; ushlab turish qayta otmaydi', () => {
  const l = createLoadout({ seed: 5 });
  const dir = [0, 0, -1];
  switchTo(l, 'pulse-pistol', 0);
  stepLoadout(l, WEAPON_SWITCH_MS + 1);
  const held = fireOnce(l, 2000, { dir });
  assert.equal(held.accepted, false, 'semi-auto edgesiz o‘q uzdi');
  assert.equal(held.reason, FIRE_REASON.SEMI);
  const pressed = fireOnce(l, 2000, { dir, triggerEdge: true });
  assert.equal(pressed.accepted, true);
  for (let t = 2010; t < 2400; t += 10) {
    const r = fireOnce(l, t, { dir });
    assert.equal(r.accepted, false, `t=${t} da ushlab turish qayta o‘q uzdi`);
    assert.equal(r.reason, FIRE_REASON.SEMI);
  }
  const tooSoon = fireOnce(l, 2100, { dir, triggerEdge: true });
  assert.equal(tooSoon.accepted, false);
  assert.equal(tooSoon.reason, FIRE_REASON.COOLDOWN);
  assert.equal(fireOnce(l, 2150, { dir, triggerEdge: true }).accepted, true);
  assert.equal(l.slots['pulse-pistol'].mag, 10);
});

// ---------------- 3) o'q-dori ----------------
test('ammo: mag manfiy bo‘lmaydi, bo‘sh bo‘lsa dryFires sanaladi', () => {
  const l = createLoadout({ seed: 6 });
  switchTo(l, 'scatter-shot', 0);
  stepLoadout(l, WEAPON_SWITCH_MS + 1);
  const dir = [0, 0, -1];
  let t = 1000;
  for (let i = 0; i < 6; i++) {
    assert.equal(fireOnce(l, t, { dir, triggerEdge: true }).accepted, true);
    t += 800;
  }
  const st = l.slots['scatter-shot'];
  assert.equal(st.mag, 0);
  for (let i = 0; i < 5; i++) {
    const r = fireOnce(l, t, { dir, triggerEdge: true });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, FIRE_REASON.EMPTY);
    t += 800;
  }
  assert.equal(st.mag, 0, 'mag manfiy bo‘lib ketdi');
  assert.equal(st.dryFires, 5, `dryFires=${st.dryFires}`);
  assert.equal(st.shotsFired, 6, 'bo‘sh o‘q shotsFired ni oshirmasligi kerak');
});

test('ammo: mag + reserve + shotsFired doimiy (2000 qadam, reload bilan)', () => {
  const l = createLoadout({ seed: 9 });
  const st = l.slots['neon-rifle'];
  const total = st.mag + st.reserve;
  const dir = [0, 0, -1];
  let attempts = 0;
  for (let i = 0; i < 2000; i++) {
    const now = i * 25;
    if (i % 20 === 0) {
      if (startReload(l, now).started) attempts++;
    }
    stepLoadout(l, now);
    fireOnce(l, now, { dir });
    assert.ok(st.mag >= 0, `i=${i}: mag=${st.mag}`);
    assert.ok(st.reserve >= 0, `i=${i}: reserve=${st.reserve}`);
    assert.equal(st.mag + st.reserve + st.shotsFired, total,
      `i=${i}: o‘q-dori yo‘qoldi (${st.mag}+${st.reserve}+${st.shotsFired} ≠ ${total})`);
  }
  assert.ok(attempts >= 3, `reload urinishlari: ${attempts}`);
  assert.ok(st.reloadsCompleted >= 3, `tugagan reload: ${st.reloadsCompleted}`);
  assert.ok(st.shotsFired > 30, `o‘q uzildi: ${st.shotsFired}`);
  assert.equal(st.mag + st.reserve + st.shotsFired, total);
});

// ---------------- 4) reload ----------------
test('reload: aynan yetishmagan o‘qni oladi, reserve shuncha kamayadi', () => {
  const l = createLoadout({ seed: 7 });
  const st = l.slots['neon-rifle'];
  const dir = [0, 0, -1];
  for (let i = 0; i < 7; i++) fireOnce(l, i * 200, { dir });
  assert.equal(st.mag, 23);
  assert.equal(st.reserve, 120);
  const r = startReload(l, 3000);
  assert.equal(r.started, true);
  assert.equal(r.durationMs, RIFLE.reloadMs);
  assert.equal(r.endsAt, 3000 + RIFLE.reloadMs);
  assert.equal(st.reloading, true, 'reloading bayrog‘i qo‘yilmadi');
  const during = fireOnce(l, 3000 + RIFLE.reloadMs - 1, { dir });
  assert.equal(during.accepted, false);
  assert.equal(during.reason, FIRE_REASON.RELOADING);
  assert.equal(stepLoadout(l, 3000 + RIFLE.reloadMs - 1), null, 'erta tugadi');
  assert.equal(st.reloading, true);
  const done = stepLoadout(l, 3000 + RIFLE.reloadMs);
  assert.ok(done, 'reload tugamadi');
  assert.equal(done.reloaded, 7, `reloaded=${done.reloaded} (aynan deficit)`);
  assert.equal(st.mag, 30);
  assert.equal(st.reserve, 113, `reserve=${st.reserve} (120-7)`);
  assert.equal(st.reloading, false);
  assert.equal(st.reloadsCompleted, 1);
  assert.equal(fireOnce(l, 3000 + RIFLE.reloadMs, { dir }).accepted, true);
  assert.equal(st.mag, 29);
});

test('reload: to‘liq magazinda / reload ichida / reserve 0 — boshlanmaydi', () => {
  const l = createLoadout({ seed: 8 });
  assert.equal(startReload(l, 0).reason, 'full', 'to‘liq magazinda reload boshlandi');
  assert.equal(startReload(l, 0).started, false);
  fireOnce(l, 0, { dir: [0, 0, -1] });
  assert.equal(startReload(l, 100).started, true);
  assert.equal(startReload(l, 150).reason, 'already', 'reload ichida qayta boshlandi');
  const l2 = createLoadout({ seed: 8 });
  l2.slots['neon-rifle'].reserve = 0;
  l2.slots['neon-rifle'].mag = 5;
  assert.equal(startReload(l2, 0).reason, 'no_reserve');
});

test('reload: reserve yetmasa faqat mavjudini oladi (mag < magSize)', () => {
  const l = createLoadout({ seed: 11 });
  switchTo(l, 'pulse-pistol', 0);
  stepLoadout(l, WEAPON_SWITCH_MS + 1);
  const st = l.slots['pulse-pistol'];
  st.mag = 2;
  st.reserve = 3;
  startReload(l, 0);
  const done = stepLoadout(l, PISTOL.reloadMs);
  assert.equal(done.reloaded, 3);
  assert.equal(st.mag, 5, `mag=${st.mag} (2+3)`);
  assert.equal(st.reserve, 0);
  assert.equal(startReload(l, PISTOL.reloadMs + 1).reason, 'no_reserve');
});

// ---------------- 5) qurol almashtirish ----------------
test('switch: slot o‘q-dorisi saqlanadi, draw vaqti otishni to‘sadi', () => {
  const dir = [0, 0, -1];
  const l = createLoadout({ seed: 12 });
  for (let i = 0; i < 4; i++) fireOnce(l, i * 200, { dir });
  assert.equal(l.slots['neon-rifle'].mag, 26);
  const sw = switchTo(l, 'pulse-pistol', 1000);
  assert.equal(sw.switched, true);
  assert.equal(activeWeapon(l).id, 'pulse-pistol');
  const early = fireOnce(l, 1000 + WEAPON_SWITCH_MS - 1, { dir, triggerEdge: true });
  assert.equal(early.accepted, false);
  assert.equal(early.reason, FIRE_REASON.SWITCHING);
  assert.equal(stepLoadout(l, 1000 + WEAPON_SWITCH_MS), null);
  assert.equal(loadoutSnapshot(l, 1000 + WEAPON_SWITCH_MS).switching, false);
  assert.equal(fireOnce(l, 1000 + WEAPON_SWITCH_MS, { dir, triggerEdge: true }).accepted, true);
  assert.equal(l.slots['pulse-pistol'].mag, 11);
  switchTo(l, 'neon-rifle', 5000);
  stepLoadout(l, 5000 + WEAPON_SWITCH_MS + 1);
  assert.equal(activeWeapon(l).id, 'neon-rifle');
  assert.equal(l.slots['neon-rifle'].mag, 26, 'slot o‘q-dorisi saqlanmadi');
});

test('switch: noma’lum id rad, reload bekor qilinadi, bir xil id — "same"', () => {
  const l = createLoadout({ seed: 13 });
  assert.equal(switchTo(l, 'laser-cannon', 0).reason, 'unknown');
  assert.equal(activeWeapon(l).id, 'neon-rifle');
  assert.equal(switchTo(l, 'neon-rifle', 0).reason, 'same');
  fireOnce(l, 0, { dir: [0, 0, -1] });
  assert.equal(startReload(l, 10).started, true);
  assert.equal(l.slots['neon-rifle'].reloading, true);
  switchTo(l, 'scatter-shot', 20);
  assert.equal(l.slots['neon-rifle'].reloading, false, 'reload bekor qilinmadi');
  assert.equal(l.slots['neon-rifle'].mag, 29, 'bekor qilingan reload o‘q-dorini o‘zgartirdi');
  assert.equal(l.slots['neon-rifle'].reserve, 120);
});

test('refillLoadout: barcha slotlar to‘ladi, reload bekor, faol slot 1', () => {
  const l = createLoadout({ seed: 14 });
  const dir = [0, 0, -1];
  for (let i = 0; i < 5; i++) fireOnce(l, i * 200, { dir });
  switchTo(l, 'scatter-shot', 2000);
  stepLoadout(l, 2500);
  for (let i = 0; i < 3; i++) fireOnce(l, 2500 + i * 900, { dir, triggerEdge: true });
  startReload(l, 6000);
  refillLoadout(l);
  assert.equal(activeWeapon(l).id, 'neon-rifle');
  for (const id of WEAPON_ORDER) {
    assert.equal(l.slots[id].mag, WEAPONS[id].magSize, `${id}: mag to‘lmadi`);
    assert.equal(l.slots[id].reserve, WEAPONS[id].startReserve, `${id}: reserve to‘lmadi`);
    assert.equal(l.slots[id].reloading, false, `${id}: reload qoldi`);
  }
  assert.equal(fireOnce(l, 7000, { dir }).accepted, true);
});

// ---------------- 6) spread ----------------
test('spread: deterministik, normallashgan, konus ichida, pelletlar xilma-xil', () => {
  const dir = [0, 0, -1];
  const outA = Array.from({ length: MAX_PELLETS }, () => [0, 0, 0]);
  const outB = Array.from({ length: MAX_PELLETS }, () => [0, 0, 0]);
  const n1 = spreadDirections(dir, SCATTER, { seed: 42, shotId: 7 }, outA);
  const n2 = spreadDirections(dir, SCATTER, { seed: 42, shotId: 7 }, outB);
  assert.equal(n1, 9);
  assert.equal(n2, 9);
  for (let i = 0; i < 9; i++) {
    assert.deepEqual(outB[i], outA[i], `pellet ${i} deterministik emas`);
    assert.ok(Math.abs(speed(outA[i]) - 1) < 1e-9, `pellet ${i} normallashmagan`);
  }
  const lim = SCATTER.spreadDeg.base * Math.PI / 180 + 1e-9;
  const cone = maxCone(outA, 9, dir);
  assert.ok(cone <= lim, `konusdan chiqdi: ${cone}`);
  assert.ok(cone > 0.02, 'spread umuman yo‘q — scatter juda aniq');
  const uniq = new Set(outA.slice(0, 9).map((v) => v.map((x) => x.toFixed(6)).join(',')));
  assert.ok(uniq.size >= 7, `pelletlar juda bir xil: ${uniq.size} xil`);
  spreadDirections(dir, SCATTER, { seed: 42, shotId: 8 }, outB);
  assert.notDeepEqual(outB.slice(0, 9), outA.slice(0, 9), 'shotId o‘zgarsa ham bir xil');
  spreadDirections(dir, SCATTER, { seed: 43, shotId: 7 }, outB);
  assert.notDeepEqual(outB.slice(0, 9), outA.slice(0, 9), 'seed o‘zgarsa ham bir xil');
});

test('spread: harakat kengaytiradi; 0 spread aniq yo‘nalish beradi', () => {
  const dir = [0, 0, -1];
  const out = Array.from({ length: MAX_PELLETS }, () => [0, 0, 0]);
  let still = 0;
  let moving = 0;
  for (let s = 1; s <= 40; s++) {
    spreadDirections(dir, RIFLE, { seed: 1, shotId: s }, out);
    still = Math.max(still, maxCone(out, 1, dir));
    spreadDirections(dir, RIFLE, { seed: 1, shotId: s, moving: true }, out);
    moving = Math.max(moving, maxCone(out, 1, dir));
  }
  assert.ok(moving > still * 1.5, `harakat spreadi kengaymadi: ${still} → ${moving}`);
  assert.ok(still <= RIFLE.spreadDeg.base * Math.PI / 180 + 1e-9, 'still konus chegarasi');
  assert.ok(moving <= RIFLE.spreadDeg.moving * Math.PI / 180 + 1e-9, 'moving konus chegarasi');
  const nd = [0.3, -0.2, 0.9];
  const nl = speed(nd);
  spreadDirections(nd, GRENADE, { seed: 5, shotId: 2 }, out);
  const g = out[0];
  assert.ok(Math.abs(g[0] - nd[0] / nl) < 1e-12, 'grenada yo‘nalishi buzildi');
  assert.ok(Math.abs(g[1] - nd[1] / nl) < 1e-12);
  assert.ok(Math.abs(g[2] - nd[2] / nl) < 1e-12);
});

test('tryFire: qabul qilinsa spread yo‘nalishlari yoziladi; o‘limda otilmaydi', () => {
  const l = createLoadout({ seed: 21 });
  switchTo(l, 'scatter-shot', 0);
  stepLoadout(l, 400);
  const s = tryFire(l, 500, { dir: [0, 0, -1], triggerEdge: true });
  assert.equal(s.accepted, true);
  assert.equal(s.pellets, 9);
  assert.equal(s.weaponId, 'scatter-shot');
  assert.equal(s.shotId, 1);
  assert.equal(s.spreadDeg, SCATTER.spreadDeg.base);
  for (let i = 0; i < s.pellets; i++) {
    assert.ok(Math.abs(speed(s.dirs[i]) - 1) < 1e-9, `dirs[${i}] normallashmagan`);
  }
  const dir = [0, 0, -1];
  assert.equal(fireBlockReason(l, 600, { dir, triggerEdge: true, alive: false }), FIRE_REASON.DEAD);
  const d = tryFire(l, 600, { dir, triggerEdge: true, alive: false });
  assert.equal(d.accepted, false);
  assert.equal(d.reason, FIRE_REASON.DEAD);
  assert.equal(l.slots['scatter-shot'].mag, 5, 'o‘lgan holatda o‘q-dori kamaydi');
});

// ---------------- 7) zarar formulasi ----------------
test('computeDamage: falloff monoton pasayadi, range dan keyin 0', () => {
  assert.equal(computeDamage(RIFLE, 0), 26);
  assert.equal(computeDamage(RIFLE, 18), 26, 'falloff boshlanishigacha to‘liq zarar');
  assert.equal(computeDamage(RIFLE, 45), 20, 'falloff oxirida minimal zarar');
  assert.equal(computeDamage(RIFLE, 60), 20);
  let prev = Infinity;
  for (let d = 0; d <= RIFLE.range; d += 0.5) {
    const v = computeDamage(RIFLE, d);
    assert.ok(v <= prev + 1e-9, `d=${d}: falloff oshdi (${prev} → ${v})`);
    assert.ok(v > 0, `d=${d}: range ichida zarar 0`);
    prev = v;
  }
  assert.equal(computeDamage(RIFLE, 60.1), 0, 'range dan keyin zarar 0 bo‘lishi kerak');
  assert.equal(computeDamage(RIFLE, 200), 0);
  assert.equal(computeDamage(PISTOL, 5), 34);
  assert.equal(computeDamage(PISTOL, 35), 22);
  assert.equal(computeDamage(SCATTER, 1), 12);
  assert.equal(computeDamage(SCATTER, 18), 3);
  assert.equal(computeDamage(SCATTER, 18.5), 0);
});

test('computeDamage: hit-zone multiplikatorlari va yaroqsiz kirish', () => {
  assert.equal(computeDamage(RIFLE, 10, 'head'), 52, 'head = ×2');
  assert.equal(computeDamage(RIFLE, 10, 'body'), 26);
  assert.equal(computeDamage(RIFLE, 10, 'legs'), 19.5, 'legs = ×0.75');
  assert.equal(computeDamage(RIFLE, 10, 'ring'), 39, 'ring = ×1.5');
  assert.equal(computeDamage(RIFLE, 10, 'nomalum'), 26, 'noma’lum zone → body');
  assert.equal(computeDamage(RIFLE, 10, undefined), 26);
  assert.equal(computeDamage(null, 10), 0);
  assert.equal(computeDamage(RIFLE, NaN), 0);
  assert.equal(computeDamage(RIFLE, Infinity), 0);
  assert.equal(computeDamage(RIFLE, -1), 0);
  assert.equal(computeDamage(SCATTER, 2) * SCATTER.pellets, 108, '9 pellet yaqinda');
  assert.ok(computeDamage(SCATTER, 18) * 9 < 30, 'uzoqda scatter kuchsiz bo‘lishi kerak');
});

test('mulberry32: deterministik va [0,1) oralig‘ida', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const c = mulberry32(12346);
  let diff = 0;
  for (let i = 0; i < 50; i++) {
    const x = a();
    assert.equal(x, b(), `i=${i}: bir seed bir xil natija bermadi`);
    assert.ok(x >= 0 && x < 1, `i=${i}: x=${x}`);
    if (x !== c()) diff++;
  }
  assert.ok(diff > 40, `boshqa seed deyarli bir xil ketma-ketlik berdi (diff=${diff})`);
});

// ---------------- 8) snapshot / read-only tekshiruv ----------------
test('loadoutSnapshot: HUD maydonlari va reload progress (out qayta ishlatiladi)', () => {
  const l = createLoadout({ seed: 30 });
  const out = {};
  let snap = loadoutSnapshot(l, 0, out);
  assert.equal(snap, out, 'snapshot yangi obyekt yaratdi (allokatsiya)');
  assert.equal(snap.weaponId, 'neon-rifle');
  assert.equal(snap.mag, 30);
  assert.equal(snap.magSize, 30);
  assert.equal(snap.reserve, 120);
  assert.equal(snap.reloading, false);
  assert.equal(snap.auto, true);
  assert.equal(snap.reloadProgress, 1);
  assert.equal(snap.shotsFired, 0);
  tryFire(l, 100, { dir: [0, 0, -1] });
  startReload(l, 200);
  snap = loadoutSnapshot(l, 200 + RIFLE.reloadMs / 2, out);
  assert.equal(snap.reloading, true);
  assert.ok(Math.abs(snap.reloadProgress - 0.5) < 0.02, `progress=${snap.reloadProgress}`);
  tryFire(l, 200 + RIFLE.reloadMs / 2, { dir: [0, 0, -1] });
  snap = loadoutSnapshot(l, 3000, out);
  assert.equal(snap.lastReason, FIRE_REASON.RELOADING, 'oxirgi rad sababi ko‘rinmadi');
  assert.equal(snap.rejected, 1);
  assert.equal(snap.mag, 29, 'snapshot mag qiymatini buzdi');
});

test('canFire / fireBlockReason: holatni o‘zgartirmaydi (read-only tekshiruv)', () => {
  const l = createLoadout({ seed: 31 });
  const st = l.slots['neon-rifle'];
  const beforeRejected = l.rejected;
  assert.equal(canFire(l, 0, { dir: [0, 0, -1] }), true);
  assert.equal(fireBlockReason(l, 0, { dir: [0, 0, -1] }), '');
  tryFire(l, 0, { dir: [0, 0, -1] });
  assert.equal(canFire(l, 50, { dir: [0, 0, -1] }), false);
  assert.equal(fireBlockReason(l, 50, { dir: [0, 0, -1] }), FIRE_REASON.COOLDOWN);
  assert.equal(st.mag, 29, 'canFire o‘q-dorini o‘zgartirdi');
  assert.equal(l.rejected, beforeRejected, 'canFire rad hisoblagichni oshirdi');
  assert.equal(activeState(l), st, 'activeState boshqa obyekt qaytardi');
  assert.equal(l._shot.dirs.length, MAX_PELLETS, '_shot.dirs budjeti');
});