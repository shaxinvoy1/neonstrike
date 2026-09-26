// ============================================================
// NEON STRIKE — PHASE 5: AVTORITATIV SESSIYA (server tomoni, SOF holat)
// three.js / DOM / renderer YO'Q. `now` HAR DOIM tashqaridan (server tick)
// beriladi → deterministik testlar.
//
// TRUST MODELI (muhim):
//   klient FAQAT intent yuboradi: {seq, pose, aim, intents{fire,reload,switchTo}}
//   server QAROR QILADI: cooldown, o'q-dori, reload, hit, zarar, HP, o'lim,
//   respawn, granata portlashi.
//   Klient `damage`/`hp`/`targetHp`/`ammo`/`cooldown`/`hits` YUBORSA —
//   butun buyruq rad etiladi (forbidden_authority). Bu "fake authority"ning
//   oldini oladi: server hech qachon klient raqamini qabul qilmaydi.
//
// Qoidalar shared/combat.js + shared/weapons.js + shared/grenade.js dan
// QAYTA ISHLATILADI — dublikat combat mantiq YARATILMAYDI.
// ============================================================
import {
  createCombatState, stepCombat, combatSnapshot, addTarget, clearTargets,
  respawnPlayer, setPeerTargets, registerExternalDeath
} from '../shared/combat.js';
import { applyRespawn } from '../shared/respawn.js';
import { refillLoadout, WEAPONS } from '../shared/weapons.js';
import { TRAINING_DUMMIES, TRAINING_RINGS, MAP, SPAWNS, SOLID_BOXES } from '../shared/map.js';
import { PLAYER, headroomClear } from '../shared/collision.js';
import {
  createMovementState, resetMovement, stepMovement, normalizeAxis
} from '../shared/movement.js';
import { SIM } from '../shared/protocol-consts.js';

/** Input rad etilish sabablari (testlar/telemetriya shu matnlarni o'qiydi) */
export const SESSION_REJECT = Object.freeze({
  BAD_MSG: 'bad_msg',
  NO_SESSION: 'no_session',
  BAD_SEQ: 'bad_seq',
  DUPLICATE_SEQ: 'duplicate_seq',
  STALE_SEQ: 'stale_seq',
  BAD_POSE: 'bad_pose',
  POSE_BOUNDS: 'pose_bounds',
  POSE_BLOCKED: 'pose_blocked',
  BAD_AIM: 'bad_aim',
  BAD_MOVE: 'bad_move',
  BAD_INTENT: 'bad_intent',
  BAD_WEAPON: 'bad_weapon',
  FORBIDDEN_AUTHORITY: 'forbidden_authority',
  TOO_MANY_INPUTS: 'too_many_inputs'
});

/**
 * Klient YUBORA OLMAYDIGAN avtoritar maydonlar. Mavjudligi — buyruqni rad
 * etish sababi (klient o'yin natijasini "tahrirlab" yubora olmasligi kerak).
 */
export const FORBIDDEN_FIELDS = Object.freeze([
  'damage', 'damageDealt', 'hp', 'health', 'targetHp', 'targetHealth',
  'hit', 'hits', 'kill', 'kills', 'death', 'died', 'alive', 'dead',
  'ammo', 'mag', 'magazine', 'reserve', 'cooldown', 'nextFireAt',
  'reloadEndsAt', 'explode', 'explosion', 'score', 'scores',
  // PHASE 7: avtoritar harakat/holat da'volari (klient pozitsiya/
  // tezlik/tick ni "tahrirlab" yubora olmaydi)
  'position', 'pos', 'velocity', 'vx', 'vy', 'vz', 'tick', 'serverTick',
  'spread', 'seed', 'recoil', 'authoritative',
  // PHASE 8: jamoa/raund/ball — SERVER EGASI. Klient bu qiymatlarni
  // "tahrirlab" yubora olmaydi (uydirma jamoa/ball/raund rad etiladi).
  'teamId', 'team', 'teams', 'roundState', 'roundNumber', 'roundWinner',
  'matchState', 'matchWinner', 'match', 'lives', 'round',
  // PHASE 12: KIMLIK da'volari. INPUT da kimlik SOCKET/sessiyadan olinadi —
  // klient "men p999/host" deb yuborishi mumkin emas (lobby/chat bilan bir xil
  // qatlamli himoya; maydon mavjudligi buyruqni rad etadi).
  'playerId', 'id', 'name', 'senderId', 'hostId', 'owner'
]);

