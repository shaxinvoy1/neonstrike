// ============================================================
// NEON STRIKE — PHASE 4: COMBAT DVIGATELI (SOF QOIDALAR, SOF HOLAT)
// three.js / DOM / renderer YO'Q. Vaqt (now, dt) tashqaridan beriladi.
// Bu modul PHASE 5 da serverda AYNAN shu ko'rinishda ishlatiladi:
//   intents (trigger/reload/switch) + aim ray → COMBAT LOGIC → DAMAGE RESULT
// Klient faqat: (1) intents yig'adi, (2) natijani render/HUD ga uzatadi.
// ============================================================
import { SOLID_BOXES, SPAWNS, MAP } from './map.js';
import { HEALTH, createHealth, applyDamage, resetHealth } from './health.js';
import {
  WEAPONS, createLoadout, activeWeapon, loadoutSnapshot,
  tryFire, startReload, stepLoadout, switchTo, computeDamage
} from './weapons.js';
import { resolveShot, createShotResult, humanoidZones, ringZone, placeHumanoidZones } from './hitdetect.js';
import { pickSpawn, defaultRespawnCandidates, applyRespawn } from './respawn.js';
import { createGrenade, stepGrenade, explodeGrenade } from './grenade.js';

/** Bitta kadrda yozib ulguriladigan hodisalar budjeti (bounded) */
export const EVENT_CAPACITY = 64;
/** Bir vaqtda faol granata budjeti */
export const GRENADE_CAPACITY = 8;
/** Sub'ekt (granata nishonlari) budjeti */
const SUBJECT_CAPACITY = 24;

export const TARGET_CENTRE_Y = 1.15;   // dummy "ko'krak" nuqtasi (granata/LOS uchun)
export const PLAYER_CENTRE_Y = 1.1;

const EMPTY = {};
const EMPTY_LIST = [];

function createEvent () {
  return {
    type: '', targetId: '', zone: '', weaponId: '', reason: '',
    damage: 0, distance: 0, blocked: false, los: true,
    x: 0, y: 0, z: 0
  };
}

/** Natija (har kadr qayta ishlatiladi — allokatsiya yo'q) */
function createResult () {
  const events = [];
  for (let i = 0; i < EVENT_CAPACITY; i++) events.push(createEvent());
  return {
    now: 0,
    eventCount: 0,
    droppedEvents: 0,
    shot: { accepted: false, reason: '', weaponId: '', shotId: 0, pellets: 0, spreadDeg: 0 },
    shotsAccepted: 0,
    shotsRejected: 0,
    pelletsFired: 0,
    hits: 0,
    blockedHits: 0,
    kills: 0,
    damageTotal: 0,
    friendlyBlocked: 0,
    reloadCompleted: 0,
    weaponSwitched: false,
    respawned: false,
    died: false,
    explosions: 0,
    grenadesActive: 0,
    targetId: '',
    zone: '',
    lastHitDamage: 0,
    events
  };
}

/**
 * Combat holati. `position` — o'yinchi OYOG'i (Movement.pos bilan bir xil
 * obyekt ulashilishi mumkin: klient sinxronlaydi).
 */
export function createCombatState (opts = {}) {
  const seed = opts.seed === undefined ? 20260917 : opts.seed;
  const state = {
    boxes: opts.boxes || SOLID_BOXES,
    floorY: opts.floorY === undefined ? MAP.FLOOR_Y : opts.floorY,
    spawns: opts.spawns || defaultRespawnCandidates(),
    playerSpawn: opts.playerSpawn || SPAWNS.A,
    seed,
    now: 0,
    loadout: opts.loadout || createLoadout({ seed }),
    health: opts.health || createHealth(HEALTH.PLAYER_MAX, { label: 'player' }),
    position: opts.position || { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z },
    yaw: opts.yaw === undefined ? SPAWNS.A.yaw : opts.yaw,
    pitch: 0,
    aimOrigin: [SPAWNS.A.x, SPAWNS.A.y + 1.62, SPAWNS.A.z],
    aimDir: [0, 0, 1],
    respawnAt: Infinity,
    respawnCount: 0,
    // PHASE 1: dushman o'ldirgani hisobga olindi (raund ichida bir marta)
    externalDeath: false,
    damageSeq: 0,
    targets: [],
    targetById: new Map(),
    grenades: [],
    grenadeSeq: 0,
    stats: {
      shots: 0, hits: 0, blocked: 0, kills: 0, deaths: 0, respawns: 0,
      damageDealt: 0, damageTaken: 0, selfDamage: 0, dryFires: 0,
      grenadeThrows: 0, grenadeExplosions: 0, targetsKilled: 0
    },
    // ---- PHASE 8: boshqa o'yinchilar (server to'ldiradi; standart BO'SH) ----
    ownerId: opts.ownerId || 'player',   // otuvchi kimligi (eventId namespace)
    peerTargets: [],                     // faqat server to'ldiradi (setPeerTargets)
    peerById: new Map(),
    _shotTargets: [],                    // targets + peers (qayta ishlatiladi)
    _shotResult: createShotResult(),
    _subjects: [],
    _subjectCount: 0,
    _loadoutSnap: {},
    result: createResult()
  };
  for (let i = 0; i < SUBJECT_CAPACITY; i++) state._subjects.push({ id: '', kind: '', x: 0, y: 0, z: 0 });
  return state;
}

