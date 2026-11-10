// ============================================================
// NEON FACILITY — vizual arena (Reference B)
// Kolliziya: shared/map.js COLLIDERS (server bilan bir xil). Bu modul faqat
// ko'rinishni quradi: har bir kollayder o'z turiga mos detallar bilan,
// statik geometriya MATERIAL bo'yicha birlashtiriladi (draw call kam).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { COLLIDERS, MAP, SPAWN_ZONES, SITES, CATWALK, REACTOR } from '/shared/map.js';

const HX = MAP.HALF_X, HZ = MAP.HALF_Z;

// ---------- protsedural teksturalar ----------
function canvasTex (w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}
const TEX = {
  floor: () => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#1a2246'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,20'},${Math.random() * 0.035})`; g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 8, 2 + Math.random() * 8); }
    g.strokeStyle = 'rgba(5,8,22,.9)'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
    g.strokeStyle = 'rgba(120,150,255,.10)'; g.lineWidth = 2; g.strokeRect(7, 7, w - 14, h - 14);
    g.fillStyle = 'rgba(10,14,34,.8)'; for (const [x, y] of [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16]]) { g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
  }),
  wall: () => canvasTex(256, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#1b2452'); gr.addColorStop(1, '#141b3e');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, 6, h); g.fillRect(w / 2 - 2, 0, 4, h);
    g.fillStyle = 'rgba(140,170,255,.07)'; g.fillRect(8, 0, 3, h); g.fillRect(w / 2 + 3, 0, 3, h);
    for (const y of [h * 0.3, h * 0.72]) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, y, w, 5); g.fillStyle = 'rgba(160,190,255,.06)'; g.fillRect(0, y + 5, w, 2); }
    g.fillStyle = 'rgba(8,12,30,.7)'; for (let i = 0; i < 6; i++) g.fillRect(w * 0.62, h * 0.4 + i * 10, w * 0.26, 4);   // vent
  }),
  crate: () => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#1d2650'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#0c1130'; g.lineWidth = 18; g.strokeRect(9, 9, w - 18, h - 18);
    g.lineWidth = 14; g.beginPath(); g.moveTo(18, 18); g.lineTo(w - 18, h - 18); g.moveTo(w - 18, 18); g.lineTo(18, h - 18); g.stroke();
    g.strokeStyle = 'rgba(150,180,255,.18)'; g.lineWidth = 2; g.strokeRect(19, 19, w - 38, h - 38);
  }, false),
  container: () => canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#18224a'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 24) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(x, 0, 6, h); g.fillStyle = 'rgba(160,190,255,.07)'; g.fillRect(x + 7, 0, 3, h); }
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, w, 14); g.fillRect(0, h - 14, w, 14);
    g.fillStyle = '#0d1433'; g.fillRect(w * 0.08, h * 0.3, w * 0.16, h * 0.34);
    g.fillStyle = '#3f9dff'; for (let i = 0; i < 5; i++) g.fillRect(w * 0.1, h * 0.34 + i * 15, w * 0.12, 6);
  }, false),
  grate: () => canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#20294f'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0b1029'; for (let x = 4; x < w; x += 12) g.fillRect(x, 0, 6, h);
    g.fillStyle = 'rgba(150,180,255,.12)'; for (let x = 10; x < w; x += 12) g.fillRect(x, 0, 1, h);
  }),
  windows: () => canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#0d1230'; g.fillRect(0, 0, w, h);
    for (let y = 8; y < h; y += 20) for (let x = 8; x < w; x += 22) {
      const r = Math.random();
      g.fillStyle = r < 0.18 ? '#7fc8ff' : r < 0.26 ? '#b48cff' : r < 0.32 ? '#3a5cff' : '#141a3c';
      g.fillRect(x, y, 13, 10);
    }
  }),
  glow: () => canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }, false),
  sign: () => canvasTex(1024, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.shadowColor = '#4fa8ff'; g.shadowBlur = 40;
    g.fillStyle = '#c9e4ff'; g.font = '900 430px system-ui, Arial'; g.textBaseline = 'middle';
    g.fillText('A', 60, 270);
    g.lineWidth = 46; g.strokeStyle = '#c9e4ff'; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(520, 270); g.lineTo(860, 270); g.moveTo(740, 150); g.lineTo(880, 270); g.lineTo(740, 390); g.stroke();
  }, false),
  floorText: (txt, color) => canvasTex(512, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = color; g.globalAlpha = 0.85;
    g.font = '800 84px system-ui, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, w / 2, h / 2);
  }, false)
};

