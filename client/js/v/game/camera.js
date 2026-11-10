// ============================================================
// YELKA-USTI (OTS) KAMERA — Reference B: personaj orqadan, ekranning
// pastki-chap qismida, kamera biroz yuqoridan.
// Nishon: kamera nuri (ekran markazi) → birinchi to'siq/o'yinchi nuqtasi T.
// Server nuri: ko'z (O) → T. Shu sababli crosshair, server o'qi va tumshuq
// tracer'i bitta nuqtaga yaqinlashadi; yaqin to'siq O→T ni to'ssa crosshair
// "bloklangan" holatga o'tadi (o'q to'siqqa tegadi — server ham shunday hisoblaydi).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { CAMERA_BOXES } from '/shared/map.js';
import { PLAYER } from '/shared/collision.js';
import { CROUCH } from '/shared/movement.js';

export const CAM = Object.freeze({
  DIST: 3.55, DIST_AIM: 2.0, SHOULDER: 0.92, SHOULDER_AIM: 0.7, PIVOT_Y: 2.2, PIVOT_Y_AIM: 2.05,
  PITCH_MIN: -1.1, PITCH_MAX: 0.95, RADIUS: 0.22, SENS: 0.0023, FOV_AIM: 0.72
});

/** Nur–AABB (slab): t (masofa) yoki Infinity */
export function rayBox (o, d, b, pad = 0) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const lo = b.min[i] - pad, hi = b.max[i] + pad;
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo || o[i] > hi) return Infinity; continue; }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) { const t = a; a = c; c = t; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  return t0;
}
export function rayWorld (o, d, maxT = 120, boxes = CAMERA_BOXES, pad = 0) {
  let best = maxT;
  for (let i = 0; i < boxes.length; i++) { const t = rayBox(o, d, boxes[i], pad); if (t < best) best = t; }
  return best;
}

export class OTSCamera {
  constructor (camera) {
    this.camera = camera;
    this.yaw = 0; this.pitch = -0.08;
    this.aimK = 0;
    this.dist = CAM.DIST;
    this.recoilP = 0; this.recoilY = 0;
    this.shake = 0;
    this.baseFov = 72;
    this.pos = new THREE.Vector3();
    this.fwd = new THREE.Vector3();
    this._o = [0, 0, 0]; this._d = [0, 0, 0];
  }
  look (dx, dy) {
    this.yaw -= dx * CAM.SENS * (1 - 0.35 * this.aimK);
    this.pitch -= dy * CAM.SENS * (1 - 0.35 * this.aimK);
    this.pitch = Math.max(CAM.PITCH_MIN, Math.min(CAM.PITCH_MAX, this.pitch));
  }
  kick (p, y) { this.recoilP += p; this.recoilY += (Math.random() - 0.5) * 2 * y; }

  /** Haqiqiy (recoil qo'shilgan) burchaklar — serverga shu yuboriladi */
  aimYaw () { return this.yaw + this.recoilY; }
  aimPitch () { return Math.max(CAM.PITCH_MIN, Math.min(CAM.PITCH_MAX, this.pitch + this.recoilP)); }

