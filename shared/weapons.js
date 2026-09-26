// ============================================================
// NEON STRIKE — PHASE 4: QUROL TIZIMI (SOF QOIDALAR)
// three.js / DOM / timer YO'Q → node testlar, klient va PHASE 5 SERVER
// aynan shu modulni ishlatadi (avtoritar rejimga tayyor poydevor).
//  - WEAPONS            : ma'lumotga asoslangan konfiguratsiya (4 qurol)
//  - computeDamage()    : masofa (falloff) × hit-zone multiplikatori
//  - spreadDirections() : deterministik PRNG (Math.random ISHLATILMAYDI)
//  - createLoadout() / tryFire() / startReload() / stepLoadout() /
//    switchTo()         : o'q-dori + cooldown + reload + almashtirish mashinasi
// `now` (ms) HAR DOIM tashqaridan beriladi → deterministik testlar va
// Phase 5 server tick'i uchun bir xil kod.
// ============================================================
import { clamp } from './collision.js';

/** Hit-zone multiplikatorlari (hitdetect.js ham shundan qayta eksport qiladi) */
export const HIT_ZONES = Object.freeze({
  head: 2.0,
  body: 1.0,
  legs: 0.75,
  ring: 1.5
});

/** Qurol almashtirish (draw) vaqti — shu vaqt ichida o'q uzilmaydi */
export const WEAPON_SWITCH_MS = 300;
/** Bitta o'qda hisoblanadigan maksimal pellet (scatter = 9) */
export const MAX_PELLETS = 16;

/** O'q uzishni rad etish sabablari (HUD/debug/testlar shu matnlarni o'qiydi) */
export const FIRE_REASON = Object.freeze({
  DEAD: 'dead',
  /** PHASE 1: raund/match faol emas (ROUND_END / MATCH_END) — o'q uzilmaydi */
  ROUND_OVER: 'round-over',
  SWITCHING: 'switching',
  RELOADING: 'reloading',
  COOLDOWN: 'cooldown',
  EMPTY: 'empty',
  SEMI: 'semi-held',
  /** PHASE 1: o'lik holatda reload boshlanmaydi */
  RELOAD_BLOCKED: 'reload-blocked'
});

const DEG = Math.PI / 180;

/** Konfiguratsiyani muzlatadi (nested obyektlar bilan) */
const W = (cfg) => Object.freeze({
  ...cfg,
  intervalMs: 60000 / cfg.rpm,
  pellets: cfg.pellets || 1,
  falloff: Object.freeze(cfg.falloff),
  spreadDeg: Object.freeze(cfg.spreadDeg),
  recoil: Object.freeze(cfg.recoil || { pitch: 0, yaw: 0 }),
  projectile: cfg.projectile ? Object.freeze(cfg.projectile) : null
});

/**
 * PHASE 1 — QUROL ROLLARI (original qiymatlar; boshqa o'yindan KO'CHIRILMAGAN):
 *
 *  neon-rifle    · haqiqiy avtomat · o'rta masofa ustuni · barqaror tepki
 *  pulse-pistol  · yarim-avtomat · aniqlik/precision · yuqori tepki, tez tiklanish
 *  scatter-shot  · yaqin masofa burst · katta konus, pelletlar taqsimoti
 *  energy-grenade· hudud nazorati · snaryad + radius zarar
 *
 * `spreadDeg.bloom/*`  — har otishda o'sadigan qo'shimcha konus (AVTORITATIV,
 *                        server ham xuddi shu deterministik hisobni yuritadi)
 * `recoil`             — barrel ko'tarilishi (radian/otish); KLIENT taqdimoti,
 *                        lekin kamera bilan BIRGA siljiydi → crosshair/ o'q mos
 */

/**
 * QUROLLAR (Phase 4 rejasidagi 4 ta):
 *  damage/damageMin — falloff.start..falloff.end oralig'ida chiziqli pasayadi
 *  range            — maksimal masofa (undan keyin o'q tegmaydi)
 *  auto             — true: trigger ushlab turilsa otadi; false: har bosish = 1 o'q
 */
