// ============================================================
// NEON STRIKE — PHASE 4: pooled combat effektlari
// BARCHA effektlar oldindan yaratilgan (pool) → kadrda geometry/
// material/obyekt yaratish YO'Q, faqat visibility + TTL.
// Neon til: to'q ko'k fon, cyan/violet/qizil, additive glow.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { PALETTE } from '/shared/map.js';

const POOL = {
  FLASH: 4,       // muzzle flash (qurol uchidagi yorqin sprite)
  TRACER: 16,     // o'q izi (muzzle → hit)
  SPARK: 32,      // hit spark (nishon/devorda)
  BLAST: 2,       // granata portlashi
  PUFF: 6         // nishon o'lim so'nish "puff" i
};
const TTL = { FLASH: 55, TRACER: 80, SPARK: 220, BLAST: 320, PUFF: 600 };

function flashMaterial (color) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
}

function makeFlash () {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), flashMaterial(PALETTE.TRIM));
  m.visible = false;
  return { mesh: m, t: 0, ttl: TTL.FLASH };
}

function makeTracer () {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 1), flashMaterial(PALETTE.CORE_GLOW));
  m.visible = false;
  return { mesh: m, t: 0, ttl: TTL.TRACER };
}

function makeSpark () {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.09), flashMaterial(PALETTE.TARGET));
  m.visible = false;
  return { mesh: m, t: 0, ttl: TTL.SPARK, vx: 0, vy: 0, vz: 0 };
}

function makeBlast () {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), flashMaterial(PALETTE.TARGET_ACCENT));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.07, 6, 22), flashMaterial(PALETTE.TRIM));
  ring.rotation.x = Math.PI / 2;
  g.add(shell, ring);
  g.visible = false;
  return { mesh: g, t: 0, ttl: TTL.BLAST };
}

/** Nishon o'limi: yuqoriga ko'tarilib so'nuvchi "puff" (kichik shar + halqa) */
function makePuff () {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), flashMaterial(PALETTE.TARGET));
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 6, 18), flashMaterial(PALETTE.TARGET_ACCENT));
  halo.rotation.x = Math.PI / 2;
  g.add(shell, halo);
  g.visible = false;
  return { mesh: g, t: 0, ttl: TTL.PUFF, rise: 0 };
}

export class Effects {
  constructor (scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'combat-effects';
    scene.add(this.group);
    this.flashes = [];
    this.tracers = [];
    this.sparks = [];
    this.blasts = [];
    this.puffs = [];
    for (let i = 0; i < POOL.FLASH; i++) this.flashes.push(makeFlash());
    for (let i = 0; i < POOL.TRACER; i++) this.tracers.push(makeTracer());
    for (let i = 0; i < POOL.SPARK; i++) this.sparks.push(makeSpark());
    for (let i = 0; i < POOL.BLAST; i++) this.blasts.push(makeBlast());
    for (let i = 0; i < POOL.PUFF; i++) this.puffs.push(makePuff());
    this.pools = [this.flashes, this.tracers, this.sparks, this.blasts, this.puffs];
    for (const pool of this.pools) {
      for (const e of pool) this.group.add(e.mesh);
    }
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  _spawn (pool) {
    for (const e of pool) if (!e.mesh.visible) return e;
    return null;                                     // pool to'lgan — effekt tashlab ketiladi
  }

  /** Qurol uchidagi flash (camQuat — kameraga qaragan sprite uchun) */
  muzzleFlash (x, y, z, camQuat) {
    const e = this._spawn(this.flashes);
    if (!e) return false;
    e.mesh.position.set(x, y, z);
    if (camQuat) e.mesh.quaternion.copy(camQuat);
    e.mesh.scale.setScalar(0.7 + Math.random() * 0.5);
    e.t = 0;
    e.mesh.visible = true;
    return true;
  }

  /** O'q izi: from → to (jahon koordinatalari) */
  tracer (from, to) {
    const e = this._spawn(this.tracers);
    if (!e) return false;
    this._a.set(from[0], from[1], from[2]);
    this._b.set(to[0], to[1], to[2]);
    e.mesh.position.copy(this._a).add(this._b).multiplyScalar(0.5);
    e.mesh.lookAt(this._b);
    e.mesh.scale.z = Math.max(0.1, this._a.distanceTo(this._b));
    e.t = 0;
    e.mesh.visible = true;
    return true;
  }

  /** Hit spark (nishon yoki devor). `color` — hex raqam (har spark o'z materialiga ega) */
  spark (x, y, z, color) {
    const e = this._spawn(this.sparks);
    if (!e) return false;
    e.mesh.position.set(x, y, z);
    if (color !== undefined) e.mesh.material.color.setHex(color);
    e.vx = (Math.random() - 0.5) * 3;
    e.vy = Math.random() * 2.5;
    e.vz = (Math.random() - 0.5) * 3;
    e.t = 0;
    e.mesh.visible = true;
    return true;
  }

  /** Granata portlashi */
  blast (x, y, z, radius = 1) {
    const e = this._spawn(this.blasts);
    if (!e) return false;
    e.mesh.position.set(x, y, z);
    e.mesh.scale.setScalar(radius * 0.35);
    e.t = 0;
    e.mesh.visible = true;
    return true;
  }

  /** Nishon o'limi "puff" i (ko'krak balandligida) */
  deathPuff (x, y, z) {
    const e = this._spawn(this.puffs);
    if (!e) return false;
    e.mesh.position.set(x, y, z);
    e.mesh.scale.setScalar(1);
    e.rise = 0;
    e.t = 0;
    e.mesh.visible = true;
    return true;
  }

  /** Har kadr: TTL kamaytirish, o'lganini yashirish (allokatsiya yo'q) */
  update (dtMs) {
    const dt = dtMs / 1000;
    for (const pool of this.pools) {
      for (const e of pool) {
        if (!e.mesh.visible) continue;
        e.t += dtMs;
        const k = 1 - e.t / e.ttl;
        if (k <= 0) { e.mesh.visible = false; continue; }
        if (e.vy !== undefined) {                    // spark: tushish + sochilish
          e.vy -= 9.8 * dt;
          e.mesh.position.x += e.vx * dt;
          e.mesh.position.y += e.vy * dt;
          e.mesh.position.z += e.vz * dt;
        }
        if (e.rise !== undefined && pool === this.puffs) {   // puff: yuqoriga ko'tarilish
          e.rise += 1.1 * dt;
          e.mesh.position.y += 1.1 * dt;
          e.mesh.rotation.y += 3.2 * dt;
          e.mesh.scale.setScalar(0.7 + e.rise * 1.4);
        } else if (e.mesh.isGroup) {                 // blast: kengayish
          e.mesh.scale.multiplyScalar(1 + 2.2 * dt);
        }
        this._setOpacity(e.mesh, 0.95 * k);
      }
    }
  }

  /** Guruh ichidagi barcha materiallarga opacity (pooled — material almashmaydi) */
  _setOpacity (obj, v) {
    if (obj.material && obj.material.opacity !== undefined) obj.material.opacity = v;
    if (obj.children) for (const c of obj.children) this._setOpacity(c, v);
  }

  /** Barcha effektlarni o'chirish (session reset) */
  clear () {
    for (const pool of this.pools) {
      for (const e of pool) e.mesh.visible = false;
    }
  }

  get activeCount () {
    let n = 0;
    for (const pool of this.pools) {
      for (const e of pool) if (e.mesh.visible) n += 1;
    }
    return n;
  }
}