// ---------------- nishonlar ----------------
/**
 * Nishon qo'shadi (training dummy / halqa / lokal test nishoni).
 * @param {{id:string, kind?:string, x:number, y?:number, z:number, hp?:number, respawnMs?:number}} cfg
 */
export function addTarget (state, cfg) {
  if (!cfg || !cfg.id) return null;
  const kind = cfg.kind || 'dummy';
  const y = cfg.y === undefined ? state.floorY : cfg.y;
  const hp = cfg.hp || (kind === 'ring' ? HEALTH.RING_MAX : HEALTH.TARGET_MAX);
  const target = {
    id: cfg.id,
    kind,
    x: cfg.x,
    y,
    z: cfg.z,
    yaw: cfg.yaw === undefined ? 0 : cfg.yaw,
    health: createHealth(hp, { label: cfg.id }),
    zones: kind === 'ring' ? ringZone(cfg.x, y, cfg.z) : humanoidZones(cfg.x, y, cfg.z),
    centre: { x: cfg.x, y: kind === 'ring' ? y : y + TARGET_CENTRE_Y, z: cfg.z },
    respawnMs: cfg.respawnMs === undefined ? HEALTH.TARGET_RESPAWN_MS : cfg.respawnMs,
    respawnAt: Infinity,
    snap: {
      id: cfg.id, kind, hp, max: hp, alive: true,
      x: cfg.x, y, z: cfg.z, centreY: 0, deaths: 0, respawnIn: 0
    }
  };
  target.snap.centreY = target.centre.y;
  state.targets.push(target);
  state.targetById.set(cfg.id, target);
  return target;
}

export function removeTarget (state, id) {
  const t = state.targetById.get(id);
  if (!t) return false;
  state.targetById.delete(id);
  const i = state.targets.indexOf(t);
  if (i >= 0) state.targets.splice(i, 1);
  return true;
}

export function clearTargets (state) {
  state.targets.length = 0;
  state.targetById.clear();
  return state;
}

/**
 * PHASE 8: boshqa o'yinchilarni OTISH NISHONASI sifatida o'rnatish.
 * `peers` — [{id, x, y, z, health, alive, friendly, teamId}] (SERVER to'ldiradi).
 *
 * MUHIM: bo'sh massiv → Phase 4/5 xatti-harakati AYNAN saqlanadi (peer yo'q,
 * `state.targets` ishlatiladi) — training/standalone rejimi o'zgarmaydi.
 * Zonalar qayta ishlatiladi va JOYIDA ko'chiriladi (allokatsiya yo'q).
 * @returns {number} faol peer nishonlar soni
 */
export function setPeerTargets (state, peers) {
  const arr = state.peerTargets;
  const list = Array.isArray(peers) ? peers : EMPTY_LIST;
  // 1) kerak bo'lmagan peer'larni olib tashlash (uzilgan o'yinchi → nishon yo'q)
  if (arr.length > list.length) arr.length = list.length;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    let t = arr[i];
    if (!t) {
      t = arr[i] = {
        id: '', kind: 'player', health: null, friendly: false, teamId: null,
        alive: true, respawnAt: Infinity, respawnMs: Infinity,
        zones: humanoidZones(0, 0, 0), centre: { x: 0, y: 0, z: 0 }
      };
    }
    t.id = String(p.id);
    t.health = p.health || null;
    t.friendly = p.friendly === true;
    t.teamId = p.teamId || null;
    // PHASE 1: shaffof havola (server sessiyasi) — jabrlanuvchining AVTORITAR
    // hodisa qutisi (`owner.incoming`) shu orqali to'ldiriladi. Mantiqqa
    // ta'sir qilmaydi; klient bu maydonni HECH QACHON o'rnatmaydi.
    t.owner = p.owner || null;
    t.alive = p.alive !== false;
    // cho'kkalagan o'yinchining hit-zonalari past (movement CROUCH.SCALE bilan bir xil)
    const hs = p.crouch ? 0.68 : 1;
    placeHumanoidZones(t.zones, p.x, p.y, p.z, { heightScale: hs });
    t.centre.x = p.x; t.centre.y = p.y + TARGET_CENTRE_Y * hs; t.centre.z = p.z;
  }
  // 2) id → nishon xaritasi (otish natijasini hal qilish uchun)
  state.peerById.clear();
  for (let i = 0; i < arr.length; i++) state.peerById.set(arr[i].id, arr[i]);
  // 3) otish nishonalari ro'yxati (targets + peers) — qayta ishlatiladi
  const st = state._shotTargets;
  st.length = 0;
  for (let i = 0; i < state.targets.length; i++) st.push(state.targets[i]);
  for (let i = 0; i < arr.length; i++) st.push(arr[i]);
  return arr.length;
}

