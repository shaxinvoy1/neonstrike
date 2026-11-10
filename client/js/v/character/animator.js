// ============================================================
// V-773 ANIMATSIYA TIZIMI
// Qatlamlar:
//  1) LOKOMOTSIYA — oyoq traektoriyasi masofa/tezlikdan (stance oyog'i yerda
//     aynan tana tezligida orqaga suriladi → sirpanish yo'q), oyoq IK, son
//     tebranishi, diagonal uchun pastki tana burilishi, cho'kkalash, havo/qo'nish.
//     Turgan joyda burilish: oyoqlar dunyoda "qadalgan", burchak/masofa oshsa qadam.
//  2) YUQORI TANA — qurol "anchor"i (yelka pivoti, aim pitch), ikki qo'l IK
//     qurol tutqichlariga (qo'l–qurol uzilishi bo'lmaydi). Recoil, reload,
//     almashtirish, granata otish, pichoq zarbasi — vaqt bo'yicha egri chiziqlar.
//  3) TO'LIQ TANA — zarba reaksiyasi, o'lim, respawn, g'alaba.
// Barcha o'tishlar eksponensial silliqlash bilan (pose snapping yo'q).
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { solveTwoBone, setWorldQuaternion } from './ik.js';

export const ANIM_STATES = Object.freeze([
  'idle', 'walk', 'walk-back', 'run', 'sprint', 'strafe-left', 'strafe-right', 'diagonal',
  'turn', 'crouch', 'crouch-walk', 'jump', 'fall', 'land', 'aim', 'shoot', 'reload',
  'switch', 'grenade', 'knife', 'hit', 'death', 'respawn', 'victory'
]);

const TAU = Math.PI * 2;
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const HIP_H = 0.47;        // bind: son bo'g'ini balandligi
const ANKLE_H = 0.075;     // bind: to'piq balandligi

/** Qurol tutish nuqtalari (root-local, yaw=0, pitch=0) — qisqa qo'llarga mos */
const HOLD = {
  rifle: { anchor: [-0.1, 0.86, 0.15], sprint: [-0.12, 0.74, 0.1], blade: -0.62 },
  pistol: { anchor: [-0.03, 0.88, 0.25], sprint: [-0.1, 0.72, 0.14], blade: -0.12 },
  grenade: { anchor: [-0.16, 0.8, 0.16], sprint: [-0.16, 0.74, 0.1] },
  knife: { anchor: [-0.15, 0.78, 0.2], sprint: [-0.16, 0.72, 0.12] }
};
const KIND = { 'neon-rifle': 'rifle', 'scatter-shot': 'rifle', 'pulse-pistol': 'pistol', 'energy-grenade': 'grenade', 'combat-knife': 'knife' };
const SHOULDER_PIVOT = new THREE.Vector3(-0.06, 0.92, 0.02);

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _p = new THREE.Vector3(), _t = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

export class Animator {
  constructor (char) {
    this.c = char;
    this.b = char.bones;
    this.root = char.root;
    // kirishlar (o'yin har kadr o'rnatadi)
    this.in = { speed: 0, fwd: 0, right: 0, airborne: false, vy: 0, crouch: false, sprint: false, pitch: 0, aiming: false, grounded: true };
    // ichki holat
    this.phase = 0;
    this.moveW = 0;        // 0 turish … 1 harakat
    this.crouchW = 0;
    this.airW = 0;
    this.sprintW = 0;
    this.aimW = 0;
    this.land = 0;          // qo'nish siqilishi (prujina)
    this.landV = 0;
    this.twist = 0;         // pastki tana burilishi (diagonal)
    this.lean = 0;
    this.dirF = 1; this.dirR = 0;
    this.kick = 0;          // recoil
    this.kickV = 0;
    this.actions = {};      // nom → {t, dur}
    this.hit = 0; this.hitDir = 0;
    this.dead = 0;          // 0..1 (o'lim progressi)
    this.isDead = false;
    this.respawnT = 0;
    this.victoryT = -1;
    this.idleT = 0;
    this.idleVar = 0;       // 0 yo'q, 1 atrofga qarash, 2 yelka qisish
    this.idleVarT = 0;
    this.nextIdleVar = 5 + Math.random() * 4;
    this.headYaw = 0;
    this.planted = [new THREE.Vector3(), new THREE.Vector3()];   // dunyo (turganda)
    this.plantInit = false;
    this.stepping = [null, null];
    this.weapon = null;
    this.weaponId = null;
    this.kind = null;
    this.weaponRoot = new THREE.Group();
    this.root.add(this.weaponRoot);
    this.state = 'idle';
    this._lastYaw = null;
    this.turnRate = 0;
    this.time = 0;
    this.footY = [0, 0];
  }

