// ============================================================
// NEON STRIKE — PHASE 7 testlari: KO'P O'YINCHILI SINXRONIZATSIYA
//
// Ishlab chiqarish modullari: server/session.js + server/lobby.js +
// server/app.js (HAQIQIY WebSocket oqimi) + client/js/game/sync-math.js.
// Mock YO'Q — hamma tekshiruv server XOTIRASI va real xabarlardan olinadi.
//
// Qoplanadi: input ketma-ketligi (seq/ack) · avtoritativ harakat ·
// SNAPSHOT qurilishi/filtrlash · o'yinchi sinxronizatsiyasi · masofaviy
// o'yinchi hayotiy sikli · disconnect tozalash · join-in-progress ·
// interpolatsiya · rekonsiliatsiya · buzilgan sinxronizatsiya xabarlari ·
// avtoritet chegaralari.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WebSocket } from 'ws';

import {
  createSession, validateInput, applyInput, stepSession, sessionSnapshot,
  setAuthoritativeMovement, playerSyncState, resetSession, targetHp,
  SESSION_REJECT, FORBIDDEN_FIELDS
} from '../../server/session.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, SIM, PROTOCOL_VERSION } from '../../shared/protocol-consts.js';
import { SPAWNS, SOLID_BOXES, MAP } from '../../shared/map.js';
import { headroomClear, PLAYER } from '../../shared/collision.js';
import { stepMovement, createMovementState, normalizeAxis } from '../../shared/movement.js';
import {
  sampleBuffer, computeReconcile, applyCorrection, SNAP_THRESHOLD
} from '../../client/js/game/sync-math.js';
import { WEAPONS } from '../../shared/weapons.js';

const RIFLE = WEAPONS['neon-rifle'];

// ---------------- yordamchilar ----------------
let NOW = 1000;
const mkSession = (id = 1) => createSession({ id, seed: id, now: NOW });

/**
 * Input xabari. Standalone rejimda server pozani TEKSHIRADI (chegara + kolliziya),
 * shu sababli standart poza spawn A (xaritada tekshirilgan ERKIN nuqta).
 */
const inputMsg = (seq, { x = SPAWNS.A.x, z = SPAWNS.A.z, y = SPAWNS.A.y, yaw = 0 } = {}, move, extra = {}) => ({
  seq,
  pose: { x, y, z, yaw, pitch: 0 },
  aim: { dir: [0, 0, 1] },
  // bo'sh obyekt "harakat niyati yo'q" degani (move maydoni umuman yuborilmaydi)
  ...(move && Object.keys(move).length ? { move } : {}),
  ...extra
});

// ============================================================
// 1) AVTORITATIV HARAKAT (server tomonda)
// ============================================================
test('p7: authoritativeMovement YO\'Q bo\'lsa — validatsiyadan o\'tgan poza pozitsiya bo\'ladi (Phase 5 yo\'li)', () => {
  const s = mkSession(1);
  assert.equal(s.authoritativeMovement, false, 'sessiya boshida avtoritativ harakat yoqilgan');
  // spawn A yaqinidagi ERKIN nuqta (xarita kolliziyasi tekshirilgan)
  const target = { x: SPAWNS.A.x + 1.5, y: SPAWNS.A.y, z: SPAWNS.A.z + 0.5 };
  assert.equal(headroomClear(target.x, target.y, target.z, PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES),
    true, 'test nuqtasi kolliziyada');
  const r = applyInput(s, inputMsg(1, target, { forward: 1, right: 0 }), NOW);
  assert.equal(r.ok, true);
  // standalone: poza qabul qilinadi (Phase 5 xatti-harakati o'zgarmagan)
  assert.equal(s.state.position.x, target.x);
  assert.equal(s.state.position.z, target.z);
  assert.equal(s.counters.poseIgnored, 0);
  assert.equal(s.moveIntent.forward, 0, 'standalone da harakat niyati qo\'llanmadi');
});

test('p7: in_game → klient pozasi pozitsiya EMAS, server harakatni O\'ZI simulyatsiya qiladi', () => {
  const s = mkSession(2);
  setAuthoritativeMovement(s, true);
  assert.equal(s.authoritativeMovement, true);
  const startX = s.state.position.x;
  const startZ = s.state.position.z;

  // (a) soxta katta poza yuboriladi + harakat niyati YO'Q → pozitsiya o'zgarmaydi
  const r1 = applyInput(s, inputMsg(1, { x: -13, z: -11, y: 0 }, {}), NOW);
  assert.equal(r1.ok, true);
  assert.equal(s.state.position.x, startX, 'klient pozasi avtoritar pozitsiyani buzdi');
  assert.equal(s.state.position.z, startZ);
  assert.equal(s.counters.poseIgnored, 1);

  // (b) harakat niyati bilan pozitsiya SERVER simulyatsiyasidan o'zgaradi
  for (let i = 2; i <= 6; i++) {
    applyInput(s, inputMsg(i, { x: 999, z: 999, y: 0 }, { forward: 1, right: 0 }), NOW);
  }
  for (let t = 0; t < 30; t++) stepSession(s, (NOW += 33), SIM.TICK_MS);

  const moved = Math.hypot(s.state.position.x - startX, s.state.position.z - startZ);
  assert.ok(moved > 0.5, `server simulyatsiyasi pozitsiyani o'zgartirmadi (${moved})`);
  assert.ok(s.counters.movedTicks >= 30, 'harakat ticklari hisoblanmadi');
  // pozitsiya xarita chegarasida va kolliziyada emas
  assert.ok(Math.abs(s.state.position.x) <= MAP.HALF_X + 1.2);
  assert.ok(headroomClear(s.state.position.x, s.state.position.y, s.state.position.z,
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES), 'server o\'yinchini devor ichiga olib kirdi');
  // aimOrigin harakatdan KEYIN qayta hisoblanadi (ko'z balandligi serverda)
  assert.equal(s.state.aimOrigin[0], s.state.position.x);
  assert.equal(s.state.aimOrigin[2], s.state.position.z);
});

