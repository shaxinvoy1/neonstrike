// ============================================================
// NEON STRIKE — PHASE 1 (post-P12): YAGONA KOORDINATA TIZIMI + AIM
//
// Muammo (P12 auditida o'lchangan): gorizontal bazis `cross(up, forward)`
// orqali qurilgan edi — bu CHAP qo'lli ramka beradi va quyidagilarni buzadi:
//   • sichqoncha o'ngga → kamera CHAPGA qaraydi
//   • D → ekran CHAPGA suradi
//   • kamera pivoti qahramonning chap yelkasiga tushadi
//
// Endi butun loyiha BITTA konvensiyadan foydalanadi (three.js bilan mos):
//   Y — tepa;  yaw = 0 → kamera +Z ga qaraydi
//   forward(yaw,pitch) = ( sin(yaw)·cos(pitch),  sin(pitch),  cos(yaw)·cos(pitch) )
//   screenRight(yaw)   = cross(forward_pitch0, up) = ( -cos(yaw), 0, sin(yaw) )
//   dx > 0 (sichqoncha o'ngga) → yaw KAMAYADI  (three.js PointerLockControls:
//   `_euler.y -= movementX` bilan AYNAN bir xil yo'nalish)
//
// Cheklovlar: three.js YO'Q, DOM YO'Q, Math dan boshqa global YO'Q → server,
// klient va node testlari bir xil kodni ishlatadi.
// ============================================================

/** Kamera/nishon yo'nalishi (yaw, pitch) — birlik vektor */
export function forwardFromYaw (yaw, pitch, out = [0, 0, 0]) {
  const cp = Math.cos(pitch);
  out[0] = Math.sin(yaw) * cp;
  out[1] = Math.sin(pitch);
  out[2] = Math.cos(yaw) * cp;
  return out;
}

/** Ekran/harakat O'NG tomoni (gorizontal, birlik) — `cross(forward, up)` */
export function rightFromYaw (yaw, out = [0, 0, 0]) {
  out[0] = -Math.cos(yaw);
  out[1] = 0;
  out[2] = Math.sin(yaw);
  return out;
}

/**
 * Gorizontal harakat bazisi ({forward:{x,z}, right:{x,z}}).
 * `out` qayta ishlatiladi (kadr ichida allokatsiya bo'lmasin).
 */
export function basisFromYaw (yaw, out = { forward: { x: 0, z: 0 }, right: { x: 0, z: 0 } }) {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  out.forward.x = sy;
  out.forward.z = cy;
  out.right.x = -cy;
  out.right.z = sy;
  return out;
}

/**
 * Kirish o'qi (forward/right) → istalgan yo'nalish (XZ).
 * YAGONA manba: klient harakati ham, server simulyatsiyasi ham shu yerni
 * chaqiradi (shared/movement.js) — bazis ikki joyda ajralib ketmaydi.
 * @param {number[]} out [x, z, uzunlik] (qayta ishlatiladi)
 */
export function moveWish (yaw, forward, right, out = [0, 0, 0]) {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  let x = sy * forward - cy * right;
  let z = cy * forward + sy * right;
  const len = Math.hypot(x, z);
  if (len > 1) { x /= len; z /= len; }
  out[0] = x;
  out[1] = z;
  out[2] = len;
  return out;
}

/**
 * Pointer Lock harakati → yangi yaw/pitch (klamp bilan).
 * `dx > 0` (o'ngga) → yaw kamayadi; `dy > 0` (pastga) → pitch kamayadi.
 */
export function lookStep (yaw, pitch, dx, dy, sens, pitchMin, pitchMax) {
  let p = pitch - dy * sens;
  if (p < pitchMin) p = pitchMin;
  else if (p > pitchMax) p = pitchMax;
  return { yaw: yaw - dx * sens, pitch: p };
}

/**
 * PHASE 1 AIM MODELI (YAGONA haqiqat manbai):
 *   EKRAN MARKAZI / CROSSHAIR
 *     → kamera nuri (kamera pozasi + kamera forward) → jahon nuqtasi
 *     → OTISH YO'NALISHI = ko'z nuqtasi (server avtoritativi) → o'sha nuqta
 *     → server shu yo'nalish bo'ylab, O'Z ko'z nuqtasidan otadi
 *
 * Shu sababli crosshair nima ko'rsatsa — o'q AYNAN o'sha yerga boradi.
 * Uchinchi shaxs parallaksi (kamera 3.4 m orqada, 0.55 m yonda) shu
 * konvergensiya bilan qoplanadi: masofa oshgani sari xato O'SMAYDI.
 *
 * `point` (nishon nuqtasi) tomon burish — birlik vektor. Degenerativ holatda
 * (nuqta juda yaqin) `null` qaytadi — chaqiruvchi kamera yo'nalishini oladi.
 */
