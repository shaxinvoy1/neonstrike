// ============================================================
// NEON STRIKE — PHASE 3: "NEON FACILITY" map testlari
// 1) Ma'lumot yaxlitligi: 60 kollayder, yaroqli AABB, 180° simmetriya
// 2) Geometriya nizomi: zina qadamlari (STEP_HEIGHT), catwalk ostidan o'tish,
//    lane'lar, spawn hududlari, callout'lar, mashq nishonlari
// 3) REAL FIZIKA BFS: spawn A dan moveAABB bilan qadamlab — platforma,
//    catwalk, 3 lane yetib boriladigan (chiqib bo'lmaydigan joy yo'q)
// Ishga tushirish: npm test
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP, REACTOR, CATWALK, COLLIDERS, SOLID_BOXES, CAMERA_BOXES, FLOOR_BOX,
  SPAWNS, SPAWN_ZONES, LANES, CALLOUTS, TRAINING_DUMMIES, TRAINING_RINGS, PALETTE
} from '../../shared/map.js';
import {
  PLAYER, CAMERA, MOVE, moveAABB, groundHeight, headroomClear, sweepCamera, overlapsY
} from '../../shared/collision.js';

const KIND_COUNTS = { wall: 4, divider: 4, platform: 1, core: 1, stair: 28, catwalk: 2, pillar: 10, crate: 10 };
const kindList = () => {
  const by = {};
  for (const c of COLLIDERS) by[c.kind] = (by[c.kind] || 0) + 1;
  return by;
};

// ---------- 1) ma'lumot yaxlitligi ----------
test('map: NEON FACILITY 44×32 m · 60 kollayder · kind taqsimoti', () => {
  assert.equal(MAP.NAME, 'NEON FACILITY');
  assert.equal(MAP.WIDTH, 44);
  assert.equal(MAP.DEPTH, 32);
  assert.equal(COLLIDERS.length, 60);
  assert.equal(SOLID_BOXES.length, 60);
  assert.equal(CAMERA_BOXES.length, 61, 'kollayder + pol plastinkasi');
  assert.deepEqual(kindList(), KIND_COUNTS);
  assert.equal(new Set(COLLIDERS.map((c) => c.id)).size, 60, 'id’lar takrorlanmasligi kerak');
});

test('map: kollayder budjeti ≤120 (Phase 3 talabi) va 5 callout', () => {
  assert.ok(COLLIDERS.length <= 120, `kollayder budjeti oshdi: ${COLLIDERS.length} > 120`);
  assert.equal(CALLOUTS.length, 5, 'aynan 5 ta foydali callout bo‘lishi kerak');
  assert.equal(LANES.length, 3, '3 asosiy lane');
  assert.equal(MAP.WIDTH, 44, 'xarita eni 44 m');
  assert.equal(MAP.DEPTH, 32, 'xarita chuqurligi 32 m');
});

test('map: barcha qutilar yaroqli AABB va xarita chegarasi ichida', () => {
  for (const c of COLLIDERS) {
    const b = c.box;
    assert.equal(b.min.length, 3, `${c.id}: min 3 komponent`);
    assert.equal(b.max.length, 3, `${c.id}: max 3 komponent`);
    for (let i = 0; i < 3; i++) assert.ok(b.max[i] > b.min[i], `${c.id}: bo‘sh AABB ${JSON.stringify(b)}`);
    assert.ok(Math.abs(b.min[0]) <= MAP.HALF_X + MAP.WALL_T + 1e-6, `${c.id}: x chegaradan tashqari`);
    assert.ok(Math.abs(b.max[0]) <= MAP.HALF_X + MAP.WALL_T + 1e-6, `${c.id}: x chegaradan tashqari`);
    assert.ok(Math.abs(b.min[2]) <= MAP.HALF_Z + MAP.WALL_T + 1e-6, `${c.id}: z chegaradan tashqari`);
    assert.ok(Math.abs(b.max[2]) <= MAP.HALF_Z + MAP.WALL_T + 1e-6, `${c.id}: z chegaradan tashqari`);
    assert.ok(b.max[1] <= MAP.WALL_H + 1e-6, `${c.id}: devor balandligidan yuqori (kamera sweep uchun)`);
  }
  assert.ok(FLOOR_BOX.max[1] === MAP.FLOOR_Y, 'pol plastinkasi FLOOR_Y da tugaydi');
});

