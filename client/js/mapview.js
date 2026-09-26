// ============================================================
// NEON STRIKE — PHASE 3: NEON FACILITY sahnasi (procedural)
// shared/map.js geometriyasidan THREE mesh'lar quradi (tashqi asset YO'Q).
//  - Kollayder kind'i → material (wall/divider/platform/core/stair/catwalk/
//    pillar/crate) — Phase 2 palitrasi bilan.
//  - Takrorlanuvchi geometriya (28 zina / 10 ustun / 10 krat) InstancedMesh →
//    draw call budjeti past (per-box mesh emas).
//  - Neon: MeshBasicMaterial chiziqlar (yorug'likka bog'liq emas, arzon).
//  - Render QILMAYDI: faqat geometriya (index.js sahnaga qo'shadi).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import {
  MAP, COLLIDERS, CATWALK, CALLOUTS, SPAWN_ZONES, LANES, PALETTE
} from '/shared/map.js';

/** Kollayder kind'i → tana materiali */
function bodyMaterials () {
  return {
    wall: new THREE.MeshLambertMaterial({ color: PALETTE.WALL }),
    divider: new THREE.MeshLambertMaterial({ color: PALETTE.WALL }),
    platform: new THREE.MeshLambertMaterial({ color: PALETTE.PLATFORM }),
    core: new THREE.MeshLambertMaterial({ color: PALETTE.CORE_BODY }),
    stair: new THREE.MeshLambertMaterial({ color: PALETTE.STAIR }),
    catwalk: new THREE.MeshLambertMaterial({ color: PALETTE.DECK }),
    pillar: new THREE.MeshLambertMaterial({ color: PALETTE.PILLAR }),
    crate: new THREE.MeshLambertMaterial({ color: PALETTE.CRATE })
  };
}

/** Kollayder kind'i → neon chiziq materiali (null = chiziq chizilmaydi) */
function trimMaterials (trimMat, trimAltMat) {
  return {
    wall: trimMat, divider: trimAltMat, platform: trimMat, core: null,
    stair: trimMat, catwalk: trimAltMat, pillar: trimAltMat, crate: trimAltMat
  };
}

const size = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
const center = (b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

/** Bitta AABB → BoxGeometry mesh */
function boxMesh (b, mat, name) {
  const [sx, sy, sz] = size(b);
  const [cx, cy, cz] = center(b);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
  mesh.position.set(cx, cy, cz);
  mesh.name = name;
  return mesh;
}

/** Bir xil kind'dagi AABB'lar → bitta InstancedMesh (draw call tejash) */
function instancedFor (boxes, mat, name, trimMat) {
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, boxes.length);
  im.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const trim = trimMat ? new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.06, 1), trimMat, boxes.length) : null;
  if (trim) trim.name = name + '-trim';
  boxes.forEach((b, i) => {
    const [sx, sy, sz] = size(b);
    const [cx, cy, cz] = center(b);
    m.compose(v.set(cx, cy, cz), q, s.set(sx, sy, sz));
    im.setMatrixAt(i, m);
    if (trim) {
      m.compose(v.set(cx, b.max[1] + 0.02, cz), q, s.set(sx * 0.94, 1, sz * 0.94));
      trim.setMatrixAt(i, m);
    }
  });
  im.instanceMatrix.needsUpdate = true;
  if (trim) trim.instanceMatrix.needsUpdate = true;
  return trim ? [im, trim] : [im];
}

/** Yupqa neon chiziq (pol/deck ustidagi yo'nalish belgisi) — hozir lane
 *  chiziqlari bitta InstancedMesh'da (instance ranglar bilan); funksiya
 *  boshqa joyda ishlatilmagani uchun olib tashlandi. */

