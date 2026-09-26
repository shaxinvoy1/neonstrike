// ============================================================
// NEON STRIKE — Phase 2 (LEGACY, deprecated): arena sahna geometriyasi (procedural)
// Phase 3 dan boshlab klient client/js/mapview.js (shared/map.js) ishlatadi.
// shared/arena.js ma'lumotidan THREE mesh'lar quradi. Tashqi asset YO'Q.
// Neon effekt: MeshBasicMaterial (yorug'likka bog'liq emas, arzon).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { ARENA, BOXES, PALETTE } from '/shared/arena.js';

const WALL_COUNT = 4;

export function createArenaMesh () {
  const group = new THREE.Group();
  group.name = 'arena';

  // ---------- pol ----------
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA.HALF * 2, ARENA.HALF * 2),
    new THREE.MeshLambertMaterial({ color: PALETTE.FLOOR })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = ARENA.FLOOR_Y;
  floor.name = 'floor';
  group.add(floor);

  // neon to'r (lines — juda arzon)
  const grid = new THREE.GridHelper(ARENA.HALF * 2, 44, PALETTE.TRIM, PALETTE.TRIM_ALT);
  grid.position.y = ARENA.FLOOR_Y + 0.012;
  grid.material.transparent = true;
  grid.material.opacity = 0.18;
  grid.material.depthWrite = false;
  grid.name = 'floor-grid';
  group.add(grid);

  // ---------- devorlar + props (AABB → BoxGeometry) ----------
  const trimMat = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM });
  const trimAltMat = new THREE.MeshBasicMaterial({ color: PALETTE.TRIM_ALT });
  const wallMat = new THREE.MeshLambertMaterial({ color: PALETTE.WALL });
  const propMat = new THREE.MeshLambertMaterial({ color: PALETTE.PROP });
  const props = [];

  BOXES.forEach((b, i) => {
    const isWall = i < WALL_COUNT;
    const sx = b.max[0] - b.min[0];
    const sy = b.max[1] - b.min[1];
    const sz = b.max[2] - b.min[2];
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(sx, sy, sz),
      isWall ? wallMat : propMat
    );
    mesh.position.set(
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2
    );
    mesh.name = (isWall ? 'wall-' : 'prop-') + i;
    group.add(mesh);
    if (!isWall) props.push(mesh);

    // yuqori neon chiziq (neon trim)
    const trim = new THREE.Mesh(
      new THREE.BoxGeometry(sx * 0.98, isWall ? 0.1 : 0.06, sz * 0.98),
      isWall ? trimMat : trimAltMat
    );
    trim.position.set(mesh.position.x, b.max[1] - (isWall ? 0.05 : 0.03), mesh.position.z);
    trim.name = mesh.name + '-trim';
    group.add(trim);
  });

  // ---------- orqa fon devori ustidagi "NEON RANGE" panel ----------
  const panel = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 2.4),
    new THREE.MeshLambertMaterial({ color: 0x101838 })
  );
  panel.position.set(0, 1.5, ARENA.HALF - 0.06);
  panel.rotation.y = Math.PI;
  panel.name = 'range-panel';
  group.add(panel);

  for (let i = 0; i < 6; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.06, 0.04),
      i % 2 === 0 ? trimMat : trimAltMat
    );
    bar.position.set(-6.5 + i * 2.6, 0.7, ARENA.HALF - 0.12);
    group.add(bar);
  }

  return {
    group,
    floor,
    props,
    counts: { walls: WALL_COUNT, props: props.length }
  };
}
