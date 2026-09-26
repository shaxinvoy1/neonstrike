// ============================================================
// NEON STRIKE — PHASE 4: TargetRegistry
// Training (Phase 2/3) vizual obyektlarini combat state'ga bog'laydi:
//   - xarita dummie/halqalarini combat nishon sifatida ro'yxatdan o'tkazish
//   - zarar/o'lim/tirilish vizualini combat snapshot'dan sinxronlash
//     (o'lim: 600 ms so'nish — kichrayish + yashirish; tirilish: to'liq qaytarish)
//   - lokal test nishon qo'shish (QA)
// Bu modul QOIDALARNI BILMAYDI — faqat vizual adapter. Qoidalar shared/combat.js da.
// MUHIM: addTarget/removeTarget — shared/combat.js dagi ERKIN funksiyalar
// (state metodi EMAS); avvalgi `state.addTarget(...)` chaqiruvi xato edi.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { makeHumanoidMaterials, createHumanoidModel, createBlobShadow } from './player.js';
import { PALETTE } from '/shared/map.js';
import { addTarget, removeTarget } from '/shared/combat.js';

/** O'lim so'nish davomiyligi (ms) — Phase 4 rejasidagi death fade */
export const DEATH_FADE_MS = 600;

export class TargetRegistry {
  /** @param {object} training — Training (Phase 2) instance
   *  @param {object} state — shared/combat.js state (targets royxati bilan) */
  constructor (training, state) {
    this.training = training;
    this.state = state;
    this.visuals = new Map();          // id → {rig, shadow, mesh, inner, kind, dead, fadeT}
    this.testGroup = new THREE.Group();
    this.testGroup.name = 'test-targets';
    (training.group.parent || training.group).add(this.testGroup);
  }

  /** Training nishonlarini combat state'ga ro'yxatdan o'tkazish (bir marta) */
  registerAll () {
    for (const d of this.training.dummies) {
      this.visuals.set(d.cfg.id, {
        kind: 'dummy', rig: d.model.rig, shadow: d.shadow, dead: false, fadeT: 0
      });
      addTarget(this.state, d.cfg);
    }
    for (const r of this.training.rings) {
      this.visuals.set(r.cfg.id, {
        kind: 'ring', mesh: r.mesh, inner: r.inner, dead: false, fadeT: 0
      });
      addTarget(this.state, r.cfg);
    }
    return this.visuals.size;
  }

  /** Lokal test nishon (QA): yangi dummy vizual + combat target
   *  @returns combat target yoki null */
  spawnTestTarget (x, z, id) {
    if (this.state.targetById.has(id)) return null;
    const mats = makeHumanoidMaterials({
      body: 0x203a4a, accent: PALETTE.TARGET, core: PALETTE.TARGET_ACCENT, dark: 0x102030
    });
    const model = createHumanoidModel(mats, { accentScale: 2.2 });
    model.rig.position.set(x, 0, z);
    const shadow = createBlobShadow();
    shadow.position.set(x, 0.02, z);
    this.testGroup.add(model.rig, shadow);
    this.visuals.set(id, { kind: 'dummy', rig: model.rig, shadow, dead: false, fadeT: 0, test: true });
    return addTarget(this.state, { id, kind: 'dummy', x, y: 0, z });
  }

  /** Faqat bitta nishon vizualini tiklash (respawn / o'lim so'nishidan keyin) */
  _show (v) {
    if (v.kind === 'dummy') {
      v.rig.visible = true;
      v.rig.scale.setScalar(1);
      if (v.shadow) { v.shadow.visible = true; v.shadow.scale.setScalar(1); }
    } else {
      v.mesh.visible = true;
      v.inner.visible = true;
    }
  }

  _hide (v) {
    if (v.kind === 'dummy') {
      v.rig.visible = false;
      if (v.shadow) v.shadow.visible = false;
    } else {
      v.mesh.visible = false;
      v.inner.visible = false;
    }
  }

  /**
   * Combat snapshot → vizual. O'limda 600 ms so'nadi (rig kichrayadi), so'ng
   * yashiriladi; tirilganda to'liq o'lchamda qaytadi.
   * @param {number} dtMs kadr davomiyligi (so'nish animatsiyasi uchun)
   * @returns {number} o'zgarishlar soni (HUD/QA uchun)
   */
  sync (dtMs = 0) {
    let changes = 0;
    for (const t of this.state.targets) {
      const v = this.visuals.get(t.id);
      if (!v) continue;
      const alive = t.snap.alive;
      if (alive) {
        if (v.dead || !this._isShown(v)) {
          v.dead = false;
          v.fadeT = 0;
          this._show(v);
          changes += 1;
        }
        continue;
      }
      // o'lim holati
      if (!v.dead) {
        v.dead = true;
        v.fadeT = 0;
        changes += 1;
      }
      v.fadeT += dtMs;
      const k = 1 - v.fadeT / DEATH_FADE_MS;
      if (k <= 0) {
        if (this._isShown(v)) { this._hide(v); changes += 1; }
      } else if (v.kind === 'dummy') {
        const s = Math.max(0.02, k);
        v.rig.scale.setScalar(s);
        if (v.shadow) v.shadow.scale.setScalar(s);
      }
    }
    return changes;
  }

  _isShown (v) {
    return v.kind === 'dummy' ? v.rig.visible : v.mesh.visible;
  }

  /** QA: nishon vizuali ko'rinadimi (rig/mesh + 600ms so'nish holati) */
  probe (id) {
    const v = this.visuals.get(id);
    if (!v) return null;
    return {
      id,
      kind: v.kind,
      dead: !!v.dead,
      fade: +(Math.min(1, (v.fadeT || 0) / DEATH_FADE_MS)).toFixed(3),
      visible: this._isShown(v),
      scale: v.kind === 'dummy' ? +v.rig.scale.x.toFixed(3) : 1
    };
  }

  /** Qayta tiklash (session reset): test nishonlarni olib tashlash + vizual tiklash */
  resetTestTargets () {
    for (const [id, v] of [...this.visuals]) {
      if (v.test) {
        if (v.rig) this.testGroup.remove(v.rig);
        if (v.shadow) this.testGroup.remove(v.shadow);
        this.visuals.delete(id);
        removeTarget(this.state, id);
        continue;
      }
      v.dead = false;
      v.fadeT = 0;
      this._show(v);
    }
    return this.visuals.size;
  }

  /** Nishon markasi (jahon koordinatasi) — QA/aim uchun */
  centreOf (id) {
    const t = this.state.targetById.get(id);
    return t ? { x: t.centre.x, y: t.centre.y, z: t.centre.z } : null;
  }
}