export const SESSION_LIMITS = Object.freeze({
  MAP_MARGIN: 1.2,
  MIN_Y: -2.5,
  MAX_Y: 14,
  MIN_AIM: 1e-6,
  MIN_SEQ: 0
});

const EMPTY_EVENTS = Object.freeze([]);

const finite3 = (v) =>
  Array.isArray(v) && v.length >= 3 &&
  Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/**
 * Xarita training nishonlarini sessiyaga yuklaydi (5 dummy + 3 halqa).
 * Manba: shared/map.js — yagona haqiqat (server ham klient bilan bir xil map).
 */
export function seedTrainingTargets (state) {
  clearTargets(state);
  for (const d of TRAINING_DUMMIES) addTarget(state, d);
  for (const r of TRAINING_RINGS) addTarget(state, { ...r, kind: 'ring' });
  return state.targets.length;
}

/**
 * Server egasidagi o'yinchi sessiyasi. `state` — shared combat holati
 * (avtoritar haqiqat). Bu obyekt klientga HECH QACHON to'liq yuborilmaydi;
 * faqat sessionSnapshot() orqali o'qiladi.
 */
export function createSession ({ id = 1, name = '', seed = 0, now = Date.now() } = {}) {
  const state = createCombatState({
    seed: seed || (id * 7919 + 13),
    position: { x: SPAWNS.A.x, y: SPAWNS.A.y, z: SPAWNS.A.z },
    yaw: SPAWNS.A.yaw,
    // PHASE 8: otuvchi kimligi (peer zarar eventId namespace uchun)
    ownerId: `p${id}`
  });
  state.pitch = 0;
  seedTrainingTargets(state);

  // PHASE 7: avtoritativ harakat yadrosi (Phase 3 SOF kodi — bitta manba).
  // movement.pos — `state.position` BILAN AYNAN bir obyekt (yagona haqiqat):
  // combat (aimOrigin/LOS) va harakat bir xil pozitsiyani o'qiydi.
  const movement = createMovementState({
    spawn: SPAWNS.A, boxes: SOLID_BOXES, floorY: MAP.FLOOR_Y
  });
  movement.pos = state.position;
  movement.faceYaw = state.yaw;

  const session = {
    id,
    playerId: `p${id}`,
    name: String(name ?? '').slice(0, 24),
    createdAt: now,
    tick: 0,
    state,
    lastSeq: -1,
    // ---- PHASE 7: ko'p o'yinchili sinxronizatsiya ----
    movement,
    /** Sessiya in_game bo'lsa server harakatni O'ZI simulyatsiya qiladi */
    authoritativeMovement: false,
    // ---- PHASE 8: jamoa/raund (qiymatlarni SERVER beradi) ----
    /** O'yinchi jamoasi ('A' | 'B' | null) — faqat server to'ldiradi */
    teamId: null,
    /** Raund LIVE paytida o'lik o'yinchi round tugaguncha O'LIK qoladi */
    holdRespawn: false,
    /**
     * PHASE 1: raund faol (LIVE) — faqat serverni to'ldiradi. `undefined`
     * bo'lsa cheklov qo'yilmaydi (standalone/training). `false` bo'lganda
     * ROUND_END/MATCH_END paytida o'q uzish rad etiladi.
     */
    roundActive: undefined,
    /**
     * PHASE 1: boshqa o'yinchilar YETKAZGAN zarar/o'lim hodisalari qutisi.
     * `shared/combat.js` (setPeerTargets → owner shu sessiya) to'ldiradi;
     * har tick `stepSession` uni EVENTS oqimiga qo'shib bo'shatadi.
     */
    incoming: [],
    moveIntent: { forward: 0, right: 0, sprint: false },
    syncFrames: 0,
    lastInputAt: now,
    lastTickAt: now,
    lastSnapshotAt: 0,
    pendingInputs: 0,
    pending: { fire: false, firePressed: false, reload: false, switchTo: null, moving: false },
    hasPending: false,
    events: EMPTY_EVENTS,
    eventTotal: 0,
    resets: 0,
    counters: {
      inputs: 0, accepted: 0, rejected: 0,
      shotsAccepted: 0, shotsRejected: 0, eventsSent: 0, ticks: 0,
      // PHASE 7
      movedTicks: 0, poseIgnored: 0,
      // PHASE 8
      friendlyBlocked: 0
    },
    _syncOut: {},
    rejections: Object.create(null),        // input validatsiyasi sabablari
    fireReasons: Object.create(null),       // combat (o'q uzish) rad sabablari
    _snapOut: {},
    _snapshot: {}
  };
  return session;
}

