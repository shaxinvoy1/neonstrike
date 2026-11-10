// ============================================================
// NEON STRIKE — o'yin sahnasi (bootstrap'dan keyin)
// Lokal: shared/movement.js bilan BASHORAT (30 Hz, server bilan bir xil dt),
// server snapshot'i bilan rekonsiliatsiya. Zarar/o'q-dori/o'lim — FAQAT server.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { MSG, SIM } from '/shared/protocol-consts.js';
import { createMovementState, stepMovement, teleportMovement, CROUCH } from '/shared/movement.js';
import { SPAWNS, SOLID_BOXES } from '/shared/map.js';
import { WEAPONS, WEAPON_ORDER } from '/shared/weapons.js';
import { PLAYER } from '/shared/collision.js';
import { createNeonEnvironment } from '../world/env.js';
import { createArena, applyAtmosphere } from '../world/arena.js';
import { OTSCamera, rayWorld } from './camera.js';
import { Input } from './input.js';
import { Effects } from './effects.js';
import { Avatar, RemotePlayer, driveAvatar, TEAM_COLOR } from './players.js';
import { Hud } from './hud.js';
import { sfx, setListener, unlockAudio } from '../audio.js';
import { settings, QUALITY } from '../settings.js';

const STEP = 1 / SIM.TICK_HZ;
const SOUND = { 'neon-rifle': 'rifle', 'pulse-pistol': 'pistol', 'scatter-shot': 'shotgun', 'combat-knife': 'knife', 'energy-grenade': 'throw' };
const FLASH = { 'neon-rifle': [1, 0x8fe8ff], 'pulse-pistol': [0.8, 0x9fd0ff], 'scatter-shot': [1.5, 0xc59bff] };
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class Game {
  constructor ({ canvas, hudRoot, touchRoot, net, mode, session, playerName, onPause, onMatchEnd, onExit }) {
    this.canvas = canvas; this.net = net; this.mode = mode; this.playerName = playerName;
    this.onPause = onPause; this.onMatchEnd = onMatchEnd; this.onExit = onExit;
    const Q = QUALITY[settings.quality] || QUALITY.high;
    this.Q = Q;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: Q.antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;
    this.renderer.shadowMap.enabled = Q.shadows && settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.env = createNeonEnvironment(this.renderer);
    this.scene.environment = this.env.texture;
    this.bgTex = applyAtmosphere(this.scene);
    this.arena = createArena({ envMap: this.env.texture, quality: settings.shadows ? Q.material : 'low' });
    this.scene.add(this.arena.root);
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 220);
    this.ots = new OTSCamera(this.camera);
    this.ots.baseFov = settings.fov;
    this.effects = new Effects(this.scene, { quality: Q.material, envMap: this.env.texture });
    this.input = new Input(canvas, touchRoot);
    this.hud = new Hud(hudRoot);
    this.hudRoot = hudRoot;

    // lokal o'yinchi
    this.me = new Avatar(this.scene, { quality: Q.material, envMap: this.env.texture, team: null, name: playerName, showLabel: false });
    const sp = session && session.state ? session.state.position : SPAWNS.A;
    this.move = createMovementState({ spawn: { x: sp.x ?? SPAWNS.A.x, y: sp.y ?? 0, z: sp.z ?? SPAWNS.A.z, yaw: SPAWNS.A.yaw } });
    this.ots.yaw = SPAWNS.A.yaw;
    this.prev = { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z };
    this.renderPos = new THREE.Vector3();
    this.seq = 0; this.acc = 0; this.history = [];
    this.authoritative = false;
    this.team = null;
    this.state = null;          // oxirgi STATE (server)
    this.loadout = null;
    this.weaponId = 'neon-rifle';
    this.me.setWeapon('neon-rifle', false);
    this.alive = true;
    this.match = null;
    this.remotes = new Map();
    this.names = new Map();
    this.dummies = new Map();
    this.chatLog = [];
    this.pending = { fire: false, firePressed: false, reload: false, switchTo: null, jump: false };
    this.macro = null;          // tezkor granata/pichoq
    this.lastFireAt = 0;
    this.aimInfo = {};
    this.frames = []; this.fpsT = 0;
    this.last = performance.now();
    this.running = false;
    this.paused = false;
    this.scoreHeld = false;
    this.prevMatch = { roundState: null, roundNumber: 0, matchState: null };
    this.stepPhase = [0, 0];
    if (session && Array.isArray(session.targets)) this._spawnDummies(session.targets);
    this._wireNet();
    this._wireChat();
    this.onResize = () => this.resize();
    addEventListener('resize', this.onResize);
    this.resize();
    window.__ns = this;
  }

  // ---------------- tarmoq ----------------
  _wireNet () {
    const n = this.net;
    this.offs = [
      n.on(MSG.STATE, (m) => this._onState(m)),
      n.on(MSG.EVENTS, (m) => this._onEvents(m.events || [])),
      n.on(MSG.SNAPSHOT, (m) => this._onSnapshot(m)),
      n.on(MSG.CHAT_MSG, (m) => { this.chatLog.push(m); if (this.chatLog.length > 50) this.chatLog.shift(); if (m.playerId !== n.playerId) sfx.chat(); }),
      n.on(MSG.LOBBY_STATE, (m) => { for (const p of m.players || []) this.names.set(p.id, p.name || p.id); }),
      n.on('close', () => { this.hud.banner('ALOQA UZILDI', 'Server bilan ulanish yo‘qoldi', 6000, 'lose'); setTimeout(() => this.onExit && this.onExit('disconnected'), 2500); })
    ];
  }
  _spawnDummies (targets) {
    for (const t of targets) {
      if (t.kind === 'ring') continue;
      const av = new Avatar(this.scene, { quality: this.Q.material, envMap: this.env.texture, team: null, name: 'TARGET', showLabel: true });
      av.setWeapon('neon-rifle', false);
      av.root.position.set(t.x, t.y || 0, t.z);
      av.root.rotation.y = t.yaw || 0;
      this.dummies.set(t.id, { av, x: t.x, y: t.y || 0, z: t.z, yaw: t.yaw || 0, alive: true });
    }
  }
  _onState (m) {
    this.state = m;
    this.loadout = m.loadout || this.loadout;
    if (m.weapon && m.weapon.weaponId !== this.weaponId) { this.weaponId = m.weapon.weaponId; this.me.setWeapon(this.weaponId); }
    if (m.teamId !== this.team) { this.team = m.teamId; this.me.setIdentity(this.playerName, m.teamId); }
    this.authoritative = !!m.authoritativeMovement;
    if (this.alive && !m.alive) this._died();
    if (!this.alive && m.alive) this._respawned(m.position);
    this.alive = m.alive;
    for (const t of m.targets || []) {
      const d = this.dummies.get(t.id);
      if (!d) continue;
      if (d.alive && !t.alive) d.av.anim.trigger('die');
      if (!d.alive && t.alive) d.av.anim.trigger('respawn');
      d.alive = t.alive; d.hp = t.hp;
    }
    // standalone (mashq): server pozitsiyani rad etsa — server qiymatiga qaytish
    if (!this.authoritative && m.position && !(this.qaHold > performance.now())) {
      const p = this.move.pos;
      if (Math.hypot(m.position.x - p.x, m.position.z - p.z) > 3) teleportMovement(this.move, m.position.x, m.position.z, undefined, m.position.y);
    }
  }
  _onSnapshot (m) {
    const now = performance.now();
    const my = this.net.playerId;
    const seen = new Set();
    for (const p of m.players) {
      this.names.set(p.id, p.name || p.id);
      if (p.id === my) { this._reconcile(p, m.ackSeq); this.mySnap = p; continue; }
      seen.add(p.id);
      let r = this.remotes.get(p.id);
      if (!r) {
        r = new RemotePlayer(this.scene, { quality: this.Q.material === 'high' ? 'medium' : this.Q.material, envMap: this.env.texture, team: p.teamId, name: p.name }, p.id);
        r.av.char.setTeam(p.teamId);
        this.remotes.set(p.id, r);
      }
      r.push(now, p);
    }
    for (const [id, r] of this.remotes) if (!seen.has(id)) { r.dispose(); this.remotes.delete(id); }
    if (m.match) this._onMatch(m.match);
    this.effects.syncGrenades(m.grenades, (pos) => { this.effects.explosion(pos); sfx.explosion(pos); this._shake(pos, 0.25); });
  }
  _reconcile (p, ackSeq) {
    if (!this.authoritative) return;
    const h = this.history.find((e) => e.seq === ackSeq);
    const mv = this.move;
    if (!h) { if (Math.hypot(p.x - mv.pos.x, p.z - mv.pos.z) > 2) teleportMovement(mv, p.x, p.z, undefined, p.y); return; }
    const ex = p.x - h.x, ey = p.y - h.y, ez = p.z - h.z;
    const err = Math.hypot(ex, ey, ez);
    if (err > 2.5) { teleportMovement(mv, p.x, p.z, undefined, p.y); this.prev = { ...mv.pos }; this.history.length = 0; return; }
    if (err > 0.01) {
      const k = err > 0.6 ? 1 : 0.35;
      mv.pos.x += ex * k; mv.pos.y += ey * k; mv.pos.z += ez * k;
      for (const e of this.history) if (e.seq > ackSeq) { e.x += ex * k; e.y += ey * k; e.z += ez * k; }
    }
    this.history = this.history.filter((e) => e.seq >= ackSeq);
    this.lastErr = err;
  }
  _onMatch (mt) {
    const pv = this.prevMatch;
    this.match = mt;
    if (mt.roundState === 'live' && (pv.roundState !== 'live' || pv.roundNumber !== mt.roundNumber)) {
      this.hud.banner(`ROUND ${mt.roundNumber}`, `${mt.maxRounds || 10} raunddan · birinchi ${mt.roundsToWin} g‘alaba`, 1800);
      sfx.roundStart();
      this.hud.dead(false);
    }
    if (mt.roundState === 'round_end' && pv.roundState === 'live') {
      const w = mt.roundWinner;
      const mine = w && w === this.team;
      this.hud.banner(w === 'draw' ? 'DURANG' : `${w === 'A' ? 'BLUE' : 'RED'} TEAM WINS`, `Raund ${mt.roundNumber} · ${mt.scores.A} : ${mt.scores.B}`, 2600, w === 'draw' ? '' : mine ? 'win' : 'lose');
      if (w !== 'draw') (mine ? sfx.victory : sfx.defeat)();
    }
    if (mt.matchState === 'match_end' && pv.matchState !== 'match_end') {
      const w = mt.matchWinner;
      if (w === this.team) { this.me.anim.trigger('victory'); for (const r of this.remotes.values()) if (r.team === w) r.av.anim.trigger('victory'); }
      setTimeout(() => this.onMatchEnd && this.onMatchEnd(this.results()), 2600);
    }
    pv.roundState = mt.roundState; pv.roundNumber = mt.roundNumber; pv.matchState = mt.matchState;
  }
  _onEvents (evs) {
    for (const e of evs) {
      const p = new THREE.Vector3(e.x, e.y, e.z);
      switch (e.type) {
        case 'hit': {
          this.effects.impact(p, true); sfx.impact(p);
          this.hud.hit(e.zone === 'head' ? 'head' : ''); (e.zone === 'head' ? sfx.headshot : sfx.hit)();
          this._lastShotPoint = p;
          const d = this.dummies.get(e.targetId); if (d) d.av.anim.trigger('hit', { dir: 0 });
          const r = this.remotes.get(e.targetId); if (r) r.av.anim.trigger('hit', { dir: 0 });
          break;
        }
        case 'blast-hit': this.hud.hit(''); sfx.hit(); break;
        case 'kill': this.hud.hit('kill'); sfx.kill(); break;
        case 'blocked': this.effects.impact(p, false); sfx.impact(p); this._lastShotPoint = p; break;
        case 'damage-taken': case 'death': {
          if (e.from) {
            const a = Math.atan2(e.from[0] - this.move.pos.x, e.from[2] - this.move.pos.z);
            this.hud.damageFrom(-(a - this.ots.yaw) + Math.PI);
          }
          if (e.attackerId) this.lastAttacker = e.attackerId;
          this.me.anim.trigger('hit', { dir: 0 }); sfx.hurt(); this.ots.shake = 0.06;
          break;
        }
        case 'self-damage': this.me.anim.trigger('hit'); sfx.hurt(); break;
        case 'reload-start': this.me.anim.trigger('reload', { ms: (WEAPONS[e.weaponId] || {}).reloadMs || 2000 }); sfx.reload(this.renderPos); break;
        case 'weapon-switch': sfx.switch(this.renderPos); break;
        case 'grenade-throw': this.me.anim.trigger('throw'); sfx.throw(this.renderPos); break;
        case 'grenade-explode': break;   // vizual — snapshot granatalari yo'qolganda (hamma uchun bir xil)
        case 'shot-rejected': if (e.reason === 'empty') { sfx.dry(); this.hud.banner('', 'R — qayta o‘qlash', 700, 'tiny'); } break;
        case 'target-respawn': { const d = this.dummies.get(e.targetId); if (d) { d.av.anim.trigger('respawn'); d.alive = true; } break; }
        default: break;
      }
    }
  }
  _died () {
    this.me.anim.trigger('die');
    sfx.death();
    const who = this.lastAttacker ? (this.names.get(this.lastAttacker) || this.lastAttacker) : '';
    this.hud.dead(true, who ? `${who} tomonidan · keyingi raundda qaytasiz` : 'Keyingi raundda qaytasiz');
    if (this.mode === 'training') this.hud.dead(true, 'Qayta tug‘ilish…');
  }
  _respawned (pos) {
    this.me.anim.trigger('respawn'); sfx.respawn();
    this.hud.dead(false);
    if (pos) { teleportMovement(this.move, pos.x, pos.z, undefined, pos.y); this.prev = { ...this.move.pos }; this.history.length = 0; }
  }
  _wireChat () {
    const inp = this.hud.el.hChatIn;
    this._chatKey = (e) => {
      if (!this.running) return;
      if ((e.code === 'Enter' || e.code === 'KeyT') && document.activeElement !== inp && !this.paused) {
        e.preventDefault(); this.hud.root.classList.add('chat-open'); inp.focus(); this.input.releaseLock(); this.chatting = true;
      } else if (e.code === 'Enter' && document.activeElement === inp) {
        const text = inp.value.trim(); if (text) this.net.send({ type: MSG.CHAT, text });
        inp.value = ''; inp.blur(); this.hud.root.classList.remove('chat-open'); this.chatting = false; this.input.requestLock();
      } else if (e.code === 'Escape' && document.activeElement === inp) { inp.blur(); this.hud.root.classList.remove('chat-open'); this.chatting = false; }
      else if (e.code === 'Escape' && !this.chatting && this.input.touch) this.onPause && this.onPause();
    };
    addEventListener('keydown', this._chatKey);
    this._plc = () => { if (this.running && !this.input.touch && !document.pointerLockElement && !this.chatting && !this.ended) this.onPause && this.onPause(); };
    document.addEventListener('pointerlockchange', this._plc);
  }

  // ---------------- tsikl ----------------
  start () {
    this.running = true; this.paused = false;
    this.input.setEnabled(true);
    this.input.requestLock();
    unlockAudio();
    this.last = performance.now();
    const loop = (t) => { if (!this.running) return; this.raf = requestAnimationFrame(loop); this.frame(t); };
    this.raf = requestAnimationFrame(loop);
  }
  pause (on) {
    this.paused = on;
    this.input.setEnabled(!on);
    if (on) this.input.releaseLock(); else this.input.requestLock();
  }
  resize () {
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    const pr = Math.min(2, (devicePixelRatio || 1)) * (this.Q.pixelRatio / 1.5) * settings.resolutionScale;
    this.renderer.setPixelRatio(Math.max(0.5, Math.min(2, pr * 1.5 / 1.5)));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame (now) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const I = this.paused || this.chatting ? null : this.input.poll();
    if (I) this._handleInput(I, now);
    // 30 Hz simulyatsiya qadamlari (server bilan bir xil)
    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 5) { this._simStep(I); this.acc -= STEP; steps++; }
    if (steps === 5) this.acc = 0;
    const a = this.acc / STEP;
    this.renderPos.set(this.prev.x + (this.move.pos.x - this.prev.x) * a, this.prev.y + (this.move.pos.y - this.prev.y) * a, this.prev.z + (this.move.pos.z - this.prev.z) * a);
    this.update(dt, now, I);
    this.renderer.render(this.scene, this.camera);
    this._stats(dt, now);
  }

  _handleInput (I, now) {
    this.ots.look(I.lookX, I.lookY);
    this.aiming = I.aim && this.alive;
    const P = this.pending;
    if (I.firePressed) P.firePressed = true;
    this.fireHeld = I.fire;
    if (I.reload) P.reload = true;
    if (I.jump) P.jump = true;
    this.wantCrouch = I.crouch; this.wantSprint = I.sprint && !this.aiming && !I.fire;
    this.axis = { forward: I.forward, right: I.right };
    const cur = WEAPON_ORDER.indexOf(this.weaponId);
    if (I.slot) P.switchTo = WEAPON_ORDER[I.slot - 1];
    if (I.cycle) {
      let i = cur;
      for (let k = 0; k < 5; k++) { i = (i + I.cycle + 5) % 5; if (WEAPON_ORDER[i] !== 'energy-grenade' || this._grenadesLeft() > 0) break; }
      P.switchTo = WEAPON_ORDER[i];
    }
    if ((I.grenade || I.knife) && !this.macro && this.alive) {
      const target = I.grenade ? 'energy-grenade' : 'combat-knife';
      if (I.grenade && this._grenadesLeft() <= 0) this.hud.banner('', 'Granata qolmadi', 800, 'tiny');
      else this.macro = { target, back: this.weaponId === target ? null : this.weaponId, phase: this.weaponId === target ? 'fire' : 'switch', t: now };
    }
    this.scoreHeld = I.score;
  }
  _grenadesLeft () { const g = (this.loadout || []).find((x) => x.id === 'energy-grenade'); return g ? g.mag + g.reserve : 0; }

  _simStep (I) {
    this.prev = { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z };
    const yaw = this.ots.aimYaw(), pitch = this.ots.aimPitch();
    const P = this.pending;
    const axis = this.alive && I !== null ? (this.axis || { forward: 0, right: 0 }) : { forward: 0, right: 0 };
    const jump = P.jump && this.alive;
    const crouch = !!this.wantCrouch && this.alive;
    const sprint = !!this.wantSprint;
    const wasAir = this.move.airborne;
    stepMovement(this.move, STEP, axis, yaw, sprint, { jump, crouch });
    if (wasAir && !this.move.airborne) sfx.land(this.renderPos);
    // tezkor makro (granata/pichoq): almashtirish → otish → qaytish
    const now = performance.now();
    let fire = !!this.fireHeld, firePressed = P.firePressed;
    if (this.macro) {
      const M = this.macro;
      if (M.phase === 'switch') { P.switchTo = M.target; M.phase = 'wait'; M.t = now; }
      else if (M.phase === 'wait' && this.weaponId === M.target && now - M.t > 380) M.phase = 'fire';
      else if (M.phase === 'wait' && now - M.t > 1500) this.macro = null;
      if (M.phase === 'fire') { fire = true; firePressed = true; M.phase = 'after'; M.t = now; if (M.target === 'combat-knife') this.me.anim.trigger('knife'); }
      else if (M.phase === 'after' && now - M.t > (M.target === 'energy-grenade' ? 750 : 450)) { if (M.back) P.switchTo = M.back; this.macro = null; }
    }
    if (firePressed && this.weaponId === 'combat-knife' && !(this.macro && this.macro.phase === 'after' && now - this.macro.t < 30)) this.me.anim.trigger('knife');
    // nishon (kamera nuri → T → ko'zdan yo'nalish)
    const bodies = [];
    for (const r of this.remotes.values()) bodies.push({ x: r.pos.x, y: r.pos.y, z: r.pos.z, crouch: r.crouch, alive: r.alive, team: r.team, ref: r });
    for (const d of this.dummies.values()) bodies.push({ x: d.x, y: d.y, z: d.z, crouch: false, alive: d.alive, ref: d });
    const aim = this.ots.aim({ x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z, crouch: this.move.crouching }, bodies, this.aimInfo);
    this.seq = ++this.net.seq;
    const msg = {
      type: MSG.INPUT, seq: this.seq,
      pose: { x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z, yaw, pitch },
      aim: { dir: aim.dir },
      intents: { fire: fire && this.alive, firePressed: firePressed && this.alive, reload: P.reload, switchTo: P.switchTo, moving: Math.hypot(axis.forward, axis.right) > 0.05 },
      move: { forward: axis.forward, right: axis.right, sprint, jump, crouch }
    };
    this.net.send(msg);
    this.history.push({ seq: this.seq, x: this.move.pos.x, y: this.move.pos.y, z: this.move.pos.z });
    if (this.history.length > 90) this.history.shift();
    if ((fire || firePressed) && this.alive) this._predictFire(firePressed, aim);
    P.firePressed = false; P.reload = false; P.switchTo = null; P.jump = false;
  }

  /** Faqat VIZUAL bashorat (flash/tracer/recoil/ovoz) — zarar serverda */
  _predictFire (pressed, aim) {
    const w = WEAPONS[this.weaponId];
    const st = this.state && this.state.weapon;
    if (!w || !st || st.reloading || st.switching) return;
    if (!w.auto && !pressed) return;
    const now = performance.now();
    if (now - this.lastFireAt < w.intervalMs * 0.98) return;
    if (w.mode !== 'melee' && st.mag <= 0) return;
    if (this.match && this.match.matchState !== 'none' && this.match.roundState !== 'live' && this.match.roundState !== 'starting') return;
    this.lastFireAt = now;
    if (w.mode === 'melee') { sfx.knife(this.renderPos); return; }
    if (w.mode === 'projectile') return;    // granata otishini server tasdiqlaydi
    const muzzle = this.me.anim.muzzleWorld(new THREE.Vector3());
    const [k, col] = FLASH[w.id] || [1, 0x8fe8ff];
    this.effects.muzzle(muzzle, k, col);
    const end = aim.blocked ? v3(aim.blockPoint) : v3(aim.point);
    this.effects.tracer(muzzle, end, col);
    if (w.pellets > 1) for (let i = 0; i < 4; i++) this.effects.tracer(muzzle, end.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.9)), col);
    this.me.anim.trigger('fire');
    this.ots.kick(w.recoil.pitch * 1.2, w.recoil.yaw);
    sfx[SOUND[w.id]](this.renderPos);
  }

  update (dt, now, I) {
    // kamera + lokal avatar
    const vel = { x: this.move.vel.x, y: this.move.vy, z: this.move.vel.z };
    this.ots.update(dt, this.renderPos, this.aiming, this.move.crouching);
    driveAvatar(this.me, dt, this.renderPos, vel, this.ots.aimYaw(), this.ots.aimPitch(), { airborne: this.move.airborne, crouch: this.move.crouching, sprint: this.move.sprinting, aiming: this.aiming || !!this.fireHeld });
    this._footsteps(this.me, this.renderPos, 1);
    setListener(this.renderPos.x, this.renderPos.y + 1.5, this.renderPos.z, this.ots.yaw);
    // masofaviy o'yinchilar
    for (const r of this.remotes.values()) {
      r.update(dt, now);
      this._footsteps(r.av, r.pos, 0.8);
      for (const ev of r.events.splice(0)) {
        if (ev.type === 'fire') this._remoteFire(r, ev.weapon);
        if (ev.type === 'die') sfx.death();
      }
    }
    for (const d of this.dummies.values()) { d.av.anim.in.speed = 0; d.av.anim.update(dt); }
    this.effects.update(dt);
    // HUD
    const st = this.state;
    if (st) {
      this.hud.vitals(st.hp, st.maxHp, st.alive);
      this.hud.weapon(st.weapon, st.loadout);
    }
    const w = WEAPONS[this.weaponId];
    const moving = Math.hypot(this.move.vel.x, this.move.vel.z) > 0.5;
    const spread = w ? (moving ? w.spreadDeg.moving : w.spreadDeg.base) * (this.aiming ? 0.6 : 1) : 1;
    const tgt = this.aimInfo.target;
    this.hud.crosshair(spread, this.aimInfo.blocked, tgt && tgt.team && tgt.team !== this.team);
    const m = this.match || { matchState: 'none' };
    this.hud.match(m, this.team);
    if (m.feed) this.hud.feed(m.feed, (id) => ({ name: this.names.get(id) || id, team: this._teamOf(id) }));
    this.hud.chat(this.chatLog.map((c) => ({ ...c, team: this._teamOf(c.playerId) })), this.net.playerId);
    // minimap: jamoadoshlar doim; dushman — ko'rinib turgan (to'siqsiz) yoki yaqinda otgan bo'lsa
    const mates = [], foes = [];
    for (const r of this.remotes.values()) {
      const p = { x: r.pos.x, z: r.pos.z, alive: r.alive };
      if (this.team && r.team === this.team) mates.push(p);
      else if (now - (r.firedAt || 0) < 1500 || this._visible(r.pos)) foes.push(p);
    }
    this.hud.minimap({ x: this.renderPos.x, z: this.renderPos.z, yaw: this.ots.yaw }, mates, foes);
    this.hud.scoreboard(this.scoreHeld, this.scoreRows(), m, this.net.playerId);
  }
  _teamOf (id) {
    if (id === this.net.playerId) return this.team;
    const r = this.remotes.get(id); return r ? r.team : null;
  }
  _visible (pos) {
    const e = [this.renderPos.x, this.renderPos.y + 1.5, this.renderPos.z];
    const dx = pos.x - e[0], dy = pos.y + 1.2 - e[1], dz = pos.z - e[2];
    const L = Math.hypot(dx, dy, dz);
    if (L > 45) return false;
    return rayWorld(e, [dx / L, dy / L, dz / L], L, SOLID_BOXES) >= L - 0.1;
  }
  _remoteFire (r, weapon) {
    r.firedAt = performance.now();
    const w = WEAPONS[weapon];
    if (!w) return;
    if (w.mode === 'melee') { r.av.anim.trigger('knife'); sfx.knife(r.pos); return; }
    if (w.mode === 'projectile') { r.av.anim.trigger('throw'); sfx.throw(r.pos); return; }
    r.av.anim.trigger('fire');
    const muzzle = r.av.anim.muzzleWorld(new THREE.Vector3());
    const cp = Math.cos(r.pitch);
    const d = [Math.sin(r.yaw) * cp, Math.sin(r.pitch), Math.cos(r.yaw) * cp];
    const o = [muzzle.x, muzzle.y, muzzle.z];
    const t = rayWorld(o, d, w.range);
    const end = new THREE.Vector3(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
    const [k, col] = FLASH[weapon] || [1, 0xff8fa0];
    const c = r.team === 'B' ? 0xff7a8f : col;
    this.effects.muzzle(muzzle, k, c);
    this.effects.tracer(muzzle, end, c);
    if (t < w.range) this.effects.impact(end, false);
    sfx[SOUND[weapon]](r.pos);
  }
  _footsteps (av, pos, k) {
    const a = av.anim;
    if (a.moveW < 0.5 || a.in.airborne) { av._fp = a.phase; return; }
    const p = a.phase, q = av._fp ?? p;
    if ((q < 0.02 && p >= 0.02) || (q < 0.52 && p >= 0.52) || (q > p && p >= 0.02)) sfx.step(pos, k * (a.sprintW > 0.5 ? 1.4 : a.crouchW > 0.5 ? 0.4 : 1));
    av._fp = p;
  }
  _shake (pos, k) {
    const d = pos.distanceTo(this.renderPos);
    this.ots.shake = Math.max(this.ots.shake, k * Math.max(0, 1 - d / 14));
  }
  _stats (dt, now) {
    this.frames.push(dt);
    if (this.frames.length > 240) this.frames.shift();
    if (now - this.fpsT > 500) {
      this.fpsT = now;
      const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
      this.fpsNow = 1 / avg;
      this.hud.fps(settings.showFps ? `${Math.round(this.fpsNow)} FPS · ${this.renderer.info.render.calls} draw` : '');
      this.hud.net(this.net.open ? `${Math.round(this.net.rtt)} ms` : 'OFFLINE');
    }
  }

  /** QA: mashq rejimida o'yinchini ko'chirish (server pozani validatsiya qiladi) */
  qaTeleport (x, z, yaw, pitch = -0.05) {
    this.qaHold = performance.now() + 2500;
    teleportMovement(this.move, x, z, yaw);
    this.prev = { ...this.move.pos };
    this.ots.yaw = yaw; this.ots.pitch = pitch;
  }

  scoreRows () {
    const rows = [];
    const me = this.mySnap;
    rows.push({ id: this.net.playerId, name: this.playerName, team: this.team, kills: me ? me.kills : (this.state?.stats?.kills || 0), deaths: me ? me.deaths : (this.state?.stats?.deaths || 0), hp: this.state ? this.state.hp : 100, alive: this.alive });
    for (const r of this.remotes.values()) rows.push({ id: r.id, name: r.name || r.id, team: r.team, kills: r.kills || 0, deaths: r.deaths || 0, hp: r.hp, alive: r.alive });
    return rows;
  }
  results () { return { match: this.match, rows: this.scoreRows(), myTeam: this.team, myId: this.net.playerId }; }

  stop () {
    this.running = false; this.ended = true;
    cancelAnimationFrame(this.raf);
    this.input.setEnabled(false);
    this.input.releaseLock();
  }
  dispose () {
    this.stop();
    for (const off of this.offs) off();
    removeEventListener('resize', this.onResize);
    removeEventListener('keydown', this._chatKey);
    document.removeEventListener('pointerlockchange', this._plc);
    this.input.dispose();
    for (const r of this.remotes.values()) r.dispose();
    for (const d of this.dummies.values()) d.av.dispose();
    this.me.dispose();
    this.effects.dispose();
    this.arena.dispose();
    this.env.dispose(); this.bgTex.dispose();
    this.renderer.dispose();
    this.hudRoot.innerHTML = '';
    if (window.__ns === this) window.__ns = null;
  }
}