export function getTarget (state, id) { return state.targetById.get(id) || null; }

/**
 * Grenata sub'ektlari ro'yxati (joyida to'ldiriladi — allokatsiya yo'q).
 * PHASE 1: endi BOSHQA O'YINCHILAR ham sub'ekt (ilgari faqat nishonlar va
 * o'zining o'zi edi → granata dushmanga zarar BERMASDI). Turlar:
 *   'target' — training nishoni/dummy · 'self' — granata tashlovchining o'zi
 *   'peer'   — boshqa o'yinchi (server avtoritativ health obyekti bilan)
 */
function fillSubjects (state) {
  const subs = state._subjects;
  let n = 0;
  for (let i = 0; i < state.targets.length; i++) {
    const t = state.targets[i];
    if (!t.health.alive) continue;
    let s = subs[n];
    if (!s) { s = { id: '', kind: '', x: 0, y: 0, z: 0 }; subs[n] = s; }
    s.id = t.id; s.kind = 'target';
    s.x = t.centre.x; s.y = t.centre.y; s.z = t.centre.z;
    n += 1;
  }
  if (state.health.alive) {
    let s = subs[n];
    if (!s) { s = { id: '', kind: '', x: 0, y: 0, z: 0 }; subs[n] = s; }
    s.id = 'player'; s.kind = 'self';
    s.x = state.position.x;
    s.y = state.position.y + PLAYER_CENTRE_Y;
    s.z = state.position.z;
    n += 1;
  }
  for (let i = 0; i < state.peerTargets.length; i++) {
    const p = state.peerTargets[i];
    if (!p.health || p.alive === false || !p.health.alive) continue;
    let s = subs[n];
    if (!s) { s = { id: '', kind: '', x: 0, y: 0, z: 0 }; subs[n] = s; }
    s.id = p.id; s.kind = 'peer';
    s.x = p.centre.x; s.y = p.centre.y; s.z = p.centre.z;
    n += 1;
  }
  state._subjectCount = n;
  return subs;
}

/** PHASE 1: jabrlanuvchining avtoritar hodisa qutisi (server to'ldiradi) */
function pushIncoming (target, ev) {
  const box = target && target.owner && target.owner.incoming;
  if (!box) return false;
  if (box.length >= 16) return false;         // chegaralangan (bounded)
  box.push(ev);
  return true;
}

// ---------------- hodisalar (bounded, qayta ishlatiladigan) ----------------
function emit (state, type, o = EMPTY) {
  const R = state.result;
  if (R.eventCount >= EVENT_CAPACITY) { R.droppedEvents += 1; return null; }
  const ev = R.events[R.eventCount];
  ev.type = type;
  ev.targetId = o.targetId || '';
  ev.zone = o.zone || '';
  ev.weaponId = o.weaponId || '';
  ev.reason = o.reason || '';
  ev.damage = o.damage || 0;
  ev.distance = o.distance || 0;
  ev.blocked = !!o.blocked;
  ev.los = o.los === undefined ? true : !!o.los;
  ev.x = o.x === undefined ? 0 : o.x;
  ev.y = o.y === undefined ? 0 : o.y;
  ev.z = o.z === undefined ? 0 : o.z;
  R.eventCount += 1;
  return ev;
}

/** O'yinchi pozasi (har kadr klient tomonidan yangilanadi) */
export function setPose (state, position, yaw, pitch) {
  if (position) {
    if (Number.isFinite(position.x)) state.position.x = position.x;
    if (Number.isFinite(position.y)) state.position.y = position.y;
    if (Number.isFinite(position.z)) state.position.z = position.z;
  }
  if (Number.isFinite(yaw)) state.yaw = yaw;
  if (Number.isFinite(pitch)) state.pitch = pitch;
  return state;
}