export const WEAPONS = Object.freeze({
  'neon-rifle': W({
    id: 'neon-rifle', name: 'NEON RIFLE', slot: 1, mode: 'hitscan', auto: true,
    rpm: 600, damage: 26, damageMin: 20, falloff: { start: 18, end: 45 }, range: 60,
    magSize: 30, startReserve: 120, reloadMs: 2200,
    spreadDeg: { base: 0.6, moving: 1.4, bloom: 0.35, bloomMax: 2.4, recover: 6 },
    recoil: { pitch: 0.011, yaw: 0.005 }
  }),
  'pulse-pistol': W({
    id: 'pulse-pistol', name: 'PULSE PISTOL', slot: 2, mode: 'hitscan', auto: false,
    rpm: 400, damage: 34, damageMin: 22, falloff: { start: 12, end: 35 }, range: 50,
    magSize: 12, startReserve: 60, reloadMs: 1400,
    spreadDeg: { base: 0.35, moving: 1.0, bloom: 0.5, bloomMax: 1.6, recover: 8 },
    recoil: { pitch: 0.017, yaw: 0.0035 }
  }),
  'scatter-shot': W({
    id: 'scatter-shot', name: 'SCATTER SHOT', slot: 3, mode: 'hitscan', auto: false,
    rpm: 75, damage: 12, damageMin: 3, falloff: { start: 6, end: 18 }, range: 18,
    magSize: 6, startReserve: 30, reloadMs: 2600, pellets: 9,
    spreadDeg: { base: 4.5, moving: 4.8, bloom: 0.6, bloomMax: 2.0, recover: 6 },
    recoil: { pitch: 0.03, yaw: 0.006 }
  }),
  'energy-grenade': W({
    id: 'energy-grenade', name: 'ENERGY GRENADE', slot: 4, mode: 'projectile', auto: false,
    rpm: 60, damage: 95, damageMin: 15, falloff: { start: 0, end: 0 }, range: 60,
    magSize: 1, startReserve: 2, reloadMs: 1200,
    spreadDeg: { base: 0, moving: 0, bloom: 0, bloomMax: 0, recover: 6 },
    recoil: { pitch: 0, yaw: 0 },
    projectile: {
      speed: 14,          // m/s
      gravity: 22,        // m/s² (movement.js GRAVITY bilan bir xil)
      fuseMs: 1600,
      maxBounces: 2,
      restitution: 0.35,
      radius: 4.2,        // portlash radiusi
      maxDamage: 95,      // markazda
      minDamage: 15,      // radius chegarasida
      selfDamageScale: 0.6
    }
  })
});

/** Slot tartibi (1..4 tugmalari va HUD shu tartibni ishlatadi) */
export const WEAPON_ORDER = Object.freeze(['neon-rifle', 'pulse-pistol', 'scatter-shot', 'energy-grenade']);

export function getWeapon (id) { return WEAPONS[id] || null; }

/**
 * Masofa + hit-zone bo'yicha zarar (falloff chiziqli).
 * @returns {number} 0 — noma'lum/masofadan tashqari; aks holda 2 xona aniqlikda
 */
export function computeDamage (weapon, distance, zone = 'body') {
  if (!weapon || !Number.isFinite(distance) || distance < 0) return 0;
  if (distance > weapon.range) return 0;
  const f = weapon.falloff;
  const t = f.end > f.start ? clamp((distance - f.start) / (f.end - f.start), 0, 1) : 0;
  const base = weapon.damage + (weapon.damageMin - weapon.damage) * t;
  const mul = HIT_ZONES[zone] === undefined ? HIT_ZONES.body : HIT_ZONES[zone];
  return Math.round(base * mul * 100) / 100;
}