test('p7: avtoritativ harakat devor bilan to\'xtatiladi (map kolliziyasi server tomonda)', () => {
  const s = mkSession(3);
  setAuthoritativeMovement(s, true);
  // spawn A dan g'arbiy devorga tomon yurar (yaw = SPAWNS.A.yaw → forward +x;
  // forward:-1 → -x) → devor to'xtatadi, o'tib ketmaydi
  for (let i = 1; i <= 4; i++) {
    applyInput(s, inputMsg(i, { yaw: SPAWNS.A.yaw }, { forward: -1, right: 0 }), NOW);
  }
  for (let t = 0; t < 150; t++) stepSession(s, (NOW += 33), SIM.TICK_MS);
  assert.ok(s.state.position.x >= -MAP.HALF_X - 1, 'server devordan o\'tib ketdi');
  assert.ok(s.movement.collisions > 0, 'devor to\'qnashuvi qayd etilmadi');
  assert.ok(headroomClear(s.state.position.x, s.state.position.y, s.state.position.z,
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES));
});

test('p7: sprint harakati urinishdan tezroq (server simulyatsiyasi)', () => {
  const walk = mkSession(4);
  const run = mkSession(5);
  setAuthoritativeMovement(walk, true);
  setAuthoritativeMovement(run, true);
  const x0 = walk.state.position.x, z0 = walk.state.position.z;
  for (const s of [walk, run]) {
    for (let i = 1; i <= 4; i++) {
      // yaw = SPAWNS.A.yaw → forward +x (arena ichiga engash)
      applyInput(s, inputMsg(i, { yaw: SPAWNS.A.yaw },
        { forward: 1, right: 0, sprint: s === run }), NOW);
    }
  }
  // Qisqa yugurish (devorga yetmasidan) — sprint tezligi darhol ko'rinadi
  for (let t = 0; t < 12; t++) { stepSession(walk, (NOW += 33), SIM.TICK_MS); stepSession(run, NOW, SIM.TICK_MS); }
  const dWalk = Math.hypot(walk.state.position.x - x0, walk.state.position.z - z0);
  const dRun = Math.hypot(run.state.position.x - x0, run.state.position.z - z0);
  assert.equal(walk.movement.sprinting, false);
  assert.equal(run.movement.sprinting, true, 'sprint flagi server tomonda qo\'llanmadi');
  assert.ok(run.movement.speed > walk.movement.speed + 0.5,
    `sprint tezligi oshmadi: ${run.movement.speed} vs ${walk.movement.speed}`);
  assert.ok(dRun > dWalk, `sprint masofasi ko'proq emas: ${dRun} vs ${dWalk}`);
});

test('p7: sof harakat yadrosi klient va server uchun BIR XIL (bitta manba)', () => {
  const a = createMovementState({ spawn: SPAWNS.A });
  const b = createMovementState({ spawn: SPAWNS.A });
  let yaw = 0.4;
  for (let i = 0; i < 40; i++) {
    yaw += 0.01;
    stepMovement(a, 1 / 60, { forward: 1, right: 0.3 }, yaw, false);
    stepMovement(b, 1 / 60, { forward: 1, right: 0.3 }, yaw, false);
  }
  assert.deepEqual(a.pos, b.pos, 'deterministik emas');
  // server yo'li ham aynan shu funksiyani chaqiradi (import tekshiruvi)
  const src = fs.readFileSync(new URL('../../server/session.js', import.meta.url), 'utf8');
  assert.match(src, /stepMovement/);
  assert.match(src, /createMovementState/);
});