  setWeapon (model, id) {
    if (this.weapon) { this.weaponRoot.remove(this.weapon); if (this.weapon.userData.dispose) this.weapon.userData.dispose(); }
    this.weapon = model || null;
    this.weaponId = id || null;
    this.kind = id ? KIND[id] || 'rifle' : null;
    if (model) this.weaponRoot.add(model);
  }

  /** Bir martalik harakatlar: fire, reload(ms), switch, throw, knife, hit(dir), die, respawn, victory, jump, land */
  trigger (name, opt = {}) {
    if (name === 'fire') { this.kickV += opt.kick || (this.kind === 'pistol' ? 9 : this.kind === 'rifle' ? 5 : 0); return; }
    if (name === 'hit') { this.hit = 1; this.hitDir = opt.dir || 0; return; }
    if (name === 'die') { if (!this.isDead) { this.isDead = true; this.dead = 0; this.deathDir = opt.dir || 0; } return; }
    if (name === 'respawn') { this.isDead = false; this.dead = 0; this.respawnT = 1; this.actions = {}; this.plantInit = false; return; }
    if (name === 'victory') { this.victoryT = 0; return; }
    if (name === 'land') { this.landV -= clamp(opt.impact || 4, 1, 10) * 0.12; return; }
    const dur = opt.ms ? opt.ms / 1000 : { reload: 2.0, switch: 0.45, throw: 0.7, knife: 0.42, jump: 0.25 }[name] || 0.4;
    this.actions[name] = { t: 0, dur };
  }

  /** Sinov sahnasi uchun: holat nomidan kirishlar va davriy harakatlar */
  driveDemo (state, dt, fixedT = null) {
    const I = this.in;
    I.speed = 0; I.fwd = 0; I.right = 0; I.airborne = false; I.crouch = false; I.sprint = false; I.pitch = 0; I.aiming = false;
    this.demoT = (this.demoT || 0) + dt;
    const t = fixedT !== null ? fixedT : this.demoT;
    const mv = (s, f, r) => { I.speed = s; const l = Math.hypot(f, r) || 1; I.fwd = f / l; I.right = r / l; };
    switch (state) {
      case 'walk': mv(2.4, 1, 0); break;
      case 'walk-back': mv(2.4, -1, 0); break;
      case 'run': mv(5.2, 1, 0); break;
      case 'sprint': mv(8, 1, 0); I.sprint = true; break;
      case 'strafe-left': mv(4, 0, -1); break;
      case 'strafe-right': mv(4, 0, 1); break;
      case 'diagonal': mv(5.2, 1, 1); break;
      case 'crouch': I.crouch = true; break;
      case 'crouch-walk': I.crouch = true; mv(2.6, 1, 0); break;
      case 'jump': case 'fall': I.airborne = true; I.vy = state === 'jump' ? 4 : -5; break;
      case 'land': if ((t % 1.2) < dt + 1e-9 || this._demoLand !== Math.floor(t / 1.2)) { this._demoLand = Math.floor(t / 1.2); this.trigger('land', { impact: 7 }); } break;
      case 'aim': I.aiming = true; I.pitch = 0.25 * Math.sin(t * 1.3); break;
      case 'shoot': I.aiming = true; if (Math.floor(t * 8) !== this._demoShot) { this._demoShot = Math.floor(t * 8); this.trigger('fire'); } break;
      case 'turn': this.root.rotation.y += dt * 1.6; break;
      case 'hit': if (Math.floor(t / 0.9) !== this._demoHit) { this._demoHit = Math.floor(t / 0.9); this.trigger('hit', { dir: 0 }); } break;
      case 'death': if (!this.isDead) this.trigger('die'); break;
      case 'respawn': if (Math.floor(t / 2.2) !== this._demoResp) { this._demoResp = Math.floor(t / 2.2); this.trigger('respawn'); } break;
      case 'victory': if (this.victoryT < 0) this.trigger('victory'); break;
      default: break;
    }
    if (state !== 'death' && state !== 'respawn' && this.isDead) this.trigger('respawn');
    if (state !== 'victory') this.victoryT = -1;
    for (const [s, a, every] of [['reload', 'reload', 2.6], ['switch', 'switch', 1.2], ['grenade', 'throw', 1.4], ['knife', 'knife', 0.9]]) {
      if (state === s && Math.floor(t / every) !== this['_demo' + s]) { this['_demo' + s] = Math.floor(t / every); this.trigger(a); }
    }
  }