/** Nishon holatini yangilash (respawn/hisoblagichlar uchun snapshot yangilanadi) */
function syncSnap (t, now) {
  const s = t.snap;
  s.hp = t.health.hp;
  s.max = t.health.max;
  s.alive = t.health.alive;
  s.deaths = t.health.deaths;
  s.respawnIn = t.health.alive ? 0 : Math.max(0, (t.respawnAt - now) / 1000);
  return s;
}

// ---------------- o'yinchi: zarar / o'lim / respawn ----------------
function onPlayerDeath (state, now) {
  state.respawnAt = now + HEALTH.PLAYER_RESPAWN_MS;
  state.result.died = true;
  state.stats.deaths += 1;
  emit(state, 'death', {
    targetId: 'player', x: state.position.x, y: state.position.y, z: state.position.z
  });
}

/**
 * PHASE 1: BOSHQA o'yinchi (dushman) o'ldirgan holat — jabrlanuvchining O'Z
 * sessiyasida avtoritar o'lim hisobi (statistika + respawn holati).
 *
 * NEGA KERAK: `onPlayerDeath` faqat o'z-o'ziga yetkazilgan zarar yo'lida
 * chaqiriladi, shu sababli dushman o'ldirganda jabrlanuvchining `stats.deaths`
 * 0 bo'lib qolardi (HUD/snapshot esa SERVER qiymatini ko'rsatadi).
 *
 * MUHIM: hodisa CHIQARILMAYDI — `death` hodisasi allaqachon otuvchi tomonidan
 * jabrlanuvchining `incoming` qutisiga qo'yilgan (dublikat feedback bo'lmasin).
 * Idempotent: bitta raund ichida faqat BIR marta hisoblanadi (`externalDeath`
 * belgisi `respawnPlayer` da — raund yangilanishida — tozalanadi).
 * @returns {boolean} hisobga olindi=true (aks holda dublikat)
 */
export function registerExternalDeath (state, now = state.now) {
  if (state.externalDeath) return false;
  state.externalDeath = true;
  state.respawnAt = Math.min(state.respawnAt, now + HEALTH.PLAYER_RESPAWN_MS);
  state.result.died = true;
  state.stats.deaths += 1;
  return true;
}

/**
 * O'yinchiga zarar (Phase 4: faqat o'z granatasi + QA test hook'i).
 * @returns health.applyDamage natijasi
 */
export function damagePlayer (state, amount, sourceId = 'test', now = state.now) {
  const r = applyDamage(state.health, {
    amount,
    sourceId,
    zone: 'body',
    eventId: `player:${sourceId}:${state.damageSeq++}`,
    at: now
  });
  if (r.accepted) {
    state.stats.damageTaken += r.amount;
    if (sourceId === 'grenade') state.stats.selfDamage += r.amount;
  }
  if (r.died) onPlayerDeath(state, now);
  return r;
}

/** O'yinchini spawn nuqtasiga qaytaradi: HP/o'q-dori to'liq, kolliziyasiz joy. */
export function respawnPlayer (state, now = state.now) {
  const picked = pickSpawn(state.spawns, { boxes: state.boxes, floorY: state.floorY });
  const spawn = picked.spawn || state.playerSpawn;
  const subj = { health: state.health, loadout: state.loadout, position: state.position, yaw: state.yaw };
  applyRespawn(subj, spawn);
  state.yaw = subj.yaw;
  state.respawnAt = Infinity;                        // re-respawn trigger tozalanadi
  state.externalDeath = false;                       // PHASE 1: yangi "hayot" — peer-death hisobi qayta ochiladi
  state.respawnCount += 1;
  state.stats.respawns += 1;
  state.result.respawned = true;
  emit(state, 'respawn', { targetId: 'player', x: spawn.x, y: spawn.y, z: spawn.z });
  return spawn;
}