// ============================================================
// 2) INPUT KETMA-KETLIGI VA VALIDATSIYA
// ============================================================
test('p7: move maydoni validatsiyasi — NaN/Infinity/tur xatosi rad etiladi', () => {
  const s = mkSession(10);
  const cases = [
    [{ forward: NaN, right: 0 }, SESSION_REJECT.BAD_MOVE],
    [{ forward: 0, right: Infinity }, SESSION_REJECT.BAD_MOVE],
    [{ forward: '-1', right: 0 }, SESSION_REJECT.BAD_MOVE],
    ['w', SESSION_REJECT.BAD_MOVE],
    [{ forward: 0, right: 0, sprint: 'ha' }, SESSION_REJECT.BAD_MOVE]
  ];
  let seq = 1;
  for (const [move, reason] of cases) {
    const v = validateInput(s, inputMsg(seq++, {}, move), NOW);
    assert.equal(v.ok, false, `qabul qilindi: ${JSON.stringify(move)}`);
    assert.equal(v.reason, reason);
  }
  // chekli qiymatlar qabul qilinadi (me'yorga qisqartiriladi)
  const v = validateInput(s, inputMsg(99, {}, { forward: 5, right: -5 }), NOW);
  assert.equal(v.ok, true);
  assert.equal(v.move.forward, 1);
  assert.equal(v.move.right, -1);
  assert.equal(validateInput(s, inputMsg(99, {}), NOW).move, null);
});

test('p7: seq — takroriy/eski/NaN buyruqlar rad etiladi (replay himoyasi)', () => {
  const s = mkSession(11);
  setAuthoritativeMovement(s, true);
  assert.equal(applyInput(s, inputMsg(5, {}, { forward: 0, right: 0 }), NOW).ok, true);
  assert.equal(applyInput(s, inputMsg(5, {}, null), NOW).reason, SESSION_REJECT.DUPLICATE_SEQ);
  assert.equal(applyInput(s, inputMsg(4, {}, null), NOW).reason, SESSION_REJECT.STALE_SEQ);
  assert.equal(applyInput(s, inputMsg(NaN, {}, null), NOW).reason, SESSION_REJECT.BAD_SEQ);
  assert.equal(s.lastSeq, 5, 'lastSeq buzildi');
});

test('p7: ackSeq — tasdiqlangan ketma-ketlik STATE va SNAPSHOT da ko\'rinadi', () => {
  const s = mkSession(12);
  setAuthoritativeMovement(s, true);
  for (let i = 1; i <= 3; i++) {
    applyInput(s, inputMsg(i, {}, { forward: 0, right: 0 }), NOW);
    stepSession(s, (NOW += 33), SIM.TICK_MS);
  }
  const snap = sessionSnapshot(s, {});
  assert.equal(snap.ackSeq, 3);
  assert.equal(snap.tick, s.tick);
  assert.equal(snap.authoritativeMovement, true);
});

// ============================================================
// 3) AVTORITET CHEGARALARI (klient holat da'vo qila olmaydi)
// ============================================================
test('p7: klient pozitsiya/tezlik/tick/HP/zarar/o\'lim da\'vo qila olmaydi', () => {
  const s = mkSession(13);
  setAuthoritativeMovement(s, true);
  const forged = [
    'position', 'pos', 'velocity', 'vx', 'vy', 'vz', 'tick', 'serverTick',
    'spread', 'seed', 'recoil', 'authoritative',
    'hp', 'health', 'damage', 'hit', 'alive', 'ammo', 'cooldown'
  ];
  for (const f of forged) {
    const v = validateInput(s, { ...inputMsg(1, {}, null), [f]: 123 }, NOW);
    assert.equal(v.ok, false, `soxta maydon qabul qilindi: ${f}`);
    assert.equal(v.reason, SESSION_REJECT.FORBIDDEN_AUTHORITY);
    assert.equal(v.field, f);
  }
  for (const f of forged) assert.ok(FORBIDDEN_FIELDS.includes(f), `FORBIDDEN_FIELDS da yo'q: ${f}`);
});

test('p7: soxta harakat buyrug\'i server holatini O\'ZGARTIRMAYDI', () => {
  const s = mkSession(14);
  setAuthoritativeMovement(s, true);
  const before = { ...s.state.position, hp: s.state.health.hp };
  const r = applyInput(s, {
    seq: 1,
    pose: { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 },
    aim: { dir: [0, 0, 1] },
    position: { x: -13, z: -11 },
    vx: 50, vz: 50, tick: 9999, hp: 5
  }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, SESSION_REJECT.FORBIDDEN_AUTHORITY);
  assert.deepEqual({ ...s.state.position, hp: s.state.health.hp }, before, 'holat o\'zgardi!');
  assert.equal(s.lastSeq, -1, 'soxta buyruq ketma-ketlikni oldi');
});

// ============================================================
// 4) SNAPSHOT QURILISHI / FILTRLASH (sof)
// ============================================================
test('p7: playerSyncState — minimal, chekli, faqat avtoritar maydonlar', () => {
  const s = mkSession(15);
  setAuthoritativeMovement(s, true);
  for (let i = 1; i <= 3; i++) {
    applyInput(s, inputMsg(i, {}, { forward: 1, right: 0.5 }), NOW);
    stepSession(s, (NOW += 33), SIM.TICK_MS);
  }
  const out = playerSyncState(s, {});
  assert.equal(out.id, 'p15');
  assert.equal(out.sessionId, 15);
  for (const k of ['x', 'y', 'z', 'vx', 'vz', 'speed', 'yaw', 'pitch', 'faceYaw']) {
    assert.equal(Number.isFinite(out[k]), true, `${k} chekli emas: ${out[k]}`);
  }
  assert.equal(out.alive, true);
  assert.equal(out.hp, 100);
  // oq-dori/cooldown kabi o'yin natijalari sinxronizatsiya paketiga chiqmaydi
  assert.equal('ammo' in out, false);
  assert.equal('mag' in out, false);
  // allocatsiya yo'q — out qayta ishlatiladi
  const again = playerSyncState(s, out);
  assert.equal(again, out, 'out qayta ishlatilmadi (allocatsiya)');
});

