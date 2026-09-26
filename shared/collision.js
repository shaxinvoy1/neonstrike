// ============================================================
// NEON STRIKE — SOF kolliziya matematikasi (Phase 2)
// three.js'dan mustaqil: klient ham, node testlar ham ishlatadi.
//  - moveAABB(): o'yinchi (silindr ≈ AABB) uchun o'q bo'yicha slayd
//  - sweepCamera(): kamera nurini AABB'lar bo'ylab qisqartirish
// ============================================================

/** O'yinchi o'lchami (metr) */
export const PLAYER = Object.freeze({
  RADIUS: 0.4,
  HEIGHT: 1.75,
  EYE: 1.62,
  STEP_HEIGHT: 0.55   // bu balandlikdagi qadam/grein top'iga o'zi chiqadi (step-up)
});

/** Uchinchi shaxs / yelka-usti kamera parametrlari */
export const CAMERA = Object.freeze({
  RADIUS: 0.28,        // kamera nuri uchun xavfsizlik radiusi
  DISTANCE: 3.4,       // ideal masofa (pivot -> kamera)
  SHOULDER: 0.55,      // yelka siljishi (OTS)
  MIN_DISTANCE: 0.55,  // to'siq oldida eng kam masofa
  AIM_AHEAD: 1.8,      // qarash nuqtasi pivotdan qanchalik oldinda
  PIVOT_Y: 1.62,       // pivot balandligi (ko'z darajasi)
  PITCH_MIN: -0.95,
  PITCH_MAX: 0.62,
  SENSITIVITY: 0.0022
});

/** Harakat sozlamalari */
export const MOVE = Object.freeze({
  WALK: 5.2,           // m/s
  SPRINT: 8.0,         // Shift
  ACCEL: 14,           // eksponensial tezlanish koeffitsienti
  TURN_RATE: 14        // model yaw silliqlash tezligi
});

const EPS = 1e-9;

/** AABB y-oraliqlari kesishadimi? (eps — polga yopishib turishni oldini oladi) */
export function overlapsY (b, y, height, eps = 0.02) {
  return b.max[1] > y + eps && b.min[1] < y + height - eps;
}

function overlap1d (aMin, aMax, bMin, bMax) {
  return aMax > bMin && aMin < bMax;
}

/** Yig'ilgan (yuqoriga ko'tarilgan) o'yinchi AABB si maydoni bo'shmi? (step-up headroom) */
export function headroomClear (x, y, z, radius, height, boxes) {
  for (const b of boxes) {
    if (!overlapsY(b, y, height)) continue;
    if (!overlap1d(z - radius, z + radius, b.min[2], b.max[2])) continue;
    if (!overlap1d(x - radius, x + radius, b.min[0], b.max[0])) continue;
    return false;
  }
  return true;
}

/**
 * (x,z) nuqtadagi QATTIQ yuza balandligi: o'yinchi oyog'i turgan yuza.
 * boxes ichidan XZ tayanchi bor va b.max[1] ≤ y+tol bo'lgan eng BALAND top.
 * Yo'q bo'lsa floorY (pol). Tushish (gravity snap) va BFS reachability'da ishlatiladi.
 */
export function groundHeight (x, z, y, radius, boxes, floorY = 0, tol = 0.05) {
  let g = floorY;
  for (const b of boxes) {
    if (b.max[1] > y + tol) continue;
    if (!overlap1d(z - radius, z + radius, b.min[2], b.max[2])) continue;
    if (!overlap1d(x - radius, x + radius, b.min[0], b.max[0])) continue;
    if (b.max[1] > g) g = b.max[1];
  }
  return g;
}

/**
 * O'yinchi pozitsiyasini delta bo'yicha harakatlantiradi va AABB'lar bilan
 * to'qnashuvni o'q bo'yicha hal qiladi (X, keyin Z) → devor bo'ylab slayd.
 * Katta delta "tunneling" qilmasligi uchun harakat radius/2 qadamlarga bo'linadi.
 * STEP-UP: to'qnashgan barcha qutilar top'i ≤ PLAYER.STEP_HEIGHT balandlikda va
 * yuqorida joy bo'lsa — o'yinchi o'zi chiqib oladi (y ko'tariladi).
 * Positsiya — oyoq (feet) nuqtasi; AABB: [x±radius] × [y .. y+height] × [z±radius].
 * @returns {{x:number,y:number,z:number,hitX:boolean,hitZ:boolean,stepped:boolean,steps:number}}
 */