// ---------- dunyo masshtabidagi UV bilan quti ----------
function worldBox (min, max, tile = 2, faces = null) {
  const sx = max[0] - min[0], sy = max[1] - min[1], sz = max[2] - min[2];
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i));
    if (faces === 'unit') continue;
    if (ay > 0.5) uv.setXY(i, x / tile, z / tile);
    else if (ax > 0.5) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  return g;
}

/** Bir xil materialdagi geometriyalarni bitta Mesh'ga birlashtirish */
class Batch {
  constructor () { this.map = new Map(); }
  add (mat, geo) { if (!this.map.has(mat)) this.map.set(mat, []); this.map.get(mat).push(geo); }
  build (parent, { shadows = true } = {}) {
    for (const [mat, list] of this.map) {
      let vc = 0, ic = 0;
      for (const g of list) { vc += g.attributes.position.count; ic += g.index.count; }
      const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), idx = new Uint32Array(ic);
      let vo = 0, io = 0;
      for (const g of list) {
        pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); uv.set(g.attributes.uv.array, vo * 2);
        const a = g.index.array; for (let k = 0; k < a.length; k++) idx[io + k] = a[k] + vo;
        io += a.length; vo += g.attributes.position.count; g.dispose();
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadows && !mat.userData.noShadow;
      m.receiveShadow = !mat.userData.emissiveOnly;
      m.matrixAutoUpdate = false;
      parent.add(m);
    }
    this.map.clear();
  }
}

