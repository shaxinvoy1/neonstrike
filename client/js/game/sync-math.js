// ============================================================
// NEON STRIKE — PHASE 7: sinxronizatsiya MATEMATIKASI (SOF)
//
// Bu fayl three.js / DOM BILAN ISHLAMAYDI — faqat sof hisob-kitob:
//   • snapshot buferidan interpolatsiya (masofaviy o'yinchilar)
//   • lokal rekonsiliatsiya qarori (server holati USTUN)
// Shu sababli Node'da HAQIQIY ishlab chiqarish kodini test qilish mumkin
// (mock EMAS) — multiplayer.js ham AYNAN shu funksiyalarni chaqiradi.
// ============================================================

/** Bundan katta xato → darhol tuzatish (snap). Kichik → yumshoq tortish. */
export const SNAP_THRESHOLD = 0.6;      // metr
/** Har snapshot'da yumshoq tuzatish ulushi */
export const SMOOTH_RATE = 0.12;

export const lerp = (a, b, t) => a + (b - a) * t;

/** Burchak interpolatsiyasi (eng qisqa yo'l, -π..π oralig'ida) */
export function angleLerp (a, b, t) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

/**
 * Snapshot buferidan `renderT` uchun interpolatsiya qilingan holat.
 * Bufer elementlari: {t, x, y, z, yaw, faceYaw, speed, alive}
 *
 * Qoida: `renderT` ni o'rab turgan ikki snapshot orasida CHIZIQLI
 * interpolatsiya (teleport EMAS). renderT oxirgi snapshotdan keyin bo'lsa —
 * oxirgi holat qaytadi (extrapolated=true; sun'iy "oldindan aytish" YO'Q).
 *
 * @returns {{state:object, interpolated:boolean, extrapolated:boolean}|null}
 */
export function sampleBuffer (buffer, renderT) {
  if (!Array.isArray(buffer) || buffer.length === 0) return null;
  if (buffer.length === 1) {
    return { state: buffer[0], interpolated: false, extrapolated: false };
  }
  let i = buffer.length - 2;
  for (let k = 0; k < buffer.length - 1; k++) {
    if (buffer[k].t <= renderT && renderT <= buffer[k + 1].t) { i = k; break; }
  }
  const a = buffer[i];
  const c = buffer[i + 1];
  const span = c.t - a.t;
  if (!(span > 0)) return { state: c, interpolated: false, extrapolated: renderT > c.t };
  let u = (renderT - a.t) / span;
  if (u < 0) u = 0;
  if (u > 1) u = 1;
  const interpolated = u > 0 && u < 1;
  return {
    state: {
      x: lerp(a.x, c.x, u),
      y: lerp(a.y, c.y, u),
      z: lerp(a.z, c.z, u),
      yaw: angleLerp(a.yaw, c.yaw, u),
      faceYaw: angleLerp(a.faceYaw === undefined ? a.yaw : a.faceYaw,
        c.faceYaw === undefined ? c.yaw : c.faceYaw, u),
      speed: lerp(a.speed || 0, c.speed || 0, u),
      alive: c.alive !== false
    },
    interpolated,
    extrapolated: renderT > c.t
  };
}

/**
 * REKONSILIATSIYA QARORI. Server `ackSeq` gacha bo'lgan buyruqlarni
 * tasdiqladi. Bashorat qilingan pozitsiya bilan server pozitsiyasi
 * solishtiriladi:
 *   • server holati USTUN
 *   • xato > threshold → 'snap' (bashorat tashlanadi, server holati olinadi)
 *   • aks holda → 'smooth' (yumshoq tortish; ko'rinadigan sakrash yo'q)
 *
 * @param {Array<{seq:number,x:number,y:number,z:number}>} pending
 * @param {number} ackSeq server tasdiqlagan ketma-ketlik
 * @param {{x:number,y:number,z:number}} server avtoritar pozitsiya
 * @param {number} threshold
 * @returns {{keepFrom:number, predicted:object, error:number, kind:string,
 *            x:number, y:number, z:number}|null}
 */
export function computeReconcile (pending, ackSeq, server, threshold = SNAP_THRESHOLD) {
  if (!Array.isArray(pending) || !server) return null;
  if (!Number.isFinite(ackSeq)) return null;
  let predicted = null;
  let keepFrom = 0;
  for (let i = 0; i < pending.length; i++) {
    if (pending[i].seq <= ackSeq) { predicted = pending[i]; keepFrom = i + 1; } else break;
  }
  if (!predicted) return null;
  const error = Math.hypot(predicted.x - server.x, predicted.z - server.z);
  return {
    keepFrom,
    predicted,
    error,
    kind: error > threshold ? 'snap' : 'smooth',
    x: server.x,
    y: server.y,
    z: server.z
  };
}

/**
 * Tuzatishni harakat holatiga qo'llash (server holati USTUN).
 * `snap` — pozitsiya serverdan olinadi, tezlik nolga tushadi.
 * `smooth` — pozitsiya server tomon yumshoq tortiladi.
 * @returns {{x:number,y:number,z:number,error:number,kind:string}|null}
 */
export function applyCorrection (movement, correction, rate = SMOOTH_RATE) {
  if (!movement || !correction) return null;
  const p = movement.pos;
  if (correction.kind === 'snap') {
    p.x = correction.x; p.y = correction.y; p.z = correction.z;
    if (movement.vel) { movement.vel.x = 0; movement.vel.z = 0; }
    movement.vy = 0;
  } else {
    p.x += (correction.x - p.x) * rate;
    p.y += (correction.y - p.y) * rate;
    p.z += (correction.z - p.z) * rate;
  }
  return {
    x: correction.x, y: correction.y, z: correction.z,
    error: +correction.error.toFixed(4), kind: correction.kind
  };
}