test('p7: sof yadro state.position BILAN bir obyekt (yagona haqiqat)', () => {
  const s = mkSession(16);
  assert.equal(s.movement.pos, s.state.position, 'movement.pos va state.position ajralib ketdi');
  setAuthoritativeMovement(s, true);
  for (let i = 1; i <= 3; i++) {
    applyInput(s, inputMsg(i, {}, { forward: 1, right: 0 }), NOW);
    stepSession(s, (NOW += 33), SIM.TICK_MS);
  }
  assert.equal(s.movement.pos, s.state.position, 'tickdan keyin obyekt almashdi');
});

test('p7: reset sessiyani spawn A ga qaytaradi va harakat holatini ham tiklaydi', () => {
  const s = mkSession(17);
  setAuthoritativeMovement(s, true);
  for (let i = 1; i <= 6; i++) applyInput(s, inputMsg(i, {}, { forward: 1, right: 0 }), NOW);
  for (let t = 0; t < 40; t++) stepSession(s, (NOW += 33), SIM.TICK_MS);
  assert.ok(Math.hypot(s.state.position.x - SPAWNS.A.x, s.state.position.z - SPAWNS.A.z) > 0.5);
  resetSession(s, NOW);
  assert.equal(s.movement.pos, s.state.position);
  assert.equal(s.movement.vel.x, 0);
  assert.equal(s.movement.vel.z, 0);
  assert.equal(s.moveIntent.forward, 0);
  assert.ok(headroomClear(s.state.position.x, s.state.position.y, s.state.position.z,
    PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES), 'reset spawn yaroqsiz');
});

// ============================================================
// 5) INTERPOLATSIYA (sof — multiplayer.js ham shu funksiyani chaqiradi)
// ============================================================
test('p7/interp: ikki snapshot orasida CHIZIQLI interpolatsiya (teleport EMAS)', () => {
  const buf = [
    { t: 1000, x: 0, y: 0, z: 0, yaw: 0, faceYaw: 0, speed: 2, alive: true },
    { t: 1050, x: 10, y: 0, z: 0, yaw: Math.PI / 2, faceYaw: 0, speed: 4, alive: true }
  ];
  const mid = sampleBuffer(buf, 1025);
  assert.equal(mid.interpolated, true, 'interpolatsiya yo\'li ishlamadi');
  assert.equal(Math.round(mid.state.x), 5, 'o\'rta nuqta noto\'g\'ri');
  assert.equal(mid.state.speed, 3);
  assert.ok(mid.state.yaw > 0.7 && mid.state.yaw < 0.85, `yaw interpolatsiyasi: ${mid.state.yaw}`);
  // chegaralar
  assert.equal(sampleBuffer(buf, 1000).state.x, 0);
  assert.equal(sampleBuffer(buf, 1050).state.x, 10);
  assert.equal(sampleBuffer(buf, 1050).interpolated, false);
});

test('p7/interp: bufer chegaralari — bo\'sh/1 element/kechikkan render', () => {
  assert.equal(sampleBuffer([], 0), null);
  const one = sampleBuffer([{ t: 10, x: 1, y: 2, z: 3, yaw: 0, faceYaw: 0, speed: 1, alive: true }], 99);
  assert.equal(one.interpolated, false);
  assert.equal(one.state.x, 1);
  const buf = [
    { t: 0, x: 0, y: 0, z: 0, yaw: 0, faceYaw: 0, speed: 0, alive: true },
    { t: 50, x: 5, y: 0, z: 0, yaw: 0, faceYaw: 0, speed: 0, alive: true }
  ];
  const late = sampleBuffer(buf, 200);
  assert.equal(late.extrapolated, true, 'kechikish qayd etilmadi');
  assert.equal(late.state.x, 5, 'oldindan aytish (extrapolation) qilingan');
  assert.equal(late.interpolated, false);
});

test('p7/interp: yaw interpolatsiyasi 180° da eng qisqa yo\'lni tanlaydi', () => {
  const buf = [
    { t: 0, x: 0, y: 0, z: 0, yaw: 3.0, faceYaw: 0, speed: 0, alive: true },
    { t: 50, x: 0, y: 0, z: 0, yaw: -3.0, faceYaw: 0, speed: 0, alive: true }
  ];
  const s = sampleBuffer(buf, 25).state;
  // 3.0 → -3.0 qisqa yo'li +π orqali: |yaw| π ga yaqin bo'lishi kerak
  assert.ok(Math.abs(s.yaw) > 3.0, `eng qisqa yo'l tanlanmadi: ${s.yaw}`);
});

