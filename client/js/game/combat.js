// ============================================================
// NEON STRIKE — PHASE 4: LOKAL COMBAT CONTROLLER (klient adapteri)
// Bu modul QOIDALARNI BILMAYDI: barcha qoidalar shared/combat.js da.
// Vazifasi:
//   1) har kadr: player pozasi + kamera → aim nuri (origin/dir)
//   2) intents (fire/reload/switch) → shared stepCombat()
//   3) natija hodisalari (hit/blocked/miss/grenade/kill/death/respawn)
//      → vizual effektlar + HUD
//   4) nishon vizuallarini (o'lim/tirilish) sinxronlash
// Tarmoq YO'Q (Phase 4 lokal) — Phase 5 da shu controller server natijasini
// ko'rsatuvchi adapterga aylanadi.
// ============================================================
import {
  createCombatState, stepCombat, combatSnapshot, damagePlayer, respawnPlayer
} from '/shared/combat.js';
import { WEAPON_ORDER, activeWeapon, refillLoadout, mulberry32 } from '/shared/weapons.js';
import { PLAYER, CAMERA } from '/shared/collision.js';
import { PALETTE, SOLID_BOXES, MAP } from '/shared/map.js';
import { resolveShot, createShotResult, humanoidZones, placeHumanoidZones } from '/shared/hitdetect.js';
// PHASE 1: yagona koordinata konvensiyasi + aim konvergensiyasi
import { forwardFromYaw, convergeDirection, deviationAngle, solveAimAngles } from '/shared/aim.js';
import { Effects } from './effects.js';
import { TargetRegistry } from './targets.js';
import { WeaponView } from './weapon-view.js';
import { CombatHud } from './hud.js';

const EYE = PLAYER.EYE;
const MOVING_SPEED = 0.6;      // shu tezlikdan yuqori — "harakatdagi spread"
/** Crosshair→o'q konvergensiyasi uchun minimal masofa (m) */
const AIM_MIN_CONVERGE = 1.2;
/** Konvergensiya kamera yo'nalishidan shu burchakdan ko'proq og'sa — bekor (rad) */
const AIM_MAX_DEVIATION = 35 * Math.PI / 180;
const MAP_FLOOR_Y = MAP.FLOOR_Y;

export class CombatController {
  constructor ({ scene, player, movement, cameraController, training, hud }) {
    this.scene = scene;
    this.player = player;
    this.movement = movement;
    this.cameraController = cameraController;
    this.training = training;

    // O'yinchi pozasi movement.pos bilan AYNI obyekt (respawn teleport uchun)
    this.state = createCombatState({ seed: 4, position: movement.pos });
    this.state.yaw = movement.faceYaw;

    this.effects = new Effects(scene);
    this.weaponView = new WeaponView(player.group);
    this.registry = new TargetRegistry(training, this.state);
    this.registry.registerAll();

    this.hud = hud instanceof CombatHud ? hud : new CombatHud(hud || {});
    this.hud.setVisible(true);
    /** PHASE 9: HUD uchun avtoritar ko'rinish (index.js beradi; null — offline) */
    this.hudView = null;

    this._aim = { origin: [0, 0, 0], dir: [0, 0, 1] };
    // PHASE 1: crosshair nuri → jahon nuqtasi ("otish nishoni")
    this._camOrigin = [0, 0, 0];
    this._camDir = [0, 0, 1];
    this._camDirAim = [0, 0, 0];
    this._aimPoint = [0, 0, 0];
    this._cross = createShotResult();
    this._crossTargets = [];
    this._peers = [];              // index.js to'ldiradi (masofaviy o'yinchilar)
    this.netPlayerId = null;       // server bergan o'z ID (EVENTS filtri uchun)
    this.aimKind = 'none';
    this.aimTargetId = '';
    this.aimDistance = 0;
    // PHASE 1: AVTORITAR PvP fikr-mulohaza hisoblagichlari (server EVENTS)
    this.fb = {
      peerHits: 0, peerKills: 0, damageTaken: 0, deathEvents: 0,
      lastDamage: 0, lastAttacker: '', lastHitTarget: '', lastHitDamage: 0,
      damageFrom: []            // eng oxirgi "zarar yo'nalishi" vektori (js=[x,y,z])
    };
    this._snap = {};
    this._muzzle = new (this.cameraController.camera.position.constructor)();
    this._muzzleDir = new (this.cameraController.camera.position.constructor)();
    this._lastWeaponId = '';
    this._moving = false;
    this.shots = 0;
    this.hits = 0;
    this.kills = 0;
    this.blocked = 0;
    this.selfDamageEvents = 0;
    this.grenadeThrows = 0;
    this.grenadeExplosions = 0;
    this.rejectReasons = Object.create(null);   // 'cooldown' | 'reloading' | 'switching' | 'semi-held' | 'empty' | 'dead'
  }

