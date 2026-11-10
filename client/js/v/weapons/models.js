// ============================================================
// QUROL MODELLARI (protsedural, har biri alohida silueti bilan).
// Har model +Z ga qaraydi; userData:
//   grip    — o'ng qo'l dastagi (lokal nuqta)
//   support — chap qo'l tayanch nuqtasi (old dastak)
//   muzzle  — o'q chiqish nuqtasi (flash/tracer shu yerdan)
//   mag     — magazin nuqtasi, magMesh — reload paytida yashiriladigan qism
// O'lcham — V-773 ning qisqa qo'llariga moslangan "o'yinchoq" masshtabi.
// ============================================================
import * as THREE from '/vendor/three.module.js';

export const WEAPON_IDS = Object.freeze(['neon-rifle', 'pulse-pistol', 'scatter-shot', 'energy-grenade', 'combat-knife']);

const mats = new Map();
function M (key, envMap) {
  const k = key + (envMap ? ':e' : '');
  if (mats.has(k)) return mats.get(k);
  const def = {
    body: { color: 0x1b2236, roughness: 0.38, metalness: 0.75 },
    dark: { color: 0x0b0f1a, roughness: 0.5, metalness: 0.6 },
    steel: { color: 0x9aa7bd, roughness: 0.22, metalness: 1.0 },
    grip: { color: 0x141824, roughness: 0.8, metalness: 0.1 },
    neon: { color: 0x0b2a55, emissive: 0x2fb8ff, emissiveIntensity: 2.4, roughness: 0.3 },
    neonV: { color: 0x2a1055, emissive: 0x9a5cff, emissiveIntensity: 2.2, roughness: 0.3 },
    frag: { color: 0x2b3a2c, roughness: 0.55, metalness: 0.35 },
    blade: { color: 0xd8e2f0, roughness: 0.12, metalness: 1.0 }
  }[key];
  const m = new THREE.MeshStandardMaterial(def);
  if (envMap) m.envMap = envMap;
  mats.set(k, m);
  return m;
}

function box (g, mat, w, h, d, x, y, z, rx = 0) {
  const m = new THREE.Mesh(new RoundedBox(w, h, d, Math.min(w, h, d) * 0.22), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  m.castShadow = true;
  g.add(m);
  return m;
}
function cyl (g, mat, r, len, x, y, z, seg = 16) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  m.castShadow = true;
  g.add(m);
  return m;
}

/** Yumaloq qirrali quti (qurol qismlari uchun — keskin qirrasiz) */
class RoundedBox extends THREE.BufferGeometry {
  constructor (w, h, d, r) {
    super();
    const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3);
    const p = g.attributes.position;
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz));
      const n = v.clone().sub(c);
      if (n.lengthSq() > 1e-12) v.copy(c).addScaledVector(n.normalize(), r);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    this.copy(g);
    g.dispose();
  }
}

function rifle (env) {
  const g = new THREE.Group();
  box(g, M('body', env), 0.07, 0.085, 0.3, 0, 0.02, 0.06);             // receiver
  cyl(g, M('steel', env), 0.017, 0.2, 0, 0.035, 0.3);                  // barrel
  cyl(g, M('dark', env), 0.026, 0.05, 0, 0.035, 0.42);                 // muzzle brake
  box(g, M('dark', env), 0.06, 0.06, 0.14, 0, 0.012, 0.19);            // handguard
  box(g, M('neon', env), 0.074, 0.012, 0.2, 0, 0.068, 0.08);          // neon rail
  box(g, M('neon', env), 0.072, 0.01, 0.12, 0, 0.0, 0.26);            // handguard stripe
  box(g, M('body', env), 0.055, 0.07, 0.15, 0, 0.0, -0.15);            // stock
  box(g, M('dark', env), 0.06, 0.09, 0.03, 0, -0.005, -0.23);          // butt pad
  box(g, M('grip', env), 0.045, 0.1, 0.05, 0, -0.06, -0.005, 0.25);    // pistol grip
  const mag = box(g, M('dark', env), 0.04, 0.12, 0.06, 0, -0.07, 0.1, -0.18);   // magazine
  box(g, M('dark', env), 0.04, 0.04, 0.06, 0, 0.09, 0.02);             // optic base
  box(g, M('neonV', env), 0.03, 0.03, 0.05, 0, 0.115, 0.02);           // optic glow
  return finish(g, { grip: [0, -0.04, 0.0], support: [0, -0.005, 0.14], muzzle: [0, 0.035, 0.45], mag: [0, -0.09, 0.1], magMesh: mag });
}

function pistol (env) {
  const g = new THREE.Group();
  box(g, M('body', env), 0.045, 0.055, 0.17, 0, 0.03, 0.05);           // slide
  box(g, M('neon', env), 0.048, 0.01, 0.12, 0, 0.06, 0.05);            // top glow
  cyl(g, M('steel', env), 0.011, 0.04, 0, 0.03, 0.15);                 // barrel tip
  box(g, M('grip', env), 0.04, 0.1, 0.05, 0, -0.035, -0.012, 0.22);   // grip
  const mag = box(g, M('dark', env), 0.03, 0.03, 0.035, 0, -0.09, -0.02, 0.22);
  box(g, M('dark', env), 0.012, 0.03, 0.04, 0, -0.01, 0.04);           // trigger guard
  return finish(g, { grip: [0, -0.03, -0.01], support: [0.025, -0.05, 0.0], muzzle: [0, 0.03, 0.175], mag: [0, -0.09, -0.02], magMesh: mag });
}

