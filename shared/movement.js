// ============================================================
// NEON STRIKE — SOF (pure) harakat yadrosi
// Phase 3 dagi mahalliy harakat mantig'i AYNAN shu yerga ko'chirildi —
// endi KLIENT ham, SERVER ham (Phase 7 avtoritativ simulyatsiya) BITTA
// manbadan foydalanadi. Shu sababli klient bashorati (prediction) bilan
// server simulyatsiyasi bir xil qoidalar bo'yicha yuradi va
// rekonsiliatsiya xatosi kichik bo'ladi.
//
// Cheklovlar: three.js YO'Q, DOM YO'Q, Mathdan boshqa global YO'Q.
// Node'da to'g'ridan-to'g'ri test qilinadi.
// ============================================================
import { moveAABB, groundHeight, PLAYER, MOVE, damp } from './collision.js';
import { SOLID_BOXES, SPAWNS, MAP } from './map.js';
// PHASE 1: gorizontal bazis YAGONA manbadan (shared/aim.js) — klient harakati,
// server simulyatsiyasi va crosshair nuri bir xil ramkada bo'lishi uchun.
import { moveWish } from './aim.js';

/** Tushish tezlanishi (m/s²) — sakrash YO'Q, faqat tushish (Phase 3) */
export const GRAVITY = 22;
/** Vertikal snap uchun epsilon */
export const MOVEMENT_EPS = 1e-4;

/** Qayta ishlatiladigan istalgan-yo'nalish buferi (kadr ichida allokatsiya yo'q) */
const _wish = [0, 0, 0];

/** Burchaklar orasidagi eng qisqa yo'l bo'ylab interpolatsiya (-π..π) */
export function angleLerp (a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

/**
 * Avtoritativ harakat holati (SOF obyekt — class EMAS; server ham,
 * klient ham bir xil maydonlarni ishlatadi).
 */
export function createMovementState ({ spawn = SPAWNS.A, boxes = SOLID_BOXES, floorY = MAP.FLOOR_Y } = {}) {
  const m = { spawn, boxes, floorY };
  resetMovement(m);
  return m;
}

/** Holatni spawn'ga qaytarish (pozitsiya/tezlik/flags) */
export function resetMovement (m) {
  m.pos = { x: m.spawn.x, y: m.spawn.y, z: m.spawn.z };
  m.vel = { x: 0, z: 0 };
  m.vy = 0;
  m.airborne = false;
  m.speed = 0;
  m.faceYaw = m.spawn.yaw;
  m.sprinting = false;
  m.hitX = false;
  m.hitZ = false;
  m.stepped = false;
  m.collisions = 0;
  m.travelled = 0;
  return m;
}

/**
 * Bitta simulyatsiya qadami (Phase 3 mantiqi AYNAN saqlangan).
 * @param {object} m harakat holati (createMovementState)
 * @param {number} dt sekund
 * @param {{forward:number,right:number}} axis kirish o'qi (-1..1)
 * @param {number} yaw kamera yaw (harakat bazasi)
 * @param {boolean} sprint
 * @returns {{x:number,y:number,z:number,hitX:boolean,hitZ:boolean,stepped:number}}
 */
export function stepMovement (m, dt, axis, yaw, sprint = false) {
  const forward = axis && Number.isFinite(axis.forward) ? axis.forward : 0;
  const right = axis && Number.isFinite(axis.right) ? axis.right : 0;

  // kamera yaw'iga nisbatan istalgan yo'nalish:
  //   forward = (sin yaw, cos yaw) · right = (-cos yaw, sin yaw)   [ekran o'ngi]
  // PHASE 1 TUZATISHI: ilgari right = (cos yaw, -sin yaw) edi (teskari
  // qo'l ramkasi) → A/D ekranda teskari tomonga surilardi.
  const wish = moveWish(yaw, forward, right, _wish);
  let wishX = wish[0];
  let wishZ = wish[1];
  const len = wish[2];

  m.sprinting = sprint && len > 0.01;
  const maxSpeed = m.sprinting ? MOVE.SPRINT : MOVE.WALK;
  const k = damp(MOVE.ACCEL, dt);
  m.vel.x += (wishX * maxSpeed - m.vel.x) * k;
  m.vel.z += (wishZ * maxSpeed - m.vel.z) * k;
  if (Math.abs(m.vel.x) < 0.001) m.vel.x = 0;
  if (Math.abs(m.vel.z) < 0.001) m.vel.z = 0;

  const res = moveAABB(m.pos, { x: m.vel.x * dt, z: m.vel.z * dt },
    PLAYER.RADIUS, PLAYER.HEIGHT, m.boxes);

  if (res.hitX) m.vel.x = 0;
  if (res.hitZ) m.vel.z = 0;

  const dx = res.x - m.pos.x;
  const dz = res.z - m.pos.z;
  const moved = Math.hypot(dx, dz) > 1e-4;
  m.travelled += Math.hypot(dx, dz);
  m.pos.x = res.x;
  m.pos.y = res.y;
  m.pos.z = res.z;
  m.stepped = !!res.stepped;
  // hitX/hitZ — OXIRGI haqiqiy siljishdagi to'qnashuv holati (HUD uchun barqaror):
  // to'xtab turganda flag "yaltirab" ketmasligi uchun harakat bo'lmaganda saqlanadi.
  if (moved) {
    m.hitX = res.hitX;
    m.hitZ = res.hitZ;
  }
  if (res.hitX || res.hitZ) m.collisions++;

  // ---------- vertikal: tushish (platformadan/qinadan sakrab tushish) ----------
  // STEP-UP moveAABB ichida yuqoriga o'tkazadi; bu yerda faqat PASTGA tushish:
  const g = groundHeight(m.pos.x, m.pos.z, m.pos.y, PLAYER.RADIUS, m.boxes, m.floorY);
  if (m.pos.y > g + MOVEMENT_EPS) {
    m.airborne = true;
    m.vy -= GRAVITY * dt;
    let ny = m.pos.y + m.vy * dt;
    if (ny <= g) { ny = g; m.vy = 0; m.airborne = false; }
    m.pos.y = ny;
  } else {
    m.pos.y = g;
    m.vy = 0;
    m.airborne = false;
  }

  m.speed = Math.hypot(m.vel.x, m.vel.z);

  // tana yuzi harakat yo'nalishiga sekin buriladi (OTS uchun tabiiy)
  if (m.speed > 0.4) {
    m.faceYaw = angleLerp(m.faceYaw, Math.atan2(m.vel.x, m.vel.z), damp(MOVE.TURN_RATE, dt));
  }
  return res;
}

/** Diagnostika/teleport (klient test vositasi + server respawn/resync) */
export function teleportMovement (m, x, z, yaw, y) {
  m.pos.x = x;
  m.pos.z = z;
  if (typeof y === 'number') m.pos.y = y;
  m.vel.x = 0;
  m.vel.z = 0;
  m.vy = 0;
  m.airborne = false;
  m.speed = 0;
  if (typeof yaw === 'number') m.faceYaw = yaw;
  return m;
}

/**
 * Kirish o'qini normallashtirish: chekli sonlarni [-1,1] ga qisadi.
 * Noto'g'ri (NaN/Infinity) qiymat → null (server rad etadi).
 */
export function normalizeAxis (forward, right) {
  const f = Number.isFinite(forward) ? Math.max(-1, Math.min(1, forward)) : null;
  const r = Number.isFinite(right) ? Math.max(-1, Math.min(1, right)) : null;
  if (f === null || r === null) return null;
  return { forward: f, right: r };
}
