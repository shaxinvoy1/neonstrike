// ============================================================
// NEON STRIKE — PHASE 4: ENERGY GRENADE (MINIMAL-REAL, SOF QOIDALAR)
// Fizika dvigateli YO'Q: faqat gravitatsiya + o'q bo'yicha AABB sakrash
// (shared/collision.js primitivlari) + fuse + radial zarar + LOS darvozasi.
// PHASE 5 kengaytirish nuqtasi: stepGrenade()/explodeGrenade() server tick'ida
// AYNAN shu ko'rinishda chaqiriladi.
// ============================================================
import { rayAABB, groundHeight } from './collision.js';

/** Snaryad radiusi (AABB sakrash uchun "shar") */
export const GRENADE_RADIUS = 0.12;
/** Bitta qadamdagi maksimal siljish (tunneling bo'lmasin) */
const MAX_SUBSTEP = 0.25;

/** Kollayder yozuvi ham xom AABB ham {box} bo'lishi mumkin */
const boxOf = (c) => (c && c.box ? c.box : c);

/** Shar (x,y,z,r) biror AABB bilan kesishadimi (kengaytirilgan quti testi) */
export function sphereHits (x, y, z, r, colliders) {
  for (let i = 0; i < colliders.length; i++) {
    const b = boxOf(colliders[i]);
    if (x + r <= b.min[0] || x - r >= b.max[0]) continue;
    if (y + r <= b.min[1] || y - r >= b.max[1]) continue;
    if (z + r <= b.min[2] || z - r >= b.max[2]) continue;
    return true;
  }
  return false;
}

const _norm = (d) => {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
};

/**
 * Snaryad yaratish. `cfg` — WEAPONS['energy-grenade'].projectile.
 * @returns {{pos:number[], vel:number[], cfg:object, ...}}
 */
export function createGrenade ({ id = 0, ownerId = 'player', origin, dir, cfg, now = 0 }) {
  const d = _norm(dir || [0, 0, 1]);
  return {
    id,
    ownerId,
    cfg,
    pos: [origin[0], origin[1], origin[2]],
    vel: [d[0] * cfg.speed, d[1] * cfg.speed, d[2] * cfg.speed],
    bornAt: now,
    explodesAt: now + cfg.fuseMs,
    bounces: 0,
    rest: false,
    alive: true,
    exploded: false,
    explodedAt: 0,
    hitCount: 0,
    steps: 0,
    results: []
  };
}

/**
 * Snaryadni dt (ms) bo'yicha siljitadi: gravitatsiya + o'q bo'yicha AABB
 * sakrash. Holat JOYIDA o'zgartiriladi (allokatsiya yo'q).
 * @returns {number} shu qadamda sodir bo'lgan sakrashlar soni
 */
export function stepGrenade (g, dtMs, colliders, floorY = 0) {
  if (!g.alive) return 0;
  const cfg = g.cfg;
  const dt = Math.min(0.05, Math.max(0, dtMs / 1000));
  if (dt <= 0) return 0;
  let newBounces = 0;

  g.vel[1] -= cfg.gravity * dt;
  const speed = Math.hypot(g.vel[0], g.vel[1], g.vel[2]);
  const steps = Math.min(8, Math.max(1, Math.ceil(speed * dt / MAX_SUBSTEP)));
  const sdt = dt / steps;
  g.steps += steps;

  const bounce = (axis) => {
    g.vel[axis] = -g.vel[axis] * cfg.restitution;
    if (Math.abs(g.vel[axis]) < 0.4) g.vel[axis] = 0;
    g.bounces += 1;
    newBounces += 1;
  };

  for (let s = 0; s < steps; s++) {
    const nx = g.pos[0] + g.vel[0] * sdt;
    if (sphereHits(nx, g.pos[1], g.pos[2], GRENADE_RADIUS, colliders)) bounce(0);
    else g.pos[0] = nx;

    const nz = g.pos[2] + g.vel[2] * sdt;
    if (sphereHits(g.pos[0], g.pos[1], nz, GRENADE_RADIUS, colliders)) bounce(2);
    else g.pos[2] = nz;

    const ny = g.pos[1] + g.vel[1] * sdt;
    if (sphereHits(g.pos[0], ny, g.pos[2], GRENADE_RADIUS, colliders)) bounce(1);
    else g.pos[1] = ny;

    // pol / platforma / deck yuzasi
    const gy = groundHeight(g.pos[0], g.pos[2], g.pos[1] + GRENADE_RADIUS,
      GRENADE_RADIUS, colliders, floorY, 0.02);
    if (g.pos[1] - GRENADE_RADIUS < gy) {
      g.pos[1] = gy + GRENADE_RADIUS;
      if (g.vel[1] < 0) {
        g.vel[1] = -g.vel[1] * cfg.restitution;
        if (g.vel[1] < 0.6) g.vel[1] = 0;
        g.bounces += 1;
        newBounces += 1;
      }
    }

    // sakrash budjeti tugasa — yotib qoladi (gorizontal harakat to'xtaydi)
    if (g.bounces > cfg.maxBounces && !g.rest) {
      g.rest = true;
      g.vel[0] = 0;
      g.vel[2] = 0;
    }
  }
  return newBounces;
}