/**
 * Input validatsiyasi (HOLATNI O'ZGARTIRMAYDI). Qoidalar:
 *  - obyekt, `type` server tomonidan allaqachon tekshirilgan
 *  - avtoritar maydonlar TAQIQLANGAN (forbidden_authority)
 *  - seq: chekli musbat butun son, takroriy/eski bo'lmasin
 *  - pose: chekli, xarita chegarasida, kolliziya ichida EMAS (headroomClear)
 *  - aim.dir: chekli va noldan farqli (server o'zi normallashtiradi)
 *  - intents: boolean'ga majburlanadi; switchTo faqat mavjud qurol id
 * @returns {{ok:true, seq:number, intents:object, pose:object, dir:number[]} |
 *           {ok:false, reason:string, field?:string}}
 */
export function validateInput (session, msg, now = 0) {
  if (!session) return { ok: false, reason: SESSION_REJECT.NO_SESSION };
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, reason: SESSION_REJECT.BAD_MSG };
  }

  // 0) klient avtoritar natijani yuborishi mumkin emas
  for (let i = 0; i < FORBIDDEN_FIELDS.length; i++) {
    const f = FORBIDDEN_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(msg, f)) {
      return { ok: false, reason: SESSION_REJECT.FORBIDDEN_AUTHORITY, field: f };
    }
  }

  // 1) buyruq tartibi (takroriy/eski buyruq — replay himoyasi)
  const seq = msg.seq;
  if (!Number.isFinite(seq) || !Number.isInteger(seq) || seq < SESSION_LIMITS.MIN_SEQ) {
    return { ok: false, reason: SESSION_REJECT.BAD_SEQ };
  }
  if (seq === session.lastSeq) return { ok: false, reason: SESSION_REJECT.DUPLICATE_SEQ };
  if (seq < session.lastSeq) return { ok: false, reason: SESSION_REJECT.STALE_SEQ };

  // 2) poza (server faqat VALID pozani qabul qiladi)
  const pose = msg.pose;
  if (!pose || typeof pose !== 'object' ||
      !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z) ||
      !Number.isFinite(pose.yaw) || !Number.isFinite(pose.pitch)) {
    return { ok: false, reason: SESSION_REJECT.BAD_POSE };
  }
  // PHASE 7: in_game (avtoritativ harakat) rejimida pozitsiya EMAS, faqat
  // orientatsiya ishlatiladi — shu sababli pozitsiya ustida chegara/kolliziya
  // tekshiruvi o'tkazilmaydi (foydalanilmayotgan ma'lumot uchun qo'shimcha
  // talab qo'yish ma'nosiz). Chekli sonlar tekshiruvi YUQORIDA baribir
  // majburiy — NaN/Infinity hech qachon o'tmaydi.
  if (!session.authoritativeMovement) {
    if (Math.abs(pose.x) > MAP.HALF_X + SESSION_LIMITS.MAP_MARGIN ||
        Math.abs(pose.z) > MAP.HALF_Z + SESSION_LIMITS.MAP_MARGIN ||
        pose.y < SESSION_LIMITS.MIN_Y || pose.y > SESSION_LIMITS.MAX_Y) {
      return { ok: false, reason: SESSION_REJECT.POSE_BOUNDS };
    }
    if (!headroomClear(pose.x, pose.y, pose.z, PLAYER.RADIUS, PLAYER.HEIGHT, SOLID_BOXES)) {
      return { ok: false, reason: SESSION_REJECT.POSE_BLOCKED };
    }
  }

  // 3) nishon yo'nalishi (origin EMAS — origin server o'zi hisoblaydi)
  const aim = msg.aim;
  if (!aim || typeof aim !== 'object' || !finite3(aim.dir)) {
    return { ok: false, reason: SESSION_REJECT.BAD_AIM };
  }
  const len = Math.hypot(aim.dir[0], aim.dir[1], aim.dir[2]);
  if (!(len > SESSION_LIMITS.MIN_AIM)) return { ok: false, reason: SESSION_REJECT.BAD_AIM };

  // 4) PHASE 7: harakat niyati (ixtiyoriy) — FAQAT chekli sonlar [-1,1].
  //    Klient bu bilan pozitsiya EMAS, "qayerga yurmoqchi" ni aytadi.
  let move = null;
  if (msg.move !== undefined && msg.move !== null) {
    if (typeof msg.move !== 'object' || Array.isArray(msg.move)) {
      return { ok: false, reason: SESSION_REJECT.BAD_MOVE };
    }
    const ax = normalizeAxis(msg.move.forward, msg.move.right);
    if (!ax) return { ok: false, reason: SESSION_REJECT.BAD_MOVE };
    if (msg.move.sprint !== undefined && typeof msg.move.sprint !== 'boolean') {
      return { ok: false, reason: SESSION_REJECT.BAD_MOVE };
    }
    move = { forward: ax.forward, right: ax.right, sprint: msg.move.sprint === true };
  }

  // 5) intentlar
  const raw = msg.intents;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    return { ok: false, reason: SESSION_REJECT.BAD_INTENT };
  }
  const src = raw || {};
  let switchTo = null;
  if (src.switchTo !== undefined && src.switchTo !== null) {
    if (typeof src.switchTo !== 'string' || !WEAPONS[src.switchTo]) {
      return { ok: false, reason: SESSION_REJECT.BAD_WEAPON };
    }
    switchTo = src.switchTo;
  }

  return {
    ok: true,
    seq,
    pose: { x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw, pitch: pose.pitch },
    dir: [aim.dir[0] / len, aim.dir[1] / len, aim.dir[2] / len],
    move,
    intents: {
      fire: src.fire === true,
      firePressed: src.firePressed === true,
      reload: src.reload === true,
      switchTo,
      moving: src.moving === true
    }
  };
}

