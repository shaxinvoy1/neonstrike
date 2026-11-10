// ============================================================
// NEON STRIKE — MODEL V-773 (Reference A)
// Bitta SkinnedMesh: silliq qismlar birlashtirilgan geometriya, bo'g'inlarda
// avtomatik (masofa bo'yicha) skin og'irliklari → egilganda yoriq/uzilish yo'q.
// Bosh QATTIQ (faqat head suyagi) — animatsiyada deformatsiya bo'lmaydi.
// O'lcham: balandlik 1.75 m = PLAYER.HEIGHT (kolliziya/kamera bilan bir xil).
// Model +Z ga qaraydi (o'yindagi yaw=0 bilan mos).
// ============================================================
import * as THREE from '/vendor/three.module.js';

export const V773 = Object.freeze({
  HEIGHT: 1.75,
  HEAD_R: 0.36,
  HEAD_Y: 1.39,
  EYE_Y: 1.38,          // ko'zlar markazi (nomlar/marker uchun)
  MARKER_Y: 2.05
});

/** Suyaklar: [nom, ota, bind holat (dunyo, oyoq nuqtasiga nisbatan)] */
const BONES = [
  ['root', null, [0, 0, 0]],
  ['hips', 'root', [0, 0.50, 0]],
  ['spine', 'hips', [0, 0.64, 0]],
  ['chest', 'spine', [0, 0.80, 0]],
  ['neck', 'chest', [0, 0.98, 0]],
  ['head', 'neck', [0, 1.05, 0]],
  ['shoulder.L', 'chest', [0.10, 0.93, 0]],
  ['upperArm.L', 'shoulder.L', [0.19, 0.93, 0]],
  ['forearm.L', 'upperArm.L', [0.215, 0.745, 0]],
  ['hand.L', 'forearm.L', [0.228, 0.575, 0]],
  ['shoulder.R', 'chest', [-0.10, 0.93, 0]],
  ['upperArm.R', 'shoulder.R', [-0.19, 0.93, 0]],
  ['forearm.R', 'upperArm.R', [-0.215, 0.745, 0]],
  ['hand.R', 'forearm.R', [-0.228, 0.575, 0]],
  ['upperLeg.L', 'hips', [0.095, 0.47, 0]],
  ['knee.L', 'upperLeg.L', [0.1, 0.265, 0]],
  ['ankle.L', 'knee.L', [0.1, 0.075, 0]],
  ['foot.L', 'ankle.L', [0.1, 0.035, 0.1]],
  ['upperLeg.R', 'hips', [-0.095, 0.47, 0]],
  ['knee.R', 'upperLeg.R', [-0.1, 0.265, 0]],
  ['ankle.R', 'knee.R', [-0.1, 0.075, 0]],
  ['foot.R', 'ankle.R', [-0.1, 0.035, 0.1]]
];
/** Barg suyaklar uchun segment uchi (og'irlik hisobida ishlatiladi) */
const TIPS = { head: [0, 1.75, 0], 'hand.L': [0.232, 0.49, 0], 'hand.R': [-0.232, 0.49, 0], 'foot.L': [0.1, 0.03, 0.16], 'foot.R': [-0.1, 0.03, 0.16] };

const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function segDist (p, a, b) {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq()), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Geometriyani suyaklarga bog'lash: har vertex uchun nomzod suyaklar
 * segmentiga masofa → 1/d^4 og'irlik, eng yaqin 2 ta (normallangan).
 */
function skinPart (geo, candidates, boneIndex, segs) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    const ws = candidates.map((name) => {
      const s = segs[name];
      const d = segDist(p, s[0], s[1]);
      return [boneIndex[name], 1 / (Math.pow(d + 0.012, 4))];
    }).sort((a, b) => b[1] - a[1]);
    const a = ws[0], b = ws[1] || [a[0], 0];
    const t = a[1] + b[1];
    si[i * 4] = a[0]; sw[i * 4] = a[1] / t;
    si[i * 4 + 1] = b[0]; sw[i * 4 + 1] = b[1] / t;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  return geo;
}

function mergeGeometries (list) {
  let vCount = 0, iCount = 0;
  for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3);
  const si = new Uint16Array(vCount * 4), sw = new Float32Array(vCount * 4);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    si.set(g.attributes.skinIndex.array, vo * 4);
    sw.set(g.attributes.skinWeight.array, vo * 4);
    if (g.index) { const a = g.index.array; for (let k = 0; k < a.length; k++) idx[io + k] = a[k] + vo; io += a.length; } else { for (let k = 0; k < c; k++) idx[io + k] = vo + k; io += c; }
    vo += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** a→b yo'nalishidagi kapsula (silliq yumaloq uchlar) */
function capsule (a, b, r, seg = 14) {
  const A = v3(a), B = v3(b);
  const len = A.distanceTo(B);
  const g = new THREE.CapsuleGeometry(r, len, 6, seg);
  const dir = B.clone().sub(A).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
  return g;
}