export function moveAABB (pos, delta, radius, height, boxes) {
  const STEP = PLAYER.STEP_HEIGHT;
  let y = pos.y;
  let x = pos.x;
  let z = pos.z;
  let hitX = false;
  let hitZ = false;
  let stepped = false;

  const len = Math.hypot(delta.x, delta.z);
  const maxStep = Math.max(0.05, radius * 0.5);
  const steps = len > maxStep ? Math.ceil(len / maxStep) : 1;
  const sx = delta.x / steps;
  const sz = delta.z / steps;

  for (let s = 0; s < steps; s++) {
    if (sx !== 0) {
      x += sx;
      let clampX = null;
      let stepTop = -Infinity;
      for (const b of boxes) {
        if (!overlapsY(b, y, height)) continue;
        if (!overlap1d(z - radius, z + radius, b.min[2], b.max[2])) continue;
        if (!overlap1d(x - radius, x + radius, b.min[0], b.max[0])) continue;
        const top = b.max[1];
        if (top - y <= STEP && headroomClear(x, top, z, radius, height, boxes)) {
          if (top > stepTop) stepTop = top;
        } else {
          // eng konservativ clamp: harakat yo'nalishiga qarashli orqaga chekinish
          const c = sx > 0 ? b.min[0] - radius : b.max[0] + radius;
          clampX = clampX === null ? c : (sx > 0 ? Math.min(clampX, c) : Math.max(clampX, c));
          hitX = true;
        }
      }
      if (clampX !== null) x = clampX;
      else if (stepTop > y) { y = stepTop; stepped = true; }
    }
    if (sz !== 0) {
      z += sz;
      let clampZ = null;
      let stepTop = -Infinity;
      for (const b of boxes) {
        if (!overlapsY(b, y, height)) continue;
        if (!overlap1d(x - radius, x + radius, b.min[0], b.max[0])) continue;
        if (!overlap1d(z - radius, z + radius, b.min[2], b.max[2])) continue;
        const top = b.max[1];
        if (top - y <= STEP && headroomClear(x, top, z, radius, height, boxes)) {
          if (top > stepTop) stepTop = top;
        } else {
          const c = sz > 0 ? b.min[2] - radius : b.max[2] + radius;
          clampZ = clampZ === null ? c : (sz > 0 ? Math.min(clampZ, c) : Math.max(clampZ, c));
          hitZ = true;
        }
      }
      if (clampZ !== null) z = clampZ;
      else if (stepTop > y) { y = stepTop; stepped = true; }
    }
  }

  return { x, y, z, hitX, hitZ, stepped, steps };
}

/**
 * Nuqta (radius bilan kengaytirilgan) quti ichidami?
 * Diqqat: o va d — MASSIV ko'rinishida: [x, y, z].
 */
export function pointInBox (o, b, radius = 0) {
  return overlap1d(o[0] - radius, o[0] + radius, b.min[0], b.max[0]) &&
         overlap1d(o[1], o[1], b.min[1], b.max[1]) &&
         overlap1d(o[2] - radius, o[2] + radius, b.min[2], b.max[2]);
}

/**
 * Slab usuli: o nuqtadan (o + t*d, t ∈ [0,1]) radius bilan kengaytirilgan
 * qutiga kirish parametri. Kesishmasa yoki o quti ichida bo'lsa Infinity.
 * Diqqat: o va d — MASSIV ko'rinishida: [x, y, z].
 */
export function rayAABB (o, d, b, radius = 0) {
  // o kengaytirilgan quti ichida bo'lsa — qisqartirish ma'nosiz
  if (pointInBox(o, b, radius)) return Infinity;
  let tmin = 0;
  let tmax = 1;
  for (let i = 0; i < 3; i++) {
    const lo = b.min[i] - radius;
    const hi = b.max[i] + radius;
    const di = d[i];
    if (Math.abs(di) < EPS) {
      if (o[i] < lo || o[i] > hi) return Infinity;
    } else {
      let t1 = (lo - o[i]) / di;
      let t2 = (hi - o[i]) / di;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

/**
 * Pivotdan ideal kamera nuqtasigacha "nur" yuboradi va to'siq bo'lsa
 * masofani qisqartiradi (kamera devor/krat ichiga kirmaydi).
 * @returns {{x,y,z,t,distance,blocked,blockedByIndex}}
 */
export function sweepCamera (origin, target, boxes, radius, minDistance = 0) {
  const o = [origin.x, origin.y, origin.z];
  const d = [target.x - origin.x, target.y - origin.y, target.z - origin.z];
  const full = Math.hypot(d[0], d[1], d[2]);
  let t = 1;
  let blockedByIndex = -1;
  for (let i = 0; i < boxes.length; i++) {
    const hit = rayAABB(o, d, boxes[i], radius);
    if (hit < t) { t = hit; blockedByIndex = i; }
  }
  let tt = Math.max(0, Math.min(1, t));
  let distance = full * tt;
  if (minDistance > 0 && distance < minDistance && full > minDistance) {
    tt = minDistance / full;
    distance = minDistance;
  }
  return {
    x: o[0] + d[0] * tt,
    y: o[1] + d[1] * tt,
    z: o[2] + d[2] * tt,
    t: tt,
    distance,
    blocked: blockedByIndex >= 0
  };
}

export function clamp (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Kadr vaqtidan mustaqil eksponensial silliqlash koeffitsienti */
export function damp (rate, dt) { return 1 - Math.exp(-rate * dt); }