// ---------------- o'q uzish (hitscan) ----------------
function resolveHitscanShot (state, now, shot) {
  const R = state.result;
  const scratch = state._shotResult;
  const weapon = shot.weapon;
  // PHASE 8: peer bo'lsa — targets + peers; aks holda faqat targets (Phase 4/5)
  const shotTargets = state.peerTargets.length ? state._shotTargets : state.targets;
  for (let i = 0; i < shot.pellets; i++) {
    const res = resolveShot({
      origin: shot.origin,
      dir: shot.dirs[i],
      maxDistance: weapon.range,
      colliders: state.boxes,
      targets: shotTargets,
      out: scratch
    });
    R.pelletsFired += 1;
    if (res.kind === 'target') {
      const target = state.targetById.get(res.targetId) || state.peerById.get(res.targetId);
      // PHASE 8: DO'STONA o'q — bir jamoadagi o'yinchiga zarar YO'Q (server
      // qoidasi). Nishon baribir o'qni TO'SADI (bloklash o'zgaradi).
      if (target && target.kind === 'player' && target.friendly) {
        R.friendlyBlocked += 1;
        R.targetId = res.targetId;
        R.zone = res.zone;
        emit(state, 'friendly-blocked', {
          targetId: res.targetId, zone: res.zone, distance: res.distance,
          weaponId: weapon.id, x: res.point[0], y: res.point[1], z: res.point[2]
        });
        continue;
      }
      const damage = computeDamage(weapon, res.distance, res.zone);
      // PHASE 8: peer nishon uchun eventId otuvchi bilan NAMESPACE qilinadi
      // (ikki xil otuvchining bir xil shotId:pellet raqami dublikat deb
      // hisoblanib, zarar JIMGINA yo'qolmasligi uchun). Nishon (dummy) yo'li
      // Phase 4/5 formatini AYNAN saqlaydi.
      const evId = target && target.kind === 'player'
        ? `${state.ownerId}:${shot.shotId}:${i}`
        : `${shot.shotId}:${i}`;
      const applied = target
        ? applyDamage(target.health, {
          amount: damage,
          sourceId: 'player',
          eventId: evId,
          zone: res.zone,
          distance: res.distance,
          at: now
        })
        : null;
      const dealt = applied && applied.accepted ? applied.amount : 0;
      if (dealt > 0) {
        R.hits += 1;
        R.damageTotal += dealt;
        R.lastHitDamage = dealt;
        state.stats.hits += 1;
        state.stats.damageDealt += dealt;
      }
      R.targetId = res.targetId;
      R.zone = res.zone;
      // PHASE 1: jabrlanuvchi o'yinchiga AVTORITAR hodisa (zarar yo'nalishi +
      // zarar raqami + o'lim). FAQAT server to'ldiradi; o'q otgan klient bunga
      // ta'sir qilolmaydi (u faqat intent yuboradi).
      if (target && target.kind === 'player' && dealt > 0) {
        pushIncoming(target, {
          type: applied && applied.died ? 'death' : 'damage-taken',
          damage: dealt, attackerId: state.ownerId, weaponId: weapon.id,
          zone: res.zone, fatal: !!(applied && applied.died),
          from: [shot.origin[0], shot.origin[1], shot.origin[2]]
        });
      }
      emit(state, 'hit', {
        targetId: res.targetId, zone: res.zone, damage: dealt, distance: res.distance,
        weaponId: weapon.id, x: res.point[0], y: res.point[1], z: res.point[2]
      });
      if (applied && applied.died) {
        target.respawnAt = now + target.respawnMs;
        R.kills += 1;
        state.stats.kills += 1;
        state.stats.targetsKilled += 1;
        emit(state, 'kill', {
          targetId: res.targetId, zone: res.zone, damage: dealt, distance: res.distance,
          weaponId: weapon.id, x: res.point[0], y: res.point[1], z: res.point[2]
        });
      }
    } else if (res.kind === 'wall' || res.kind === 'blocked_origin') {
      R.blockedHits += 1;
      state.stats.blocked += 1;
      emit(state, 'blocked', {
        blocked: true, reason: res.reason, colliderId: res.colliderId,
        distance: res.distance, weaponId: weapon.id,
        x: res.point[0], y: res.point[1], z: res.point[2]
      });
    } else if (res.kind === 'none') {
      emit(state, 'miss', {
        distance: res.distance, weaponId: weapon.id,
        x: res.point[0], y: res.point[1], z: res.point[2]
      });
    }
    // res.kind === 'invalid' → hodisa chiqarilmaydi (o'q hisobga olinmaydi)
  }
}

// ---------------- granata ----------------
function throwGrenade (state, now, origin, dir) {
  if (state.grenades.length >= GRENADE_CAPACITY) return null;
  const wp = WEAPONS['energy-grenade'];
  state.grenadeSeq += 1;
  const g = createGrenade({
    id: state.grenadeSeq, ownerId: 'player', origin, dir, cfg: wp.projectile, now
  });
  state.grenades.push(g);
  state.stats.grenadeThrows += 1;
  emit(state, 'grenade-throw', {
    weaponId: wp.id, x: origin[0], y: origin[1], z: origin[2]
  });
  return g;
}

