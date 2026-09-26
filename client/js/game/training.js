// ============================================================
// NEON STRIKE — Phase 2: TRAINING (offline) rejimi
// Statik nishonlar: 5 humanoid dummy + 3 halqa. Harakat yo'q (statik),
// tarmoq/combat yo'q. Faqat sessiya taymeri yuritiladi.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { TRAINING_DUMMIES, TRAINING_RINGS, PALETTE } from '/shared/map.js';
import { createHumanoidModel, makeHumanoidMaterials, createBlobShadow } from './player.js';

export class Training {
  constructor (scene) {
    this.group = new THREE.Group();
    this.group.name = 'training';
    this.elapsed = 0;
    this.dummies = [];
    this.rings = [];

    // Dummy'lar — qizil/pushti neon siluet (player'dan farqli palitra)
    const mats = makeHumanoidMaterials({
      body: 0x33204a, accent: PALETTE.TARGET, core: PALETTE.TARGET_ACCENT, dark: 0x1b1030
    });

    for (const cfg of TRAINING_DUMMIES) {
      const model = createHumanoidModel(mats, { accentScale: 2.2 });
      model.rig.position.set(cfg.x, cfg.y ?? 0, cfg.z);
      model.rig.rotation.y = cfg.yaw;
      const shadow = createBlobShadow();
      shadow.position.set(cfg.x, (cfg.y ?? 0) + 0.02, cfg.z);
      this.group.add(model.rig, shadow);
      this.dummies.push({ cfg, model, shadow });
    }

    // Havodagi halqa-nishonlar (statik)
    const ringMat = new THREE.MeshBasicMaterial({ color: PALETTE.TARGET_ACCENT });
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0x2a1030, transparent: true, opacity: 0.55, side: THREE.DoubleSide
    });
    for (const cfg of TRAINING_RINGS) {
      const mesh = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 8, 20), ringMat);
      mesh.position.set(cfg.x, cfg.y, cfg.z);
      mesh.rotation.y = cfg.yaw;
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.44, 20), innerMat);
      inner.position.set(cfg.x, cfg.y, cfg.z + 0.01);
      inner.rotation.y = cfg.yaw;
      this.group.add(mesh, inner);
      this.rings.push({ cfg, mesh, inner });
    }

    scene.add(this.group);
    this.targetCount = this.dummies.length + this.rings.length;
  }

  update (dt) { this.elapsed += dt; }

  reset () { this.elapsed = 0; }

  get summary () {
    return {
      dummies: this.dummies.length,
      rings: this.rings.length,
      targets: this.targetCount,
      elapsed: this.elapsed
    };
  }
}