/** Portlash nuqtasi → nishon markazi LOS tekshiruvi (devor to'ssa — zarar yo'q) */
export function explosionLineOfSight (from, subject, colliders) {
  if (!colliders || !colliders.length) return true;
  const o = [from[0], from[1], from[2]];
  const d = [subject.x - from[0], subject.y - from[1], subject.z - from[2]];
  for (let i = 0; i < colliders.length; i++) {
    if (rayAABB(o, d, boxOf(colliders[i]), 0) < 1) return false;
  }
  return true;
}

/** Masofaga qarab radial zarar (markazda maxDamage → chetda minDamage).
 *  Radiusdan TASHQARIDA 0 — portlash ta'siri chegarasi (explodeGrenade ham
 *  radius ichidagilarni oladi, lekin API o'zi ham izchil bo'lishi kerak).
 *
 *  PHASE 1: `kind` — 'target' (nishon) · 'self' (tashlovchining o'zi, jazo
 *  koeffitsiyenti bilan) · 'peer' (boshqa o'yinchi — TO'LIQ zarar). Ilgari
 *  faqat 'player' (o'zining o'zi) mavjud edi va dushmanlar sub'ekt emas edi. */
export function grenadeDamageAt (cfg, distance, kind = 'target') {
  if (!Number.isFinite(distance) || distance < 0) return 0;
  if (distance > cfg.radius) return 0;
  const t = 1 - Math.min(1, distance / cfg.radius);
  let amount = cfg.minDamage + (cfg.maxDamage - cfg.minDamage) * t;
  if (kind === 'self' || kind === 'player') amount *= cfg.selfDamageScale;
  return Math.round(amount * 100) / 100;
}

/**
 * Portlash: radius ichidagi sub'ektlar uchun zarar hodisalarini hisoblaydi
 * (QO'LLAMAYDI — qo'llash shared/health.js da, combat.js orqali).
 * @param {object} g snaryad
 * @param {Array<{id:string,kind:string,x:number,y:number,z:number}>} subjects
 * @param {Array} colliders
 * @returns {number} hodisalar soni (g.results[0..n-1])
 */
export function explodeGrenade (g, subjects, colliders, count = subjects.length) {
  if (!g.alive || g.exploded) return 0;              // qayta portlash himoyasi
  const cfg = g.cfg;
  g.exploded = true;
  g.alive = false;
  g.explodedAt = g.explodesAt;
  let n = 0;
  for (let si = 0; si < count; si++) {
    const s = subjects[si];
    if (!s) continue;
    const dx = s.x - g.pos[0];
    const dy = s.y - g.pos[1];
    const dz = s.z - g.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (!(dist <= cfg.radius)) continue;
    let ev = g.results[n];
    if (!ev) {
      ev = { id: '', kind: '', amount: 0, distance: 0, los: false, x: 0, y: 0, z: 0 };
      g.results[n] = ev;
    }
    const los = explosionLineOfSight(g.pos, s, colliders);
    ev.id = s.id;
    ev.kind = s.kind;
    ev.distance = dist;
    ev.los = los;
    ev.x = s.x; ev.y = s.y; ev.z = s.z;
    ev.amount = los ? grenadeDamageAt(cfg, dist, s.kind) : 0;
    n += 1;
  }
  g.hitCount = n;
  return n;
}