test('map: 180° markaziy simmetriya — har bir kollayderning aksi mavjud', () => {
  const mirror = (b) => ({ min: [-b.max[0], b.min[1], -b.max[2]], max: [-b.min[0], b.max[1], -b.min[2]] });
  const same = (a, b) => a.min.every((v, i) => v === b.min[i]) && a.max.every((v, i) => v === b.max[i]);
  const missing = [];
  for (const c of COLLIDERS) {
    const m = mirror(c.box);
    if (!COLLIDERS.some((o) => same(o.box, m))) missing.push(c.id);
  }
  assert.deepEqual(missing, [], `aksi topilmagan: ${missing.join(', ')}`);
  assert.deepEqual(kindList(), KIND_COUNTS, 'simmetriya kind taqsimotini buzmasligi kerak');
});

test('map: zina/ustun/platforma bir-birining ichiga kirmaydi (faqat krat juftliklari)', () => {
  const vol = (a, b) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - 1e-9 && b.min[i] < a.max[i] - 1e-9);
  const CRITICAL = new Set(['stair', 'platform', 'catwalk', 'core', 'pillar', 'divider']);
  const bad = [];
  for (let i = 0; i < COLLIDERS.length; i++) {
    for (let j = i + 1; j < COLLIDERS.length; j++) {
      const a = COLLIDERS[i]; const b = COLLIDERS[j];
      if (!vol(a.box, b.box)) continue;
      if (CRITICAL.has(a.kind) || CRITICAL.has(b.kind)) bad.push(`${a.id}⨯${b.id}`);
    }
  }
  assert.deepEqual(bad, [], `muhim kollayderlar kesishadi: ${bad.join(', ')}`);
});

// ---------- 2) geometriya nizomi ----------
test('map: REACTOR zinalari pol → platforma yo‘nalishida ko‘tariladi', () => {
  const west = COLLIDERS.filter((c) => /^reactor-stair-w\d$/.test(c.id));
  assert.equal(west.length, REACTOR.STAIR_COUNT);
  // w0 = platformaga eng yaqin, w3 = eng olis
  const near = west.find((c) => c.id === 'reactor-stair-w0');
  const far = west.find((c) => c.id === `reactor-stair-w${REACTOR.STAIR_COUNT - 1}`);
  assert.equal(near.box.max[1], REACTOR.PLATFORM.max[1], 'eng yaqin zina platforma sathida bo‘lishi kerak');
  assert.equal(far.box.max[1], REACTOR.STAIR_STEP, 'eng olis zina bir qadam balandlikda');
  assert.ok(near.box.min[0] === REACTOR.PLATFORM.min[0] - 0.8, 'zina platforma chetidan boshlanadi');
  for (let i = 0; i < REACTOR.STAIR_COUNT; i++) {
    const s = west.find((c) => c.id === `reactor-stair-w${i}`);
    assert.ok(s.box.max[1] - MAP.FLOOR_Y <= PLAYER.HEIGHT, `${s.id}: balandlik budgeti`);
    const east = COLLIDERS.find((c) => c.id === `reactor-stair-w${i}-R`);
    assert.ok(east, `reactor-stair-w${i}-R yo‘q`);
    assert.equal(east.box.max[1], s.box.max[1], `sharq zinasi balandligi farq qiladi: ${s.id}`);
  }
  // poldan platformagacha har bir qadam STEP_HEIGHT dan oshmaydi (tashqaridan ichkariga)
  let level = MAP.FLOOR_Y;
  for (let i = REACTOR.STAIR_COUNT - 1; i >= 0; i--) {
    const s = west.find((c) => c.id === `reactor-stair-w${i}`);
    const rise = s.box.max[1] - level;
    assert.ok(rise <= PLAYER.STEP_HEIGHT + 1e-9, `${s.id}: qadam ${rise.toFixed(2)} m > STEP_HEIGHT`);
    level = s.box.max[1];
  }
  assert.equal(level, REACTOR.PLATFORM.max[1], 'zina platforma sathiga yetishi kerak');
});

