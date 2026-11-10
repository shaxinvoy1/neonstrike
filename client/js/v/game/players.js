// O'yinchi avatari: V-773 + animator + qo'ldagi qurol + ism/jamoa belgisi.
// RemotePlayer: server snapshot'lari interpolatsiya buferi (100 ms), animatsiya
// holati serverdan (qurol, cho'kkalash, reload, o'q hisoblagichi, tirik/o'lik).
import * as THREE from '/vendor/three.module.js';
import { createV773, V773 } from '../character/model.js';
import { Animator } from '../character/animator.js';
import { createWeaponModel } from '../weapons/models.js';
import { SIM } from '/shared/protocol-consts.js';

export const TEAM_COLOR = { A: '#3d9bff', B: '#ff4466', null: '#cfe6ff' };
export const TEAM_NAME = { A: 'BLUE', B: 'RED' };

function labelSprite () {
  const c = document.createElement('canvas'); c.width = 256; c.height = 96;
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: true }));
  s.scale.set(1.1, 0.41, 1);
  s.userData = { c, t, key: '' };
  s.renderOrder = 10;
  return s;
}
function drawLabel (s, name, team) {
  const key = name + '|' + team;
  if (s.userData.key === key) return;
  s.userData.key = key;
  const { c, t } = s.userData;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const col = TEAM_COLOR[team] || TEAM_COLOR.null;
  g.font = '700 36px system-ui, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(5,8,25,.85)'; g.strokeText(name, 128, 32);
  g.fillStyle = col; g.fillText(name, 128, 32);
  g.fillStyle = col; g.beginPath(); g.moveTo(112, 64); g.lineTo(144, 64); g.lineTo(128, 86); g.closePath(); g.fill();
  t.needsUpdate = true;
}