  // ---------------------------------------------------------
  update (dt) {
    const I = this.in, b = this.b;
    this.time += dt;
    // -------- holat og'irliklari (silliq) --------
    const moving = I.speed > 0.25 && !I.airborne;
    this.moveW += ((moving ? 1 : 0) - this.moveW) * damp(9, dt);
    this.crouchW += ((I.crouch ? 1 : 0) - this.crouchW) * damp(10, dt);
    this.airW += ((I.airborne ? 1 : 0) - this.airW) * damp(I.airborne ? 12 : 18, dt);
    this.sprintW += ((I.sprint && moving ? 1 : 0) - this.sprintW) * damp(6, dt);
    this.aimW += ((I.aiming ? 1 : 0) - this.aimW) * damp(12, dt);
    if (I.speed > 0.25) {
      // yo'nalish silliq (keskin o'zgarish → yumshoq o'tish)
      this.dirF += (I.fwd - this.dirF) * damp(10, dt);
      this.dirR += (I.right - this.dirR) * damp(10, dt);
    }
    // qo'nish prujinasi
    this.landV += (-this.land * 160 - this.landV * 18) * dt;
    this.land = clamp(this.land + this.landV * dt, -0.2, 0.05);
    // recoil prujinasi
    this.kickV += (-this.kick * 260 - this.kickV * 26) * dt;
    this.kick += this.kickV * dt;
    // harakatlar vaqti
    for (const k in this.actions) { const a = this.actions[k]; a.t += dt; if (a.t >= a.dur) delete this.actions[k]; }
    this.hit = Math.max(0, this.hit - dt * 3.2);
    this.respawnT = Math.max(0, this.respawnT - dt * 1.4);
    if (this.isDead) this.dead = Math.min(1, this.dead + dt * 1.8);
    if (this.victoryT >= 0) this.victoryT += dt;
    // aylanish tezligi (turgan joyda burilish uchun)
    const yaw = this.root.rotation.y;
    if (this._lastYaw !== null && dt > 0) {
      const d = Math.atan2(Math.sin(yaw - this._lastYaw), Math.cos(yaw - this._lastYaw));
      this.turnRate += (d / dt - this.turnRate) * damp(10, dt);
    }
    this._lastYaw = yaw;

    // -------- lokomotsiya fazasi (masofaga bog'liq) --------
    const sp = I.speed;
    const cad = 2.0 + 0.36 * sp;                         // sikl/soniya
    const stance = clamp(0.62 - 0.035 * sp, 0.33, 0.6);   // tayanch ulushi
    const stride = sp > 0.05 ? sp * stance / cad : 0;     // tayanch oyog'i yerda bosib o'tadigan masofa
    if (moving) this.phase = (this.phase + cad * dt) % 1;

    // -------- 1) dam holat --------
    for (const name in b) { const r = this.c.rest[name]; b[name].position.copy(r.pos); b[name].quaternion.copy(r.quat); }

    const mw = this.moveW, cw = this.crouchW, aw = this.airW;
    // diagonal: pastki tana harakat yo'nalishi tomon buriladi, yuqori tana — qaytaradi
    const f = this.dirF, r = this.dirR;
    let twistT = 0;
    if (mw > 0.01) twistT = f >= -0.2 ? Math.atan2(-r, Math.max(0.2, f)) * 0.5 : Math.atan2(r, Math.max(0.2, -f)) * 0.5;
    twistT = clamp(twistT, -0.6, 0.6) * mw;
    this.twist += (twistT - this.twist) * damp(8, dt);

    // tana egilishi (tezlanish/sprint)
    const leanT = 0.06 * mw * clamp(f, -1, 1) + 0.18 * this.sprintW + 0.22 * cw;
    this.lean += (leanT - this.lean) * damp(7, dt);

    // son balandligi: bob + cho'kkalash + qo'nish
    const p = this.phase * TAU;
    const bob = mw * (0.022 + 0.006 * sp) * (0.5 - 0.5 * Math.cos(2 * p)) * (1 - aw);
    const breathe = (1 - mw) * 0.004 * Math.sin(this.time * 2.1);
    let hipsDrop = 0.2 * cw + bob + this.land * -1 + 0.03 * this.sprintW;
    b.hips.position.y -= hipsDrop - breathe;
    // idle og'irlik o'tkazish
    b.hips.position.x += (1 - mw) * 0.012 * Math.sin(this.time * 0.9);
    b.hips.rotation.set(0, this.twist, 0);
    b.hips.rotation.z = (1 - mw) * 0.02 * Math.sin(this.time * 0.9) + mw * 0.035 * Math.sin(p) * (1 - aw);
    b.spine.rotation.set(this.lean * 0.5, -this.twist * 0.55, -mw * 0.03 * Math.sin(p));
    b.chest.rotation.set(this.lean * 0.45 + breathe * 3, -this.twist * 0.45, 0);
    // bosh: qarash pitch'ining bir qismi, idle variatsiyalari
    this.idleT = mw > 0.5 || this.kind && this.aimW > 0.5 ? 0 : this.idleT + dt;
    if (this.idleT > this.nextIdleVar && !this.idleVar) { this.idleVar = 1 + (Math.random() < 0.5 ? 1 : 0); this.idleVarT = 0; }
    let headYawT = 0, shrug = 0;
    if (this.idleVar) {
      this.idleVarT += dt;
      const k = Math.sin(clamp(this.idleVarT / 2.4, 0, 1) * Math.PI);
      if (this.idleVar === 1) headYawT = 0.55 * Math.sin(this.idleVarT * 2.2) * k;
      else shrug = k;
      if (this.idleVarT > 2.4) { this.idleVar = 0; this.idleT = 0; this.nextIdleVar = 6 + Math.random() * 6; }
    }
    if (this.idleT === 0) this.idleVar = 0;
    this.headYaw += (headYawT - this.headYaw) * damp(6, dt);
    b.neck.rotation.set(-I.pitch * 0.18 - this.lean * 0.6, this.twist * 0.2, 0);
    b.head.rotation.set(-I.pitch * 0.32 + 0.04 * Math.sin(this.time * 1.3) * (1 - mw), this.headYaw, 0.03 * shrug);
    // zarba reaksiyasi (orqaga silkinish)
    if (this.hit > 0) {
      const k = Math.sin(this.hit * Math.PI) * 0.22;
      b.spine.rotation.x -= k * Math.cos(this.hitDir);
      b.spine.rotation.z += k * Math.sin(this.hitDir) * 0.6;
      b.head.rotation.x -= k * 0.8;
    }
    // qurolsiz qo'llar (yurishda tebranish) — qurol bo'lsa IK yozadi
    const armSwing = mw * (0.45 + 0.05 * sp) * Math.sin(p);
    for (const s of [1, -1]) {
      const L = s > 0 ? 'L' : 'R';
      b['upperArm.' + L].rotation.set(-armSwing * s * clamp(f, -1, 1) - 0.08, 0, s * (0.12 + 0.06 * shrug + aw * 0.5));
      b['forearm.' + L].rotation.set(-0.25 - mw * 0.25 - aw * 0.5, 0, 0);
      b['shoulder.' + L].position.y += 0.025 * shrug;
    }
    this.root.updateMatrixWorld(true);

    // -------- 2) oyoqlar: maqsad nuqtalari + IK --------
    this._legs(dt, p, stance, stride, f, r, mw, cw, aw);

    // -------- 3) qurol / yuqori tana --------
    this._upper(dt);

    // -------- 4) to'liq tana: o'lim / g'alaba / respawn --------
    this._fullBody(dt);
    this.state = this._label();
  }