test('map: CATWALK zinalari deck sathiga chiqadi, ostidan yurish mumkin', () => {
  for (const deck of COLLIDERS.filter((c) => c.kind === 'catwalk')) {
    assert.equal(deck.box.max[1], CATWALK.DECK_TOP);
    assert.equal(deck.box.min[1], CATWALK.DECK_BOTTOM);
  }
  assert.ok(CATWALK.DECK_BOTTOM > PLAYER.HEIGHT,
    `deck ostidan o‘tib bo‘lmaydi: ${CATWALK.DECK_BOTTOM} ≤ ${PLAYER.HEIGHT}`);
  const flight = COLLIDERS.filter((c) => /^catwalk-nw\d$/.test(c.id));
  assert.equal(flight.length, CATWALK.STEPS);
  let prevTop = MAP.FLOOR_Y;
  for (let i = flight.length - 1; i >= 0; i--) {
    const s = flight.find((c) => c.id === `catwalk-nw${i}`);
    assert.ok(s.box.max[1] - prevTop <= PLAYER.STEP_HEIGHT + 1e-9, `${s.id}: qadam juda baland`);
    prevTop = s.box.max[1];
  }
  assert.equal(prevTop, CATWALK.DECK_TOP, 'oxirgi zina deck sathiga yetishi kerak');
  assert.ok(REACTOR.PLATFORM.max[1] > PLAYER.STEP_HEIGHT,
    'platforma oddiy qadam bilan emas, zina orqali olinishi kerak');
});