export class Avatar {
  constructor (scene, { quality, envMap, team = null, name = '', showLabel = true }) {
    this.scene = scene;
    this.envMap = envMap;
    this.char = createV773({ quality, team, envMap, castShadow: quality !== 'low' });
    this.anim = new Animator(this.char);
    this.root = this.char.root;
    scene.add(this.root);
    this.team = team;
    this.name = name;
    this.weaponId = null;
    this.label = showLabel ? labelSprite() : null;
    if (this.label) { this.label.position.set(0, V773.MARKER_Y, 0); this.root.add(this.label); drawLabel(this.label, name, team); }
    // jamoa halqasi (oyoq ostida, nozik)
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 32), new THREE.MeshBasicMaterial({ color: TEAM_COLOR[team] || 0x88aaff, transparent: true, opacity: 0.55, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.015;
    this.root.add(this.ring);
  }
  setIdentity (name, team) {
    if (team !== this.team) { this.team = team; this.char.setTeam(team); this.ring.material.color.set(TEAM_COLOR[team] || 0x88aaff); }
    this.name = name;
    if (this.label) drawLabel(this.label, name, team);
  }
  setWeapon (id, animate = true) {
    if (id === this.weaponId) return;
    const first = this.weaponId === null;
    this.weaponId = id;
    this.anim.setWeapon(id ? createWeaponModel(id, { envMap: this.envMap }) : null, id);
    if (animate && !first) this.anim.trigger('switch');
  }
  dispose () {
    this.anim.setWeapon(null, null);
    this.scene.remove(this.root);
    this.char.dispose();
    if (this.label) { this.label.material.map.dispose(); this.label.material.dispose(); }
    this.ring.geometry.dispose(); this.ring.material.dispose();
  }
}

/** Snapshot'dan boshqariladigan masofaviy o'yinchi */
export class RemotePlayer {
  constructor (scene, opts, id) {
    this.id = id;
    this.av = new Avatar(scene, opts);
    this.buf = [];       // [{t, x,y,z,yaw,pitch, ...}]
    this.last = null;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.alive = true; this.crouch = false;
    this.shots = null; this.reloading = false; this.weapon = null;
    this.events = [];    // tashqi (o'yin) iste'mol qiladi: {type:'fire'|'die'|'respawn', ...}
  }
  push (t, s) {
    this.buf.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, airborne: s.airborne, crouch: s.crouch });
    if (this.buf.length > 30) this.buf.shift();
    this.av.setIdentity(s.name || this.id, s.teamId);
    if (this.weapon !== s.weapon) { this.av.setWeapon(s.weapon); this.weapon = s.weapon; }
    if (this.shots !== null && s.shots > this.shots && s.alive) {
      const n = Math.min(3, s.shots - this.shots);
      for (let i = 0; i < n; i++) this.events.push({ type: 'fire', weapon: s.weapon });
    }
    this.shots = s.shots;
    if (s.reloading && !this.reloading) { this.av.anim.trigger('reload', { ms: 2000 }); this.events.push({ type: 'reload' }); }
    this.reloading = s.reloading;
    if (this.alive && !s.alive) { this.av.anim.trigger('die'); this.events.push({ type: 'die' }); }
    if (!this.alive && s.alive) { this.av.anim.trigger('respawn'); this.events.push({ type: 'respawn' }); this.buf.length = 0; this.buf.push({ t, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch }); }
    this.alive = s.alive;
    this.crouch = s.crouch;
    this.sprint = !!s.sprint;
    this.kills = s.kills; this.deaths = s.deaths; this.hp = s.hp; this.team = s.teamId; this.name = s.name;
  }
  update (dt, renderT) {
    const b = this.buf;
    if (!b.length) return;
    const t = renderT - SIM.INTERP_DELAY_MS;
    let a = b[0], c = b[b.length - 1];
    for (let i = 0; i < b.length - 1; i++) if (b[i].t <= t && b[i + 1].t >= t) { a = b[i]; c = b[i + 1]; break; }
    const span = c.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1.2, (t - a.t) / span)) : 1;
    const nx = a.x + (c.x - a.x) * k, ny = a.y + (c.y - a.y) * k, nz = a.z + (c.z - a.z) * k;
    if (dt > 0) {
      const vx = (nx - this.pos.x) / dt, vz = (nz - this.pos.z) / dt;
      const sm = 1 - Math.exp(-12 * dt);
      if (Math.hypot(nx - this.pos.x, nz - this.pos.z) < 3) { this.vel.x += (vx - this.vel.x) * sm; this.vel.z += (vz - this.vel.z) * sm; this.vel.y = (ny - this.pos.y) / dt; }
    }
    this.pos.set(nx, ny, nz);
    const dy = Math.atan2(Math.sin(c.yaw - a.yaw), Math.cos(c.yaw - a.yaw));
    this.yaw = a.yaw + dy * Math.min(1, k);
    this.pitch = a.pitch + (c.pitch - a.pitch) * Math.min(1, k);
    driveAvatar(this.av, dt, this.pos, this.vel, this.yaw, this.pitch, { airborne: !!c.airborne, crouch: this.crouch, sprint: this.sprint, aiming: false });
  }
  dispose () { this.av.dispose(); }
}

/** Animator kirishlarini harakat holatidan to'ldirish (lokal ham, masofaviy ham) */
export function driveAvatar (av, dt, pos, vel, yaw, pitch, st) {
  const root = av.root;
  root.position.copy(pos);
  // tana kamera/nishon yo'nalishiga qaraydi (otishma o'yini: oyoqlar harakatga moslashadi)
  const cur = root.rotation.y;
  const d = Math.atan2(Math.sin(yaw - cur), Math.cos(yaw - cur));
  root.rotation.y = cur + d * (1 - Math.exp(-18 * dt));
  const I = av.anim.in;
  const sp = Math.hypot(vel.x, vel.z);
  I.speed = st.airborne ? 0 : sp;
  if (sp > 0.05) {
    const fy = root.rotation.y;
    const fx = Math.sin(fy), fz = Math.cos(fy);
    const rx = -Math.cos(fy), rz = Math.sin(fy);
    I.fwd = (vel.x * fx + vel.z * fz) / sp;
    I.right = (vel.x * rx + vel.z * rz) / sp;
  }
  const wasAir = I.airborne;
  I.airborne = !!st.airborne;
  I.vy = vel.y || 0;
  if (wasAir && !I.airborne) av.anim.trigger('land', { impact: Math.min(10, Math.abs(av._lastVy || 6)) });
  av._lastVy = vel.y;
  I.crouch = !!st.crouch;
  I.sprint = !!st.sprint;
  I.pitch = pitch;
  I.aiming = !!st.aiming;
  av.anim.update(dt);
}
