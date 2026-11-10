// Model V-773 tekshiruv sahnasi: 4 yo'nalish (old, chap, orqa, o'ng) +
// animatsiya holatlarini qo'lda tanlash (?state=walk&turn=1 URL parametrlari ham).
import * as THREE from '/vendor/three.module.js';
import { createV773 } from './character/model.js';
import { createNeonEnvironment } from './world/env.js';
import { Animator, ANIM_STATES } from './character/animator.js';
import { createWeaponModel, WEAPON_IDS } from './weapons/models.js';

const qs = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a1024);
const env = createNeonEnvironment(renderer);
scene.environment = env.texture;

const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
const single = qs.get('single') === '1';
camera.position.set(0, 1.25, single ? 4.6 : 9.2);
camera.lookAt(0, 0.95, 0);

scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x1a1640, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(2.5, 5, 6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 4; key.shadow.camera.bottom = -2;
scene.add(key);
const rimB = new THREE.PointLight(0x2f8cff, 18, 12); rimB.position.set(-4, 2.5, -2); scene.add(rimB);
const rimV = new THREE.PointLight(0xb05cff, 14, 12); rimV.position.set(4, 2.2, -2.5); scene.add(rimV);

// pol + neon chiziqlar + shaffof poydevorlar
const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 16), new THREE.MeshStandardMaterial({ color: 0x0f1736, roughness: 0.5, metalness: 0.4 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
for (const [z, c] of [[-1.6, 0x2fd0ff], [-2.4, 0xb05cff]]) {
  const s = new THREE.Mesh(new THREE.PlaneGeometry(30, 0.06), new THREE.MeshBasicMaterial({ color: c }));
  s.rotation.x = -Math.PI / 2; s.position.set(0, 0.003, z); scene.add(s);
}
const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshStandardMaterial({ color: 0x121a3c, roughness: 0.7 }));
wall.position.set(0, 5, -4); scene.add(wall);

const quality = qs.get('q') || 'high';
const xs = single ? [0] : [-3.3, -1.1, 1.1, 3.3];
const yaws = single ? [Number(qs.get('yaw') || 0)] : [0, -Math.PI / 2, Math.PI, Math.PI / 2];
const chars = [];
xs.forEach((x, i) => {
  const ped = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.7), new THREE.MeshPhysicalMaterial({ color: 0xbfe8ff, roughness: 0.05, transmission: 0.85, thickness: 0.1, transparent: true, opacity: 0.55 }));
  ped.position.set(x, 0.04, 0); ped.receiveShadow = true; scene.add(ped);
  const c = createV773({ quality, team: qs.get('team') || null, envMap: env.texture });
  c.root.position.set(x, 0.08, 0);
  c.root.rotation.y = yaws[i];
  scene.add(c.root);
  const anim = new Animator(c);
  chars.push({ c, anim });
});
if (qs.get('labels') === '0' || single) document.getElementById('labels').style.display = 'none';

let state = qs.get('state') || 'idle';
let weapon = qs.get('weapon') || 'none';
function setWeapon (id) {
  weapon = id;
  for (const { anim } of chars) anim.setWeapon(id === 'none' ? null : createWeaponModel(id, { envMap: env.texture }), id === 'none' ? null : id);
}
setWeapon(weapon);

const bar = document.getElementById('bar');
const mk = (label, on, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; if (on) b.classList.add('on'); bar.appendChild(b); return b; };
for (const s of ANIM_STATES) mk(s, s === state, () => { state = s; [...bar.children].forEach((x) => x.classList.toggle('on', x.textContent === s || x.dataset.w === weapon)); });
for (const w of ['none', ...WEAPON_IDS]) { const b = mk('🔫 ' + w, w === weapon, () => setWeapon(w)); b.dataset.w = w; }

function resize () {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
const fixedT = qs.has('t') ? Number(qs.get('t')) : null;
function frame (now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const { anim } of chars) {
    anim.driveDemo(state, fixedT === null ? dt : 0, fixedT);
    anim.update(fixedT === null ? dt : 1 / 60);
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
window.__viewer = { chars, setState: (s) => { state = s; }, setWeapon, renderer, ik: () => chars.map(({ anim }) => [anim.ikErrR || 0, anim.ikErrL || 0, anim.state]) };