/**
 * Buyruqni qo'llash: validatsiya → poza server holatiga yoziladi → intent
 * navbatga qo'shiladi. Tick'da bir marta stepSession() iste'mol qiladi.
 * @returns {{ok:boolean, seq?:number, reason:string, field?:string}}
 */
export function applyInput (session, msg, now = session.state.now) {
  if (!session) return { ok: false, reason: SESSION_REJECT.NO_SESSION };
  session.counters.inputs += 1;
  // to'planish himoyasi: bitta tick'da haddan tashqari ko'p buyruq qabul qilinmaydi
  if (session.pendingInputs >= SIM.MAX_INPUTS_PER_TICK) {
    session.counters.rejected += 1;
    session.rejections[SESSION_REJECT.TOO_MANY_INPUTS] =
      (session.rejections[SESSION_REJECT.TOO_MANY_INPUTS] || 0) + 1;
    return { ok: false, reason: SESSION_REJECT.TOO_MANY_INPUTS };
  }
  const v = validateInput(session, msg, now);
  if (!v.ok) {
    session.counters.rejected += 1;
    session.rejections[v.reason] = (session.rejections[v.reason] || 0) + 1;
    return v;
  }

  session.lastSeq = v.seq;
  session.lastInputAt = now;
  session.pendingInputs += 1;

  const st = session.state;

  // ORIENTATSIYA — har doim klient niyatidan (sichqoncha kabi) va u
  // VALIDATSIYADAN o'tgan (chekli son). Orientatsiya serverda QAROR qilinadigan
  // narsa emas, u kirish niyati.
  st.yaw = v.pose.yaw;
  st.pitch = v.pose.pitch;
  st.aimDir[0] = v.dir[0];
  st.aimDir[1] = v.dir[1];
  st.aimDir[2] = v.dir[2];

  if (session.authoritativeMovement) {
    // ---- PHASE 7: AVTORITATIV HARAKAT ----
    // Sessiya in_game: pozitsiya SERVER tomonidan simulyatsiya qilinadi.
    // Klient `pose.x/y/z` bu yerda QABUL QILINMAYDI (u avtoritar harakat
    // buyrug'i emas) — faqat `move` niyati navbatga qo'yiladi.
    if (v.move) {
      session.moveIntent.forward = v.move.forward;
      session.moveIntent.right = v.move.right;
      session.moveIntent.sprint = v.move.sprint;
      if (Math.abs(v.move.forward) > 0.01 || Math.abs(v.move.right) > 0.01) {
        session.pending.moving = true;
      }
    } else {
      session.moveIntent.forward = 0;
      session.moveIntent.right = 0;
      session.moveIntent.sprint = false;
    }
    session.counters.poseIgnored += 1;
  } else {
    // ---- PHASE 5/6 yo'li (standalone/training) ----
    // Validatsiyadan o'tgan poza server holatining pozitsiyasi bo'ladi —
    // bu Phase 5 xatti-harakati (o'zgarishsiz saqlanadi).
    st.position.x = v.pose.x;
    st.position.y = v.pose.y;
    st.position.z = v.pose.z;
  }

  // ko'z balandligi SERVER tomonidan hisoblanadi (klient originni yubormaydi)
  st.aimOrigin[0] = st.position.x;
  st.aimOrigin[1] = st.position.y + PLAYER.EYE;
  st.aimOrigin[2] = st.position.z;

  const p = session.pending;
  const i = v.intents;
  if (i.fire) p.fire = true;
  if (i.firePressed) p.firePressed = true;
  if (i.reload) p.reload = true;
  if (i.moving) p.moving = true;
  if (i.switchTo) p.switchTo = i.switchTo;
  session.hasPending = true;
  session.counters.accepted += 1;
  return { ok: true, seq: v.seq, reason: '' };
}