function detonate (state, g, now) {
  const R = state.result;
  const subjects = fillSubjects(state);
  const n = explodeGrenade(g, subjects, state.boxes, state._subjectCount);
  state.stats.grenadeExplosions += 1;
  R.explosions += 1;
  emit(state, 'grenade-explode', {
    weaponId: 'energy-grenade', x: g.pos[0], y: g.pos[1], z: g.pos[2]
  });
  for (let i = 0; i < n; i++) {
    const ev = g.results[i];
    if (ev.kind === 'self') {                         // o'z granatasi (self-damage)
      const r = ev.amount > 0 ? damagePlayer(state, ev.amount, 'grenade', now) : null;
      emit(state, 'self-damage', {
        damage: r && r.accepted ? r.amount : 0,
        distance: ev.distance, los: ev.los,
        x: g.pos[0], y: g.pos[1], z: g.pos[2]
      });
      continue;
    }
    // PHASE 1: BOSHQA O'YINCHI — granata endi dushmanga AVTORITATIV zarar beradi
    if (ev.kind === 'peer') {
      const peer = state.peerById.get(ev.id);
      if (!peer || !peer.health || !peer.health.alive) continue;
      if (peer.friendly) {                            // jamoadosh — zarar YO'Q
        R.friendlyBlocked += 1;
        emit(state, 'friendly-blocked', {
          targetId: ev.id, zone: 'blast', distance: ev.distance,
          weaponId: 'energy-grenade', los: ev.los, x: ev.x, y: ev.y, z: ev.z
        });
        continue;
      }
      let dealt = 0;
      let died = false;
      if (ev.amount > 0) {                            // LOS to'silgan bo'lsa 0
        const applied = applyDamage(peer.health, {
          amount: ev.amount,
          sourceId: 'grenade',
          // eventId OTUVCHI bilan namespace qilinadi (ikki tashlovchi
          // bir xil grenade id ishlatsa — zarar jimgina yo'qolmasin)
          eventId: `grenade:${g.id}:${ev.id}:${state.ownerId}`,
          zone: 'blast',
          distance: ev.distance,
          at: now
        });
        if (applied.accepted) { dealt = applied.amount; died = applied.died; }
      }
      if (dealt > 0) {
        R.hits += 1;
        R.damageTotal += dealt;
        R.lastHitDamage = dealt;
        state.stats.hits += 1;
        state.stats.damageDealt += dealt;
      }
      R.targetId = ev.id;
      R.zone = ev.los ? 'blast' : 'covered';
      // PHASE 1: jabrlanuvchiga AVTORITAR hodisa (o'z feedback'i uchun)
      pushIncoming(peer, {
        type: died ? 'death' : 'damage-taken',
        damage: dealt, attackerId: state.ownerId, weaponId: 'energy-grenade',
        zone: 'blast', from: [g.pos[0], g.pos[1], g.pos[2]], fatal: died
      });
      if (died) {
        R.kills += 1;
        state.stats.kills += 1;
        state.stats.targetsKilled += 1;
        emit(state, 'kill', {
          targetId: ev.id, zone: 'blast', damage: dealt, distance: ev.distance,
          weaponId: 'energy-grenade', x: ev.x, y: ev.y, z: ev.z
        });
      }
      emit(state, 'blast-hit', {
        targetId: ev.id, zone: ev.los ? 'blast' : 'covered',
        damage: dealt, distance: ev.distance, los: ev.los,
        weaponId: 'energy-grenade', x: ev.x, y: ev.y, z: ev.z
      });
      continue;
    }
    const target = state.targetById.get(ev.id);
    if (!target) continue;
    let dealt = 0;
    let died = false;
    if (ev.amount > 0) {                              // LOS to'silgan bo'lsa amount = 0
      const applied = applyDamage(target.health, {
        amount: ev.amount,
        sourceId: 'grenade',
        eventId: `grenade:${g.id}:${ev.id}`,
        zone: 'blast',
        distance: ev.distance,
        at: now
      });
      if (applied.accepted) { dealt = applied.amount; died = applied.died; }
    }
    if (dealt > 0) {
      R.hits += 1;
      R.damageTotal += dealt;
      R.lastHitDamage = dealt;
      state.stats.hits += 1;
      state.stats.damageDealt += dealt;
    }
    R.targetId = target.id;
    R.zone = ev.los ? 'blast' : 'covered';
    if (died) {
      target.respawnAt = now + target.respawnMs;
      R.kills += 1;
      state.stats.kills += 1;
      state.stats.targetsKilled += 1;
      emit(state, 'kill', {
        targetId: target.id, zone: 'blast', damage: dealt, distance: ev.distance,
        weaponId: 'energy-grenade', x: ev.x, y: ev.y, z: ev.z
      });
    }
    emit(state, 'blast-hit', {
      targetId: target.id, zone: ev.los ? 'blast' : 'covered',
      damage: dealt, distance: ev.distance, los: ev.los,
      weaponId: 'energy-grenade', x: ev.x, y: ev.y, z: ev.z
    });
  }
}