// ============================================================
// 6) REKONSILIATSIYA (sof — server holati USTUN)
// ============================================================
test('p7/recon: kichik xato → yumshoq tortish; katta xato → snap', () => {
  const pending = [
    { seq: 10, x: 0, y: 0, z: 0 },
    { seq: 11, x: 1, y: 0, z: 0 },
    { seq: 12, x: 2, y: 0, z: 0 }
  ];
  // ackSeq=11, server 1.1 da → xato 0.1 → smooth
  const small = computeReconcile(pending, 11, { x: 1.1, y: 0, z: 0 });
  assert.equal(small.kind, 'smooth');
  assert.equal(small.keepFrom, 2, 'tasdiqlangan buyruqlar navbatdan chiqarilmadi');
  assert.ok(Math.abs(small.error - 0.1) < 1e-9);
  // ackSeq=12, server 15 da → xato 13 → snap
  const big = computeReconcile(pending, 12, { x: 15, y: 0, z: 0 });
  assert.equal(big.kind, 'snap');
  assert.ok(big.error > SNAP_THRESHOLD);
  // tasdiqlanmagan buyruq (ack hali yetmagan) → qaror YO'Q
  assert.equal(computeReconcile(pending, 9, { x: 0, y: 0, z: 0 }), null);
  assert.equal(computeReconcile([], 5, { x: 0, y: 0, z: 0 }), null);
  assert.equal(computeReconcile(pending, NaN, { x: 0, y: 0, z: 0 }), null);
});

test('p7/recon: snap — pozitsiya serverdan olinadi va tezlik nolga tushadi', () => {
  const movement = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 9, z: -4 }, vy: 3 };
  const info = applyCorrection(movement, { kind: 'snap', x: 7, y: 0, z: -3, error: 12 });
  assert.deepEqual(movement.pos, { x: 7, y: 0, z: -3 });
  assert.equal(movement.vel.x, 0);
  assert.equal(movement.vel.z, 0);
  assert.equal(movement.vy, 0);
  assert.equal(info.kind, 'snap');
  assert.equal(info.error, 12);
});

test('p7/recon: smooth — server tomon qismiy tortish (server holati ustun)', () => {
  const movement = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, z: 0 }, vy: 0 };
  applyCorrection(movement, { kind: 'smooth', x: 1, y: 0, z: 0, error: 0.2 }, 0.25);
  assert.ok(Math.abs(movement.pos.x - 0.25) < 1e-9, `tortish noto'g'ri: ${movement.pos.x}`);
  assert.equal(movement.pos.z, 0);
  // server hech qachon klient holatiga "moslashmaydi" — faqat klient tuzatiladi
  assert.equal(applyCorrection(null, { kind: 'snap', x: 1, y: 0, z: 0, error: 1 }), null);
});

test('p7/recon: normalizeAxis — noto\'g\'ri qiymat null qaytaradi', () => {
  assert.deepEqual(normalizeAxis(1, -1), { forward: 1, right: -1 });
  assert.equal(normalizeAxis(NaN, 0), null);
  assert.equal(normalizeAxis(0, Infinity), null);
  assert.equal(normalizeAxis(undefined, 0), null);
});

// ============================================================
// 7) HAQIQIY WEBSOCKET: ikki mustaqil klient sinxronizatsiyasi
// ============================================================
const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const PORT = server.httpServer.address().port;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._q = []; ws._waiters = [];
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
function next (ws, type = null, timeout = 6000) {
  for (let i = 0; i < ws._q.length; i++) {
    if (!type || ws._q[i].type === type) return Promise.resolve(ws._q.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`msg timeout (${type})`)), timeout);
    ws._waiters.push({ type, resolve, to });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));

async function at (pred, label, tries = 200) {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout: ' + label);
}
/** Berilgan ulanishdan `count` ta SNAPSHOT yig'ish (chegaralangan — leak yo'q) */
async function collectSnapshots (ws, count, ms = 4000) {
  const out = [];
  const t0 = Date.now();
  while (out.length < count && Date.now() - t0 < ms) {
    try { out.push(await next(ws, MSG.SNAPSHOT, 1500)); } catch { break; }
  }
  return out;
}
const sessionById = (id) => server.state.sessions.get(id);

async function hello (name) {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name });
  const w = await next(ws, MSG.WELCOME);
  const sess = await next(ws, MSG.SESSION);
  return { ws, welcome: w, session: sess, playerId: sess.playerId };
}
async function closeClient (c) { try { c.ws.terminate(); } catch {} }
async function emptyLobby (tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (!server.state.lobby.session) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
/** lobby'ni tozalash: barcha sessiyalarni yopamiz */
async function resetWorld () {
  for (const ws of [...server.state.connections]) { try { ws.terminate(); } catch {} }
  await emptyLobby();
  await at(() => server.state.connections.size === 0, 'ulanishlar yopilmadi');
}

/** host start → ikki klient tayyor */
async function startedPair () {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const a = await hello('sync-a');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  const b = await hello('sync-b');
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 2, 'join');
  send(a.ws, { type: MSG.START_SESSION });
  await at(() => sessionById(a.session.sessionId).authoritativeMovement
    && sessionById(b.session.sessionId).authoritativeMovement, 'authoritative on');
  return { a, b };
}

