// ============================================================
// NEON STRIKE — PHASE 4: RESPAWN (SOF QOIDALAR)
// MAVJUD xarita spawn ma'lumotidan foydalanadi: SPAWNS.A / SPAWNS.B.
// Spawn kolliziya ichida bo'lmasligi AVVAL tekshiriladi (headroomClear +
// groundHeight) — "spawn inside collision" holati mumkin emas.
// Jamoa/round/ballar YO'Q (Phase 8).
// ============================================================
import { headroomClear, groundHeight, PLAYER } from './collision.js';
import { SPAWNS, SOLID_BOXES, MAP } from './map.js';
import { createHealth, resetHealth, HEALTH } from './health.js';
import { refillLoadout } from './weapons.js';

/** Respawn nomzodlari tartibi (deterministik) */
export const RESPAWN_ORDER = Object.freeze(['A', 'B']);

/**
 * Spawn nuqtasi yaroqlimi: bo'sh joy (headroom) + pol/yuzaga mos balandlik.
 * @returns {{valid:boolean, reason:string, groundY:number}}
 */
export function validateSpawn (spawn, opts = {}) {
  const boxes = opts.boxes || SOLID_BOXES;
  const radius = opts.radius || PLAYER.RADIUS;
  const height = opts.height || PLAYER.HEIGHT;
  const floorY = opts.floorY === undefined ? MAP.FLOOR_Y : opts.floorY;
  const tol = opts.groundTolerance === undefined ? 0.35 : opts.groundTolerance;

  if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.y) || !Number.isFinite(spawn.z)) {
    return { valid: false, reason: 'bad_spawn', groundY: NaN };
  }
  const groundY = groundHeight(spawn.x, spawn.z, spawn.y + 0.05, radius, boxes, floorY);
  if (!headroomClear(spawn.x, spawn.y, spawn.z, radius, height, boxes)) {
    return { valid: false, reason: 'blocked', groundY };
  }
  if (Math.abs(groundY - spawn.y) > tol) {
    return { valid: false, reason: groundY > spawn.y ? 'inside_floor' : 'floating', groundY };
  }
  return { valid: true, reason: 'ok', groundY };
}

/**
 * Nomzodlar orasidan BIRINCHI yaroqli spawnni oladi (deterministik tartib).
 * @param {Array<object>} candidates
 * @returns {{spawn:object|null, checks:Array}}
 */
export function pickSpawn (candidates, opts = {}) {
  const checks = [];
  for (const c of candidates) {
    const v = validateSpawn(c, opts);
    checks.push({ spawn: c, ...v });
    if (v.valid) return { spawn: c, checks };
  }
  return { spawn: null, checks };
}

/** Standart nomzodlar: SPAWNS.A birinchi (Phase 2/3 spawn bilan bir xil) */
export function defaultRespawnCandidates () {
  return RESPAWN_ORDER.map((k) => SPAWNS[k]).filter(Boolean);
}

/**
 * Respawn qo'llanadi: HP to'liq, o'lim holati tozalanadi, o'q-dori to'liq,
 * pozitsiya/yaw spawn nuqtasiga o'rnatiladi.
 * @param {object} subject {health, loadout, position:{x,y,z}, yaw}
 */
export function applyRespawn (subject, spawn) {
  if (!subject || !spawn) return null;
  if (subject.health) resetHealth(subject.health);
  if (subject.loadout) refillLoadout(subject.loadout);
  if (subject.position) {
    subject.position.x = spawn.x;
    subject.position.y = spawn.y;
    subject.position.z = spawn.z;
  }
  if (Number.isFinite(spawn.yaw)) subject.yaw = spawn.yaw;
  subject.respawns = (subject.respawns || 0) + 1;
  return subject;
}

/** O'yinchi uchun yangi combatant holati (position — tashqi obyekt bilan ulashiladi) */
export function createPlayerSubject (position, opts = {}) {
  return {
    health: createHealth(opts.maxHp || HEALTH.PLAYER_MAX, { label: 'player' }),
    loadout: opts.loadout || null,
    position: position || { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z },
    yaw: opts.yaw === undefined ? SPAWNS.A.yaw : opts.yaw,
    respawns: 0
  };
}