function shotgun (env) {
  const g = new THREE.Group();
  box(g, M('body', env), 0.075, 0.08, 0.24, 0, 0.02, 0.03);            // receiver
  cyl(g, M('steel', env), 0.022, 0.28, 0, 0.045, 0.28);                // barrel
  cyl(g, M('dark', env), 0.02, 0.24, 0, 0.0, 0.26);                    // tube magazine
  const pump = box(g, M('grip', env), 0.065, 0.055, 0.1, 0, 0.005, 0.13);   // pump
  box(g, M('neonV', env), 0.077, 0.012, 0.18, 0, 0.065, 0.04);         // violet glow
  box(g, M('body', env), 0.06, 0.08, 0.17, 0, -0.005, -0.17, 0.08);    // stock
  box(g, M('grip', env), 0.045, 0.095, 0.05, 0, -0.06, -0.03, 0.3);
  const mag = box(g, M('steel', env), 0.03, 0.03, 0.05, 0.04, 0.0, 0.06);   // shell port
  return finish(g, { grip: [0, -0.045, -0.025], support: [0, -0.01, 0.125], muzzle: [0, 0.045, 0.43], mag: [0.04, 0, 0.06], magMesh: mag, pump });
}

function grenade (env) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 16), M('frag', env));
  body.scale.set(1, 1.15, 1);
  body.castShadow = true;
  g.add(body);
  for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.004, 6, 24), M('dark', env)); r.rotation.x = Math.PI / 2; r.position.y = -0.03 + i * 0.03; g.add(r); }
  box(g, M('steel', env), 0.03, 0.03, 0.03, 0, 0.065, 0);              // fuse
  box(g, M('steel', env), 0.01, 0.06, 0.014, 0.022, 0.03, 0);          // spoon
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), M('neon', env)); led.position.set(0, 0.085, 0); g.add(led);
  return finish(g, { grip: [0, -0.01, 0], support: null, muzzle: [0, 0.02, 0.04] });
}

function knife (env) {
  const g = new THREE.Group();
  box(g, M('grip', env), 0.03, 0.03, 0.1, 0, 0, -0.01);                // handle
  box(g, M('steel', env), 0.05, 0.035, 0.012, 0, 0, 0.045);            // guard
  const shape = new THREE.Shape();
  shape.moveTo(-0.014, 0); shape.lineTo(0.014, 0); shape.lineTo(0.012, 0.12); shape.quadraticCurveTo(0.004, 0.17, -0.014, 0.17); shape.lineTo(-0.014, 0);
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.006, bevelEnabled: true, bevelSize: 0.002, bevelThickness: 0.002, bevelSegments: 1 });
  bladeGeo.rotateX(Math.PI / 2);
  bladeGeo.translate(0, 0.003, 0.05);
  const blade = new THREE.Mesh(bladeGeo, M('blade', env)); blade.castShadow = true;
  g.add(blade);
  box(g, M('neon', env), 0.004, 0.004, 0.1, 0.0, 0.007, 0.11);        // edge glow
  return finish(g, { grip: [0, 0, -0.01], support: null, muzzle: [0, 0, 0.21] });
}

function finish (g, u) {
  const v = (a) => (a ? new THREE.Vector3(a[0], a[1], a[2]) : null);
  g.userData = { grip: v(u.grip), support: v(u.support), muzzle: v(u.muzzle), mag: v(u.mag), magMesh: u.magMesh || null, pump: u.pump || null };
  // dastak (grip) nuqtasi qurolning lokal markazi bo'lsin → aylantirish qo'l atrofida
  const off = g.userData.grip.clone();
  for (const ch of g.children) ch.position.sub(off);
  for (const k of ['grip', 'support', 'muzzle', 'mag']) if (g.userData[k]) g.userData[k].sub(off);
  g.userData.dispose = () => g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  return g;
}

const BUILD = { 'neon-rifle': rifle, 'pulse-pistol': pistol, 'scatter-shot': shotgun, 'energy-grenade': grenade, 'combat-knife': knife };
const WEAPON_SCALE = { 'neon-rifle': 1.45, 'scatter-shot': 1.4, 'pulse-pistol': 1.35, 'energy-grenade': 1.3, 'combat-knife': 1.3 };
export function createWeaponModel (id, { envMap = null } = {}) {
  const fn = BUILD[id];
  if (!fn) throw new Error('noma’lum qurol: ' + id);
  const g = fn(envMap);
  g.name = id;
  // o'yin masshtabi (Reference B: qurol tana bilan mutanosib ko'rinadi)
  const k = WEAPON_SCALE[id] || 1;
  g.scale.setScalar(k);
  return g;
}

/** HUD ikonkalari uchun ixcham SVG siluetlar (har qurol alohida) */
export const WEAPON_ICON = {
  'neon-rifle': '<svg viewBox="0 0 64 24"><path d="M2 9h8l2-3h22l2 2h14v3h8v3h-8v2h-9l-3 6h-5l1-6h-8l-2 5h-5l1-5H8l-4 3H2z"/></svg>',
  'pulse-pistol': '<svg viewBox="0 0 64 24"><path d="M14 5h34v7H32l-2 2h-5l-3 9h-7l2-9h-3z"/></svg>',
  'scatter-shot': '<svg viewBox="0 0 64 24"><path d="M2 10h10l3-3h44v4H40v3H22l-3 7h-6l1-6H6l-4 2z"/></svg>',
  'energy-grenade': '<svg viewBox="0 0 64 24"><circle cx="32" cy="14" r="8"/><path d="M29 3h6v4h-6zM35 4l6 5-2 1-5-3z"/></svg>',
  'combat-knife': '<svg viewBox="0 0 64 24"><path d="M6 10h18v4H6zM24 8h3v8h-3zM27 9h24l8 3-8 3H27z"/></svg>'
};