  update (dt, playerPos, aiming, crouch) {
    this.aimK += ((aiming ? 1 : 0) - this.aimK) * (1 - Math.exp(-14 * dt));
    // recoil tiklanishi
    const rec = 1 - Math.exp(-9 * dt);
    this.recoilP -= this.recoilP * rec; this.recoilY -= this.recoilY * rec;
    this.shake *= Math.exp(-8 * dt);
    const yaw = this.aimYaw(), pitch = this.aimPitch();
    const k = this.aimK;
    const sh = CAM.SHOULDER + (CAM.SHOULDER_AIM - CAM.SHOULDER) * k;
    const py = (CAM.PIVOT_Y + (CAM.PIVOT_Y_AIM - CAM.PIVOT_Y) * k) - (crouch ? 0.42 : 0);
    const want = CAM.DIST + (CAM.DIST_AIM - CAM.DIST) * k;
    const cp = Math.cos(pitch);
    const f = this.fwd.set(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    // pivot: avval yelka tomonga (devor ichiga kirmasin)
    const base = [playerPos.x, playerPos.y + py, playerPos.z];
    const sd = [rx, 0, rz];
    const st = Math.min(sh, rayWorld(base, sd, sh + CAM.RADIUS) - CAM.RADIUS);
    const pivot = [base[0] + rx * Math.max(0, st), base[1], base[2] + rz * Math.max(0, st)];
    // orqaga sweep (kamera kolliziyasi) — devor ortiga o'tmaydi
    const back = [-f.x, -f.y, -f.z];
    const hit = rayWorld(pivot, back, want + CAM.RADIUS, CAMERA_BOXES, CAM.RADIUS * 0.6) - CAM.RADIUS;
    const target = Math.max(0.35, Math.min(want, hit));
    // yaqinlashish darhol, uzoqlashish silliq (pop-in yo'q)
    this.dist = target < this.dist ? target : this.dist + (target - this.dist) * (1 - Math.exp(-6 * dt));
    this.pos.set(pivot[0] + back[0] * this.dist, pivot[1] + back[1] * this.dist, pivot[2] + back[2] * this.dist);
    if (this.shake > 0.001) this.pos.add(new THREE.Vector3((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, 0));
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.pos.x + f.x, this.pos.y + f.y, this.pos.z + f.z);
    const fov = this.baseFov * (1 - (1 - CAM.FOV_AIM) * k);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  /**
   * Nishon nuqtasi: kamera nuri (dunyo + o'yinchi zonalari) → T;
   * ko'zdan (server origin) T ga yo'nalish + to'siq tekshiruvi.
   * @param {object} self — {x,y,z, crouch}
   * @param {Array} bodies — [{x,y,z,crouch,alive}] (raqiblar/nishonlar, AABB zonalar uchun)
   */
  aim (self, bodies, out) {
    const o = this._o, d = this._d;
    o[0] = this.pos.x; o[1] = this.pos.y; o[2] = this.pos.z;
    d[0] = this.fwd.x; d[1] = this.fwd.y; d[2] = this.fwd.z;
    // kamera → o'yinchining o'zi orqali o'tib ketmasligi uchun boshlanish nuqtasi
    // o'yinchi tekisligidan keyin (aks holda o'z boshiga "tegadi")
    let t = rayWorld(o, d, 140);
    let target = null;
    for (const b of bodies) {
      if (!b.alive) continue;
      const hs = b.crouch ? CROUCH.SCALE : 1;
      const box = { min: [b.x - 0.36, b.y, b.z - 0.36], max: [b.x + 0.36, b.y + PLAYER.HEIGHT * hs, b.z + 0.36] };
      const tb = rayBox(o, d, box);
      if (tb < t) { t = tb; target = b; }
    }
    const T = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const eye = [self.x, self.y + PLAYER.EYE * (self.crouch ? CROUCH.SCALE : 1), self.z];
    let dx = T[0] - eye[0], dy = T[1] - eye[1], dz = T[2] - eye[2];
    let L = Math.hypot(dx, dy, dz);
    // T ko'zning orqasida yoki juda yaqin → kamera yo'nalishi
    if (L < 0.6 || dx * d[0] + dy * d[1] + dz * d[2] < 0) { dx = d[0]; dy = d[1]; dz = d[2]; L = 1; }
    const dir = [dx / L, dy / L, dz / L];
    // ko'z → T yo'lida yaqinroq to'siq bormi? (yaqin cover holati)
    const tw = rayWorld(eye, dir, L);
    out.dir = dir;
    out.point = T;
    out.dist = t;
    out.eye = eye;
    out.blocked = tw < L - 0.2;
    out.blockPoint = out.blocked ? [eye[0] + dir[0] * tw, eye[1] + dir[1] * tw, eye[2] + dir[2] * tw] : null;
    out.target = target;
    return out;
  }
}
