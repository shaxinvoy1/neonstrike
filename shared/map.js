// ============================================================
// NEON STRIKE — PHASE 3: MAP "NEON FACILITY"
// SOF MA'LUMOT moduli (three.js import YO'Q → server ham ishlata oladi).
// 1 birlik = 1 metr. Barcha to'siqlar AABB: { min:[x,y,z], max:[x,y,z] }.
// O'lcham: 44m (x) × 32m (z) → x ∈ [-22,22], z ∈ [-16,16].
// Simmetriya: MARKAZIY NUQTA (180°) — (x,z) → (-x,-z). Har bir kollayder
// uchun uning aksi xaritada mavjud (test/unit/map.test.js tekshiradi).
// Hududlar:
//   - 2 spawn: A (g'arb, x≈-19.5) va B (sharq, x≈+19.5)
//   - MID lane: markaz, o'rtada REACTOR platformasi (h=1.2, zinali)
//   - LEFT/LONG koridor: shimol (z<-4.8), KATWALK ostidan o'tadi
//   - CATWALK: janub + shimol ko'targich yo'laklari (deck y=2.2, osti 1.9)
//   - Kratlar: cover, nuqtaviy juftliklarda
// ============================================================

const b3 = (x, y, z) => Object.freeze([x, y, z]);
const bx = (min, max) => Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) });
/** Markaziy nuqta simmetriyasi: (x,y,z) → (-x, y, -z) */
const mirrorBox = (b) => bx([-b.max[0], b.min[1], -b.max[2]], [-b.min[0], b.max[1], -b.min[2]]);
const sameBox = (a, b) => a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);

export const MAP = Object.freeze({
  NAME: 'NEON FACILITY',
  WIDTH: 44,
  DEPTH: 32,
  HALF_X: 22,
  HALF_Z: 16,
  FLOOR_Y: 0,
  WALL_T: 0.6,
  WALL_H: 4.0
});

// ---------- konstantalar (metrlar) ----------
const HX = MAP.HALF_X;     // 22
const HZ = MAP.HALF_Z;     // 16
const WT = MAP.WALL_T;     // 0.6
const WH = MAP.WALL_H;     // 4

export const REACTOR = Object.freeze({
  PLATFORM: bx(b3(-4.5, 0, -4), b3(4.5, 1.2, 4)),       // h=1.2
  CORE: bx(b3(-1.1, 1.2, -1.1), b3(1.1, 3.2, 1.1)),     // markaziy reaktor ustuni
  STAIR_Z: 2,                                            // zinalar kengligi ±2
  STAIR_STEP: 0.3,                                       // har zina 0.3m (STEP 0.55 dan past)
  STAIR_COUNT: 4
});

export const CATWALK = Object.freeze({
  DECK_TOP: 2.2,
  DECK_BOTTOM: 1.9,          // ostidan yurish uchun: 1.9 > PLAYER.HEIGHT (1.75)
  DECK_HALF_X: 14,
  DECK_Z_HALF: 1.5,          // deck kengligi 3m
  STEP: 0.44,
  STEPS: 5                   // har uchida 5 zina (2.2 = 5×0.44)
});

// ---------- BASE kollayderlar (g'arb/shimol + o'zak) — aynasi mirror() bilan ----------
const BASE = [];
const add = (id, kind, min, max) => BASE.push(Object.freeze({ id, kind, box: bx(Object.freeze(min), Object.freeze(max)) }));

// --- tashqi devorlar (N va W; S va E mirror orqali) ---
add('wall-north', 'wall', b3(-HX - WT, 0, -HZ - WT), b3(HX + WT, WH, -HZ));
add('wall-west', 'wall', b3(-HX - WT, 0, -HZ - WT), b3(-HX, WH, HZ + WT));

// --- ajratuvchi devorlar (divider): MID ↔ yon lanelar, 2 teshik (x=±11..±13) ---
add('divider-nw', 'divider', b3(-17, 0, -4.8), b3(-13, 3, -4.2));
add('divider-nmid', 'divider', b3(-11, 0, -4.8), b3(11, 3, -4.2));

