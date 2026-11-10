// Vizual effektlar: tumshuq chaqnashi, tracer, zarba uchqunlari, portlash,
// havodagi granatalar. Hammasi oldindan ajratilgan pul'lardan (GC yo'q).
import * as THREE from '/vendor/three.module.js';
import { createWeaponModel } from '../weapons/models.js';

function glowTex () {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor (scene, opts = {}) {
    const { quality = 'high', envMap = null } = opts;
    this.scene = scene;
    this.baseK = quality === 'low' ? 0.5 : quality === 'medium' ? 0.8 : 1;
    this.k = this.baseK * (opts.effects ?? 1);
    this.tex = glowTex();
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0x9fe6ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      m.visible = false; scene.add(m); this.flashes.push({ m, t: 0 });
    }
    this.light = new THREE.PointLight(0x6fd0ff, 0, 7, 2); scene.add(this.light);
    this.lightT = 0;
    // tracerlar
    this.tracers = [];
    for (let i = 0; i < 24; i++) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x8fe8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      l.visible = false; l.frustumCulled = false; scene.add(l); this.tracers.push({ l, t: 0 });
    }
    // uchqunlar (Points)
    this.N = Math.round(400 * this.k);
    this.pPos = new Float32Array(this.N * 3); this.pVel = new Float32Array(this.N * 3); this.pLife = new Float32Array(this.N); this.pCol = new Float32Array(this.N * 3);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.points = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.09, map: this.tex, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.points.frustumCulled = false; scene.add(this.points);
    this.pi = 0;
    // portlashlar
    this.blasts = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffb36b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.visible = false; scene.add(s);
      const L = new THREE.PointLight(0xff9a4a, 0, 14, 2); scene.add(L);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring);
      this.blasts.push({ s, L, ring, t: 9 });
    }
    // havodagi granatalar (id → mesh)
    this.grenades = new Map();
    this.envMap = envMap;
  }

  muzzle (pos, scale = 1, color = 0x9fe6ff) {
    const f = this.flashes.find((x) => x.t <= 0) || this.flashes[0];
    f.m.position.copy(pos); f.m.material.color.set(color);
    const s = (0.32 + Math.random() * 0.12) * scale; f.m.scale.set(s, s, 1); f.m.material.rotation = Math.random() * 6;
    f.m.visible = true; f.t = 0.05;
    this.light.position.copy(pos); this.light.intensity = 6 * scale; this.light.color.set(color); this.lightT = 0.05;
  }
  tracer (from, to, color = 0x8fe8ff) {
    const tr = this.tracers.find((x) => x.t <= 0) || this.tracers[0];
    const a = tr.l.geometry.attributes.position.array;
    a[0] = from.x; a[1] = from.y; a[2] = from.z; a[3] = to.x; a[4] = to.y; a[5] = to.z;
    tr.l.geometry.attributes.position.needsUpdate = true;
    tr.l.material.color.set(color); tr.l.material.opacity = 1;
    tr.l.visible = true; tr.t = 0.07;
  }
  sparks (pos, n = 10, color = [0.6, 0.9, 1], speed = 4, life = 0.35) {
    n = Math.max(1, Math.round(n * this.k));
    for (let i = 0; i < n; i++) {
      const j = this.pi = (this.pi + 1) % this.N;
      this.pPos[j * 3] = pos.x; this.pPos[j * 3 + 1] = pos.y; this.pPos[j * 3 + 2] = pos.z;
      const u = Math.random() * 6.283, v = Math.random() * 2 - 1, s = speed * (0.3 + Math.random());
      this.pVel[j * 3] = Math.cos(u) * Math.sqrt(1 - v * v) * s; this.pVel[j * 3 + 1] = Math.abs(v) * s + 1; this.pVel[j * 3 + 2] = Math.sin(u) * Math.sqrt(1 - v * v) * s;
      this.pLife[j] = life * (0.6 + Math.random() * 0.6);
      this.pCol[j * 3] = color[0]; this.pCol[j * 3 + 1] = color[1]; this.pCol[j * 3 + 2] = color[2];
    }
  }
  impact (pos, flesh = false) { this.sparks(pos, flesh ? 8 : 12, flesh ? [1, 0.35, 0.45] : [0.6, 0.9, 1], flesh ? 2.5 : 4); }
  explosion (pos) {
    const b = this.blasts.find((x) => x.t > 1) || this.blasts[0];
    b.s.position.copy(pos); b.L.position.copy(pos).y += 0.5; b.ring.position.set(pos.x, pos.y + 0.05, pos.z);
    b.t = 0; b.s.visible = b.ring.visible = true;
    this.sparks(pos, 70, [1, 0.7, 0.35], 9, 0.8);
    this.sparks(pos, 30, [0.5, 0.85, 1], 6, 0.6);
  }
  /** Server snapshot'idagi granatalar ro'yxati → mesh; yo'qolganlari portlaydi */
  syncGrenades (list, onExplode) {
    const seen = new Set();
    for (const g of list || []) {
      seen.add(g.id);
      let e = this.grenades.get(g.id);
      if (!e) { const m = createWeaponModel('energy-grenade', { envMap: this.envMap }); m.scale.setScalar(1.5); this.scene.add(m); e = { m, prev: new THREE.Vector3(g.x, g.y, g.z), cur: new THREE.Vector3(g.x, g.y, g.z), t: 0 }; this.grenades.set(g.id, e); }
      e.prev.copy(e.m.position.lengthSq() ? e.m.position : e.cur); e.cur.set(g.x, g.y, g.z); e.t = 0;
    }
    for (const [id, e] of this.grenades) {
      if (seen.has(id)) continue;
      this.scene.remove(e.m); e.m.userData.dispose();
      this.grenades.delete(id);
      onExplode && onExplode(e.cur.clone());
    }
  }

  update (dt) {
    for (const f of this.flashes) if (f.t > 0) { f.t -= dt; if (f.t <= 0) f.m.visible = false; }
    if (this.lightT > 0) { this.lightT -= dt; if (this.lightT <= 0) this.light.intensity = 0; }
    for (const tr of this.tracers) if (tr.t > 0) { tr.t -= dt; tr.l.material.opacity = Math.max(0, tr.t / 0.07); if (tr.t <= 0) tr.l.visible = false; }
    let any = false;
    for (let j = 0; j < this.N; j++) {
      if (this.pLife[j] <= 0) continue;
      any = true;
      this.pLife[j] -= dt;
      if (this.pLife[j] <= 0) { this.pPos[j * 3 + 1] = -100; continue; }
      this.pVel[j * 3 + 1] -= 14 * dt;
      this.pPos[j * 3] += this.pVel[j * 3] * dt; this.pPos[j * 3 + 1] += this.pVel[j * 3 + 1] * dt; this.pPos[j * 3 + 2] += this.pVel[j * 3 + 2] * dt;
      if (this.pPos[j * 3 + 1] < 0.02) { this.pPos[j * 3 + 1] = 0.02; this.pVel[j * 3 + 1] *= -0.3; }
    }
    if (any) this.points.geometry.attributes.position.needsUpdate = true;
    for (const b of this.blasts) {
      if (b.t > 1) continue;
      b.t += dt;
      const u = Math.min(1, b.t / 0.6);
      b.s.scale.setScalar(0.3 + 3.6 * Math.sqrt(u)); b.s.material.opacity = (1 - u) * 0.85;
      b.ring.scale.setScalar(0.5 + 4.5 * u); b.ring.material.opacity = (1 - u) * 0.9;
      b.L.intensity = 40 * (1 - u);
      if (b.t >= 0.6) { b.s.visible = b.ring.visible = false; b.L.intensity = 0; b.t = 9; }
    }
    // granatalar: snapshotlar orasida silliq (50 ms)
    for (const e of this.grenades.values()) {
      e.t = Math.min(1, e.t + dt / 0.05);
      e.m.position.lerpVectors(e.prev, e.cur, e.t);
      e.m.rotation.x += dt * 9; e.m.rotation.z += dt * 5;
    }
  }
  dispose () {
    this.scene.traverse(() => {});
    for (const f of this.flashes) { this.scene.remove(f.m); f.m.material.dispose(); }
    for (const t of this.tracers) { this.scene.remove(t.l); t.l.geometry.dispose(); t.l.material.dispose(); }
    for (const b of this.blasts) { for (const o of [b.s, b.ring]) { this.scene.remove(o); o.geometry.dispose(); o.material.dispose(); } this.scene.remove(b.L); }
    this.scene.remove(this.points, this.light); this.points.geometry.dispose(); this.points.material.dispose(); this.tex.dispose();
    for (const e of this.grenades.values()) { this.scene.remove(e.m); e.m.userData.dispose(); }
  }
}