/** MC: input yuborish (serverga real WebSocket orqali) */
function fireInput (c, seq, { forward = 0, right = 0, sprint = false } = {}, overrides = {}) {
  const s = sessionById(c.session.sessionId);
  send(c.ws, {
    type: MSG.INPUT,
    seq,
    pose: { x: s.state.position.x, y: s.state.position.y, z: s.state.position.z, yaw: 0, pitch: 0 },
    aim: { dir: [0, 0, 1] },
    move: { forward, right, sprint },
    ...overrides
  });
}

test('WS/P7: host start → serverda ikkita avtoritativ sessiya (har xil playerId)', async () => {
  await resetWorld();
  const { a, b } = await startedPair();
  assert.notEqual(a.playerId, b.playerId, 'player identity takrorlandi');
  assert.equal(a.playerId, 'p1');
  assert.equal(b.playerId, 'p2');
  assert.equal(a.session.sessionId === b.session.sessionId, false, 'sessiyalar bir xil');
  const l = server.state.lobby.session;
  assert.equal(l.players.length, 2);
  assert.equal(l.state, 'in_game');
  assert.equal(server.telemetry().sync.mode, 'authoritative');
  assert.equal(server.telemetry().protocol, PROTOCOL_VERSION);
  await closeClient(a); await closeClient(b);
  await resetWorld();
});