// ---------------- deterministik spread ----------------
/** Kichik, tez PRNG (mulberry32) — Math.random o'rniga */
export function mulberry32 (a) {
  let s = a >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash3 = (seed, shotId, pellet) =>
  (seed ^ Math.imul(shotId, 7919) ^ Math.imul(pellet, 104729)) >>> 0;

const _basis = { right: [0, 0, 0], up: [0, 0, 0] };
/** d ga perpendikulyar ortonormal bazis (spread konusi uchun) */
function basisFrom (d) {
  const ref = Math.abs(d[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  // right = d × ref
  let rx = d[1] * ref[2] - d[2] * ref[1];
  let ry = d[2] * ref[0] - d[0] * ref[2];
  let rz = d[0] * ref[1] - d[1] * ref[0];
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // up = right × d
  const ux = ry * d[2] - rz * d[1];
  const uy = rz * d[0] - rx * d[2];
  const uz = rx * d[1] - ry * d[0];
  _basis.right[0] = rx; _basis.right[1] = ry; _basis.right[2] = rz;
  _basis.up[0] = ux; _basis.up[1] = uy; _basis.up[2] = uz;
  return _basis;
}

/**
 * `dir` atrofida konus shaklidagi yo'nalishlar. `out` — QAYTA ISHLATILADIGAN
 * massiv ([x,y,z] uchliklar), shuning uchun o'q uzishda allokatsiya bo'lmaydi.
 * Determinizm: (seed, shotId, pellet) → bir xil natija (Phase 5 server takrorlay oladi).
 * @returns {number} hisoblangan yo'nalishlar soni
 */
export function spreadDirections (dir, weapon, opts = {}, out) {
  const count = opts.count || weapon.pellets;
  // PHASE 1: `opts.deg` — bloom bilan hisoblangan joriy konus (tryFire beradi).
  // Berilmasa — bazaviy/moving qiymat (Phase 4 xatti-harakati AYNAN saqlanadi).
  const deg = Number.isFinite(opts.deg)
    ? opts.deg
    : (opts.moving ? weapon.spreadDeg.moving : weapon.spreadDeg.base);
  const maxA = deg * DEG;
  const seed = opts.seed || 1;
  const shotId = opts.shotId || 1;
  const dx = dir[0], dy = dir[1], dz = dir[2];
  const dl = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / dl, ny = dy / dl, nz = dz / dl;
  const b = maxA > 0 ? basisFrom([nx, ny, nz]) : null;
  for (let i = 0; i < count; i++) {
    let v = out[i];
    if (!v) { v = [0, 0, 0]; out[i] = v; }
    if (!b) { v[0] = nx; v[1] = ny; v[2] = nz; continue; }
    const rng = mulberry32(hash3(seed, shotId, i));
    const ang = Math.sqrt(rng()) * maxA;          // diskda bir tekis taqsimot
    const phi = rng() * Math.PI * 2;
    const off = Math.tan(ang);
    const ox = (b.right[0] * Math.cos(phi) + b.up[0] * Math.sin(phi)) * off;
    const oy = (b.right[1] * Math.cos(phi) + b.up[1] * Math.sin(phi)) * off;
    const oz = (b.right[2] * Math.cos(phi) + b.up[2] * Math.sin(phi)) * off;
    const vx = nx + ox, vy = ny + oy, vz = nz + oz;
    const vl = Math.hypot(vx, vy, vz) || 1;
    v[0] = vx / vl; v[1] = vy / vl; v[2] = vz / vl;
  }
  return count;
}

// ============================================================
// HOLAT MASHINASI: o'q-dori / cooldown / reload / almashtirish
// ============================================================

/** Bitta qurol slotining holati (o'q-dori, cooldown, reload) */
function createSlotState (weapon, fullAmmo) {
  return {
    id: weapon.id,
    weapon,
    mag: fullAmmo ? weapon.magSize : 0,
    reserve: fullAmmo ? weapon.startReserve : 0,
    reloading: false,
    reloadStartedAt: 0,
    reloadEndsAt: 0,
    reloads: 0,
    reloadsCompleted: 0,
    reloadedRounds: 0,
    nextFireAt: 0,
    shotsFired: 0,
    dryFires: 0,
    lastReason: '',
    // PHASE 1: spread bloom holati (avtoritativ, deterministik)
    bloom: 0,
    bloomAt: 0,
    maxBloom: 0
  };
}

/**
 * PHASE 1: joriy konus (gradus) = baza + to'plangan bloom.
 * QAYTA ISHLATILADIGAN hisob: `now` beriladi → klient va server bir xil
 * natija oladi (Math.random YO'Q).
 */
export function currentSpreadDeg (weapon, st, moving, now) {
  const s = weapon.spreadDeg;
  const base = moving ? s.moving : s.base;
  return base + Math.min(s.bloomMax || 0, bloomAt(weapon, st, now));
}

/** `now` gacha yemirilgan bloom qiymati (yozmasdan o'qish — PURE) */
export function bloomAt (weapon, st, now) {
  if (!st.bloom) return 0;
  const rec = weapon.spreadDeg.recover || 0;
  if (rec <= 0) return st.bloom;
  const dt = Math.max(0, (now - st.bloomAt) / 1000);
  const v = st.bloom - rec * dt;
  return v > 0 ? v : 0;
}

/** Otishdan keyin bloom'ni oshirish (AVTORITATIV, deterministik qoida) */
export function addBloom (weapon, st, now) {
  const s = weapon.spreadDeg;
  const max = s.bloomMax || 0;
  if (!s.bloom || max <= 0) { st.bloom = 0; st.bloomAt = now; return 0; }
  st.bloom = Math.min(max, bloomAt(weapon, st, now) + s.bloom);
  st.bloomAt = now;
  if (st.bloom > st.maxBloom) st.maxBloom = st.bloom;
  return st.bloom;
}

/**
 * Loadout — barcha qurollar + faol slot. Qayta ishlatiladigan `_shot`
 * obyekti orqali tryFire() natijasi allokatsiyasiz qaytariladi.
 */
export function createLoadout ({ seed = 1, ids = WEAPON_ORDER, fullAmmo = true } = {}) {
  const slots = {};
  const order = ids.filter((id) => !!WEAPONS[id]);
  for (const id of order) slots[id] = createSlotState(WEAPONS[id], fullAmmo);
  return {
    seed,
    ids: order,
    slots,
    index: 0,
    switching: false,
    switchEndsAt: 0,
    shotId: 0,
    rejected: 0,
    lastReason: '',
    _shot: {
      accepted: false,
      reason: '',
      weaponId: '',
      shotId: 0,
      pellets: 0,
      spreadDeg: 0,
      moving: false,
      dirs: Array.from({ length: MAX_PELLETS }, () => [0, 0, 0])
    }
  };
}

export function activeWeapon (loadout) { return loadout.slots[loadout.ids[loadout.index]].weapon; }
export function activeState (loadout) { return loadout.slots[loadout.ids[loadout.index]]; }

/** O'q uzish mumkin emasligi sababi ('' — mumkin). HOLATNI O'ZGARTIRMAYDI.
 *  Sabab ustuvorligi: o'lim → draw → reload → trigger (edge) → cooldown → o'q-dori.
 *  Semi-auto'da edge yo'qligi cooldown'dan MUHIMROQ: trigger ushlab turilsa
 *  cooldown tugagach ham o'q uzilmaydi, shuning uchun haqiqiy sabab "semi-held". */
export function fireBlockReason (loadout, now, flags = {}) {
  const st = activeState(loadout);
  const wp = st.weapon;
  if (flags.alive === false) return FIRE_REASON.DEAD;
  // PHASE 1: raund faol emas (ROUND_END/MATCH_END) → o'q uzilmaydi.
  // `undefined` — cheklov QO'YILMAGAN (standalone/training xatti-harakati).
  if (flags.roundActive === false) return FIRE_REASON.ROUND_OVER;
  if (loadout.switching && now < loadout.switchEndsAt) return FIRE_REASON.SWITCHING;
  if (st.reloading) return FIRE_REASON.RELOADING;
  if (!wp.auto && !flags.triggerEdge) return FIRE_REASON.SEMI;
  if (now < st.nextFireAt) return FIRE_REASON.COOLDOWN;
  if (st.mag <= 0) return FIRE_REASON.EMPTY;
  return '';
}

export function canFire (loadout, now, flags = {}) {
  return fireBlockReason(loadout, now, flags) === '';
}

/**
 * O'q uzish urinishi. Rad etilsa ham holat buzilmaydi (o'q-dori manfiy bo'lmaydi).
 * Natija — loadout._shot (QAYTA ISHLATILADI: keyingi chaqiruvda ustiga yoziladi).
 * Qabul qilinsa: mag -1, shotId +1, spread yo'nalishlari _shot.dirs[0..pellets-1].
 * `flags.dir` berilmasa [0,0,1] olinadi (testlar doim aniq `dir` beradi).
 */
export function tryFire (loadout, now, flags = {}) {
  const st = activeState(loadout);
  const wp = st.weapon;
  const s = loadout._shot;
  s.accepted = false;
  s.weaponId = wp.id;
  s.pellets = 0;
  s.moving = !!flags.moving;
  // PHASE 1: joriy konus = baza + to'plangan bloom (deterministik)
  s.spreadDeg = currentSpreadDeg(wp, st, !!flags.moving, now);

  const reason = fireBlockReason(loadout, now, flags);
  if (reason) {
    loadout.rejected += 1;
    loadout.lastReason = reason;
    st.lastReason = reason;
    if (reason === FIRE_REASON.EMPTY) st.dryFires += 1;
    s.reason = reason;
    return s;
  }

  if (loadout.switching) loadout.switching = false;   // muddati o'tgan draw
  st.mag -= 1;
  st.shotsFired += 1;
  st.nextFireAt = now + wp.intervalMs;
  st.lastReason = '';
  loadout.shotId += 1;

  s.accepted = true;
  s.reason = 'ok';
  s.shotId = loadout.shotId;
  s.pellets = spreadDirections(flags.dir || [0, 0, 1], wp,
    { moving: s.moving, seed: loadout.seed, shotId: loadout.shotId, deg: s.spreadDeg }, s.dirs);
  // PHASE 1: otish bloom'ni oshiradi (keyingi o'qlar konusi kengayadi)
  addBloom(wp, st, now);
  return s;
}

/** Reload boshlash (natija — kichik yangi obyekt; siyrak chaqiriladi) */
export function startReload (loadout, now, flags = {}) {
  const st = activeState(loadout);
  const wp = st.weapon;
  // PHASE 1 HARDENING: o'lik holatda reload boshlanmaydi (impossible state)
  if (flags.alive === false) return { started: false, reason: FIRE_REASON.DEAD };
  if (loadout.switching && now < loadout.switchEndsAt) return { started: false, reason: 'switching' };
  if (st.reloading) return { started: false, reason: 'already' };
  if (st.mag >= wp.magSize) return { started: false, reason: 'full' };
  if (st.reserve <= 0) return { started: false, reason: 'no_reserve' };
  st.reloading = true;
  st.reloadStartedAt = now;
  st.reloadEndsAt = now + wp.reloadMs;
  st.reloads += 1;
  return { started: true, reason: 'ok', endsAt: st.reloadEndsAt, durationMs: wp.reloadMs };
}

/** Reload tugashini tekshiradi (har kadr bir marta). @returns {null|{reloaded,mag,reserve}} */
export function stepLoadout (loadout, now) {
  const st = activeState(loadout);
  let completed = null;
  if (st.reloading && now >= st.reloadEndsAt) {
    const deficit = st.weapon.magSize - st.mag;
    const take = Math.max(0, Math.min(deficit, st.reserve));
    st.mag += take;
    st.reserve -= take;
    st.reloading = false;
    st.reloadEndsAt = 0;
    st.reloadsCompleted += 1;
    st.reloadedRounds += take;
    completed = { reloaded: take, mag: st.mag, reserve: st.reserve };
  }
  if (loadout.switching && now >= loadout.switchEndsAt) loadout.switching = false;
  return completed;
}

/**
 * Qurol almashtirish. Reload bekor qilinadi; draw vaqti (WEAPON_SWITCH_MS)
 * davomida o'q uzib bo'lmaydi. Slot o'q-dorisi saqlanadi (per-weapon).
 */
export function switchTo (loadout, id, now) {
  const st = loadout.slots[id];
  if (!st) return { switched: false, reason: 'unknown' };
  if (id === loadout.ids[loadout.index]) {
    loadout.switching = false;
    return { switched: false, reason: 'same' };
  }
  if (loadout.switching && now < loadout.switchEndsAt) return { switched: false, reason: 'switching' };
  const prev = activeState(loadout);
  if (prev.reloading) { prev.reloading = false; prev.reloadEndsAt = 0; prev.reloadStartedAt = 0; }
  loadout.index = loadout.ids.indexOf(id);
  st.lastReason = '';
  loadout.switching = true;
  loadout.switchEndsAt = now + WEAPON_SWITCH_MS;
  return { switched: true, reason: 'ok', id, endsAt: loadout.switchEndsAt };
}

/** Qayta tug'ilish / sessiya qayta boshlash: o'q-dori to'liq, reload bekor. */
export function refillLoadout (loadout, { keepStats = true } = {}) {
  for (const id of loadout.ids) {
    const st = loadout.slots[id];
    st.mag = st.weapon.magSize;
    st.reserve = st.weapon.startReserve;
    st.reloading = false;
    st.reloadStartedAt = 0;
    st.reloadEndsAt = 0;
    st.nextFireAt = 0;
    st.lastReason = '';
    st.bloom = 0;
    st.bloomAt = 0;
    st.maxBloom = keepStats ? st.maxBloom : 0;
    if (!keepStats) {
      st.shotsFired = 0; st.dryFires = 0; st.reloads = 0;
      st.reloadsCompleted = 0; st.reloadedRounds = 0;
      st.maxBloom = 0;
    }
  }
  loadout.switching = false;
  loadout.switchEndsAt = 0;
  loadout.index = 0;
  loadout.lastReason = '';
  return loadout;
}

/** Diagnostika/HUD uchun snapshot (out ustiga yoziladi — allokatsiya yo'q) */
export function loadoutSnapshot (loadout, now, out = {}) {
  const st = activeState(loadout);
  const wp = st.weapon;
  out.weaponId = wp.id;
  out.weaponName = wp.name;
  out.slot = wp.slot;
  out.mode = wp.mode;
  out.auto = wp.auto;
  out.mag = st.mag;
  out.magSize = wp.magSize;
  out.reserve = st.reserve;
  out.reloading = st.reloading;
  out.reloadEndsAt = st.reloadEndsAt;
  out.reloadProgress = st.reloading
    ? clamp(1 - (st.reloadEndsAt - now) / wp.reloadMs, 0, 1)
    : (st.mag >= wp.magSize ? 1 : st.mag / wp.magSize);
  out.switching = loadout.switching && now < loadout.switchEndsAt;
  out.shotsFired = st.shotsFired;
  out.dryFires = st.dryFires;
  out.reloads = st.reloads;
  out.reloadsCompleted = st.reloadsCompleted;
  out.rejected = loadout.rejected;
  out.lastReason = loadout.lastReason;
  out.shotId = loadout.shotId;
  // PHASE 1: joriy konus (bloom bilan) — HUD crosshair kengligi ham shundan
  out.spreadDeg = currentSpreadDeg(wp, st, false, now);
  out.bloom = +bloomAt(wp, st, now).toFixed(4);
  out.maxBloom = +st.maxBloom.toFixed(4);
  return out;
}