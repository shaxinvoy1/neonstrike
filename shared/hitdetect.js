// ============================================================
// NEON STRIKE — PHASE 4: HIT DETECTION (SOF QOIDALAR)
// MAVJUD kolliziya infratuzilmasi qayta ishlatiladi (shared/collision.js
// rayAABB / pointInBox) — dublikat kolliziya tizimi YARATILMAYDI.
// Natija turlari: 'target' | 'wall' | 'none' | 'invalid' | 'blocked_origin'
// Devor/cover nishonni TO'SADI: devor parametri t doim nishon t si bilan
// solishtiriladi (teng bo'lsa — devor ustuvor, konservativ).
// ============================================================
import { rayAABB, pointInBox } from './collision.js';
import { HIT_ZONES } from './weapons.js';

export { HIT_ZONES } from './weapons.js';

const EPS = 1e-9;

/** Nishon (dummy) gorizontal radiusi — humanoid vizualidan kichik */
export const TARGET_RADIUS = 0.34;
/** Halqa nishoni radiusi */
export const RING_RADIUS = 0.62;

/** Dummy hit-zonalari (balandliklar real humanoid rig'idan olingan) */
export const ZONE_BOUNDS = Object.freeze({
  head: Object.freeze({ y0: 1.45, y1: 1.78, r: 0.2 }),
  body: Object.freeze({ y0: 0.85, y1: 1.45, r: TARGET_RADIUS }),
  legs: Object.freeze({ y0: 0.0, y1: 0.85, r: TARGET_RADIUS * 0.7 })
});

/**
 * Oyoq nuqtasi (x, y, z = yer sathi) atrofidagi 3 ta AABB zona.
 * DIQQAT: qutilar MASSIV ko'rinishida (rayAABB/pointInBox shuni kutadi).
 * @returns {Array<{zone:string, box:{min:number[],max:number[]}}>}
 */
export function humanoidZones (x, y, z, opts = {}) {
  const r = opts.radius || TARGET_RADIUS;
  const scale = r / TARGET_RADIUS;
  const out = [];
  for (const zone of ['head', 'body', 'legs']) {
    const b = ZONE_BOUNDS[zone];
    const zr = b.r * scale;
    out.push({
      zone,
      box: {
        min: [x - zr, y + b.y0, z - zr],
        max: [x + zr, y + b.y1, z + zr]
      }
    });
  }
  return out;
}

/**
 * PHASE 8: mavjud humanoid zonalarini JOYIDA ko'chirish (allokatsiya yo'q).
 * Server har tick boshqa o'yinchilarning pozitsiyasini shu bilan yangilaydi —
 * yangi massiv yaratilmaydi (issiq yo'lda GC bosimi yo'q).
 */
export function placeHumanoidZones (zones, x, y, z, opts = {}) {
  if (!Array.isArray(zones)) return zones;
  const r = opts.radius || TARGET_RADIUS;
  const scale = r / TARGET_RADIUS;
  const hs = opts.heightScale || 1;
  for (let i = 0; i < zones.length; i++) {
    const b = ZONE_BOUNDS[zones[i].zone];
    if (!b) continue;
    const zr = b.r * scale;
    const box = zones[i].box;
    box.min[0] = x - zr; box.min[1] = y + b.y0 * hs; box.min[2] = z - zr;
    box.max[0] = x + zr; box.max[1] = y + b.y1 * hs; box.max[2] = z + zr;
  }
  return zones;
}

/** Havodagi halqa nishoni (bitta zona) */
export function ringZone (x, y, z, radius = RING_RADIUS) {
  return [{
    zone: 'ring',
    box: { min: [x - radius, y - radius, z - radius], max: [x + radius, y + radius, z + radius] }
  }];
}

/** Qayta ishlatiladigan natija obyekti (kadr ichida allokatsiya bo'lmasin) */
export function createShotResult () {
  return {
    kind: 'none',
    blocked: false,
    targetId: '',
    zone: '',
    zoneMultiplier: 1,
    distance: 0,
    rayT: 1,
    point: [0, 0, 0],
    wallDistance: Infinity,
    colliderIndex: -1,
    colliderId: '',
    colliderKind: '',
    reason: ''
  };
}

const _d = [0, 0, 0];

/** Kollayder yozuvi ham xom AABB ham {box,id,kind} bo'lishi mumkin */
const boxOf = (c) => (c && c.box ? c.box : c);

/**
 * Bitta o'q uchun eng yaqin to'siq/nishonni topadi.
 * @param {{origin:number[], dir:number[], maxDistance:number, colliders:Array,
 *          targets:Array<{id:string,alive:boolean,zones:Array}>, out?:object}} args
 * @returns natija obyekti (args.out yoki yangi) — QAYTA ISHLATILADI
 */