export function convergeDirection (point, origin, out = [0, 0, 0], opts = {}) {
  const min = opts.minDistance === undefined ? 0.25 : opts.minDistance;
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const dz = point[2] - origin[2];
  const len = Math.hypot(dx, dy, dz);
  if (!(len > min) || !Number.isFinite(len)) return null;
  out[0] = dx / len;
  out[1] = dy / len;
  out[2] = dz / len;
  return out;
}

/**
 * YELKA-USTI KAMERA GEOMETRIYASI — YAGONA manba.
 * Klient `CameraController.update()` ham, QA `aimAtPoint()` ham, node testlari
 * ham AYNAN shu funksiyani chaqiradi (kamera modeli ikki joyda ajralmasin).
 * Sweep/silliqlash/max(minY) BU YERDA YO'Q — ular CameraController ishi.
 * @param {{x:number,y:number,z:number}} playerPos o'yinchi OYOG'i
 * @param {object} cam CAMERA konfiguratsiyasi (shared/collision.js)
 */
export function cameraPose (playerPos, yaw, pitch, cam, out) {
  const o = out || { pivot: [0, 0, 0], pos: [0, 0, 0], fwd: [0, 0, 0], right: [0, 0, 0] };
  const fwd = forwardFromYaw(yaw, pitch, o.fwd);
  const right = rightFromYaw(yaw, o.right);
  o.pivot[0] = playerPos.x + right[0] * cam.SHOULDER;
  o.pivot[1] = playerPos.y + cam.PIVOT_Y;
  o.pivot[2] = playerPos.z + right[2] * cam.SHOULDER;
  o.pos[0] = o.pivot[0] - fwd[0] * cam.DISTANCE;
  o.pos[1] = o.pivot[1] - fwd[1] * cam.DISTANCE;
  o.pos[2] = o.pivot[2] - fwd[2] * cam.DISTANCE;
  return o;
}

/**
 * Crosshair AYNAN `target` nuqtasiga tushadigan yaw/pitch (fixed-point).
 * Kamera pozasi yaw/pitch ga bog'liq bo'lgani uchun iterativ yechiladi
 * (o'lchandi: yaqin nishonlarda xato har iteratsiyada ~0.64 barobar kamayadi;
 * 8 iteratsiyada 2 m da ham xato < 0.004 NDC). FAQAT QA/verifikatsiya yo'li —
 * har kadrlik yo'lda ishlatilmaydi (u `cameraPose` ni to'g'ridan chaqiradi).
 * PITCH_MIN/MAX ga qisqartiriladi (kamera klampi bilan bir xil).
 */
export function solveAimAngles (playerPos, target, cam, iterations = 8) {
  const scratch = { pivot: [0, 0, 0], pos: [0, 0, 0], fwd: [0, 0, 0], right: [0, 0, 0] };
  let yaw = Math.atan2(target[0] - playerPos.x, target[2] - playerPos.z);
  let h = Math.hypot(target[0] - playerPos.x, target[2] - playerPos.z);
  let pitch = Math.atan2(target[1] - (playerPos.y + cam.PIVOT_Y), h);
  const n = Math.max(1, iterations | 0);
  for (let i = 0; i < n; i++) {
    const p = cameraPose(playerPos, yaw, pitch, cam, scratch);
    const dx = target[0] - p.pos[0];
    const dy = target[1] - p.pos[1];
    const dz = target[2] - p.pos[2];
    yaw = Math.atan2(dx, dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
  if (pitch < cam.PITCH_MIN) pitch = cam.PITCH_MIN;
  else if (pitch > cam.PITCH_MAX) pitch = cam.PITCH_MAX;
  return { yaw, pitch };
}

/** Ikki birlik vektor orasidagi burchak (radian) — konvergensiya
 *  xavfsizlik darvozasi uchun (juda katta og'ish = degenerativ holat). */
export function deviationAngle (a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c = d > 1 ? 1 : (d < -1 ? -1 : d);
  return Math.acos(c);
}