/** Combat natijasidan JSON-xavfsiz hodisalar ro'yxati (faqat bor bo'lsa) */
function collectEvents (R) {
  if (!R.eventCount) return EMPTY_EVENTS;
  const out = new Array(R.eventCount);
  for (let i = 0; i < R.eventCount; i++) {
    const e = R.events[i];
    out[i] = {
      type: e.type,
      targetId: e.targetId,
      zone: e.zone,
      weaponId: e.weaponId,
      reason: e.reason,
      damage: e.damage,
      distance: +e.distance.toFixed(3),
      blocked: e.blocked,
      los: e.los,
      x: +e.x.toFixed(3),
      y: +e.y.toFixed(3),
      z: +e.z.toFixed(3)
    };
  }
  return out;
}

/**
 * Avtoritar simulyatsiya qadami (30 Hz). Intentlar iste'mol qilinadi:
 * cooldown/o'q-dori/reload/hit/zarar/HP/o'lim/respawn/granata — hammasi
 * shared/combat.js ichida, SERVER vaqti bilan hal qilinadi.
 * @returns shared stepCombat natijasi (qayta ishlatiladi)
 */
export function stepSession (session, now, dtMs) {
  const st = session.state;
  const dt = Number.isFinite(dtMs) && dtMs > 0 ? Math.min(100, dtMs) : 1000 / 30;

  // ---- PHASE 7: AVTORITATIV HARAKAT SIMULYATSIYASI ----
  // Sessiya in_game bo'lsa pozitsiya SERVER tomonidan, Phase 3 SOF yadrosi
  // bilan yuritiladi (klient bilan AYNAN bir xil qoidalar). Boshqa hollarda
  // (standalone) pozitsiyani applyInput yozadi — Phase 5 xatti-harakati.
  if (session.authoritativeMovement) {
    const mi = session.moveIntent;
    stepMovement(session.movement, dt / 1000,
      { forward: mi.forward, right: mi.right }, st.yaw, mi.sprint);
    session.counters.movedTicks += 1;
  }

  // origin har tick qayta hisoblanadi (pozitsiya HARAKATDAN keyin)
  st.aimOrigin[0] = st.position.x;
  st.aimOrigin[1] = st.position.y + PLAYER.EYE;
  st.aimOrigin[2] = st.position.z;

  const p = session.pending;
  const intents = session.hasPending
    ? {
        fire: p.fire, firePressed: p.firePressed, reload: p.reload,
        switchTo: p.switchTo, moving: p.moving,
        // PHASE 1: raund faol emas (ROUND_END/MATCH_END) → o'q uzilmaydi.
        // `undefined` (match yo'q) — cheklov qo'yilmaydi.
        roundActive: session.roundActive
      }
    : null;

  const R = stepCombat(st, now, dt, intents || EMPTY_EVENTS, null);

  // PHASE 8: raund LIVE paytida o'lik o'yinchi AVTOMATIK respawn bo'lmaydi —
  // u raund tugaguncha o'lik qoladi (keyingi raund boshida tiklanadi).
  if (session.holdRespawn && !st.health.alive) st.respawnAt = Infinity;

  p.fire = false; p.firePressed = false; p.reload = false; p.switchTo = null; p.moving = false;
  session.hasPending = false;
  session.pendingInputs = 0;
  session.tick += 1;
  session.lastTickAt = now;
  session.counters.ticks += 1;
  if (R.shotsAccepted) session.counters.shotsAccepted += 1;
  // PHASE 8: do'stona o'q bloklandi (telemetriya/dalil)
  if (R.friendlyBlocked) session.counters.friendlyBlocked += 1;
  if (R.shotsRejected) {
    session.counters.shotsRejected += 1;
    const reason = R.shot.reason || 'unknown';
    session.fireReasons[reason] = (session.fireReasons[reason] || 0) + 1;
  }

  let events = collectEvents(R);
  // PHASE 1: boshqa o'yinchilar tomonidan YETKAZILGAN zarar/o'lim hodisalari.
  // Ular qoida modulida (shared/combat.js) jabrlanuvchining `incoming` qutisiga
  // yoziladi va SHU yerda uning o'z EVENTS oqimiga qo'shiladi. Shu sababli
  // jabrlanuvchi klienti HAQIQIY (avtoritar) zarar raqami/yo'nalishi va o'lim
  // haqida biladi — bashorat emas.
  if (session.incoming.length) {
    const extra = session.incoming.splice(0, session.incoming.length);
    // PHASE 1: jabrlanuvchining O'Z avtoritar o'lim hisobi. `onPlayerDeath`
    // faqat self-damage yo'lida chaqirilardi → dushman o'ldirganda
    // `stats.deaths` 0 bo'lib qolardi (snapshot/HUD SERVER qiymatini ko'rsatadi).
    // Hodisa QAYTA chiqarilmaydi (death hodisasi allaqachon qutida) va bir
    // raundda bir marta hisoblanadi (registerExternalDeath — idempotent).
    for (let i = 0; i < extra.length; i++) {
      const ev = extra[i];
      if (ev && ev.fatal === true) registerExternalDeath(st, now);
    }
    events = events.length ? events.concat(extra) : extra;
  }
  session.events = events;
  session.eventTotal += events.length;
  session.counters.eventsSent += events.length;
  return R;
}