function stepGrenades (state, dtMs, now) {
  const arr = state.grenades;
  for (let i = arr.length - 1; i >= 0; i--) {
    const g = arr[i];
    if (!g.alive) { arr.splice(i, 1); continue; }
    if (now >= g.explodesAt) { detonate(state, g, now); arr.splice(i, 1); continue; }
    stepGrenade(g, dtMs, state.boxes, state.floorY);
  }
  state.result.grenadesActive = arr.length;
}

function stepTargetRespawns (state, now) {
  for (let i = 0; i < state.targets.length; i++) {
    const t = state.targets[i];
    if (!t.health.alive && now >= t.respawnAt) {
      resetHealth(t.health);
      t.respawnAt = Infinity;
      emit(state, 'target-respawn', { targetId: t.id, x: t.x, y: t.y, z: t.z });
    }
    syncSnap(t, now);
  }
}

// ---------------- asosiy qadam ----------------
/**
 * Combat kadrini bajaradi: intents + aim → qoidalar → DAMAGE RESULT.
 * @param {object} state createCombatState natijasi
 * @param {number} now ms (klient: performance.now(); server: tick vaqti)
 * @param {number} dtMs kadr davomiyligi (ms)
 * @param {{fire?:boolean, firePressed?:boolean, reload?:boolean,
 *          switchTo?:string|null, moving?:boolean}} intents
 * @param {{origin:number[], dir:number[]}|null} aim qarash nuri (kamera/ko'z)
 * @returns state.result (QAYTA ISHLATILADI)
 */
export function stepCombat (state, now, dtMs = 16.7, intents = EMPTY, aim = null) {
  const R = state.result;
  state.now = now;
  R.now = now;
  R.eventCount = 0;
  R.shotsAccepted = 0;
  R.shotsRejected = 0;
  R.pelletsFired = 0;
  R.hits = 0;
  R.blockedHits = 0;
  R.kills = 0;
  R.damageTotal = 0;
  R.friendlyBlocked = 0;
  R.reloadCompleted = 0;
  R.weaponSwitched = false;
  R.respawned = false;
  R.died = false;
  R.explosions = 0;
  R.grenadesActive = state.grenades.length;
  R.targetId = '';
  R.zone = '';
  R.lastHitDamage = 0;
  R.shot.accepted = false;
  R.shot.reason = '';
  R.shot.weaponId = '';
  R.shot.shotId = 0;
  R.shot.pellets = 0;
  R.shot.spreadDeg = 0;

  // qarash nuri (klient kamera nurini beradi; Phase 5 server ko'z+yaw beradi)
  if (aim) {
    if (aim.origin && aim.origin.length >= 3) {
      state.aimOrigin[0] = aim.origin[0];
      state.aimOrigin[1] = aim.origin[1];
      state.aimOrigin[2] = aim.origin[2];
    }
    if (aim.dir && aim.dir.length >= 3) {
      state.aimDir[0] = aim.dir[0];
      state.aimDir[1] = aim.dir[1];
      state.aimDir[2] = aim.dir[2];
    }
  }

  // 1) qurol almashtirish (draw vaqti otishni to'sadi)
  if (intents.switchTo) {
    const sw = switchTo(state.loadout, intents.switchTo, now);
    if (sw.switched) {
      R.weaponSwitched = true;
      emit(state, 'weapon-switch', { weaponId: intents.switchTo });
    }
  }

  // 2) reload (PHASE 1: o'lik holatda boshlanmaydi — impossible state)
  if (intents.reload) {
    const rr = startReload(state.loadout, now, { alive: state.health.alive });
    if (rr.started) emit(state, 'reload-start', { weaponId: activeWeapon(state.loadout).id });
  }
  const reloadDone = stepLoadout(state.loadout, now);
  if (reloadDone) {
    R.reloadCompleted = reloadDone.reloaded;
    emit(state, 'reload-end', {
      damage: reloadDone.reloaded, weaponId: activeWeapon(state.loadout).id
    });
  }

  // 3) o'lim → respawn taymeri
  if (!state.health.alive && now >= state.respawnAt) respawnPlayer(state, now);

  // 4) granatalar (fuse/portlash)
  stepGrenades(state, dtMs, now);

  // 5) o'q uzish (intent → qoidalar → natija)
  if (intents.fire || intents.firePressed) {
    const weapon = activeWeapon(state.loadout);
    const shot = tryFire(state.loadout, now, {
      alive: state.health.alive,
      // PHASE 1: raund faol emas (ROUND_END/MATCH_END) → o'q uzilmaydi.
      // `undefined` — cheklov yo'q (standalone/training).
      roundActive: intents.roundActive,
      triggerEdge: !!intents.firePressed,
      moving: !!intents.moving,
      dir: state.aimDir
    });
    R.shot.accepted = shot.accepted;
    R.shot.reason = shot.reason;
    R.shot.weaponId = shot.weaponId;
    R.shot.shotId = shot.shotId;
    R.shot.pellets = shot.pellets;
    R.shot.spreadDeg = shot.spreadDeg;

    if (shot.accepted) {
      R.shotsAccepted = 1;
      state.stats.shots += 1;
      if (weapon.mode === 'projectile') {
        throwGrenade(state, now, state.aimOrigin, shot.dirs[0]);
      } else {
        resolveHitscanShot(state, now, {
          origin: state.aimOrigin, dirs: shot.dirs, pellets: shot.pellets,
          weapon, shotId: shot.shotId
        });
      }
      emit(state, 'shot', {
        weaponId: weapon.id, damage: R.shot.spreadDeg,
        x: state.aimOrigin[0], y: state.aimOrigin[1], z: state.aimOrigin[2]
      });
    } else {
      R.shotsRejected = 1;
      if (shot.reason === 'empty') state.stats.dryFires += 1;
      emit(state, 'shot-rejected', { reason: shot.reason, weaponId: shot.weaponId });
    }
  }

  // 6) nishonlar respawn + snapshot yangilash
  stepTargetRespawns(state, now);
  R.grenadesActive = state.grenades.length;
  return R;
}

