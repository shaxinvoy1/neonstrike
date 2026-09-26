// ============================================================
// NEON STRIKE — Phase 3: mahalliy harakat (smooth) + AABB kolliziya
//
// PHASE 7: algoritm /shared/movement.js ga ko'chirildi (YAGONA manba) —
// server avtoritativ simulyatsiyasi ham AYNAN shu kodni ishlatadi.
// Bu class faqat mavjud klient API'sini (Phase 2–4 verifikatsiya kutgan
// maydonlar: pos/vel/speed/faceYaw/hitX/hitZ/stepped/collisions/travelled)
// saqlab qoladi va sof yadroga delegatsiya qiladi.
//
// Xatti-harakat Phase 3 dagi bilan AYNAN bir xil.
// ============================================================
import { MOVE } from '/shared/collision.js';
import { SOLID_BOXES, SPAWNS, MAP } from '/shared/map.js';
import {
  resetMovement, stepMovement, teleportMovement
} from '/shared/movement.js';

export class Movement {
  constructor (spawn = SPAWNS.A, boxes = SOLID_BOXES) {
    this.spawn = spawn;
    this.boxes = boxes;
    this.floorY = MAP.FLOOR_Y;
    // sof yadro shu obyekt ustida ishlaydi (maydon nomlari bir xil)
    resetMovement(this);
  }

  reset () {
    return resetMovement(this);
  }

  /**
   * @param {number} dt sekund
   * @param {{forward:number,right:number}} axis
   * @param {number} yaw kamera yaw (harakat bazasi)
   * @param {boolean} sprint
   * @returns {{x:number,y:number,z:number,hitX:boolean,hitZ:boolean,steps:number}}
   */
  step (dt, axis, yaw, sprint = false) {
    return stepMovement(this, dt, axis, yaw, sprint);
  }

  /** Diagnostika/verifikatsiya uchun teleport (faqat test vositasi).
   *  `y` berilsa balandlik ham o'rnatiladi (masalan catwalk deck ustiga) —
   *  keyingi kadrlarda gravitatsiya/snap baribir normal ishlaydi. */
  teleport (x, z, yaw, y) {
    return teleportMovement(this, x, z, yaw, y);
  }

  /** Sprint holati (HUD/animatsiya uchun) */
  get maxSpeed () {
    return this.sprinting ? MOVE.SPRINT : MOVE.WALK;
  }
}