/**
 * Sessiyani qayta boshlash (RESET so'rovi bo'yicha SERVER qarori):
 * o'yinchi spawn A ga qaytadi (kolliziyasiz), HP/o'q-dori to'liq, nishonlar
 * tirik, granatalar tozalanadi. `lastSeq` SAQLANADI (replay himoyasi).
 */
export function resetSession (session, now = session.state.now) {
  if (!session) return null;
  const st = session.state;
  respawnPlayer(st, now);
  // PHASE 7: harakat yadrosi ham spawn'ga qaytadi va yana state.position
  // bilan bir obyektga bog'lanadi (respawnPlayer obyektni joyida o'zgartiradi).
  resetMovement(session.movement);
  session.movement.pos = st.position;
  session.movement.faceYaw = st.yaw;
  session.moveIntent.forward = 0;
  session.moveIntent.right = 0;
  session.moveIntent.sprint = false;
  refillLoadout(st.loadout, { keepStats: false });
  st.grenades.length = 0;
  st.grenadeSeq = 0;
  st.damageSeq = 0;
  st.result.eventCount = 0;
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
  const p = session.pending;
  p.fire = false; p.firePressed = false; p.reload = false; p.switchTo = null; p.moving = false;
  session.hasPending = false;
  session.pendingInputs = 0;
  session.events = EMPTY_EVENTS;
  session.resets += 1;
  return st;
}

/**
 * KLIENTGA yuboriladigan avtoritar snapshot (faqat server hal qilgan qiymatlar).
 * Klient buni faqat KO'RSATADI — qayta hisoblamaydi.
 */