// ---------------- diagnostika snapshot ----------------
/** Allokatsiyasiz snapshot (out va out._targets qayta ishlatiladi) */
export function combatSnapshot (state, out = {}) {
  const R = state.result;
  out.now = state.now;
  out.hp = state.health.hp;
  out.maxHp = state.health.max;
  out.alive = state.health.alive;
  out.deaths = state.health.deaths;
  out.respawnIn = state.health.alive ? 0 : Math.max(0, (state.respawnAt - state.now) / 1000);
  out.respawnAt = Number.isFinite(state.respawnAt) ? state.respawnAt : -1;
  out.respawns = state.stats.respawns;
  out.position = out.position || { x: 0, y: 0, z: 0 };
  out.position.x = state.position.x;
  out.position.y = state.position.y;
  out.position.z = state.position.z;
  out.yaw = state.yaw;
  out.pitch = state.pitch;
  out.aimDir = out.aimDir || [0, 0, 0];
  out.aimDir[0] = state.aimDir[0];
  out.aimDir[1] = state.aimDir[1];
  out.aimDir[2] = state.aimDir[2];
  out.aimOrigin = out.aimOrigin || [0, 0, 0];
  out.aimOrigin[0] = state.aimOrigin[0];
  out.aimOrigin[1] = state.aimOrigin[1];
  out.aimOrigin[2] = state.aimOrigin[2];
  out.weapon = loadoutSnapshot(state.loadout, state.now, state._loadoutSnap);
  out.stats = state.stats;
  out.grenades = state.grenades.length;
  out.grenadeSeq = state.grenadeSeq;
  out.droppedEvents = R.droppedEvents;
  out.lastShot = out.lastShot || {};
  out.lastShot.accepted = R.shot.accepted;
  out.lastShot.reason = R.shot.reason;
  out.lastShot.weaponId = R.shot.weaponId;
  out.lastShot.shotId = R.shot.shotId;
  out.lastShot.pellets = R.shot.pellets;
  out.lastShot.targetId = R.targetId;
  out.lastShot.zone = R.zone;
  out.lastShot.pelletsFired = R.pelletsFired;
  out.lastShot.hits = R.hits;
  out.lastShot.blocked = R.blockedHits;
  out.lastShot.damage = R.damageTotal;

  const arr = out._targets || (out._targets = []);
  let alive = 0;
  for (let i = 0; i < state.targets.length; i++) {
    const s = syncSnap(state.targets[i], state.now);
    if (s.alive) alive += 1;
    arr[i] = s;
  }
  arr.length = state.targets.length;
  out.targets = arr;
  out.targetCount = arr.length;
  out.targetsAlive = alive;
  return out;
}