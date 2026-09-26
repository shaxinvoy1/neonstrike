// ============================================================
// NEON STRIKE — Phase 2: procedural rounded humanoid (player + dummy)
// Tashqi model/asset YO'Q: CapsuleGeometry / SphereGeometry / BoxGeometry.
// Fizika AABB (shared/collision.js PLAYER), vizual siluet undan sal kichik.
// Blob shadow: tekstura canvas'da chiziladi (real-time shadow YO'Q).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { MOVE, damp } from '/shared/collision.js';
import { PALETTE } from '/shared/map.js';

/** Materiallar bir marta yaratiladi (draw call va GC budjeti uchun) */
export function makeHumanoidMaterials ({ body, accent, core, dark } = {}) {
  return {
    body: new THREE.MeshLambertMaterial({ color: body ?? PALETTE.PLAYER_BODY }),
    accent: new THREE.MeshBasicMaterial({ color: accent ?? PALETTE.PLAYER_ACCENT }),
    core: new THREE.MeshBasicMaterial({ color: core ?? PALETTE.PLAYER_CORE }),
    dark: new THREE.MeshLambertMaterial({ color: dark ?? 0x0f1636 })
  };
}

/**
 * Yumaloq humanoid: 2 oyoq + tana + bosh + 2 qo'l, neon visor/yadro/chiziqlar.
 * Oyoq/qo'l pivotlari guruhlar orqali — yurish animatsiyasi uchun.
 * @returns {{rig:THREE.Group, legs:THREE.Group[], arms:THREE.Group[], head:THREE.Mesh, state:{phase:number,swing:number}}}
 */
export function createHumanoidModel (mats, opts = {}) {
  const rig = new THREE.Group();
  const a = opts.accentScale ?? 1;   // nishon (dummy) uchun neon chiziqlar kattaroq
  const cap = (r, len, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 12), mat);
    m.position.set(x, y, z);
    return m;
  };

  // ---------- oyoqlar (pivot: son, y=0.78) ----------
  const legs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.115, 0.78, 0);
    pivot.add(cap(0.1, 0.58, mats.body, 0, -0.39, 0));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.028 * a, 0.34, 0.028 * a), mats.accent);
    stripe.position.set(side * 0.105, -0.38, 0.03);
    pivot.add(stripe);
    rig.add(pivot);
    legs.push(pivot);
  }

  // ---------- qo'llar (pivot: yelka, y=1.4) ----------
  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.31, 1.4, 0);
    pivot.add(cap(0.08, 0.4, mats.body, 0, -0.28, 0));
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.024 * a, 0.28, 0.024 * a), mats.accent);
    stripe.position.set(side * 0.078, -0.28, 0);
    pivot.add(stripe);
    rig.add(pivot);
    arms.push(pivot);
  }

  // ---------- tana ----------
  rig.add(cap(0.2, 0.16, mats.dark, 0, 0.85, 0));      // chanoq
  rig.add(cap(0.235, 0.34, mats.body, 0, 1.08, 0));    // ko'krak
  rig.add(cap(0.07, 0.08, mats.dark, 0, 1.5, 0));      // bo'yin

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), mats.body);
  head.position.set(0, 1.61, 0);
  rig.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07 * a, 0.05), mats.accent);
  visor.position.set(0, 1.63, 0.15);
  rig.add(visor);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.1 * a, 0.1 * a, 0.05), mats.core);
  core.position.set(0, 1.14, 0.23);
  rig.add(core);

  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.12), mats.dark);
  pack.position.set(0, 1.12, -0.24);
  rig.add(pack);

  const packTrim = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.03), mats.core);
  packTrim.position.set(0, 1.12, -0.31);
  rig.add(packTrim);

  rig.name = 'humanoid';
  return { rig, legs, arms, head, state: { phase: 0, swing: 0 } };
}

/**
 * O'yinchi: humanoid model + blob shadow + neon "yelka nuri" marker.
 * @returns {{group:THREE.Group, model:object, shadow:THREE.Mesh}}
 */
export function createPlayer (mats) {
  const model = createHumanoidModel(mats ?? makeHumanoidMaterials());
  const group = model.rig;
  group.name = 'player';

  // yelka ustidagi neon marker (OTS kamera o'qini ko'rsatadi)
  const markerMat = new THREE.MeshBasicMaterial({ color: PALETTE.PLAYER_ACCENT, transparent: true, opacity: 0.85 });
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.03, 0.1), markerMat);
  marker.position.set(0, 1.86, 0);
  marker.name = 'player-marker';
  group.add(marker);

  const shadow = createBlobShadow();
  return { group, model, shadow };
}

/**
 * Oddiy yurish animatsiyasi: tezlikka proporsional qadam/yelka tebranishi.
 * Har bir kadrda faqat rotation.x yangilanadi (arzon).
 */
export function animateHumanoid (model, dt, speed, maxSpeed = MOVE.WALK) {
  const norm = Math.min(1, Math.abs(speed) / maxSpeed);
  if (norm > 0.02) model.state.phase += dt * (3.4 + 5.2 * norm);
  const target = Math.sin(model.state.phase) * 0.6 * norm;
  const k = damp(MOVE.ACCEL, dt);
  model.state.swing += (target - model.state.swing) * k;
  model.legs[0].rotation.x = model.state.swing;
  model.legs[1].rotation.x = -model.state.swing;
  model.arms[0].rotation.x = -model.state.swing * 0.75;
  model.arms[1].rotation.x = model.state.swing * 0.75;
  model.rig.rotation.x = 0.07 * norm;   // engil oldinga egilish
}

/** Blob shadow teksturasi bir marta yaratiladi (barcha shadow'lar uchun umumiy) */
let blobTexture = null;
function getBlobTexture () {
  if (blobTexture) return blobTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(3,6,18,0.9)');
  g.addColorStop(0.55, 'rgba(3,6,18,0.45)');
  g.addColorStop(1, 'rgba(3,6,18,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  blobTexture = new THREE.CanvasTexture(canvas);
  blobTexture.colorSpace = THREE.SRGBColorSpace;
  return blobTexture;
}

/** Blob shadow: canvas radial gradient — real-time shadow yo'q, juda arzon */
export function createBlobShadow () {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1.7),
    new THREE.MeshBasicMaterial({
      map: getBlobTexture(), transparent: true, depthWrite: false, opacity: 0.9
    })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  mesh.name = 'blob-shadow';
  return mesh;
}

/** Blob shadow'ni pol yuzasiga joylash; balandlik oshsa — kichrayadi/xiralashadi */
export function updateBlobShadow (mesh, x, groundY, z, heightAbove) {
  const h = Math.max(0, heightAbove);
  const k = 1 / (1 + h * 0.7);
  mesh.position.set(x, groundY + 0.02, z);
  mesh.scale.setScalar(0.72 + 0.28 * k);
  mesh.material.opacity = 0.9 * k;
}