export function createArena ({ envMap = null, quality = 'high' } = {}) {
  const root = new THREE.Group();
  root.name = 'NEON_FACILITY';
  const disposables = [];
  const mk = (Ctor, o) => { const m = new Ctor(o); if (envMap && 'envMap' in m) m.envMap = envMap; disposables.push(m); return m; };
  const t = {};
  for (const k of ['floor', 'wall', 'crate', 'container', 'grate', 'windows', 'glow', 'sign']) { t[k] = TEX[k](); disposables.push(t[k]); }

  const M = {
    floor: mk(THREE.MeshStandardMaterial, { map: t.floor, color: 0xa8b4e6, roughness: 0.32, metalness: 0.55, envMapIntensity: 0.8 }),
    wall: mk(THREE.MeshStandardMaterial, { map: t.wall, color: 0xd0d8ff, roughness: 0.55, metalness: 0.3 }),
    wallDark: mk(THREE.MeshStandardMaterial, { color: 0x10173a, roughness: 0.7, metalness: 0.3 }),
    metal: mk(THREE.MeshStandardMaterial, { color: 0x2a3566, roughness: 0.35, metalness: 0.8 }),
    trim: mk(THREE.MeshStandardMaterial, { color: 0x0b1028, roughness: 0.5, metalness: 0.6 }),
    crate: mk(THREE.MeshStandardMaterial, { map: t.crate, color: 0xc6cff8, roughness: 0.5, metalness: 0.4 }),
    container: mk(THREE.MeshStandardMaterial, { map: t.container, color: 0xb6c0f0, roughness: 0.5, metalness: 0.5 }),
    grate: mk(THREE.MeshStandardMaterial, { map: t.grate, color: 0xb0bcf0, roughness: 0.45, metalness: 0.7 }),
    rail: mk(THREE.MeshStandardMaterial, { color: 0x0c1124, roughness: 0.35, metalness: 0.9 }),
    building: mk(THREE.MeshStandardMaterial, { map: t.windows, color: 0x8090d0, emissive: 0xffffff, emissiveMap: t.windows, emissiveIntensity: 0.55, roughness: 0.8 }),
    neon: mk(THREE.MeshBasicMaterial, { color: new THREE.Color(0x35c8ff).multiplyScalar(1.6) }),
    neonBlue: mk(THREE.MeshBasicMaterial, { color: new THREE.Color(0x2f6dff).multiplyScalar(1.7) }),
    neonViolet: mk(THREE.MeshBasicMaterial, { color: new THREE.Color(0x8a5cff).multiplyScalar(1.5) }),
    neonRed: mk(THREE.MeshBasicMaterial, { color: new THREE.Color(0xff3b5c).multiplyScalar(1.4) }),
    core: mk(THREE.MeshStandardMaterial, { color: 0x0b2a55, emissive: 0x2fb8ff, emissiveIntensity: 1.6, roughness: 0.2, metalness: 0.3 })
  };
  for (const k of ['neon', 'neonBlue', 'neonViolet', 'neonRed']) { M[k].userData.noShadow = true; M[k].userData.emissiveOnly = true; }
  M.building.userData.noShadow = true;
  const B = new Batch();
  const strip = (mat, min, max) => B.add(mat, worldBox(min, max, 1, 'unit'));

  // ---------- pol ----------
  B.add(M.floor, worldBox([-HX - 0.6, -0.2, -HZ - 0.6], [HX + 0.6, 0, HZ + 0.6], 2));
  // cyan pol chiziqlari (Reference B): lanelar chegarasi, spawn hududlari, reaktor atrofi
  const y0 = 0.004, y1 = 0.012;
  for (const s of [1, -1]) {
    strip(M.neon, [-17, y0, 4.05 * s - 0.04], [17, y1, 4.05 * s + 0.04]);              // MID chekkalari
    strip(M.neonBlue, [-14, y0, 9.6 * s - 0.03], [14, y1, 9.6 * s + 0.03]);
    const z = SPAWN_ZONES.A;
    const xs = s > 0 ? [z.min[0], z.max[0]] : [-z.max[0], -z.min[0]];
    strip(s > 0 ? M.neon : M.neonRed, [xs[0], y0, -5], [xs[1], y1, -4.94]);
    strip(s > 0 ? M.neon : M.neonRed, [xs[0], y0, 4.94], [xs[1], y1, 5]);
    strip(s > 0 ? M.neon : M.neonRed, [s > 0 ? xs[1] - 0.06 : xs[0], y0, -5], [s > 0 ? xs[1] : xs[0] + 0.06, y1, 5]);
  }
  // reaktor platformasi atrofidagi halqa
  const P = REACTOR.PLATFORM;
  for (const [a, b] of [[[P.min[0] - 0.12, y0, P.min[2] - 0.12], [P.max[0] + 0.12, y1, P.min[2] - 0.06]], [[P.min[0] - 0.12, y0, P.max[2] + 0.06], [P.max[0] + 0.12, y1, P.max[2] + 0.12]]]) strip(M.neon, a, b);

  // ---------- kollayderlarni turiga qarab bezash ----------
  for (const c of COLLIDERS) {
    const { min, max } = c.box;
    const w = max[0] - min[0], d = max[2] - min[2], h = max[1] - min[1];
    switch (c.kind) {
      case 'wall': {
        // tashqi devor: kollayderdan baland (vizual 7 m), tepada neon chiziq, pastda plinth
        const vmax = [max[0], 7.2, max[2]];
        B.add(M.wall, worldBox(min, vmax, 3.2));
        const inner = w > d ? (max[2] <= -HZ + 0.01 ? 'N' : 'S') : (max[0] <= -HX + 0.01 ? 'W' : 'E');
        const iz = inner === 'N' ? max[2] : inner === 'S' ? min[2] : null;
        const ix = inner === 'W' ? max[0] : inner === 'E' ? min[0] : null;
        for (const [yy, mat] of [[4.1, M.neonBlue], [6.9, M.neon]]) {
          if (iz !== null) strip(mat, [min[0], yy, iz - (inner === 'S' ? 0.05 : 0)], [max[0], yy + 0.08, iz + (inner === 'N' ? 0.05 : 0)]);
          else strip(mat, [ix - (inner === 'E' ? 0.05 : 0), yy, min[2]], [ix + (inner === 'W' ? 0.05 : 0), yy + 0.08, max[2]]);
        }
        // vertikal neon ustunlar (har 8 m)
        const along = iz !== null ? [min[0], max[0]] : [min[2], max[2]];
        for (let u = along[0] + 4; u < along[1] - 2; u += 8) {
          if (iz !== null) { strip(M.trim, [u - 0.35, 0, iz - (inner === 'S' ? 0.25 : 0)], [u + 0.35, 7.2, iz + (inner === 'N' ? 0.25 : 0)]); strip(M.neonBlue, [u - 0.05, 0.4, iz + (inner === 'N' ? 0.26 : -0.26)], [u + 0.05, 3.8, iz + (inner === 'N' ? 0.28 : -0.28)]); } else { strip(M.trim, [ix - (inner === 'E' ? 0.25 : 0), 0, u - 0.35], [ix + (inner === 'W' ? 0.25 : 0), 7.2, u + 0.35]); strip(M.neonBlue, [ix + (inner === 'W' ? 0.26 : -0.28), 0.4, u - 0.05], [ix + (inner === 'W' ? 0.28 : -0.26), 3.8, u + 0.05]); }
        }
        break;
      }
      case 'divider': {
        B.add(M.wall, worldBox(min, max, 3));
        strip(M.neon, [min[0], max[1], min[2] - 0.02], [max[0], max[1] + 0.05, max[2] + 0.02]);
        strip(M.trim, [min[0], 0, min[2] - 0.03], [max[0], 0.18, max[2] + 0.03]);
        break;
      }
      case 'platform': {
        B.add(M.metal, worldBox(min, max, 2));
        B.add(M.grate, worldBox([min[0] + 0.3, max[1], min[2] + 0.3], [max[0] - 0.3, max[1] + 0.01, max[2] - 0.3], 1));
        for (const z of [min[2], max[2]]) strip(M.neon, [min[0], max[1] - 0.12, z - 0.03], [max[0], max[1] - 0.04, z + 0.03]);
        break;
      }
      case 'core': {
        const core = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, h, 24), M.core);
        core.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        core.castShadow = true;
        root.add(core);
        disposables.push(core.geometry);
        for (const yy of [min[1] + 0.3, max[1] - 0.3]) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.06, 8, 32), M.metal);
          ring.rotation.x = Math.PI / 2; ring.position.set(core.position.x, yy, core.position.z); root.add(ring); disposables.push(ring.geometry);
        }
        break;
      }
      case 'stair': {
        B.add(M.metal, worldBox(min, max, 1));
        // zina burni neon chizig'i (qadamlar ko'rinadi)
        const front = min[0] < 0 ? min[0] : max[0];
        const dir = Math.abs(front - min[0]) < 1e-6 ? 1 : -1;
        if (w < 1.2) strip(M.neon, [front - (dir < 0 ? 0.04 : 0), max[1] - 0.03, min[2]], [front + (dir > 0 ? 0.04 : 0), max[1], max[2]]);
        break;
      }
      case 'catwalk': {
        B.add(M.grate, worldBox([min[0], max[1] - 0.05, min[2]], max, 1));
        B.add(M.metal, worldBox(min, [max[0], max[1] - 0.05, max[2]], 2));
        // pastki neon (osti yoritilgan) + panjaralar (uzun tomonlarda)
        for (const z of [min[2] + 0.08, max[2] - 0.08]) strip(M.neonBlue, [min[0], min[1] - 0.02, z - 0.03], [max[0], min[1], z + 0.03]);
        const outerZ = min[2] < 0 ? [min[2], max[2]] : [max[2], min[2]];
        for (const z of outerZ) {
          B.add(M.rail, worldBox([min[0], max[1] + 1.02, z - 0.035], [max[0], max[1] + 1.08, z + 0.035], 1));
          B.add(M.rail, worldBox([min[0], max[1] + 0.52, z - 0.02], [max[0], max[1] + 0.56, z + 0.02], 1));
          strip(M.neon, [min[0], max[1] + 1.08, z - 0.015], [max[0], max[1] + 1.1, z + 0.015]);
          for (let x = min[0]; x <= max[0] + 1e-6; x += 2) B.add(M.rail, worldBox([x - 0.03, max[1], z - 0.03], [x + 0.03, max[1] + 1.08, z + 0.03], 1));
        }
        break;
      }
      case 'pillar': {
        B.add(M.metal, worldBox(min, max, 1));
        strip(M.neonBlue, [min[0] - 0.01, 0.2, (min[2] + max[2]) / 2 - 0.02], [max[0] + 0.01, max[1] - 0.2, (min[2] + max[2]) / 2 + 0.02]);
        break;
      }
      case 'crate': {
        B.add(M.crate, worldBox(min, max, 1, 'unit'));
        strip(M.neon, [min[0] - 0.01, max[1] - 0.04, min[2] - 0.01], [max[0] + 0.01, max[1] + 0.005, min[2] + 0.04]);
        strip(M.neon, [min[0] - 0.01, max[1] - 0.04, max[2] - 0.04], [max[0] + 0.01, max[1] + 0.005, max[2] + 0.01]);
        break;
      }
      case 'container': {
        B.add(M.container, worldBox(min, max, 1, 'unit'));
        B.add(M.trim, worldBox([min[0] - 0.04, max[1] - 0.12, min[2] - 0.04], [max[0] + 0.04, max[1] + 0.02, max[2] + 0.04], 1));
        B.add(M.trim, worldBox([min[0] - 0.04, 0, min[2] - 0.04], [max[0] + 0.04, 0.14, max[2] + 0.04], 1));
        for (const x of [min[0] - 0.045, max[0] + 0.005]) strip(M.neonBlue, [x, 0.3, min[2] + 0.2], [x + 0.04, max[1] - 0.3, min[2] + 0.26]);
        break;
      }
      default: B.add(M.metal, worldBox(min, max, 2));
    }
  }

  // ---------- fon: devor ortidagi sanoat binolari ----------
  const bld = (x0, z0, x1, z1, hgt) => B.add(M.building, worldBox([x0, 0, z0], [x1, hgt, z1], 3));
  for (let x = -HX - 4; x < HX + 4; x += 9) {
    bld(x, -HZ - 12, x + 7 + Math.random() * 2, -HZ - 5, 11 + Math.random() * 9);
    bld(x, HZ + 5, x + 7 + Math.random() * 2, HZ + 12, 11 + Math.random() * 9);
  }
  for (let z = -HZ - 4; z < HZ + 4; z += 9) {
    bld(-HX - 12, z, -HX - 5, z + 7, 10 + Math.random() * 8);
    bld(HX + 5, z, HX + 12, z + 7, 10 + Math.random() * 8);
  }
  // shimoliy ustki yo'lak (Reference B: devor tepasidagi ko'prik va panjara)
  B.add(M.metal, worldBox([-HX, 7.2, -HZ - 3], [HX, 7.5, -HZ]));
  for (let x = -HX; x <= HX; x += 2.2) B.add(M.rail, worldBox([x - 0.04, 7.5, -HZ - 0.08], [x + 0.04, 8.6, -HZ]));
  B.add(M.rail, worldBox([-HX, 8.55, -HZ - 0.08], [HX, 8.62, -HZ]));
  strip(M.neonBlue, [-HX, 7.2, -HZ - 0.02], [HX, 7.26, -HZ + 0.02]);

  B.build(root, { shadows: quality !== 'low' });

  // ---------- A-SITE belgisi (katta "A →") ----------
  const S = SITES.A.sign;
  const signMat = new THREE.MeshBasicMaterial({ map: t.sign, transparent: true, depthWrite: false, color: new THREE.Color(1.6, 1.8, 2.4) });
  disposables.push(signMat);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.6, 2.8), signMat);
  sign.position.set(S.x, S.y, S.z + 0.05);
  root.add(sign);
  disposables.push(sign.geometry);
  // site maydonchasi: pol yozuvi
  const siteTex = TEX.floorText('A SITE', '#7fd8ff'); disposables.push(siteTex);
  const siteMat = new THREE.MeshBasicMaterial({ map: siteTex, transparent: true, depthWrite: false }); disposables.push(siteMat);
  const siteLabel = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), siteMat);
  siteLabel.rotation.x = -Math.PI / 2; siteLabel.position.set(12.5, 0.02, -7.4); root.add(siteLabel); disposables.push(siteLabel.geometry);

  // ---------- yorug'lik ----------
  const lights = new THREE.Group();
  lights.add(new THREE.HemisphereLight(0x9ab4ff, 0x1c2250, quality === 'low' ? 1.6 : 1.25));
  const moon = new THREE.DirectionalLight(0xc8d6ff, quality === 'low' ? 1.3 : 1.6);
  moon.position.set(-14, 26, 10);
  moon.target.position.set(0, 0, 0);
  if (quality !== 'low') {
    moon.castShadow = true;
    moon.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
    const sc = moon.shadow.camera; sc.left = -26; sc.right = 26; sc.top = 20; sc.bottom = -20; sc.near = 1; sc.far = 70;
    moon.shadow.bias = -0.0006; moon.shadow.normalBias = 0.03;
  }
  lights.add(moon, moon.target);
  const pts = quality === 'low' ? [] : [
    [0, 4.2, 0, 0x2fb8ff, 30, 16], [-19.5, 3.5, 0, 0x2f8cff, 24, 12], [19.5, 3.5, 0, 0xff3b5c, 20, 12],
    [11.5, 4.5, -13.5, 0x3f8cff, 26, 14], [-11.5, 4.5, 13.5, 0x7b5cff, 22, 14], [0, 3.6, -12, 0x35c8ff, 18, 12]
  ];
  for (const [x, y, z, c, i, d] of pts) { const L = new THREE.PointLight(c, i, d, 1.6); L.position.set(x, y, z); lights.add(L); }
  root.add(lights);

  // neon "glow" kvadratlari (bloomsiz yorqin his) — additiv
  const glowMat = new THREE.SpriteMaterial({ map: t.glow, color: 0x3fa8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 });
  disposables.push(glowMat);
  for (const [x, y, z, s] of [[S.x - 1.4, S.y, S.z + 0.3, 5], [S.x + 1.2, S.y, S.z + 0.3, 4], [0, 3.2, 0, 4.5], [-19.5, 0.3, 0, 6]]) {
    const sp = new THREE.Sprite(glowMat); sp.position.set(x, y, z); sp.scale.set(s, s * 0.7, 1); root.add(sp);
  }

  return {
    root,
    lights,
    dispose () {
      root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const d of disposables) d.dispose && d.dispose();
    }
  };
}

/** Sahna sozlamalari: fon, tuman (Reference B: to'q ko'k / binafsha atmosfera) */
export function applyAtmosphere (scene) {
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#05081a'); gr.addColorStop(0.45, '#1a1550'); gr.addColorStop(0.62, '#2a2a7a'); gr.addColorStop(1, '#0a1030');
  g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = t;
  scene.fog = new THREE.FogExp2(0x0c1236, 0.018);
  return t;
}