test('map: moveAABB — zinaga chiqadi, platforma devoriga uriladi, deck ostidan o‘tadi', () => {
  // 1) mid lane'dan g'arb zinasiga qadam
  let r = moveAABB({ x: -8.4, y: MAP.FLOOR_Y, z: 0 }, { x: 1.0, y: 0, z: 0 },
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
  assert.equal(r.stepped, true, 'zinaga ko‘tarilishi kerak (step-up)');
  assert.ok(r.y > 0.25 && r.y <= 0.35, `zina balandligi: y=${r.y}`);

  // 2) platforma devoriga (zina bo'lmagan z=3 kesimi) urilib to‘xtash
  r = moveAABB({ x: -8, y: MAP.FLOOR_Y, z: 3 }, { x: 5, y: 0, z: 0 },
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
  assert.equal(r.hitX, true, 'platforma devori to‘smadi');
  assert.ok(Math.abs(r.x - (REACTOR.PLATFORM.min[0] - PLAYER.RADIUS)) < 1e-6, `to‘xtash x=${r.x}`);
  assert.equal(r.y, MAP.FLOOR_Y, 'platformaga qadam bilan chiqib ketmasligi kerak');

  // 2b) MID lane'dagi divider (nmid + uning 180° aksi) to‘sadi
  r = moveAABB({ x: 0, y: MAP.FLOOR_Y, z: 6 }, { x: 0, y: 0, z: -3 },
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
  assert.equal(r.hitZ, true, 'divider to‘smadi');
  assert.ok(Math.abs(r.z - 5.2) < 1e-6, `divider to‘xtashi z=${r.z}`);

  // 3) catwalk deck OSTI bo‘sh (yurish mumkin)
  r = moveAABB({ x: -10.5, y: MAP.FLOOR_Y, z: -12 }, { x: -2, y: 0, z: 0 },
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
  assert.equal(r.hitX, false, 'deck ostida to‘siq bor');
  assert.ok(Math.abs(r.x - -12.5) < 1e-6 && r.y === MAP.FLOOR_Y, `deck ostida x=${r.x} y=${r.y}`);
});

test('map: groundHeight — platforma/dek/pol sathlarini to‘g‘ri qaytaradi', () => {
  assert.equal(groundHeight(-3, 0, 1.2, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y), REACTOR.PLATFORM.max[1]);
  assert.equal(groundHeight(-10.5, -12, 2.25, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y), CATWALK.DECK_TOP);
  assert.equal(groundHeight(-10.5, -12, 0.5, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y), MAP.FLOOR_Y);
  assert.equal(groundHeight(0, 8, 0, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y), MAP.FLOOR_Y);
});

test('map: spawn hududlari, callout’lar va lane’lar izchil', () => {
  for (const key of ['A', 'B']) {
    const s = SPAWNS[key];
    const z = SPAWN_ZONES[key];
    assert.ok(s.x > z.min[0] && s.x < z.max[0], `spawn ${key} hududidan tashqarida`);
    assert.ok(s.z > z.min[2] && s.z < z.max[2], `spawn ${key} hududidan tashqarida`);
    assert.equal(s.y, MAP.FLOOR_Y);
    const clear = headroomClear(s.x, s.y, s.z, PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
    assert.ok(clear, `spawn ${key} kollayder ichida`);
  }
  assert.ok(SPAWNS.A.x === -SPAWNS.B.x, 'spawn’lar simmetrik emas (x)');
  assert.ok(SPAWNS.A.z === -SPAWNS.B.z, 'spawn’lar simmetrik emas (z)');

  for (const c of CALLOUTS) {
    assert.ok(Math.abs(c.x) <= MAP.HALF_X && Math.abs(c.z) <= MAP.HALF_Z, `${c.id} xaritadan tashqarida`);
    assert.ok(['A', 'B'].includes(c.color), `${c.id}: noto‘g‘ri rang`);
  }
  const reactorCallout = CALLOUTS.find((c) => c.id === 'REACTOR');
  const deckCallout = CALLOUTS.find((c) => c.id === 'CATWALK');
  assert.ok(reactorCallout.y > REACTOR.PLATFORM.max[1] && reactorCallout.y < REACTOR.PLATFORM.max[1] + 0.1,
    'REACTOR callout platforma sathida emas');
  assert.ok(deckCallout.y > CATWALK.DECK_TOP && deckCallout.y < CATWALK.DECK_TOP + 0.1,
    'CATWALK callout deck sathida emas');

  assert.equal(LANES.length, 3, '3 lane bo‘lishi kerak');
  for (const lane of LANES) {
    for (let i = 0; i < 3; i++) assert.ok(lane.max[i] > lane.min[i], `${lane.id}: bo‘sh hudud`);
    assert.ok(Math.abs(lane.max[0]) <= MAP.HALF_X && Math.abs(lane.max[2]) <= MAP.HALF_Z, `${lane.id} xaritadan tashqarida`);
  }
  assert.ok(PALETTE.TRIM !== PALETTE.TRIM_ALT && PALETTE.FLOOR !== PALETTE.WALL, 'palitra qiymatlari');
});

test('map: mashq nishonlari xarita ichida va kollayderlarga tiqilmagan', () => {
  const RAD = 0.5;
  for (const t of [...TRAINING_DUMMIES, ...TRAINING_RINGS]) {
    assert.ok(Math.abs(t.x) < MAP.HALF_X && Math.abs(t.z) < MAP.HALF_Z, `${t.id} xaritadan tashqarida`);
    for (const b of SOLID_BOXES) {
      const hit = t.x > b.min[0] - RAD && t.x < b.max[0] + RAD &&
                  t.z > b.min[2] - RAD && t.z < b.max[2] + RAD &&
                  overlapsY(b, t.y, 1.7);
      assert.ok(!hit, `${t.id} kollayder ichida: ${JSON.stringify(b)}`);
    }
  }
});

test('sweepCamera: real mapada kamera devor/o‘zak ichiga kirmaydi', () => {
  const back = sweepCamera({ x: SPAWNS.A.x, y: CAMERA.PIVOT_Y, z: SPAWNS.A.z },
    { x: SPAWNS.A.x - CAMERA.DISTANCE, y: CAMERA.PIVOT_Y, z: SPAWNS.A.z }, CAMERA_BOXES, CAMERA.RADIUS);
  assert.ok(back.x > -MAP.HALF_X + CAMERA.RADIUS - 1e-6, `kamera devor ichida: x=${back.x}`);

  const wall = sweepCamera({ x: -21.4, y: CAMERA.PIVOT_Y, z: 0 },
    { x: -21.4 - CAMERA.DISTANCE, y: CAMERA.PIVOT_Y, z: 0 }, CAMERA_BOXES, CAMERA.RADIUS, CAMERA.MIN_DISTANCE);
  assert.equal(wall.blocked, true, 'g‘arb devori kamerani qisqartirmadi');
  assert.ok(wall.x > -MAP.HALF_X, `kamera devor ichida: x=${wall.x}`);

  const core = sweepCamera({ x: 0, y: CAMERA.PIVOT_Y, z: -2.6 },
    { x: 0, y: CAMERA.PIVOT_Y, z: -2.6 + CAMERA.DISTANCE }, CAMERA_BOXES, CAMERA.RADIUS);
  assert.equal(core.blocked, true, 'reaktor o‘zagi kamerani to‘smadi');
  assert.ok(core.z < REACTOR.CORE.min[2], `kamera o‘zak ichida: z=${core.z}`);

  assert.ok(CAMERA.PITCH_MIN < 0 && CAMERA.PITCH_MAX > 0 && MOVE.SPRINT > MOVE.WALK);
});

// ---------- 3) REAL FIZIKA BFS (reachability) ----------
/**
 * Spawn'dan moveAABB (haqiqiy o'yin fizikasi) bilan 1 m qadamlab yetib
 * boriladigan barcha holatlar. Har qadam: harakat + gravitatsiya snap.
 * Holatlar 0.25 m kvantlanadi (dedupe). Shu tarzda "xaritada chiqib
 * bo'lmaydigan joy" yo'qligi isbotlanadi (zina teskari bo'lsa test yiqiladi).
 */
function reachable (start) {
  const Q = (v) => Math.round(v * 4) / 4;
  const key = (n) => [Q(n.x), Q(n.y), Q(n.z)].join('|');
  const s0 = { x: start.x, y: groundHeight(start.x, start.z, start.y, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y), z: start.z };
  const seen = new Set([key(s0)]);
  const visited = [s0];
  const queue = [s0];
  while (queue.length) {
    const p = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r = moveAABB(p, { x: dx, z: dz }, PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES);
      if (Math.hypot(r.x - p.x, r.z - p.z) < 0.6) continue;      // devor to‘sdi
      const g = groundHeight(r.x, r.z, Math.max(r.y, p.y) + 0.05, PLAYER.RADIUS, SOLID_BOXES, MAP.FLOOR_Y);
      const n = { x: r.x, y: g, z: r.z };
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      visited.push(n);
      queue.push(n);
    }
  }
  return visited;
}

test('map: BFS reachability — platforma, catwalk va 3 lane spawn’dan yetib boriladi', () => {
  const nodes = reachable(SPAWNS.A);
  const at = (fn) => nodes.some(fn);
  const checks = [
    ['SPAWN B (sharq) yetib boriladi', at((n) => Math.abs(n.x - 19.5) < 1.01 && Math.abs(n.z) < 1.01 && n.y < 0.05)],
    ['REACTOR platformasi (y=1.2) — zina orqali', at((n) => Math.abs(n.x) < 4.6 && Math.abs(n.z) < 4.1 && n.y > 1.19)],
    ['CATWALK shimoliy deck (y=2.2)', at((n) => Math.abs(n.z + 12) < 1.6 && n.y > 2.19)],
    ['CATWALK janubiy deck (y=2.2)', at((n) => Math.abs(n.z - 12) < 1.6 && n.y > 2.19)],
    ['CATWALK zinasi (y>0.8, g‘arb uchi)', at((n) => n.x < -16 && n.x > -19 && n.y > 0.8 && Math.abs(n.z + 12) < 1.6)],
    ['LONG koridor (deck OSTI, y=0)', at((n) => Math.abs(n.z + 12) < 1.6 && n.y < 0.05)],
    ['MID lane (x≈-12 … sharq, y=0)', at((n) => Math.abs(n.z) < 0.6 && n.x > 7 && n.x < 9 && n.y < 0.05)],
    ['divider teshigi (x≈-12, z≈-4.5) — lanelar orasi', at((n) => Math.abs(n.x + 12) < 1.01 && n.z < -3.5 && n.z > -5.5)],
    ['reaktor o‘zagi ustida turib bo‘lmaydi (to‘siq)', !at((n) => Math.abs(n.x) < 1.0 && Math.abs(n.z) < 1.0 && n.y > 1.3 && n.y < 3.1)]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  assert.ok(nodes.length > 500, `BFS juda kam holat ko‘rdi: ${nodes.length}`);
  assert.deepEqual(failed, [], `yetib bo‘lmaydigan nuqtalar: ${failed.join(' | ')}`);
});