  get weaponId () { return activeWeapon(this.state.loadout).id; }

  /** Hozir harakatdami (spread + Phase 5 intent) */
  get moving () { return this._moving; }

  /**
   * Kamera yaw/pitch → normallashgan KAMERA yo'nalishi (shared/aim.js bilan
   * bir xil formula — verify-phase4 P4.9 shu qiymatni tekshiradi).
   */
  aimDir (out = this._aim.dir) {
    return forwardFromYaw(this.cameraController.yaw, this.cameraController.pitch, out);
  }

  /**
   * PHASE 1: crosshair (kamera nuri) qaysi jahon nuqtasiga to'g'ri keladi.
   * Devor/nishon/masofaviy o'yinchi — eng yaqin to'siq olinadi.
   * `null` EMAS: har doim nuqta qaytaradi (hech narsa tegmasa — range oxiri).
   */
  aimPoint (out = this._aimPoint) {
    const cam = this.cameraController;
    const o = this._camOrigin;
    o[0] = cam.pos.x; o[1] = cam.pos.y; o[2] = cam.pos.z;
    const d = forwardFromYaw(cam.yaw, cam.pitch, this._camDir);
    const wp = activeWeapon(this.state.loadout);
    const maxD = wp && Number.isFinite(wp.range) && wp.range > 0 ? wp.range : 60;
    const targets = this._crossTargets.length ? this._crossTargets : this.state.targets;
    const res = resolveShot({
      origin: o, dir: d, maxDistance: maxD,
      colliders: SOLID_BOXES, targets, out: this._cross
    });
    out[0] = res.point[0]; out[1] = res.point[1]; out[2] = res.point[2];
    this.aimKind = res.kind;
    this.aimTargetId = res.targetId || '';
    this.aimDistance = res.distance;
    return out;
  }

  /**
   * PHASE 1: AVTORITATIV otish yo'nalishi = ko'z nuqtasi → crosshair nuqtasi.
   * Shu tufayli crosshair nima ko'rsatsa, o'q AYNAN o'sha yerga boradi
   * (ilgari: kamera nuri va ko'z nuri PARALLEL edi → doimiy lateral xato).
   * Degenerativ holat (nuqta juda yaqin / haddan tashqari og'ish) → kamera
   * yo'nalishining o'zi ishlatiladi.
   */
  shotDir (out = this._aim.dir) {
    const camDir = this.aimDir(this._camDirAim);
    const ap = this.aimPoint();
    const o = this.aimOrigin();
    const conv = convergeDirection(ap, o, out, { minDistance: AIM_MIN_CONVERGE });
    if (!conv) return this.aimDir(out);
    if (deviationAngle(conv, camDir) > AIM_MAX_DEVIATION) return this.aimDir(out);
    return conv;
  }