// --- REACTOR: ko'tarilgan markaziy platforma + o'zak + g'arb zinalari ---
add('reactor-platform', 'platform', REACTOR.PLATFORM.min, REACTOR.PLATFORM.max);
add('reactor-core', 'core', REACTOR.CORE.min, REACTOR.CORE.max);
// Zina balandligi platformadan TASHQARIGA qarab pasayadi: w0 (eng yaqin, x≈-4.9)
// eng baland = platforma sathi (1.2), w3 (eng olis) = polga eng yaqin (0.3).
// Aks holda zinapoya "teskari ramp" bo'lib qoladi va 0.3 balandlikdagi birinchi
// zina platforma devoriga (1.2) urilib, STEP_HEIGHT=0.55 dan oshib ketadi —
// platformaga umuman chiqib bo'lmaydi (test/unit/map.test.js BFS buni tekshiradi).
for (let i = 0; i < REACTOR.STAIR_COUNT; i++) {
  const x0 = -4.5 - 0.8 * (i + 1);
  const x1 = -4.5 - 0.8 * i;
  const top = REACTOR.STAIR_STEP * (REACTOR.STAIR_COUNT - i);
  add(`reactor-stair-w${i}`, 'stair', b3(x0, 0, -REACTOR.STAIR_Z), b3(x1, top, REACTOR.STAIR_Z));
}

// --- CATWALK (shimol): deck y[1.9,2.2], chetki zinalar W va E tomonda ---
{
  const dz0 = -HZ + 2.5;              // -13.5
  const dz1 = -HZ + 5.5;              // -10.5
  add('catwalk-deck-n', 'catwalk', b3(-CATWALK.DECK_HALF_X, CATWALK.DECK_BOTTOM, dz0), b3(CATWALK.DECK_HALF_X, CATWALK.DECK_TOP, dz1));
  for (let i = 0; i < CATWALK.STEPS; i++) {
    const top = CATWALK.DECK_TOP - CATWALK.STEP * i;
    // g'arb zinalari: deck chetidan tashqariga (-x yo'nalishda) pastayadi
    add(`catwalk-nw${i}`, 'stair', b3(-14 - 0.8 * (i + 1), 0, dz0), b3(-14 - 0.8 * i, top, dz1));
    // sharq zinalari
    add(`catwalk-ne${i}`, 'stair', b3(14 + 0.8 * i, 0, dz0), b3(14 + 0.8 * (i + 1), top, dz1));
  }
  // deck osti ustunlari (janub tomonda; shimol mirror orqali)
  for (const xc of [-13.5, -7, 0, 7, 13.5]) {
    add(`pillar-${xc}`, 'pillar', b3(xc - 0.25, 0, 11.75), b3(xc + 0.25, CATWALK.DECK_BOTTOM, 12.25));
  }
}

// --- COVER kratlar (har juftlikdan bittasi BASE'da, aksi mirror) ---
add('crate-1', 'crate', b3(-9.9, 0, -8.4), b3(-8.1, 1.4, -6.6));      // 1.8×1.4×1.8
add('crate-2', 'crate', b3(-14.3, 0, 1.8), b3(-12.7, 1.6, 3.4));      // 1.6³
add('crate-3', 'crate', b3(-6.3, 0, -13.0), b3(-4.7, 1.0, -11.4));    // 1.6×1.0×1.6 (deck osti)
add('crate-4', 'crate', b3(-15.9, 0, 0.1), b3(-14.1, 1.2, 1.9));      // 1.8×1.2×1.8
add('crate-5', 'crate', b3(-2.4, 0, -9.6), b3(-1.2, 1.2, -8.4));      // 1.2³

// --- YIRIK SANOAT KONTEYNERLARI (Reference B): cover + ko'rish chizig'ini bo'ladi ---
add('container-1', 'container', b3(-21.4, 0, -9.6), b3(-18.6, 2.6, -6.4));   // spawn A shimoli
add('container-2', 'container', b3(2.5, 0, -7.6), b3(5.5, 2.6, -6.0));       // LONG markazi (MID devori oldida)

// ---------- yakuniy kollayderlar: BASE + o'zagi bo'lmaganlarning aksi ----------
const MIRRORED = BASE
  .filter((c) => !sameBox(c.box, mirrorBox(c.box)))
  .map((c) => Object.freeze({ id: c.id + '-R', kind: c.kind, box: mirrorBox(c.box) }));

export const COLLIDERS = Object.freeze(BASE.concat(MIRRORED));
export const SOLID_BOXES = Object.freeze(COLLIDERS.map((c) => c.box));

/** Pol plastinkasi — faqat kamera kolliziyasi uchun */
export const FLOOR_BOX = bx(b3(-HX, -1, -HZ), b3(HX, MAP.FLOOR_Y, HZ));
export const CAMERA_BOXES = Object.freeze([...SOLID_BOXES, FLOOR_BOX]);

// ---------- spawn hududlari va nuqtalari ----------
export const SPAWN_ZONES = Object.freeze({
  A: Object.freeze({ min: b3(-HX, 0, -5), max: b3(-HX + 5, 3, 5) }),   // g'arb
  B: Object.freeze({ min: b3(HX - 5, 0, -5), max: b3(HX, 3, 5) })      // sharq
});

