// ============================================================
// NEON STRIKE — Phase 2: yelka-usti (over-the-shoulder) kamera
// Pointer Lock yaw/pitch → pivot (yelka balandligi) → ideal masofa →
// AABB sweep (devor/krat ichiga kirmaydi) → silliqlash → qayta sweep.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { CAMERA, sweepCamera, clamp, damp } from '/shared/collision.js';
import { CAMERA_BOXES, MAP } from '/shared/map.js';
// PHASE 1: yagona koordinata konvensiyasi (shared/aim.js)
import { forwardFromYaw, basisFromYaw, lookStep, cameraPose } from '/shared/aim.js';

/** Recoil (otish tepkisi) tiklanish tezligi — 1/s (eksponensial) */
const RECOIL_RECOVER = 9;

export class CameraController {
  constructor (camera, boxes = CAMERA_BOXES) {
    this.camera = camera;
    this.boxes = boxes;
    this.yaw = 0;
    this.pitch = -0.12;
    this.pos = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this.aim = new THREE.Vector3();
    this.first = true;
    this.lookEvents = 0;
    this.accumDX = 0;
    this.accumDY = 0;
    // PHASE 1: VISUAL recoil (taqdimot). Otish paytida pitch/yaw ga qo'shiladi va
    // vaqt o'tishi bilan qaytariladi. Bu QIYMAT ham kamera, ham crosshair
    // yo'nalishiga kiradi — shu sababli crosshair va o'q MOSLIGI saqlanadi
    // (klientga yangi avtoritet BERILMAYDI: yo'nalish baribir intent).
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilShots = 0;
    this._pose = { pivot: [0, 0, 0], pos: [0, 0, 0], fwd: [0, 0, 0], right: [0, 0, 0] };
    this._basis = { forward: { x: 0, z: 0 }, right: { x: 0, z: 0 } };
    this.last = { desiredDistance: CAMERA.DISTANCE, distance: CAMERA.DISTANCE, blocked: false, t: 1, minYClamped: false };
  }

  /**
   * Sichqoncha harakati (Pointer Lock movementX/Y).
   * PHASE 1 TUZATISHI: ilgari `yaw += dx·SENS` edi → sichqoncha o'ngga
   * yurganda kamera CHAPGA qarardi (eksa teskari). Endi `yaw -= dx·SENS`
   * (three.js PointerLockControls bilan bir xil).
   */
  look (dx, dy) {
    if (dx === 0 && dy === 0) return;
    this.accumDX += dx;
    this.accumDY += dy;
    const r = lookStep(this.yaw, this.pitch, dx, dy,
      CAMERA.SENSITIVITY, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    this.yaw = r.yaw;
    this.pitch = r.pitch;
    // sichqoncha bilan tuzatish — to'plangan recoil qaytariladi (tabiiy his)
    if (this.recoilPitch !== 0 || this.recoilYaw !== 0) {
      this.recoilPitch = 0;
      this.recoilYaw = 0;
    }
    this.lookEvents++;
  }

  /** Gorizontal bazis (harakat uchun) — ekran o'ngi = (-cos yaw, sin yaw) */
  basis () {
    return basisFromYaw(this.yaw, this._basis);
  }

  /**
   * PHASE 1: otish tepkisi (VISUAL + nishonni siljitadi).
   * Qabul qilingan o'q uchun klient adapteri chaqiradi.
   */
  applyRecoil (pitchKick, yawKick) {
    if (!Number.isFinite(pitchKick) || !Number.isFinite(yawKick)) return this.recoilPitch;
    this.pitch = clamp(this.pitch + pitchKick, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    this.yaw += yawKick;
    this.recoilPitch += pitchKick;
    this.recoilYaw += yawKick;
    this.recoilShots += 1;
    return this.recoilPitch;
  }

  /** Recoil'ni vaqt bo'yicha qaytarish (kadr boshida) */
  decayRecoil (dt) {
    if (this.recoilPitch === 0 && this.recoilYaw === 0) return 0;
    const k = 1 - Math.exp(-RECOIL_RECOVER * dt);
    const dp = this.recoilPitch * k;
    const dyaw = this.recoilYaw * k;
    this.pitch = clamp(this.pitch - dp, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    this.yaw -= dyaw;
    this.recoilPitch -= dp;
    this.recoilYaw -= dyaw;
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;
    return this.recoilPitch;
  }

  /** Recoil holatini tozalash (teleport/spawn/respawn) */
  clearRecoil () {
    this.recoilPitch = 0;
    this.recoilYaw = 0;
  }

  update (dt, playerPos, groundY = MAP.FLOOR_Y) {
    // PHASE 1: pivot/kamera geometriyasi shared/aim.js dan (YAGONA manba —
    // QA `aimAtPoint` va testlar ham AYNAN shu formulani ishlatadi).
    // Yelka pivoti qahramonning O'NG tomonida (ekran o'ngi).
    const pose = cameraPose(playerPos, this.yaw, this.pitch, CAMERA, this._pose);
    const fwd = pose.fwd;
    const pivot = { x: pose.pivot[0], y: pose.pivot[1], z: pose.pivot[2] };
    this.pivot.set(pivot.x, pivot.y, pivot.z);

    const desired = {
      x: pivot.x - fwd[0] * CAMERA.DISTANCE,
      y: pivot.y - fwd[1] * CAMERA.DISTANCE,
      z: pivot.z - fwd[2] * CAMERA.DISTANCE
    };

    const sweep = sweepCamera(pivot, desired, this.boxes, CAMERA.RADIUS, CAMERA.MIN_DISTANCE);
    const minY = groundY + 0.35;

    if (this.first) {
      this.pos.set(sweep.x, Math.max(sweep.y, minY), sweep.z);
      this.first = false;
    } else {
      const k = damp(18, dt);
      this.pos.x += (sweep.x - this.pos.x) * k;
      this.pos.y += (sweep.y - this.pos.y) * k;
      this.pos.z += (sweep.z - this.pos.z) * k;
      // silliqlash "sirg'alishi" devor ichiga kirsa — qayta sweep bilan qaytariladi
      const re = sweepCamera(pivot, { x: this.pos.x, y: this.pos.y, z: this.pos.z },
        this.boxes, CAMERA.RADIUS, CAMERA.MIN_DISTANCE);
      if (re.t < 1) this.pos.set(re.x, re.y, re.z);
    }

    const clampedY = this.pos.y < minY;
    if (clampedY) this.pos.y = minY;

    this.camera.position.copy(this.pos);
    this.aim.set(pivot.x + fwd[0] * CAMERA.AIM_AHEAD, pivot.y + fwd[1] * CAMERA.AIM_AHEAD, pivot.z + fwd[2] * CAMERA.AIM_AHEAD);
    this.camera.lookAt(this.aim);

    this.last = {
      desiredDistance: CAMERA.DISTANCE,
      distance: Math.hypot(this.pos.x - pivot.x, this.pos.y - pivot.y, this.pos.z - pivot.z),
      blocked: sweep.blocked,
      t: sweep.t,
      minYClamped: clampedY
    };
    return this.last;
  }
}