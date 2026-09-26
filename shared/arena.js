// ============================================================
// NEON STRIKE — ARENA "NEON RANGE" (Phase 2: offline mashq xonasi)
// LEGACY / DEPRECATED (Phase 3): o'yin endi shared/map.js (NEON FACILITY)
// ishlatadi. Bu fayl faqat eski Phase 2 test izchilligi uchun saqlanmoqda.
// SOF MA'LUMOT moduli: three.js import QILINMAYDI, shuning uchun
// node testlar ham, klient ham aynan shu manbadan foydalanadi.
// Barcha to'siqlar AABB: { min:[x,y,z], max:[x,y,z] } (1 birlik = 1 metr)
// ============================================================

const vec = (x, y, z) => Object.freeze([x, y, z]);
const box = (min, max) => Object.freeze({ min, max });

export const ARENA = Object.freeze({
  NAME: 'NEON RANGE',
  HALF: 22,           // pol: x,z ∈ [-22, +22]
  WALL_THICK: 0.6,
  WALL_HEIGHT: 3.6,
  FLOOR_Y: 0
});

/** Pol plastinkasi — faqat kamera kolliziyasi uchun (yuzasi y=0) */
export const FLOOR_BOX = box(
  vec(-ARENA.HALF, -1, -ARENA.HALF),
  vec(ARENA.HALF, ARENA.FLOOR_Y, ARENA.HALF)
);

/**
 * Qattiq to'siqlar (hammasi AABB):
 *  - 4 tashqi devor (balandligi WALL_HEIGHT — kamerani tashqariga chiqarmaydi)
 *  - 8 ta prop: kratlar, ustun, past platformalar (kamerani to'sadi + slide beradi)
 */
export const BOXES = Object.freeze([
  // --- tashqi devorlar ---
  box(vec(-ARENA.HALF - 0.6, 0, -ARENA.HALF - 0.6), vec(ARENA.HALF + 0.6, ARENA.WALL_HEIGHT, -ARENA.HALF)), // shimol (-z)
  box(vec(-ARENA.HALF - 0.6, 0, ARENA.HALF), vec(ARENA.HALF + 0.6, ARENA.WALL_HEIGHT, ARENA.HALF + 0.6)),     // janub  (+z)
  box(vec(-ARENA.HALF - 0.6, 0, -ARENA.HALF), vec(-ARENA.HALF, ARENA.WALL_HEIGHT, ARENA.HALF)),              // g'arb  (-x)
  box(vec(ARENA.HALF, 0, -ARENA.HALF), vec(ARENA.HALF + 0.6, ARENA.WALL_HEIGHT, ARENA.HALF)),                // sharq (+x)
  // --- props ---
  box(vec(-8.0, 0, -6.0), vec(-5.2, 2.2, -3.2)),   // katta krat (2.8 × 2.2 × 2.8)
  box(vec(5.0, 0, -7.5), vec(8.6, 1.4, -3.9)),     // past platforma (o'ng-shimol)
  box(vec(-1.2, 0, 6.5), vec(1.2, 3.6, 8.9)),      // markaziy ustun
  box(vec(-16.0, 0, 3.0), vec(-12.4, 2.6, 6.6)),   // krat (chap)
  box(vec(10.5, 0, 4.0), vec(13.1, 3.0, 6.6)),     // krat (o'ng)
  box(vec(-19.0, 0, -18.0), vec(-15.0, 2.4, -14.4)), // spawn yonidagi krat
  box(vec(14.0, 0, -16.0), vec(17.4, 1.8, -12.6)),
  box(vec(13.0, 0, 12.0), vec(17.0, 0.9, 16.0))    // mashq platformasi (janub-sharq)
]);

/** Kamera uchun to'siqlar: props + devorlar + pol */
export const CAMERA_BOXES = Object.freeze([...BOXES, FLOOR_BOX]);

/** O'yinchi spawn nuqtasi (yaw=0 → +z ga qaragan, nishonlarga qarab) */
export const SPAWN = Object.freeze({ x: 0, y: ARENA.FLOOR_Y, z: -16, yaw: 0 });

/** Statik mashq nishonlari — oddiy humanoid "dummy"lar */
export const DUMMIES = Object.freeze([
  Object.freeze({ id: 'dummy-1', x: -11.0, z: 15.5, yaw: Math.PI }),
  Object.freeze({ id: 'dummy-2', x: -6.0, z: 16.0, yaw: Math.PI }),
  Object.freeze({ id: 'dummy-3', x: 0, z: 15.0, yaw: Math.PI }),
  Object.freeze({ id: 'dummy-4', x: 6.0, z: 16.0, yaw: Math.PI }),
  Object.freeze({ id: 'dummy-5', x: 12.0, z: 15.5, yaw: Math.PI })
]);

/** Statik halqa-nishonlar (havoda, aylanmaydi) */
export const RINGS = Object.freeze([
  Object.freeze({ id: 'ring-1', x: 0, y: 1.7, z: 11.5, yaw: 0 }),
  Object.freeze({ id: 'ring-2', x: -3.6, y: 1.7, z: 9.8, yaw: 0 }),
  Object.freeze({ id: 'ring-3', x: 3.6, y: 1.7, z: 9.8, yaw: 0 })
]);

/** Neon palitra (konsept-rasm: to'q ko'k/binafsha + cyan) */
export const PALETTE = Object.freeze({
  BG: 0x070b1c,
  FOG: 0x0a1030,
  FLOOR: 0x0d1330,
  WALL: 0x141c46,
  PROP: 0x1a2350,
  TRIM: 0x35c8ff,     // cyan neon
  TRIM_ALT: 0x7b5cff, // binafsha neon
  PLAYER_BODY: 0x1b2350,
  PLAYER_ACCENT: 0x35c8ff,
  PLAYER_CORE: 0x7b5cff,
  TARGET: 0xff4d5e,
  TARGET_ACCENT: 0xff8a4d
});