test('WS/P7: A harakat niyati → SERVER pozitsiyasi o\'zgaradi → B SNAPSHOT oladi', async () => {
  await resetWorld();
  const { a, b } = await startedPair();
  const sa = sessionById(a.session.sessionId);
  const sb = sessionById(b.session.sessionId);
  const a0 = { ...sa.state.position };
  const b0 = { ...sb.state.position };

  // B snapshot oqimini tinglaydi (serverdan AVTORITAR holat)
  const pump = collectSnapshots(b.ws, 40, 5000);
  // A ham o'z snapshotlarini tinglaydi (ackSeq — SHU ulanish uchun)
  const pumpA = collectSnapshots(a.ws, 40, 5000);

  // A real harakat buyruqlarini yuboradi (har tick oldin)
  let seq = 0;
  for (let t = 0; t < 45; t++) {
    seq += 1;
    fireInput(a, seq, { forward: 1, right: 0 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const snaps = await pump;
  const snapsA = await pumpA;
  const lastSnap = snaps[snaps.length - 1];
  const lastA = snapsA[snapsA.length - 1];

  // (1) SERVER holati o'zgardi (server XOTIRASI — klient da'vosi emas)
  const movedA = Math.hypot(sa.state.position.x - a0.x, sa.state.position.z - a0.z);
  const movedB = Math.hypot(sb.state.position.x - b0.x, sb.state.position.z - b0.z);
  assert.ok(movedA > 1, `A server tomonda harakatlanmadi: ${movedA}`);
  assert.ok(movedB < 0.05, `B harakatlanmasligi kerak edi: ${movedB}`);
  assert.ok(sa.counters.movedTicks > 0, 'A uchun harakat ticki yo\'q');

  // (2) B SNAPSHOT oldi va unda A ning YANGI avtoritar holati bor
  assert.ok(lastSnap, 'B snapshot olmadi');
  const hide = lastSnap.players.find((p) => p.id === a.playerId);
  assert.ok(hide, 'snapshotda A yo\'q');
  assert.ok(Math.abs(hide.x - sa.state.position.x) < 0.6,
    `snapshot A holatini aks ettirmadi: ${hide.x} vs ${sa.state.position.x}`);
  assert.ok(Number.isFinite(lastSnap.serverTick) && lastSnap.serverTick > 0);
  // ackSeq — A ninng O'Z ulanishi uchun (u yuborgan ketma-ketlik serverda qayta ishlandi)
  assert.ok(lastA && Number.isFinite(lastA.ackSeq) && lastA.ackSeq >= 1, 'ackSeq yo\'q');
  assert.equal(sa.lastSeq >= 1, true, 'server ketma-ketlikni qayd etmadi');
  assert.equal(lastSnap.players.length >= 2, true);

  await closeClient(a); await closeClient(b);
  await resetWorld();
});

test('WS/P7: ikki tomonlama — B yuboradi, A B ning holatini oladi (aks simmetriya)', async () => {
  await resetWorld();
  const { a, b } = await startedPair();
  const sa = sessionById(a.session.sessionId);
  const sb = sessionById(b.session.sessionId);
  const b0 = { ...sb.state.position };

  const pump = collectSnapshots(a.ws, 30, 5000);

  let seq = 0;
  for (let t = 0; t < 30; t++) {
    fireInput(b, ++seq, { forward: 1, right: 0 });
    await new Promise((r) => setTimeout(r, 33));
  }
  const snapsA = await pump;
  const snapA = snapsA[snapsA.length - 1];

  const movedB = Math.hypot(sb.state.position.x - b0.x, sb.state.position.z - b0.z);
  const movedA = Math.hypot(sa.state.position.x - SPAWNS.A.x, sa.state.position.z - SPAWNS.A.z);
  assert.ok(movedB > 1, `B server tomonda harakatlanmadi: ${movedB}`);
  assert.ok(movedA < 0.05, 'A harakatlanmasligi kerak edi');
  assert.ok(snapA && snapA.players.some((p) => p.id === b.playerId), 'A B ni ko\'rmadi');

  await closeClient(a); await closeClient(b);
  await resetWorld();
});

test('WS/P7: disconnect → masofaviy o\'yinchi snapshotdan YO\'QOLADI (stale yo\'q)', async () => {
  await resetWorld();
  const { a, b } = await startedPair();
  const sa = sessionById(a.session.sessionId);

  // B hali oyinda — A ning snapshotida B bor
  const before = await next(a.ws, MSG.SNAPSHOT);
  assert.equal(before.players.some((p) => p.id === b.playerId), true, 'A boshida B ni kormadi');

  await closeClient(b);
  await at(() => !server.state.sessions.has(b.session.sessionId), 'sessiya yopildi');
  await at(() => server.state.lobby.session && server.state.lobby.session.players.length === 1, 'a\'zo tozalandi');

  // A keyingi snapshotlarda B ni KO'RMAYDI (navbatdagi eski snapshotlar emas —
  // YANGI snapshotlar kutiladi)
  let gone = false;
  let latest = null;
  for (let i = 0; i < 60 && !gone; i++) {
    latest = await next(a.ws, MSG.SNAPSHOT, 2000);
    gone = !latest.players.some((p) => p.id === b.playerId);
  }
  assert.equal(gone, true, 'stale masofaviy o\'yinchi qoldi');
  assert.equal(latest.players.length, 1);
  assert.equal(latest.players[0].id, sa.playerId);

  await closeClient(a);
  await resetWorld();
});

test('WS/P7: join-in-progress — yangi a\'zo JORIY avtoritar holatni oladi', async () => {
  await resetWorld();
  const a = await hello('late-host');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await next(a.ws, MSG.LOBBY_STATE);
  send(a.ws, { type: MSG.START_SESSION });
  const sa = sessionById(a.session.sessionId);
  await at(() => sa.authoritativeMovement, 'A authoritative');

  // A o'yin ichida harakatlanadi
  let seq = 0;
  for (let t = 0; t < 25; t++) { fireInput(a, ++seq, { forward: 1, right: 0 }); await new Promise((r) => setTimeout(r, 33)); }
  const aPos = { ...sa.state.position };

  // keyin B qo'shiladi (in_game) → darhol snapshot oladi
  const b = await hello('late-guest');
  send(b.ws, { type: MSG.JOIN_SESSION });
  await at(() => server.state.lobby.session.players.length === 2, 'B qo\'shildi');
  const snap = await next(b.ws, MSG.SNAPSHOT);
  const seenA = snap.players.find((p) => p.id === a.playerId);
  assert.ok(seenA, 'yangi a\'zo mavjud o\'yinchini ko\'rmadi');
  assert.ok(Math.abs(seenA.x - aPos.x) < 0.6, 'yangi a\'zo JORIY holatni olmadi');
  assert.equal(snap.players.length, 2, 'dublikat/o\'zimni takror ko\'rsatish');
  assert.equal(new Set(snap.players.map((p) => p.id)).size, 2, 'player identity takrorlandi');

  await closeClient(a); await closeClient(b);
  await resetWorld();
});

test('WS/P7: soxta sinxronizatsiya xabarlari rad — server tirik qoladi', async () => {
  await resetWorld();
  const { a } = await startedPair();
  const sa = sessionById(a.session.sessionId);
  const pos = { ...sa.state.position };
  let seq = 5000;

  // (a) pozitsiya da'vosi
  send(a.ws, {
    type: MSG.INPUT, seq: ++seq,
    pose: { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] },
    position: { x: -13, z: -11, y: 0 }, tick: 999999
  });
  assert.equal((await next(a.ws, MSG.INPUT_ACK)).reason, 'forbidden_authority');

  // (b) NaN harakat
  send(a.ws, {
    type: MSG.INPUT, seq: ++seq,
    pose: { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 }, aim: { dir: [0, 0, 1] },
    move: { forward: NaN, right: 0 }
  });
  const bad = await next(a.ws, MSG.INPUT_ACK);
  assert.equal(bad.accepted, false);
  assert.equal(bad.reason, 'bad_move');

  // (c) buzilgan JSON / noma'lum tur / katta xabar / buzuq snapshot
  a.ws.send('{snapshot buzuq');
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'bad_json');
  send(a.ws, { type: 'snapshot', players: [{ id: 'p1', x: 1 }] });   // klient→server snapshot
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'unknown_type');
  a.ws.send(JSON.stringify({ type: MSG.INPUT, pad: 'x'.repeat(40000) }));
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'too_big');

  // (d) server holati o'zgarmagan + tirik
  assert.deepEqual({ ...sa.state.position }, pos, 'soxta xabar holatni o\'zgartirdi');
  send(a.ws, { type: MSG.PING, t: 7 });
  assert.equal((await next(a.ws, MSG.PONG)).t, 7);
  assert.equal(server.telemetry().tickErrors, 0);
  await closeClient(a);
  await resetWorld();
});