  /**
   * PHASE 1: crosshair nuri uchun masofaviy o'yinchilar (server avtoritar
   * holatidan interpolatsiya qilingan pozitsiyalar). `peers` — [{id,alive,x,y,z}].
   * Lokal nishon ro'yxati = training nishonlari + masofaviy o'yinchilar
   * (server tomonidagi `_shotTargets` bilan bir xil semantika).
   */
  setPeerTargets (peers) {
    const list = Array.isArray(peers) ? peers : [];
    const arr = this._peers;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      let e = arr[i];
      if (!e) e = arr[i] = { id: '', alive: true, zones: humanoidZones(0, 0, 0) };
      e.id = String(p.id);
      e.alive = p.alive !== false;
      // server bilan AYNAN bir xil zona geometriyasi (shared/hitdetect)
      placeHumanoidZones(e.zones, p.x, p.y || 0, p.z);
    }
    if (arr.length > list.length) arr.length = list.length;
    const ct = this._crossTargets;
    ct.length = 0;
    for (let i = 0; i < this.state.targets.length; i++) ct.push(this.state.targets[i]);
    for (let i = 0; i < arr.length; i++) ct.push(arr[i]);
    return arr.length;
  }

  /** Ko'z nuqtasi (o'yinchi pozasi + EYE) */
  aimOrigin (out = this._aim.origin) {
    const p = this.movement.pos;
    out[0] = p.x; out[1] = p.y + EYE; out[2] = p.z;
    return out;
  }

  /**
   * Bir kadr: intents → shared stepCombat → vizual.
   * @param {number} dtMs
   * @param {number} now performance.now() (shared engine uchun monotonik ms)
   * @param {object} intents input.consumeIntents() natijasi
   */
  update (dtMs, now, intents = {}) {
    const st = this.state;
    const cam = this.cameraController;

    // 0) PHASE 1: recoil qaytarilishi (kadr boshida — vaqt bo'yicha)
    cam.decayRecoil(dtMs / 1000);

    // 1) pozani engine'ga yozish (shared setPose bilan bir xil semantika)
    //    PHASE 1: aim yo'nalishi endi CROSSHAIR nuqtasiga KONVERGENT
    this.aimOrigin();
    this.shotDir();
    st.position.x = this.movement.pos.x;
    st.position.y = this.movement.pos.y;
    st.position.z = this.movement.pos.z;
    st.yaw = cam.yaw;
    st.pitch = cam.pitch;

    // 2) intents
    let switchTo = null;
    if (intents.switchSlot >= 1 && intents.switchSlot <= WEAPON_ORDER.length) {
      switchTo = WEAPON_ORDER[intents.switchSlot - 1];
    }
    this._moving = this.movement.speed > MOVING_SPEED;

    const R = stepCombat(st, now, dtMs, {
      fire: !!intents.fire,
      firePressed: !!intents.firePressed,
      reload: !!intents.reload,
      switchTo,
      moving: this._moving
    }, { origin: this._aim.origin, dir: this._aim.dir });

    // 3) rad etilgan o'q sabablari (HUD/debug/QA — kadr bo'yicha yo'qolmaydi)
    if (R.shotsRejected) {
      const rn = R.shot.reason || 'unknown';
      this.rejectReasons[rn] = (this.rejectReasons[rn] || 0) + 1;
    }

    // 4) natija → effektlar / HUD
    this._applyEvents(R, now, dtMs);

    // 5) respawn bo'lsa: kamera yaw + harakat holati spawn'ga qaytadi
    if (R.respawned) {
      cam.yaw = st.yaw;
      cam.pitch = 0;
      cam.first = true;
      this.movement.teleport(st.position.x, st.position.z, st.yaw, st.position.y);
    }

    // 6) nishon vizuallari (o'lim so'nishi / tirilish)
    this.registry.sync(dtMs);

    // 7) qurol ko'rinishi
    const wid = this.weaponId;
    if (wid !== this._lastWeaponId) {
      this.weaponView.setWeapon(wid);
      this._lastWeaponId = wid;
    }
    this.weaponView.setSuppressed(cam.last.distance < 1.05);
    this.weaponView.update(cam.yaw, cam.pitch, this.movement.faceYaw);
    if (st.health.alive && !this.weaponView.visible) this.weaponView.setVisible(true);

    // 8) effekt TTL
    this.effects.update(dtMs);

    // 9) HUD
    // PHASE 9: HUD avtoritar server holatini AFZAL ko'radi (`setHudView` bilan
    // beriladi — client/js/game/hud-state.js). Avtoritar sessiya bo'lmasa
    // (offline TRAINING) lokal bashorat ko'rsatiladi. Hisoblash BU YERDA YO'Q.
    const snap = this.snapshot();
    snap.moving = this._moving;
    this.hud.update(dtMs, snap, this.hudView);
    return R;
  }

  /** Engine hodisalarini vizual effektlarga aylantirish */
  _applyEvents (R, now, dtMs) {
    const cam = this.cameraController;
    const muzzle = this.weaponView.muzzleWorld(this._muzzle);
    const from = muzzle ? [muzzle.x, muzzle.y, muzzle.z] : this._aim.origin;
    let traced = 0;

    if (R.shot.accepted) {
      this.shots += 1;
      this.effects.muzzleFlash(from[0], from[1], from[2], cam.camera.quaternion);
      // PHASE 1: qurol tepkisi (VISUAL). Deterministik yaw kick — seed+shotId.
      // Kamera ham, crosshair ham birga siljiydi → moslik saqlanadi.
      const wp = activeWeapon(this.state.loadout);
      const rec = wp && wp.recoil;
      if (rec && (rec.pitch || rec.yaw)) {
        const rng = mulberry32((this.state.loadout.seed ^ (R.shot.shotId * 7919)) >>> 0);
        const yawKick = rec.yaw ? (rng() * 2 - 1) * rec.yaw : 0;
        cam.applyRecoil(rec.pitch, yawKick);
      }
    }

    for (let i = 0; i < R.eventCount; i++) {
      const ev = R.events[i];
      switch (ev.type) {
        case 'hit':
          this.effects.tracer(from, [ev.x, ev.y, ev.z]);
          this.effects.spark(ev.x, ev.y, ev.z, PALETTE.TARGET);
          this.hud.hitMarker();
          this.hits += 1;
          break;
        case 'blocked':
          this.effects.tracer(from, [ev.x, ev.y, ev.z]);
          this.effects.spark(ev.x, ev.y, ev.z, PALETTE.TRIM);
          this.blocked += 1;
          break;
        case 'miss':
          if (traced < 6) { this.effects.tracer(from, [ev.x, ev.y, ev.z]); traced += 1; }
          break;
        case 'kill':
          this.kills += 1;
          this.effects.deathPuff(ev.x, ev.y, ev.z);
          this.hud.pushFeed(`DOWN · ${ev.targetId} · ${ev.zone.toUpperCase()} · ${ev.weaponId}`);
          break;
        case 'grenade-throw':
          this.grenadeThrows += 1;
          break;
        case 'grenade-explode':
          this.grenadeExplosions += 1;
          this.effects.blast(ev.x, ev.y, ev.z, 1);
          this.hud.pushFeed('ENERGY GRENADE · DETONATED');
          break;
        case 'self-damage':
          if (ev.damage > 0) {
            this.selfDamageEvents += 1;
            this.hud.damageFlash(ev.damage);
            this.hud.pushFeed(`SELF DAMAGE −${Math.round(ev.damage)}`);
          }
          break;
        case 'death':
          this.hud.damageFlash(100);
          this.hud.pushFeed('YOU WERE DOWNED');
          break;
        case 'respawn':
          this.hud.pushFeed('RESPAWNED · SPAWN A');
          break;
        case 'reload-start':
          break;
        case 'reload-end':
          break;
        case 'weapon-switch':
          this.hud.pushFeed(`EQUIP · ${ev.weaponId.toUpperCase()}`);
          break;
        default:
          break;
      }
    }
  }

  /** QA/HUD uchun snapshot (qayta ishlatiladigan out) */
  snapshot (out = this._snap) {
    return combatSnapshot(this.state, out);
  }

  /** Lokal test nishoni (QA) */
  addTestTarget (x, z, id) { return this.registry.spawnTestTarget(x, z, id); }

  /** O'yinchiga zarar (Phase 4: o'z granatasi + QA) — shared yo'l */
  damage (amount, sourceId = 'test', now = this.state.now) {
    return damagePlayer(this.state, amount, sourceId, now);
  }

  /**
   * Nishonni nishonga olish uchun yaw/pitch hisoblash (QA/verifikatsiya).
   * PHASE 1: endi CROSSHAIR shu nuqtaga tushadigan qilib yechim topiladi —
   * kamera pozasi yaw/pitch ga bog'liq bo'lgani uchun 3 marta qayta hisoblanadi
   * (fixed-point). Shu bilan "aim qilingan nuqta = crosshair nuqtasi".
   */
  aimAtPoint (x, y, z) {
    const cam = this.cameraController;
    let { yaw, pitch } = solveAimAngles(this.movement.pos, [x, y, z], CAMERA, 8);
    if (cam) {
      // HAQIQIY kamera quvurini takrorlaymiz (sweep + minY klamp + smoothing
      // boshlanishi). Sof model devor yonida siljib ketishi mumkin, shuning
      // uchun aniq yechim faqat real kamera pozasi bilan topiladi.
      for (let i = 0; i < 6; i++) {
        cam.yaw = yaw;
        cam.pitch = pitch;
        cam.first = true;
        cam.update(1 / 60, this.movement.pos, MAP_FLOOR_Y);
        const cp = cam.pos;
        const dx = x - cp.x;
        const dy = y - cp.y;
        const dz = z - cp.z;
        yaw = Math.atan2(dx, dz);
        let p = Math.atan2(dy, Math.hypot(dx, dz));
        if (p < CAMERA.PITCH_MIN) p = CAMERA.PITCH_MIN;
        else if (p > CAMERA.PITCH_MAX) p = CAMERA.PITCH_MAX;
        pitch = p;
      }
      cam.yaw = yaw;
      cam.pitch = pitch;
      cam.clearRecoil();
      cam.first = true;
      cam.update(1 / 60, this.movement.pos, MAP_FLOOR_Y);
    }
    this.state.yaw = yaw;
    this.aimOrigin();
    this.shotDir();
    this.aimPoint();
    return { yaw, pitch, camPos: [cam.pos.x, cam.pos.y, cam.pos.z] };
  }

  /** Nishon markaziga qarab nishonga olish */
  aimAtTarget (targetId) {
    const c = this.registry.centreOf(targetId);
    if (!c) return null;
    return this.aimAtPoint(c.x, c.y, c.z);
  }

  /**
   * PHASE 1: AVTORITAR PvP hodisalarini qabul qilish (server EVENTS → main.js).
   * FAQAT taqdimot/feedback: HP, o'lim, zarar AVTORITETI serverda qoladi.
   * Klient bashorati hech qachon "soxta kill" yaratmaydi — barcha raqamlar
   * server hodisalaridan olinadi.
   * @returns {number} qabul qilingan hodisalar soni
   */
  applyAuthoritativeEvents (events) {
    if (!Array.isArray(events) || !events.length) return 0;
    const myId = this.netPlayerId || null;
    let n = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || typeof ev.type !== 'string') continue;
      switch (ev.type) {
        case 'hit':
          // faqat BOSHQA o'yinchiga tegilgan o'q (dummy emas)
          if (myId && ev.targetId === myId) break;
          if (!/^p\d+$/.test(ev.targetId || '')) break;
          this.hud.hitMarker();
          this.hud.damageNumber(ev.damage);
          this.fb.peerHits += 1;
          this.fb.lastHitTarget = ev.targetId;
          this.fb.lastHitDamage = ev.damage;
          n += 1;
          break;
        case 'kill':
          if (myId && ev.targetId === myId) break;
          if (!/^p\d+$/.test(ev.targetId || '')) break;
          this.effects.deathPuff(ev.x, ev.y, ev.z);
          this.hud.pushFeed(`DOWN · ${ev.targetId} · ${ev.weaponId}`);
          this.fb.peerKills += 1;
          n += 1;
          break;
        case 'damage-taken':
          this.fb.damageTaken += ev.damage || 0;
          this.fb.lastDamage = ev.damage || 0;
          this.fb.lastAttacker = ev.attackerId || '';
          if (Array.isArray(ev.from)) this.fb.damageFrom = ev.from.slice(0, 3);
          this.hud.damageFlash(ev.damage || 0);
          this.hud.damageDirection(ev.from, this.movement.pos, this.cameraController.yaw);
          this.hud.pushFeed(`${ev.attackerId || '?'} → SIZ −${Math.round(ev.damage || 0)}`);
          n += 1;
          break;
        case 'death':
          this.fb.deathEvents += 1;
          this.hud.damageFlash(100);
          this.hud.damageDirection(ev.from, this.movement.pos, this.cameraController.yaw);
          this.hud.pushFeed(`DOWNED BY ${ev.attackerId || '?'}`);
          n += 1;
          break;
        default:
          break;
      }
    }
    return n;
  }

  /**
   * PHASE 1: mahalliy o'yinchining holatini AVTORITAR tiriklik holatiga
   * moslashtirish (server snapshot'idagi `players[me].alive`).
   *
   * NEGA: P5/P8 avtoritetida dushman o'ldirsa ham klientning lokal holati
   * tirik qolib, o'q otishni "davom ettirardi" (server rad etardi → otish
   * hissi buzilardi). Endi o'lim MAHALLIY cheklovga olib keladi
   * (`FIRE_REASON.DEAD`), raund boshida esa server qayta tiriltirgani uchun
   * holat tiklanadi. Bu FAQAT cheklov/taqdimot: zarar/HP/oltirish avtoriteti
   * serverda (klient hech qachon o'z holatini serverga majburlab qo'ymaydi).
   * @param {boolean|null} alive server bergan tiriklik (null — noma'lum)
   * @returns {boolean} holat o'zgardi
   */
  syncAuthoritativeAlive (alive) {
    if (alive === null || alive === undefined) return false;
    const want = alive !== false;
    const h = this.state.health;
    if (h.alive === want) return false;
    if (want) {
      // Server qayta tiriltirdi (raund boshi): HP/o'q-dori ticklanadi va
      // pozitsiya spawn'ga qaytadi — keyin rekonsiliatsiya server pozitsiyasini
      // o'zi tortib oladi (server holati USTUN).
      respawnPlayer(this.state, this.state.now);
      return true;
    }
    h.alive = false;
    h.hp = 0;
    this.state.respawnAt = Infinity;
    return true;
  }

  /** QA: qurol mesh ko'rinishi + muzzle jahon pozasi */
  weaponProbe () {
    const m = this.weaponView.muzzleWorld(this._muzzle);
    const d = this.weaponView.muzzleWorldDir(this._muzzleDir);
    return {
      weaponId: this.weaponView.activeId,
      visible: this.weaponView.visible,
      models: Object.keys(this.weaponView.models).length,
      muzzle: m ? [m.x, m.y, m.z] : null,
      muzzleDir: d ? [d.x, d.y, d.z] : null,
      aimDir: [this._aim.dir[0], this._aim.dir[1], this._aim.dir[2]],
      // PHASE 1: crosshair/camera math (verify-phase1 ishlatadi)
      camDir: [this._camDir[0], this._camDir[1], this._camDir[2]],
      camPos: [this._camOrigin[0], this._camOrigin[1], this._camOrigin[2]],
      aimPoint: [this._aimPoint[0], this._aimPoint[1], this._aimPoint[2]],
      aimKind: this.aimKind,
      aimTargetId: this.aimTargetId,
      aimDistance: +this.aimDistance.toFixed(3),
      shotDir: [this._aim.dir[0], this._aim.dir[1], this._aim.dir[2]],
      recoil: {
        pitch: +(this.cameraController.recoilPitch || 0).toFixed(5),
        yaw: +(this.cameraController.recoilYaw || 0).toFixed(5),
        shots: this.cameraController.recoilShots || 0
      }
    };
  }

  /**
   * PHASE 9: HUD uchun AVTORITAR ko'rinishni o'rnatish (hud-state.js natijasi).
   * `null` → offline TRAINING: HUD lokal bashoratni ko'rsatadi.
   * Bu metod HECH NARSA hisoblamaydi — faqat ko'rsatiladigan qiymatni beradi.
   */
  setHudView (view) {
    this.hudView = view && view.authoritative ? view : null;
    return this.hudView;
  }

  /** Server bergan o'z playerId si (faqat EVENTS filtri uchun) */
  setPlayerId (id) {
    this.netPlayerId = id || null;
    return this.netPlayerId;
  }

  /** QA: to'liq combat holati (JSON-xavfsiz) */
  qa () {
    const s = this.snapshot();
    return {
      shots: this.shots,
      hits: this.hits,
      kills: this.kills,
      blocked: this.blocked,
      selfDamageEvents: this.selfDamageEvents,
      grenadeThrows: this.grenadeThrows,
      grenadeExplosions: this.grenadeExplosions,
      hp: s.hp,
      alive: s.alive,
      deaths: s.deaths,
      respawnIn: s.respawnIn,
      weapon: s.weapon,
      stats: s.stats,
      targets: s.targets.map((t) => ({
        id: t.id, alive: t.alive, hp: t.hp, deaths: t.deaths, respawnIn: t.respawnIn
      })),
      targetVisuals: this.state.targets.map((t) => this.registry.probe(t.id)).filter(Boolean),
      effectsActive: this.effects.activeCount,
      grenadesActive: s.grenades,
      rejectReasons: { ...this.rejectReasons },
      // PHASE 1: crosshair ↔ o'q konvergensiyasi (dalil maydonlari)
      aim: {
        kind: this.aimKind,
        targetId: this.aimTargetId,
        distance: +this.aimDistance.toFixed(3),
        camDir: [this._camDir[0], this._camDir[1], this._camDir[2]],
        shotDir: [this._aim.dir[0], this._aim.dir[1], this._aim.dir[2]],
        camPos: [this._camOrigin[0], this._camOrigin[1], this._camOrigin[2]],
        point: [this._aimPoint[0], this._aimPoint[1], this._aimPoint[2]],
        recoil: {
          pitch: +(this.cameraController.recoilPitch || 0).toFixed(5),
          yaw: +(this.cameraController.recoilYaw || 0).toFixed(5),
          shots: this.cameraController.recoilShots || 0
        }
      },
      // PHASE 1: AVTORITAR PvP feedback (server EVENTS dan; bashorat EMAS)
      feedback: { ...this.fb, damageFrom: this.fb.damageFrom.slice(0, 3) },
      peers: this._peers.length,
      hud: this.hud.state(s)
    };
  }

  /** Sessiya qayta boshlash: o'yinchi + nishonlar + effektlar tozalanadi */
  reset () {
    const st = this.state;
    // o'yinchi: HP/o'q-dori/pozitsiya (shared respawn yo'li — spawn validligi bilan)
    respawnPlayer(st, st.now);
    st.respawnAt = Infinity;
    // slot statistikasi ham tozalanadi: mag+reserve+shotsFired == doimiy bo'lishi
    // uchun shotsFired reset paytida nolga tushishi SHART (akslanmagan holda
    // o'q-dori hisobi buziladi).
    refillLoadout(st.loadout, { keepStats: false });
    // granatalar/o'q-dori/qoidalar
    st.grenades.length = 0;
    st.grenadeSeq = 0;
    st.result.eventCount = 0;
    st.damageSeq = 0;
    Object.assign(st.stats, {
      shots: 0, hits: 0, blocked: 0, kills: 0, deaths: 0, respawns: 0,
      damageDealt: 0, damageTaken: 0, selfDamage: 0, dryFires: 0,
      grenadeThrows: 0, grenadeExplosions: 0, targetsKilled: 0
    });
    for (const t of st.targets) {
      t.health.hp = t.health.max;
      t.health.alive = true;
      t.health.deaths = 0;
      t.respawnAt = Infinity;
    }
    this.registry.resetTestTargets();
    this.registry.sync(0);
    this.effects.clear();
    this.movement.teleport(st.position.x, st.position.z, st.yaw, st.position.y);
    this.cameraController.yaw = st.yaw;
    this.cameraController.first = true;
    this.shots = 0; this.hits = 0; this.kills = 0; this.blocked = 0;
    this.selfDamageEvents = 0; this.grenadeThrows = 0; this.grenadeExplosions = 0;
    this.rejectReasons = Object.create(null);
    this.cameraController.clearRecoil();
    this.fb = {
      peerHits: 0, peerKills: 0, damageTaken: 0, deathEvents: 0,
      lastDamage: 0, lastAttacker: '', lastHitTarget: '', lastHitDamage: 0,
      damageFrom: []
    };
    return st;
  }
}