export function createMapMesh () {
  const group = new THREE.Group();
  group.name = 'map';
  const mats = bodyMaterials();
  const trimMat = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM });
  const trimAltMat = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM_ALT });
  const trims = trimMaterials(trimMat, trimAltMat);

  // ---------- pol + neon to'r ----------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP.WIDTH, MAP.DEPTH),
    new THREE.MeshLambertMaterial({ color: PALETTE.FLOOR })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = MAP.FLOOR_Y;
  floor.name = 'floor';
  group.add(floor);

  const grid = new THREE.GridHelper(MAP.WIDTH, 44, PALETTE.TRIM, PALETTE.TRIM_ALT);
  grid.position.y = MAP.FLOOR_Y + 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.16;
  grid.material.depthWrite = false;
  grid.name = 'floor-grid';
  group.add(grid);

  // ---------- kollayderlar: yakka (unique) + instanced (takrorlanuvchi) ----------
  const REPEATED = new Set(['stair', 'pillar', 'crate']);
  const byKind = new Map();
  const counts = { wall: 0, divider: 0, platform: 0, core: 0, stair: 0, catwalk: 0, pillar: 0, crate: 0 };
  const instanced = [];
  let meshCount = 0;

  for (const c of COLLIDERS) {
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    if (REPEATED.has(c.kind)) {
      if (!byKind.has(c.kind)) byKind.set(c.kind, []);
      byKind.get(c.kind).push(c.box);
      continue;
    }
    group.add(boxMesh(c.box, mats[c.kind], c.id));
    meshCount++;
    if (trims[c.kind]) {
      const [sx, , sz] = size(c.box);
      const [cx, , cz] = center(c.box);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(sx * 0.96, 0.08, sz * 0.96), trims[c.kind]);
      trim.position.set(cx, c.box.max[1] + 0.045, cz);
      trim.name = c.id + '-trim';
      group.add(trim);
      meshCount++;
    }
  }

  for (const [kind, boxes] of byKind) {
    for (const part of instancedFor(boxes, mats[kind], kind + '-inst', trims[kind])) {
      group.add(part);
      instanced.push(part);
      meshCount++;
    }
  }

  // ---------- REACTOR o'zagi: neon glow + nur ustuni ----------
  const core = COLLIDERS.find((c) => c.kind === 'core');
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 2.2, 2.5),
    new THREE.MeshBasicMaterial({ color: PALETTE.CORE_GLOW, transparent: true, opacity: 0.16, depthWrite: false })
  );
  glow.position.set(0, 2.2, 0);
  glow.name = 'reactor-glow';
  group.add(glow);
  meshCount++;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 12, 8),
    new THREE.MeshBasicMaterial({ color: PALETTE.CORE_GLOW, transparent: true, opacity: 0.3, depthWrite: false })
  );
  beam.position.set(0, core.box.max[1] + 6, 0);
  beam.name = 'reactor-beam';
  group.add(beam);
  meshCount++;

  // ---------- lane yo'nalish chiziqlari (LANES ma'lumotidan) ----------
  // Bitta InstancedMesh + instance ranglari (3 mesh → 1 mesh: draw call budjeti)
  const laneStrips = [];
  const laneIM = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55 }),
    LANES.length
  );
  laneIM.name = 'lane-strips';
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const cyan = new THREE.Color(PALETTE.TRIM);
    const violet = new THREE.Color(PALETTE.TRIM_ALT);
    LANES.forEach((lane, i) => {
      const sx = lane.max[0] - lane.min[0];
      const cx = (lane.min[0] + lane.max[0]) / 2;
      const cz = (lane.min[2] + lane.max[2]) / 2;
      // catwalk lane deck USTIDAN o'tadi, qolganlari poldan
      const isAlt = lane.id === 'right-catwalk';
      const y = (isAlt ? CATWALK.DECK_TOP : MAP.FLOOR_Y) + 0.02;
      m.compose(v.set(cx, y, cz), q, s.set(sx, 0.02, 0.08));
      laneIM.setMatrixAt(i, m);
      laneIM.setColorAt(i, isAlt ? violet : cyan);
    });
    laneIM.instanceMatrix.needsUpdate = true;
    if (laneIM.instanceColor) laneIM.instanceColor.needsUpdate = true;
  }
  group.add(laneIM);
  laneStrips.push(laneIM);
  meshCount++;

  // ---------- spawn hududlari plitalari ----------
  const spawnPlates = [];
  for (const key of Object.keys(SPAWN_ZONES)) {
    const z = SPAWN_ZONES[key];
    const mat = (key === 'A' ? trimMat : trimAltMat).clone();
    mat.transparent = true;
    mat.opacity = 0.22;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(z.max[0] - z.min[0], z.max[2] - z.min[2]), mat);
    plate.rotation.x = -Math.PI / 2;
    plate.position.set((z.min[0] + z.max[0]) / 2, MAP.FLOOR_Y + 0.03, (z.min[2] + z.max[2]) / 2);
    plate.name = 'spawn-plate-' + key;
    group.add(plate);
    spawnPlates.push(plate);
    meshCount++;
  }

  // ---------- callout plitalari ----------
  const callouts = [];
  for (const c of CALLOUTS) {
    const mat = (c.color === 'A' ? trimMat : trimAltMat).clone();
    mat.transparent = true;
    mat.opacity = 0.6;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.02, 1.1), mat);
    plate.position.set(c.x, c.y, c.z);
    plate.name = 'callout-' + c.id;
    group.add(plate);
    callouts.push(plate);
    meshCount++;
  }

  group.userData.stats = {
    colliders: COLLIDERS.length,
    meshes: meshCount,
    instances: instanced.reduce((n, m) => n + m.count, 0)
  };

  return {
    group,
    floor,
    grid,
    laneStrips,
    spawnPlates,
    callouts,
    counts: { ...counts, colliders: COLLIDERS.length, meshes: meshCount, instanced: instanced.length }
  };
}