export function sessionSnapshot (session, out = {}) {
  const s = combatSnapshot(session.state, session._snapOut);
  out.sessionId = session.id;
  out.playerId = session.playerId;
  out.tick = session.tick;
  // PHASE 7: tasdiqlangan input ketma-ketligi + harakat rejimi
  out.ackSeq = session.lastSeq;
  out.authoritativeMovement = !!session.authoritativeMovement;
  out.teamId = session.teamId || null;
  out.serverNow = +session.state.now.toFixed(1);
  out.hp = s.hp;
  out.maxHp = s.maxHp;
  out.alive = s.alive;
  out.deaths = s.deaths;
  // PHASE 8: raund davomida o'lik o'yinchi `respawnAt = Infinity` bo'ladi
  // (avtomatik respawn yo'q) → cheksiz qiymat JSON'ga tushmasin.
  out.respawnIn = Number.isFinite(s.respawnIn) ? +s.respawnIn.toFixed(3) : -1;
  out.position = { x: +s.position.x.toFixed(3), y: +s.position.y.toFixed(3), z: +s.position.z.toFixed(3) };
  out.yaw = s.yaw;
  out.pitch = s.pitch;
  out.weapon = {
    weaponId: s.weapon.weaponId,
    slot: s.weapon.slot,
    mode: s.weapon.mode,
    auto: s.weapon.auto,
    mag: s.weapon.mag,
    magSize: s.weapon.magSize,
    reserve: s.weapon.reserve,
    reloading: s.weapon.reloading,
    reloadProgress: +s.weapon.reloadProgress.toFixed(3),
    switching: s.weapon.switching,
    shotsFired: s.weapon.shotsFired,
    dryFires: s.weapon.dryFires,
    lastReason: s.weapon.lastReason
  };
  out.grenades = s.grenades;
  out.stats = {
    shots: s.stats.shots, hits: s.stats.hits, blocked: s.stats.blocked,
    kills: s.stats.kills, deaths: s.stats.deaths, respawns: s.stats.respawns,
    damageDealt: s.stats.damageDealt, damageTaken: s.stats.damageTaken,
    selfDamage: s.stats.selfDamage, dryFires: s.stats.dryFires,
    grenadeThrows: s.stats.grenadeThrows, grenadeExplosions: s.stats.grenadeExplosions
  };
  out.lastShot = {
    accepted: s.lastShot.accepted, reason: s.lastShot.reason, shotId: s.lastShot.shotId,
    pellets: s.lastShot.pellets, targetId: s.lastShot.targetId, zone: s.lastShot.zone,
    hits: s.lastShot.hits, blocked: s.lastShot.blocked, damage: s.lastShot.damage
  };
  const arr = out.targets || (out.targets = []);
  for (let i = 0; i < s.targets.length; i++) {
    const t = s.targets[i];
    let o = arr[i];
    if (!o) { o = arr[i] = {}; }
    o.id = t.id;
    o.kind = t.kind;
    o.hp = t.hp;
    o.max = t.max;
    o.alive = t.alive;
    o.deaths = t.deaths;
    o.respawnIn = +t.respawnIn.toFixed(3);
  }
  arr.length = s.targets.length;
  out.targetCount = arr.length;
  out.authority = {
    accepted: session.counters.accepted,
    rejected: session.counters.rejected,
    shotsAccepted: session.counters.shotsAccepted,
    shotsRejected: session.counters.shotsRejected,
    rejections: { ...session.rejections },
    fireReasons: { ...session.fireReasons }
  };
  return out;
}

/**
 * PHASE 8: o'yinchini JAMOA spawn nuqtasiga joylashtirish (raund boshi/reset).
 * HP/o'q-dori to'liq, granatalar tozalanadi, harakat yadrosi spawn'ga
 * qaytariladi va `movement.pos` yana `state.position` bilan BIR obyekt bo'ladi.
 * Faqat SERVER chaqiradi (klient spawn ni tanlay olmaydi).
 * @returns {object|null} qo'llangan spawn
 */