export function resolveShot (args) {
  const out = args.out || createShotResult();
  const o = args.origin;
  const din = args.dir;
  const maxDistance = args.maxDistance;

  out.kind = 'none';
  out.blocked = false;
  out.targetId = '';
  out.zone = '';
  out.zoneMultiplier = 1;
  out.distance = 0;
  out.rayT = 1;
  out.point[0] = 0; out.point[1] = 0; out.point[2] = 0;
  out.wallDistance = Infinity;
  out.colliderIndex = -1;
  out.colliderId = '';
  out.colliderKind = '';
  out.reason = '';

  // --- kirish validatsiyasi ---
  if (!o || !din || o.length < 3 || din.length < 3) { out.kind = 'invalid'; out.reason = 'bad_args'; return out; }
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) { out.kind = 'invalid'; out.reason = 'bad_range'; return out; }
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(o[i]) || !Number.isFinite(din[i])) { out.kind = 'invalid'; out.reason = 'nan'; return out; }
  }
  const dl = Math.hypot(din[0], din[1], din[2]);
  if (dl < EPS) { out.kind = 'invalid'; out.reason = 'zero_dir'; return out; }
  _d[0] = din[0] / dl * maxDistance;         // masofa bilan masshtablangan (t ∈ [0,1])
  _d[1] = din[1] / dl * maxDistance;
  _d[2] = din[2] / dl * maxDistance;
  const ux = din[0] / dl, uy = din[1] / dl, uz = din[2] / dl;

  const colliders = args.colliders || [];
  const targets = args.targets || [];

  // --- 1) origin qattiq quti ichida bo'lsa (devorga tiqilib qolgan o'yinchi) ---
  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (pointInBox(o, boxOf(c), 0.02)) {
      out.kind = 'blocked_origin';
      out.blocked = true;
      out.colliderIndex = i;
      out.colliderId = c.id || '';
      out.colliderKind = c.kind || '';
      out.reason = 'origin_in_collider';
      out.point[0] = o[0]; out.point[1] = o[1]; out.point[2] = o[2];
      return out;
    }
  }

  // --- 2) qattiq geometriya (devor/cover) ---
  let tWall = Infinity;
  let wallIdx = -1;
  for (let i = 0; i < colliders.length; i++) {
    const t = rayAABB(o, _d, boxOf(colliders[i]), 0);
    if (t < tWall) { tWall = t; wallIdx = i; }
  }

  // --- 3) nishonlar (faqat tiriklari) ---
  let tTarget = Infinity;
  let targetId = '';
  let zone = '';
  for (let i = 0; i < targets.length; i++) {
    const tg = targets[i];
    if (!tg || tg.alive === false) continue;
    const zones = tg.zones;
    if (!zones) continue;
    for (let j = 0; j < zones.length; j++) {
      const t = rayAABB(o, _d, zones[j].box, 0);
      if (t < tTarget) { tTarget = t; targetId = tg.id; zone = zones[j].zone; }
    }
  }

  // --- 4) hal qilish: devor yaqinroq (yoki TENGBOLSA) — nishon to'silgan
  //     (konservativ: devor yuzasi nishon zonasining yuzasi bilan aynan
  //     ustma-ust tushsa, devor g'alaba qozonadi).
  //     tWall === Infinity → devor Yo'Q: Infinity <= Infinity xato
  //     'wall' (missni blocked deb belgilash)ga yo'l qo'ymaslik uchun guard ---
  if (tWall !== Infinity && tWall <= tTarget) {
    out.kind = 'wall';
    out.blocked = true;
    out.rayT = tWall;
    out.distance = tWall * maxDistance;
    out.wallDistance = out.distance;
    const c = colliders[wallIdx];
    out.colliderIndex = wallIdx;
    out.colliderId = (c && c.id) || '';
    out.colliderKind = (c && c.kind) || '';
    out.point[0] = o[0] + ux * out.distance;
    out.point[1] = o[1] + uy * out.distance;
    out.point[2] = o[2] + uz * out.distance;
    return out;
  }

  if (tTarget <= 1) {
    out.kind = 'target';
    out.targetId = targetId;
    out.zone = zone;
    out.zoneMultiplier = HIT_ZONES[zone] === undefined ? 1 : HIT_ZONES[zone];
    out.rayT = tTarget;
    out.distance = tTarget * maxDistance;
    out.wallDistance = tWall === Infinity ? Infinity : tWall * maxDistance;
    out.point[0] = o[0] + ux * out.distance;
    out.point[1] = o[1] + uy * out.distance;
    out.point[2] = o[2] + uz * out.distance;
    return out;
  }

  // --- 5) hech narsa tegilmadi (range ichida) ---
  out.kind = 'none';
  out.distance = maxDistance;
  out.rayT = 1;
  out.point[0] = o[0] + ux * maxDistance;
  out.point[1] = o[1] + uy * maxDistance;
  out.point[2] = o[2] + uz * maxDistance;
  return out;
}