function ellipsoid (c, s, seg = 20) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));
  g.scale(s[0], s[1], s[2]);
  g.translate(c[0], c[1], c[2]);
  return g;
}

/** Tana: yumshoq "loviya" profili (lathe) — son, bel, ko'krak, bo'yin bir yuzada */
function torso () {
  const prof = [
    [0.0, 0.40], [0.085, 0.415], [0.145, 0.455], [0.172, 0.52], [0.176, 0.6], [0.165, 0.69],
    [0.162, 0.78], [0.168, 0.86], [0.158, 0.93], [0.128, 0.985], [0.088, 1.02], [0.075, 1.06], [0.07, 1.1], [0.0, 1.13]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const curve = new THREE.SplineCurve(prof);
  const g = new THREE.LatheGeometry(curve.getPoints(40), 28);
  g.scale(1.08, 1, 0.84);
  return g;
}

/** Marvarid (pearl) material: oq/och-kulrang, yumshoq yaltiroq, ozgina iridessensiya */
export function makeBodyMaterial (quality = 'high', team = null) {
  const base = {
    color: 0xeceef4, roughness: 0.34, metalness: 0.0,
    envMapIntensity: 0.9
  };
  const mat = quality === 'low'
    ? new THREE.MeshStandardMaterial(base)
    : new THREE.MeshPhysicalMaterial({
      ...base, clearcoat: 0.55, clearcoatRoughness: 0.22,
      sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xd9d4ff),
      iridescence: quality === 'high' ? 0.28 : 0, iridescenceIOR: 1.25, iridescenceThicknessRange: [180, 420]
    });
  // jamoa: nozik fresnel rim (oq tana saqlanadi, faqat chetlarda team rangi)
  mat.userData.rim = { value: new THREE.Color(team === 'B' ? 0xff3b5c : team === 'A' ? 0x2f8cff : 0x000000) };
  mat.userData.rimStrength = { value: team ? 0.55 : 0 };
  mat.userData.baseRim = team ? 0.55 : 0;
  mat.userData.flash = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = mat.userData.rim;
    sh.uniforms.uRimK = mat.userData.rimStrength;
    sh.uniforms.uFlash = mat.userData.flash;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform float uRimK; uniform float uFlash;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += uRim * fres * uRimK + vec3(1.0, 0.25, 0.25) * uFlash;`);
  };
  mat.customProgramCacheKey = () => 'v773-' + quality;
  return mat;
}

/** Ko'z: oq sklera + qora kontur + qora qorachiq + yaltiroq nuqta (Reference A) */
function makeEye (side, mats) {
  const g = new THREE.Group();
  const outline = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), mats.outline);
  outline.scale.set(0.1, 0.128, 0.03);
  const sclera = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 20), mats.sclera);
  sclera.scale.set(0.086, 0.113, 0.03);
  sclera.position.z = 0.006;
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), mats.pupil);
  pupil.scale.set(0.05, 0.066, 0.022);
  pupil.position.set(side * 0.012, -0.004, 0.02);
  const hl = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), mats.highlight);
  hl.scale.set(0.012, 0.016, 0.008);
  hl.position.set(side * 0.004 + 0.012, 0.022, 0.041);
  g.add(outline, sclera, pupil, hl);
  g.userData.pupil = pupil;
  return g;
}

const eyeMats = () => ({
  outline: new THREE.MeshPhysicalMaterial({ color: 0x0b0c10, roughness: 0.25, clearcoat: 1 }),
  sclera: new THREE.MeshPhysicalMaterial({ color: 0xf8f8fb, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 }),
  pupil: new THREE.MeshPhysicalMaterial({ color: 0x050507, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04 }),
  highlight: new THREE.MeshBasicMaterial({ color: 0xffffff })
});

let _geoCache = null;
function buildGeometry (boneIndex, segs) {
  if (_geoCache) return _geoCache;
  const parts = [];
  const add = (g, cands) => { g.deleteAttribute('uv'); parts.push(skinPart(g.toNonIndexed ? g : g, cands, boneIndex, segs)); };
  add(torso(), ['hips', 'spine', 'chest', 'neck']);
  // bosh — QATTIQ (faqat head)
  add(ellipsoid([0, V773.HEAD_Y, 0], [V773.HEAD_R, V773.HEAD_R * 0.985, V773.HEAD_R * 0.97], 40), ['head']);
  for (const s of [1, -1]) {
    const L = s > 0 ? 'L' : 'R';
    add(ellipsoid([0.175 * s, 0.915, 0], [0.072, 0.07, 0.068], 18), ['chest', `upperArm.${L}`]);
    add(capsule([0.19 * s, 0.92, 0], [0.215 * s, 0.745, 0], 0.066), [`upperArm.${L}`, `forearm.${L}`]);
    add(capsule([0.215 * s, 0.745, 0], [0.228 * s, 0.585, 0.004], 0.062), [`upperArm.${L}`, `forearm.${L}`, `hand.${L}`]);
    // kichik yumaloq qo'l (barmoqlarsiz)
    add(ellipsoid([0.231 * s, 0.535, 0.006], [0.058, 0.07, 0.062], 18), [`forearm.${L}`, `hand.${L}`]);
    add(ellipsoid([0.21 * s, 0.545, 0.045], [0.026, 0.034, 0.03], 10), [`hand.${L}`]);   // bosh barmoq do'mbog'i
    add(capsule([0.095 * s, 0.5, 0], [0.1 * s, 0.265, 0.005], 0.094), ['hips', `upperLeg.${L}`, `knee.${L}`]);
    add(capsule([0.1 * s, 0.265, 0.005], [0.1 * s, 0.085, 0], 0.086), [`upperLeg.${L}`, `knee.${L}`, `ankle.${L}`]);
    // yumaloq oyoq kafti
    add(ellipsoid([0.1 * s, 0.05, 0.045], [0.088, 0.055, 0.13], 18), [`knee.${L}`, `ankle.${L}`, `foot.${L}`]);
  }
  _geoCache = mergeGeometries(parts);
  return _geoCache;
}

/**
 * V-773 nusxasi.
 * @returns {{root, mesh, bones, eyes, sockets, material, setTeam, setFlash, dispose}}
 */
export function createV773 ({ quality = 'high', team = null, envMap = null, castShadow = true } = {}) {
  const bones = {};
  const list = [];
  const world = {};
  for (const [name, parent, p] of BONES) {
    const b = new THREE.Bone();
    b.name = name;
    world[name] = v3(p);
    const pp = parent ? world[parent] : new THREE.Vector3();
    b.position.set(p[0] - pp.x, p[1] - pp.y, p[2] - pp.z);
    if (parent) bones[parent].add(b);
    bones[name] = b;
    list.push(b);
  }
  const boneIndex = {};
  list.forEach((b, i) => { boneIndex[b.name] = i; });
  // har suyak segmenti: o'zi → birinchi bola (yoki uchi)
  const segs = {};
  for (const [name] of BONES) {
    const child = BONES.find((r) => r[1] === name);
    segs[name] = [world[name], TIPS[name] ? v3(TIPS[name]) : child ? world[child[0]] : world[name]];
  }
  const geo = buildGeometry(boneIndex, segs);
  const material = makeBodyMaterial(quality, team);
  if (envMap) material.envMap = envMap;
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  const skeleton = new THREE.Skeleton(list);
  const root = new THREE.Group();
  root.name = 'V-773';
  root.add(bones.root);
  root.add(mesh);
  root.updateMatrixWorld(true);          // bind'dan OLDIN — aks holda boneInverses = identity
  mesh.bind(skeleton);

  // ko'zlar bosh suyagiga (qattiq) — sharsimon sirtga yopishtirilgan
  const em = eyeMats();
  if (envMap) for (const k of ['outline', 'sclera', 'pupil']) em[k].envMap = envMap;
  const eyes = [];
  for (const s of [1, -1]) {
    const eye = makeEye(s, em);
    const yaw = 0.36 * s;
    const pitch = -0.02;
    const R = V773.HEAD_R * 0.955;
    const local = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * R, V773.HEAD_Y - world.head.y + Math.sin(pitch) * R, Math.cos(yaw) * Math.cos(pitch) * R * 0.97);
    eye.position.copy(local);
    bones.head.add(eye);
    bones.head.updateMatrixWorld(true);
    // sirt normali bo'ylab: lookAt DUNYO nuqtasini kutadi (ota allaqachon biriktirilgan)
    const center = new THREE.Vector3(0, V773.HEAD_Y - world.head.y, 0);
    const n = local.clone().sub(center).normalize();
    eye.lookAt(bones.head.localToWorld(local.clone().add(n)));
    eyes.push(eye);
  }

  // qurol/effekt soketlari (qo'l suyaklariga biriktiriladi)
  const sockets = {
    gripR: new THREE.Object3D(), gripL: new THREE.Object3D(), head: new THREE.Object3D()
  };
  sockets.gripR.position.set(-0.004, -0.045, 0.02);
  bones['hand.R'].add(sockets.gripR);
  sockets.gripL.position.set(0.004, -0.045, 0.02);
  bones['hand.L'].add(sockets.gripL);
  sockets.head.position.set(0, V773.HEAD_Y - world.head.y, 0);
  bones.head.add(sockets.head);

  // bind holati (animator shundan hisoblaydi)
  const rest = {};
  for (const b of list) rest[b.name] = { pos: b.position.clone(), quat: b.quaternion.clone() };

  return {
    root, mesh, bones, eyes, sockets, material, skeleton, rest, world,
    setTeam (t) {
      material.userData.rim.value.set(t === 'B' ? 0xff3b5c : t === 'A' ? 0x2f8cff : 0x000000);
      material.userData.rimStrength.value = t ? 0.55 : 0;
      material.userData.baseRim = t ? 0.55 : 0;
    },
    setFlash (k) { material.userData.flash.value = k; },
    dispose () {
      material.dispose();
      for (const k in em) em[k].dispose();
      skeleton.dispose();
    }
  };
}