test('WS/P7: Phase 5 combat avtoriteti sinxronizatsiya bilan birga ISHLAYDI', async () => {
  await resetWorld();
  const { a } = await startedPair();
  const sa = sessionById(a.session.sessionId);
  // A ni nishonga qaratib o'q uzamiz (server hal qiladi) — dushi-1 spawn A dan ko'rinadi
  const hp0 = targetHp(sa, 'dummy-1');
  let seq = 9000;
  for (let t = 0; t < 20; t++) {
    fireInput(a, ++seq, { forward: 0, right: 0 }, {
      aim: { dir: [0, 0, -1] },
      intents: { fire: true, firePressed: true }
    });
    await new Promise((r) => setTimeout(r, 34));
  }
  assert.equal(sa.counters.shotsAccepted > 0, true, 'server otishni qabul qilmadi');
  const snap = sessionSnapshot(sa, {});
  assert.ok(Number.isFinite(snap.weapon.mag), 'server o\'q-dorini boshqarmadi');
  assert.equal(snap.weapon.mag < RIFLE.magSize, true, 'o\'q-dori sarflanmadi');
  assert.ok(targetHp(sa, 'dummy-1') <= hp0, 'server nishon HP sini boshqarmadi');
  // otish natijasi klient yubormagan — server hisoblagan
  assert.ok(sa.state.stats.shots > 0, 'shared combat o\u2019q uzishni qayd etmadi');
  await closeClient(a);
  await resetWorld();
});

test('WS/P7: SNAPSHOT kadansi ~20 Hz (30 Hz tick ichida), ortiqcha yuk yo\'q', async () => {
  await resetWorld();
  const { a } = await startedPair();
  let n = 0;
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) {
    await next(a.ws, MSG.SNAPSHOT, 3000);
    n++;
    if (n >= 6) break;
  }
  const dt = Date.now() - t0;
  // 6 snapshot ≈ 300 ms @20 Hz; keng tolerantlik (CI sekin bo'lishi mumkin)
  assert.ok(n >= 1, 'snapshot oqimi yo\'q');
  assert.ok(dt / n < 200, `snapshot oralig\\u2019i juda katta: ${dt / n} ms`);
  flushMessages(a.ws);
  await closeClient(a);
  await resetWorld();
});

/** Navbatni bo'shatish (keyingi testga eski xabarlar o'tmasin) */
function flushMessages (ws) { if (ws && ws._q) ws._q.length = 0; }

test.after(() => server.close());

// ============================================================
// 8) FAZA CHEGARASI (Phase 10+ kirmagan; Phase 8 = jamoa/raund/ball,
//    Phase 9 = HUD/chat)
// ============================================================
test('p7/chegara: sinxronizatsiya modullari — Phase 10+ termini YO\'Q', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  // PHASE 8 (jamoa/raund/ball) va PHASE 9 (HUD/chat) endi RUXSAT ETILGAN;
  // Phase 10+ (voip/voice/ranking/matchmaking/scoreboard/killfeed/inventory/
  // spectator/replay) hali YO'Q. PHASE 9 chat esa ALOHIDA server/chat.js da —
  // sinxronizatsiya modullarida chat mantig'i BO'LMASLIGI kerak.
  const forbidden = /\b(scoreboard|killfeed|chat\w*|voiceChat|voip|matchmak\w*|ranking|inventory|spectat\w*|replay)\b/i;
  for (const f of ['server/session.js', 'client/js/game/multiplayer.js', 'client/js/game/sync-math.js']) {
    const code = strip(fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'));
    const m = code.match(forbidden);
    assert.equal(m, null, `${f} da Phase 9+ termini: ${m && m[0]}`);
  }
  // PHASE 8: sinxronizatsiya holati jamoa maydonini olib yuradi (server beradi)
  const sess = fs.readFileSync(new URL('../../server/session.js', import.meta.url), 'utf8');
  assert.match(sess, /teamId/, 'session sinxronizatsiya holatida jamoa yo\u2019q');
  // sinxronizatsiya moduli interpolyatsiya/rekonsiliatsiyani HAQIQATAN ishlatadi
  const mp = fs.readFileSync(new URL('../../client/js/game/multiplayer.js', import.meta.url), 'utf8');
  assert.match(mp, /sampleBuffer/, 'interpolatsiya ulanmagan');
  assert.match(mp, /computeReconcile/, 'rekonsiliatsiya ulanmagan');
  // server hech qachon interpolatsiya/rekonsiliatsiya QILMAYDI (u avtoritet)
  const srv = fs.readFileSync(new URL('../../server/session.js', import.meta.url), 'utf8');
  assert.equal(/sampleBuffer|computeReconcile|applyCorrection/.test(srv), false,
    'server klient sinxronizatsiya matematikasini ishlatyapti');
});

test.after(() => { });