export function placePlayerAt (session, spawn, now = session.state.now) {
  if (!session || !spawn) return null;
  const st = session.state;
  const subj = { health: st.health, loadout: st.loadout, position: st.position, yaw: st.yaw, respawns: 0 };
  applyRespawn(subj, spawn);
  st.yaw = subj.yaw;
  st.pitch = 0;
  st.respawnAt = Infinity;
  st.respawnCount += 1;
  st.stats.respawns += 1;
  st.grenades.length = 0;
  st.grenadeSeq = 0;
  st.result.eventCount = 0;
  Object.assign(st.stats, {
    shots: 0, hits: 0, blocked: 0, kills: 0, deaths: 0, respawns: st.stats.respawns,
    damageDealt: 0, damageTaken: 0, selfDamage: 0, dryFires: 0,
    grenadeThrows: 0, grenadeExplosions: 0, targetsKilled: 0
  });
  for (const t of st.targets) {
    t.health.hp = t.health.max;
    t.health.alive = true;
    t.health.deaths = 0;
    t.respawnAt = Infinity;
  }
  const m = session.movement;
  m.spawn = spawn;
  resetMovement(m);
  m.pos = st.position;
  m.faceYaw = st.yaw;
  session.moveIntent.forward = 0;
  session.moveIntent.right = 0;
  session.moveIntent.sprint = false;
  const p = session.pending;
  p.fire = false; p.firePressed = false; p.reload = false; p.switchTo = null; p.moving = false;
  session.hasPending = false;
  session.pendingInputs = 0;
  session.events = EMPTY_EVENTS;
  st.aimOrigin[0] = st.position.x;
  st.aimOrigin[1] = st.position.y + PLAYER.EYE;
  st.aimOrigin[2] = st.position.z;
  session.lastTickAt = now;
  return spawn;
}

/**
 * PHASE 8: boshqa o'yinchilarni otish nishonasi sifatida o'rnatish.
 * Ro'yxatni SERVER tuzadi (app.js) — klient bunga ta'sir qila olmaydi.
 * @returns {number} faol peer nishonlar soni
 */
export function applyPeerTargets (session, peers) {
  if (!session) return 0;
  return setPeerTargets(session.state, peers);
}

/**
 * PHASE 8: raund davomida avtomatik respawnni ushlab turish (o'lik qolish).
 * Raund tugagach app.js uni o'chiradi va keyingi raund boshida spawn qaytaradi.
 */
export function setRoundHold (session, on) {
  if (!session) return false;
  session.holdRespawn = !!on;
  const st = session.state;
  if (session.holdRespawn && !st.health.alive) st.respawnAt = Infinity;
  return session.holdRespawn;
}

/**
 * PHASE 7: in_game rejimini yoqish/o'chirish (faqat SERVER qaror qiladi —
 * lobby sessiyasi boshlanganda app.js chaqiradi). Yoqilganda pozitsiya
 * endi klient `pose` dan EMAS, server simulyatsiyasidan olinadi.
 */
export function setAuthoritativeMovement (session, on) {
  if (!session) return false;
  session.authoritativeMovement = !!on;
  if (!on) {
    session.moveIntent.forward = 0;
    session.moveIntent.right = 0;
    session.moveIntent.sprint = false;
  }
  return session.authoritativeMovement;
}

/**
 * PHASE 7: bitta o'yinchining SINXRONIZATSIYA holati (SOF — faqat server
 * xotirasidagi avtoritar qiymatlar). Klient buni FAQAT ko'rsatadi/interpolatsiya
 * qiladi; qayta hisoblamaydi. `out` qayta ishlatiladi (allocatsiya yo'q).
 */
export function playerSyncState (session, out = {}) {
  const st = session.state;
  const p = st.position;
  const m = session.movement;
  out.id = session.playerId;
  out.sessionId = session.id;
  out.x = +p.x.toFixed(3);
  out.y = +p.y.toFixed(3);
  out.z = +p.z.toFixed(3);
  out.vx = +m.vel.x.toFixed(3);
  out.vz = +m.vel.z.toFixed(3);
  out.speed = +m.speed.toFixed(3);
  out.yaw = +st.yaw.toFixed(3);
  out.pitch = +st.pitch.toFixed(3);
  out.faceYaw = +m.faceYaw.toFixed(3);
  out.airborne = !!m.airborne;
  out.alive = !!st.health.alive;
  out.hp = st.health.hp;
  // PHASE 8: avtoritar jamoa (server tayinlagan) — klient FAQAT ko'rsatadi
  out.teamId = session.teamId || null;
  return out;
}

/** Nishon HP ni id bo'yicha o'qish (server tomoni telemetriya/test) */
export function targetHp (session, id) {
  const t = session.state.targetById.get(id) || null;
  return t ? t.health.hp : null;
}
