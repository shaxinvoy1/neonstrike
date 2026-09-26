// ============================================================
// NEON STRIKE — PHASE 4: qurol ko'rinishi (procedural low-poly)
// Barcha qurollar BIR martta quriladi, faqat visibility almashtiriladi
// (kadrda geometry/material yaratish YO'Q). Muzzle — barrel uchi
// Object3D (jahon pozitsiyasi/direction QA uchun ochiq).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { PALETTE } from '/shared/map.js';

const MAT_BODY = new THREE.MeshLambertMaterial({ color: 0x18244d });
const MAT_DARK = new THREE.MeshLambertMaterial({ color: 0x0d1430 });
const MAT_CYAN = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM });
const MAT_VIOLET = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM_ALT });
const MAT_TARGET = new THREE.MeshBasicMaterial({ color: PALETTE.TARGET });
const MAT_ORANGE = new THREE.MeshBasicMaterial({ color: PALETTE.TARGET_ACCENT });

const box = (w, h, d, mat, x, y, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
};

/** Qurol konfiguratsiyasi → procedural mesh (bir marta) */
function buildWeapon (id) {
  const g = new THREE.Group();
  g.name = `weapon-${id}`;
  let muzzleZ = 0.4;
  let muzzleY = 0;
  if (id === 'neon-rifle') {
    g.add(box(0.09, 0.13, 0.55, MAT_BODY, 0, 0, 0.1));          // korpus
    g.add(box(0.05, 0.05, 0.3, MAT_DARK, 0, 0.02, 0.45));       // barrel
    g.add(box(0.02, 0.02, 0.34, MAT_CYAN, 0, 0.08, 0.18));      // neon chizig'i
    g.add(box(0.07, 0.16, 0.1, MAT_DARK, 0, -0.13, 0.05));      // kabza
    muzzleZ = 0.62;
  } else if (id === 'pulse-pistol') {
    g.add(box(0.07, 0.1, 0.24, MAT_BODY, 0, 0, 0.06));
    g.add(box(0.04, 0.04, 0.12, MAT_DARK, 0, 0.02, 0.2));
    g.add(box(0.02, 0.02, 0.14, MAT_CYAN, 0, 0.07, 0.05));
    g.add(box(0.06, 0.15, 0.08, MAT_DARK, 0, -0.11, -0.02));
    muzzleZ = 0.3;
  } else if (id === 'scatter-shot') {
    g.add(box(0.12, 0.14, 0.4, MAT_BODY, 0, 0, 0.12));
    g.add(box(0.1, 0.1, 0.26, MAT_DARK, 0, 0, 0.38));
    g.add(box(0.02, 0.02, 0.24, MAT_VIOLET, 0.04, 0.08, 0.1));
    g.add(box(0.02, 0.02, 0.24, MAT_VIOLET, -0.04, 0.08, 0.1));
    g.add(box(0.08, 0.16, 0.1, MAT_DARK, 0, -0.13, 0));
    muzzleZ = 0.54;
  } else {                                                       // energy-grenade
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), MAT_TARGET);
    core.position.set(0, 0, 0.05);
    g.add(core);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.015, 6, 14), MAT_ORANGE);
    ring.position.set(0, 0, 0.05);
    g.add(ring);
    muzzleZ = 0.12;
  }
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0.02, muzzleY, muzzleZ);
  g.add(muzzle);
  return { group: g, muzzle };
}

export class WeaponView {
  /** @param {THREE.Object3D} playerGroup — player rig (rotation.y = faceYaw) */
  constructor (playerGroup) {
    this.mount = new THREE.Group();
    this.mount.name = 'weapon-mount';
    this.mount.position.set(0.3, 1.28, 0.18);      // o'ng yelka/qo'l zonasi
    playerGroup.add(this.mount);
    this.models = {};
    this.muzzles = {};
    for (const id of ['neon-rifle', 'pulse-pistol', 'scatter-shot', 'energy-grenade']) {
      const { group, muzzle } = buildWeapon(id);
      group.visible = false;
      this.mount.add(group);
      this.models[id] = group;
      this.muzzles[id] = muzzle;
    }
    this.activeId = '';
    this.suppressed = false;                        // o'lim/kamera-siqilish → yashirish
    this._wp = new THREE.Vector3();
    this._wd = new THREE.Vector3();
  }

  /** Faol qurolni almashtirish (mesh almashuvi — draw animatsiyasi hud'da) */
  setWeapon (id) {
    if (!this.models[id] || id === this.activeId) return this.activeId;
    if (this.activeId) this.models[this.activeId].visible = false;
    this.activeId = id;
    this.models[id].visible = !this.suppressed;
    return id;
  }

  get visible () { return !!this.activeId && this.models[this.activeId].visible; }

  setVisible (v) {
    if (this.activeId) this.models[this.activeId].visible = !!v && !this.suppressed;
  }

  /** Qurolni kamera yo'nalishiga qaratadi (player rig faceYaw'dan farqli). */
  update (camYaw, camPitch, playerYaw) {
    // mount — player rig ichida, rig.rotation.y=faceYaw → kompensatsiya
    this.mount.rotation.y = camYaw - playerYaw;
    this.mount.rotation.x = -camPitch;
  }

  /** Kamera devorga siqqanda qurolni yashirish (wall-clip oldini olish) */
  setSuppressed (v) {
    if (this.suppressed === v) return;
    this.suppressed = v;
    this.setVisible(!v);
  }

  /** Barrel uchi jahon pozitsiyasi (QA + tracer boshlanishi) */
  muzzleWorld (out = this._wp) {
    if (!this.activeId) return null;
    return this.muzzles[this.activeId].getWorldPosition(out);
  }

  /** Muzzle'ning jahon yo'nalishi (aim nuriga qancha yaqin — QA metrikasi) */
  muzzleWorldDir (out = this._wd) {
    if (!this.activeId) return null;
    this.muzzles[this.activeId].getWorldDirection(out);
    return out;
  }
}