export const SPAWNS = Object.freeze({
  A: Object.freeze({ x: -19.5, y: 0, z: 0, yaw: Math.PI / 2 }),        // +x (markaz) ga qaragan
  B: Object.freeze({ x: 19.5, y: 0, z: 0, yaw: -Math.PI / 2 })         // -x (markaz) ga qaragan
});

/** Phase 2 moslik: standart spawn = A */
export const SPAWN = SPAWNS.A;

// ---------- A-SITE (Reference B: katta "A →" belgisi bilan hudud) ----------
// Belgi shimoliy devorda; hudud — LONG koridorining sharqiy qismi (kollayder EMAS).
export const SITES = Object.freeze({
  A: Object.freeze({ id: 'A', min: b3(8, 0, -16), max: b3(17, 3, -4.8), sign: Object.freeze({ x: 11.5, y: 4.6, z: -HZ + 0.02, facing: 0 }) })
});

// ---------- lanelar (o'qish/qamrov uchun hududlar, KOLLIZIYA EMAS) ----------
export const LANES = Object.freeze([
  Object.freeze({ id: 'mid', callout: 'MID', min: b3(-17, 0, -4.2), max: b3(17, 3, 4.2) }),
  Object.freeze({ id: 'left-corridor', callout: 'LONG', min: b3(-17, 0, -16), max: b3(17, 3, -4.8) }),
  Object.freeze({ id: 'right-catwalk', callout: 'CATWALK', min: b3(-CATWALK.DECK_HALF_X, CATWALK.DECK_BOTTOM, 10.5), max: b3(CATWALK.DECK_HALF_X, CATWALK.DECK_TOP + 0.1, 13.5) })
]);

// ---------- callout belgilari (pol plastinkalari) ----------
export const CALLOUTS = Object.freeze([
  Object.freeze({ id: 'SPAWN-A', x: -19.5, y: 0.01, z: 0, color: 'A' }),
  Object.freeze({ id: 'SPAWN-B', x: 19.5, y: 0.01, z: 0, color: 'B' }),
  Object.freeze({ id: 'REACTOR', x: -2.5, y: 1.21, z: 0, color: 'A' }),
  Object.freeze({ id: 'LONG', x: -8, y: 0.01, z: -12, color: 'B' }),
  Object.freeze({ id: 'CATWALK', x: 0, y: 2.21, z: 12, color: 'B' })
]);

// ---------- mashq nishonlari (Training offline; kolliziyaga KIRMAYDI) ----------
export const TRAINING_DUMMIES = Object.freeze([
  Object.freeze({ id: 'dummy-1', x: -16, y: 0, z: -2.6, yaw: Math.PI / 2 }),
  Object.freeze({ id: 'dummy-2', x: -16, y: 0, z: 2.6, yaw: Math.PI / 2 }),
  Object.freeze({ id: 'dummy-3', x: 16, y: 0, z: 2.6, yaw: -Math.PI / 2 }),
  Object.freeze({ id: 'dummy-4', x: 16, y: 0, z: -2.6, yaw: -Math.PI / 2 }),
  // dummy-5: LONG koridorda (pillar'lar orasida toza nuqta — pillar-0-R x[0±0.25])
  Object.freeze({ id: 'dummy-5', x: -8, y: 0, z: -12, yaw: Math.PI / 2 })
]);

export const TRAINING_RINGS = Object.freeze([
  Object.freeze({ id: 'ring-1', x: 11.4, y: 1.7, z: 0.8, yaw: 0 }),
  Object.freeze({ id: 'ring-2', x: 12.8, y: 1.7, z: 0.8, yaw: 0 }),
  Object.freeze({ id: 'ring-3', x: 14.2, y: 1.7, z: 0.8, yaw: 0 })
]);

// ---------- palitra (Phase 2 qiymatlari + xarita uchun yangilar) ----------
export const PALETTE = Object.freeze({
  BG: 0x070b1c,
  FOG: 0x0a1030,
  FLOOR: 0x0d1330,
  WALL: 0x141c46,
  PROP: 0x1a2350,
  DECK: 0x232c5e,
  PILLAR: 0x10173a,
  STAIR: 0x1c2654,
  CRATE: 0x1a2350,
  PLATFORM: 0x202a58,
  CORE_BODY: 0x18305a,
  TRIM: 0x35c8ff,       // cyan neon
  TRIM_ALT: 0x7b5cff,   // binafsha neon
  CORE_GLOW: 0x8fd8ff,
  PLAYER_BODY: 0x1b2350,
  PLAYER_ACCENT: 0x35c8ff,
  PLAYER_CORE: 0x7b5cff,
  VIOLET: 0xa06bff,
  TARGET: 0xff4d5e,
  TARGET_ACCENT: 0xff8a4d
});