  _legs (dt, p, stance, stride, f, r, mw, cw, aw) {
    const b = this.b, I = this.in;
    const root = this.root;
    const hipsLocal = (side, out) => out.set(0.095 * side, 0, 0).applyEuler(_e.set(0, this.twist, 0)).add(_t.set(b.hips.position.x, 0, 0));
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const L = side > 0 ? 'L' : 'R';
      const ph = (this.phase + (i === 0 ? 0 : 0.5)) % 1;
      // harakat traektoriyasi (root-local): yo'nalish (r, f) — +X chap, +Z old
      const dx = -r, dz = f;
      let along, lift = 0;
      if (ph < stance) {
        along = 0.5 - ph / stance;              // +0.5 → -0.5 (yer bilan birga orqaga)
      } else {
        const s = (ph - stance) / (1 - stance);
        along = -0.5 + smooth(s);
        lift = Math.sin(s * Math.PI) * (0.06 + 0.012 * I.speed) * (1 + 0.6 * this.sprintW);
      }
      hipsLocal(side, _p);
      const mvx = _p.x + dx * along * stride, mvz = _p.z + dz * along * stride + 0.02;
      // turgan holat: dunyoda qadalgan oyoq + kerak bo'lsa qadam
      const neutral = _w.set(_p.x * (1 + 0.25 * cw), 0, 0.015 + 0.03 * cw);
      if (!this.plantInit) { this.planted[i].copy(neutral).applyMatrix4(root.matrixWorld); }
      const plantedLocal = _v.copy(this.planted[i]).applyMatrix4(_m.copy(root.matrixWorld).invert());
      let idleLift = 0;
      const st = this.stepping[i];
      if (st) {
        st.t += dt / 0.2;
        const k = smooth(Math.min(1, st.t));
        plantedLocal.lerpVectors(st.from, neutral, k);
        idleLift = Math.sin(Math.min(1, st.t) * Math.PI) * 0.05;
        if (st.t >= 1) { this.stepping[i] = null; this.planted[i].copy(neutral).applyMatrix4(root.matrixWorld); }
      } else if (mw < 0.5 && aw < 0.5) {
        const drift = plantedLocal.distanceTo(neutral);
        const other = this.stepping[1 - i];
        if ((drift > 0.11 || Math.abs(this.turnRate) > 2.5 && drift > 0.05) && !other) this.stepping[i] = { t: 0, from: plantedLocal.clone() };
      }
      if (mw >= 0.5 || aw >= 0.5) this.planted[i].copy(neutral).applyMatrix4(root.matrixWorld);
      // aralashtirish: turish ↔ harakat
      const tx = plantedLocal.x + (mvx - plantedLocal.x) * mw;
      const tz = plantedLocal.z + (mvz - plantedLocal.z) * mw;
      let ty = ANKLE_H + lift * mw + idleLift;
      // havo: oyoqlar tanaga tortiladi
      const tuck = aw * (I.vy > 0 ? 0.2 : 0.12);
      const hipY = b.hips.position.y + this.c.rest['upperLeg.' + L].pos.y;
      ty = ty * (1 - aw) + (hipY - 0.33 + tuck * 0.5) * aw + (i === 0 ? 0.03 : -0.02) * aw;
      _t.set(tx, ty, tz).applyMatrix4(root.matrixWorld);
      // tizza oldinga (pole) — tana yo'nalishi bo'yicha
      _w.set(_p.x * 1.2, 0.3, 0.6).applyMatrix4(root.matrixWorld);
      solveTwoBone(b['upperLeg.' + L], b['knee.' + L], b['ankle.' + L], _t, _w);
      // oyoq kafti yerga parallel (yaw = tana/son yaw'i), tayanchda tekis
      const toe = ph < stance ? 0 : -0.35 * Math.sin(((ph - stance) / (1 - stance)) * Math.PI) * mw;
      root.getWorldQuaternion(_q);
      _q2.setFromAxisAngle(Y, this.twist * mw);
      _q.multiply(_q2).multiply(_q2.setFromAxisAngle(X, toe + aw * 0.35));
      setWorldQuaternion(b['ankle.' + L], _q);
      this.footY[i] = ty;
    }
    this.plantInit = true;
  }

  _upper (dt) {
    const b = this.b, I = this.in, root = this.root;
    if (!this.weapon) { this.weaponRoot.visible = false; return; }
    this.weaponRoot.visible = true;
    const H = HOLD[this.kind] || HOLD.rifle;
    const A = this.actions;
    // anchor: tutish ↔ sprint (qurol pastga), almashtirish (pastga tushib chiqadi)
    const sw = this.sprintW * (1 - this.aimW);
    const ax = H.anchor[0] + (H.sprint[0] - H.anchor[0]) * sw;
    const hipsDY = b.hips.position.y - this.c.rest.hips.pos.y;   // cho'kkalash/bob/qo'nish — qurol tana bilan birga
    const ay = H.anchor[1] + (H.sprint[1] - H.anchor[1]) * sw + hipsDY * 0.92;
    const az = H.anchor[2] + (H.sprint[2] - H.anchor[2]) * sw + 0.03 * this.aimW;
    let pitch = clamp(I.pitch, -0.9, 0.9) * (1 - sw) - sw * 0.5;
    let yaw = 0.12 * sw;
    let roll = 0;
    let off = new THREE.Vector3(ax, ay, az);
    if (A.switch) {
      const k = Math.sin((A.switch.t / A.switch.dur) * Math.PI);
      off.y -= 0.22 * k; pitch -= 1.0 * k; roll += 0.4 * k;
    }
    if (A.reload) {
      const u = A.reload.t / A.reload.dur;
      const k = Math.sin(Math.min(1, u * 1.15) * Math.PI);
      pitch += 0.35 * k; roll -= 0.45 * k; off.y -= 0.05 * k; off.x += 0.03 * k;
    }
    // recoil: orqaga va yuqoriga
    off.z -= this.kick * 0.012;
    pitch += this.kick * 0.012;
    // granata otish: qo'l orqaga va yuqoridan oldinga
    let throwK = 0;
    if (A.throw) {
      const u = A.throw.t / A.throw.dur;
      throwK = u < 0.45 ? smooth(u / 0.45) : 1 - smooth((u - 0.45) / 0.55);
      const swing = u < 0.45 ? -1.6 * smooth(u / 0.45) : -1.6 + 2.6 * smooth(Math.min(1, (u - 0.45) / 0.25));
      off.set(-0.19, 0.92 + 0.22 * throwK, 0.05 - 0.12 * throwK + (u > 0.45 ? 0.25 * smooth(Math.min(1, (u - 0.45) / 0.25)) : 0));
      pitch = swing * 0.5;
    }
    let slash = 0;
    if (A.knife) {
      const u = A.knife.t / A.knife.dur;
      slash = u < 0.35 ? -smooth(u / 0.35) : -1 + 2 * smooth(Math.min(1, (u - 0.35) / 0.3));
      off.x += -0.08 * slash; off.z += 0.12 * Math.max(0, slash); off.y += 0.05 * (1 - Math.abs(slash));
      yaw += 0.9 * slash; roll += 0.3 * slash;
      b.chest.rotation.y -= 0.35 * slash;
    }
    // qurol transformi (root-local): yelka pivoti atrofida pitch
    // "bladed" turish: uzun qurolda yuqori tana o'ngga buriladi → chap yelka
    // old dastakka yaqinlashadi (qisqa qo'llar uchun real miltiq turishi);
    // bosh nishonga qaytariladi.
    const blade = (H.blade || 0) * (1 - (A.throw ? 1 : 0)) * (this.dead > 0 ? 0 : 1);
    this.bladeW = (this.bladeW || 0) + (blade - (this.bladeW || 0)) * damp(10, dt);
    b.spine.rotation.y += this.bladeW * 0.45;
    b.chest.rotation.y += this.bladeW * 0.55;
    b.neck.rotation.y -= this.bladeW * 0.5;
    b.head.rotation.y -= this.bladeW * 0.5;
    root.updateMatrixWorld(true);
    const wr = this.weaponRoot;
    _q.setFromEuler(_e.set(-pitch, yaw, roll, 'YXZ'));
    const pivot = SHOULDER_PIVOT;
    wr.position.copy(off).sub(pivot).applyQuaternion(_q2.setFromAxisAngle(X, -pitch * 0.85)).add(pivot);
    wr.quaternion.copy(_q);
    // pastki tana burilishi qurolga ta'sir qilmasin (yuqori tana nishonda)
    wr.updateMatrixWorld(true);
    // qo'llar IK: o'ng — dastak, chap — old dastak (yoki magazin/qo'riqlash)
    const g = this.weapon.userData;
    const pole = (s, out) => out.set(0.5 * s, 0.55, -0.35).applyMatrix4(root.matrixWorld);
    // o'ng qo'l
    _t.copy(g.grip).applyMatrix4(this.weapon.matrixWorld);
    this.ikErrR = solveTwoBone(b['upperArm.R'], b['forearm.R'], b['hand.R'], _t, pole(-1, _w));
    this.weapon.getWorldQuaternion(_q);
    setWorldQuaternion(b['hand.R'], _q.multiply(_q2.setFromAxisAngle(X, -0.25)));
    // chap qo'l
    if (g.support && !A.throw && this.kind !== 'knife' && this.kind !== 'grenade') {
      _t.copy(g.support).applyMatrix4(this.weapon.matrixWorld);
      if (A.reload) {
        // magazinni oladi → yangi magazin bilan qaytadi
        const u = A.reload.t / A.reload.dur;
        const k = Math.sin(Math.min(1, u * 1.15) * Math.PI);
        _p.copy(g.mag || g.support).applyMatrix4(this.weapon.matrixWorld);
        _w.set(0.2, 0.62, 0.05).applyMatrix4(root.matrixWorld);     // bel tomon
        const mid = u < 0.5 ? smooth(u / 0.5) : 1 - smooth((u - 0.5) / 0.5);
        _t.lerp(_p, Math.min(1, k * 2)).lerp(_w, mid * 0.75);
        if (g.magMesh) g.magMesh.visible = !(u > 0.3 && u < 0.62);
      } else if (g.magMesh) g.magMesh.visible = true;
      this.ikErrL = solveTwoBone(b['upperArm.L'], b['forearm.L'], b['hand.L'], _t, pole(1, _w));
      this.weapon.getWorldQuaternion(_q);
      setWorldQuaternion(b['hand.L'], _q.multiply(_q2.setFromAxisAngle(Y, 0.6)));
    } else {
      // bo'sh chap qo'l: muvozanat / himoya holati
      _t.set(0.17, 0.78 + 0.25 * throwK, 0.2 + 0.1 * throwK).applyMatrix4(root.matrixWorld);
      solveTwoBone(b['upperArm.L'], b['forearm.L'], b['hand.L'], _t, pole(1, _w));
    }
  }

  _fullBody (dt) {
    const b = this.b;
    if (this.dead > 0) {
      // o'lim: tana orqaga yiqiladi (son pivoti), qo'llar bo'shashadi
      const k = smooth(this.dead);
      b.hips.position.y -= 0.32 * k;
      b.hips.rotation.x -= 1.45 * k;
      b.spine.rotation.x += 0.2 * k;
      b.head.rotation.x += 0.3 * k;
      b.head.rotation.z += 0.25 * k;
      this.root.updateMatrixWorld(true);
      this.weaponRoot.visible = this.dead < 0.4;
    }
    if (this.victoryT >= 0) {
      const t = this.victoryT;
      const hop = Math.max(0, Math.sin(t * 6)) * 0.08;
      b.hips.position.y += hop;
      for (const s of [1, -1]) {
        const L = s > 0 ? 'L' : 'R';
        b['upperArm.' + L].rotation.set(0, 0, s * (2.5 + 0.2 * Math.sin(t * 6)));
        b['forearm.' + L].rotation.set(-0.3, 0, 0);
        b['hand.' + L].rotation.set(0, 0, 0);
      }
      b.head.rotation.x = -0.2;
      this.weaponRoot.visible = false;
      this.root.updateMatrixWorld(true);
    }
    // respawn: jamoa rangida yorug' "materializatsiya" + yumshoq kattalashish;
    // zarba: qisqa qizil chaqnash
    const ud = this.c.mesh.material.userData;
    ud.rimStrength.value = ud.baseRim + this.respawnT * 2.2;
    this.c.setFlash(this.hit * 0.35);
    this.c.root.scale.setScalar(this.respawnT > 0 ? 1 - 0.22 * this.respawnT * this.respawnT : 1);
  }

  _label () {
    const I = this.in, A = this.actions;
    if (this.victoryT >= 0) return 'victory';
    if (this.isDead) return 'death';
    if (this.respawnT > 0.2) return 'respawn';
    if (A.throw) return 'grenade';
    if (A.knife) return 'knife';
    if (A.reload) return 'reload';
    if (A.switch) return 'switch';
    if (this.hit > 0.3) return 'hit';
    if (I.airborne) return I.vy > 0 ? 'jump' : 'fall';
    if (this.land < -0.03) return 'land';
    if (I.crouch) return I.speed > 0.25 ? 'crouch-walk' : 'crouch';
    if (I.speed > 0.25) {
      if (I.sprint) return 'sprint';
      if (Math.abs(I.right) > 0.7 && Math.abs(I.fwd) < 0.4) return I.right > 0 ? 'strafe-right' : 'strafe-left';
      if (Math.abs(I.right) > 0.35 && Math.abs(I.fwd) > 0.35) return 'diagonal';
      if (I.fwd < -0.5) return 'walk-back';
      return I.speed > 3.5 ? 'run' : 'walk';
    }
    if (this.stepping[0] || this.stepping[1]) return 'turn';
    if (Math.abs(this.kick) > 0.05) return 'shoot';
    if (I.aiming) return 'aim';
    return 'idle';
  }

  /** Dunyo fazosidagi tumshuq (muzzle) nuqtasi */
  muzzleWorld (out = new THREE.Vector3()) {
    if (!this.weapon || !this.weapon.userData.muzzle) return this.root.getWorldPosition(out).setY(1.0);
    return out.copy(this.weapon.userData.muzzle).applyMatrix4(this.weapon.matrixWorld);
  }

  /** Maxsus diagnostika: oyoq kaftlarining dunyo balandligi */
  footHeights () {
    return [this.b['ankle.L'], this.b['ankle.R']].map((bn) => bn.getWorldPosition(new THREE.Vector3()).y);
  }
}
