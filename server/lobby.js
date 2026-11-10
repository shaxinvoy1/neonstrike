// ============================================================
// NEON STRIKE — PHASE 6: LAN LOBBY (SOF QOIDALAR, SOF HOLAT)
// three.js / DOM / socket YO'Q — faqat sessiya/host/sig'im/validatsiya qoidalari.
// Server egasi (authority) — klient hech narsani da'vo qila olmaydi:
//   • playerId    → SERVER beradi (klient yuborsa rad)
//   • hostId      → SERVER tayinlaydi (klient "men host" deya olmaydi)
//   • state       → SERVER o'tkazadi (klient "sessiya boshlandi" deya olmaydi)
//   • capacity    → SERVER majburlaydi
// Combat mantig'i BU YERDA YO'Q (u shared/combat.js + server/session.js da).
//
// SIG'IM: bitta LAN sessiya (bitta host server) — Phase 6 uchun minimal model.
// Host uzilsa: qolgan eng erta qo'shilgan o'yinchi host bo'ladi (deterministik,
// joinedAt asc → playerId asc). O'yinchi qolmasa — sessiya YOPILADI (stale state yo'q).
// ============================================================

/** Sessiya holatlari (minimal — faqat keraklilari) */
export const LOBBY_PHASE = Object.freeze({
  NONE: 'none',        // sessiya yo'q
  LOBBY: 'lobby',      // yig'ilish bosqichi (qo'shilish mumkin)
  IN_GAME: 'in_game'   // host boshladi (PHASE 7: qo'shilish OCHIQ — join-in-progress)
});

/** Rad etish sabablari (testlar/telemetriya shu matnlarni o'qiydi) */
export const LOBBY_REJECT = Object.freeze({
  BAD_MSG: 'bad_lobby',
  FORBIDDEN: 'forbidden_authority',
  NO_SESSION: 'lobby_none',
  EXISTS: 'lobby_exists',
  FULL: 'lobby_full',
  DUPLICATE: 'lobby_duplicate',
  IN_GAME: 'lobby_in_game',
  NOT_IN: 'lobby_not_member',
  NOT_HOST: 'not_host',
  ALREADY_STARTED: 'lobby_already_started'
});

/**
 * Klient YUBORA OLMAYDIGAN avtoritar maydonlar (o'zini host/player/session deb
 * e'lon qilishga urinish). Mavjudligi — buyruqni rad etish sababi.
 */
export const LOBBY_FORBIDDEN_FIELDS = Object.freeze([
  'playerId', 'hostId', 'host', 'isHost', 'owner', 'state', 'status',
  'count', 'capacity', 'maxPlayers', 'players', 'started', 'startedAt', 'revision'
]);

/** Sig'im (capacity) chegarasi: musbat butun son */
export const LOBBY_CAPACITY_MIN = 1;
export const LOBBY_CAPACITY_MAX = 32;

export function createLobbyHub ({ capacity = 8 } = {}) {
  let cap = Number.isFinite(capacity) ? Math.floor(capacity) : 8;
  cap = Math.max(LOBBY_CAPACITY_MIN, Math.min(LOBBY_CAPACITY_MAX, cap));
  return {
    capacity: cap,
    session: null,
    revision: 0,
    sessionsCreated: 0,
    joinsAccepted: 0,
    joinsRejected: 0
  };
}

/** Lobby a'zosi (app.js ulanish uchun yaratadi; id — SERVER bergan) */
export function createLobbyMember ({ id, name = '', socket = null, joinedAt = 0, sessionId = 0 }) {
  return {
    id: String(id),
    name: String(name ?? '').slice(0, 24),
    socket,
    joinedAt,
    sessionId
  };
}

const numId = (id) => {
  const n = Number(String(id).replace(/^\D+/, ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** Deterministik host tanlovi: joinedAt asc, teng bo'lsa playerId asc */
export function pickHost (players) {
  let best = null;
  for (const p of players) {
    if (!best) { best = p; continue; }
    if (p.joinedAt < best.joinedAt) best = p;
    else if (p.joinedAt === best.joinedAt && numId(p.id) < numId(best.id)) best = p;
  }
  return best;
}

export function findMember (hub, playerId) {
  const s = hub.session;
  if (!s || playerId === undefined || playerId === null) return null;
  for (let i = 0; i < s.players.length; i++) {
    if (s.players[i].id === String(playerId)) return s.players[i];
  }
  return null;
}

export function isHost (hub, playerId) {
  return !!(hub.session && hub.session.hostId !== null && hub.session.hostId === String(playerId));
}

function addMember (hub, session, member, now) {
  if (!member.joinedAt) member.joinedAt = now;
  session.players.push(member);
  hub.joinsAccepted += 1;
  return member;
}

/**
 * A'zoni sessiyadan chiqaradi. Host bo'lsa — deterministik o'tkazish.
 * Oxirgi o'yinchi chiqsa sessiya YOPILADI (hub.session = null).
 * @returns {{removed:object, hostChanged:boolean, newHostId:(string|null), closed:boolean}|null}
 */
export function removeMember (hub, playerId, now = 0) {
  const s = hub.session;
  if (!s) return null;
  const id = String(playerId);
  const i = s.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const removed = s.players.splice(i, 1)[0];
  let hostChanged = false;
  if (s.hostId === id) {
    const next = pickHost(s.players);
    s.hostId = next ? next.id : null;
    hostChanged = true;
  }
  const closed = s.players.length === 0;
  if (closed) hub.session = null;
  hub.revision += 1;
  return { removed, hostChanged, newHostId: s.hostId, closed };
}

/** Sessiya yaratish (yaratuvchi HOST bo'ladi). Idempotent: a'zo allaqachon ichida bo'lsa ok */
export function createSession (hub, member, now = Date.now()) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  if (!member || !member.id) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  const s = hub.session;
  if (s) {
    if (findMember(hub, member.id)) return { ok: true, reason: 'already', session: s };
    return { ok: false, reason: LOBBY_REJECT.EXISTS, session: s };
  }
  const session = {
    id: hub.sessionsCreated + 1,
    hostId: String(member.id),
    state: LOBBY_PHASE.LOBBY,
    createdAt: now,
    startedAt: 0,
    players: []
  };
  hub.sessionsCreated += 1;
  hub.session = session;
  addMember(hub, session, member, now);
  hub.revision += 1;
  return { ok: true, reason: 'created', session };
}

/** Mavjud sessiyaga qo'shilish (sig'im/holat/dublikat serverda tekshiriladi) */
export function joinSession (hub, member, now = Date.now()) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  if (!member || !member.id) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  const s = hub.session;
  if (!s) { hub.joinsRejected += 1; return { ok: false, reason: LOBBY_REJECT.NO_SESSION }; }
  if (findMember(hub, member.id)) return { ok: true, reason: 'already', session: s };
  // PHASE 7: JOIN-IN-PROGRESS. Phase 6 da o'yin boshlangach qo'shilish YOPIQ
  // edi; endi ochiq — sinxronizatsiya uchun yangi a'zo darhol avtoritativ
  // holatni oladi (app.js unga SNAPSHOT yuboradi). Sig'im baribir qat'iy
  // SERVER tomonidan majburlanadi (pastdagi FULL tekshiruvi).
  if (s.players.length >= hub.capacity) {
    hub.joinsRejected += 1;
    return { ok: false, reason: LOBBY_REJECT.FULL, session: s };
  }
  addMember(hub, s, member, now);
  hub.revision += 1;
  return { ok: true, reason: 'joined', session: s };
}

/** Chiqish (a'zo bo'lmasa — NOT_IN) */
export function leaveSession (hub, playerId, now = Date.now()) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  if (!hub.session) return { ok: false, reason: LOBBY_REJECT.NO_SESSION };
  if (!findMember(hub, playerId)) return { ok: false, reason: LOBBY_REJECT.NOT_IN };
  const info = removeMember(hub, playerId, now);
  return { ok: true, reason: 'left', ...info };
}

/** Sessiyani boshlash — FAQAT host (server qarori) */
export function startSession (hub, playerId, now = Date.now()) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  const s = hub.session;
  if (!s) return { ok: false, reason: LOBBY_REJECT.NO_SESSION };
  if (!findMember(hub, playerId)) return { ok: false, reason: LOBBY_REJECT.NOT_IN };
  if (s.hostId !== String(playerId)) return { ok: false, reason: LOBBY_REJECT.NOT_HOST };
  if (s.state === LOBBY_PHASE.IN_GAME) return { ok: false, reason: LOBBY_REJECT.ALREADY_STARTED };
  s.state = LOBBY_PHASE.IN_GAME;
  s.startedAt = now;
  hub.revision += 1;
  return { ok: true, reason: 'started', session: s };
}

/**
 * Match tugagach (yoki host qaror qilsa) sessiyani LOBBY holatiga qaytarish —
 * FAQAT host. Shundan keyin host qayta START qila oladi (restart).
 */
export function returnToLobby (hub, playerId, now = Date.now()) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  const s = hub.session;
  if (!s) return { ok: false, reason: LOBBY_REJECT.NO_SESSION };
  if (!findMember(hub, playerId)) return { ok: false, reason: LOBBY_REJECT.NOT_IN };
  if (s.hostId !== String(playerId)) return { ok: false, reason: LOBBY_REJECT.NOT_HOST };
  if (s.state !== LOBBY_PHASE.IN_GAME) return { ok: true, reason: 'already', session: s };
  s.state = LOBBY_PHASE.LOBBY;
  s.startedAt = 0;
  hub.revision += 1;
  return { ok: true, reason: 'lobby', session: s };
}

/** Ism xavfsizligi: boshqaruv belgilarini olib tashlaydi; matn bo'lmasa null */
export function sanitizeLobbyName (name) {
  if (name === undefined || name === null) return '';
  if (typeof name !== 'string') return null;
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}

/**
 * Lobby xabarini validatsiya qiladi (HOLATNI O'ZGARTIRMAYDI).
 * @returns {{ok:true, name:string} | {ok:false, reason:string, field?:string}}
 */
export function validateLobbyMessage (hub, msg) {
  if (!hub) return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, reason: LOBBY_REJECT.BAD_MSG };
  }
  for (let i = 0; i < LOBBY_FORBIDDEN_FIELDS.length; i++) {
    const f = LOBBY_FORBIDDEN_FIELDS[i];
    if (Object.prototype.hasOwnProperty.call(msg, f)) {
      return { ok: false, reason: LOBBY_REJECT.FORBIDDEN, field: f };
    }
  }
  // sessionId — faqat SELYEKTOR (mavjud sessiyaga mos kelishi shart)
  if (msg.sessionId !== undefined && msg.sessionId !== null) {
    if (!Number.isFinite(msg.sessionId) || !Number.isInteger(msg.sessionId)) {
      return { ok: false, reason: LOBBY_REJECT.BAD_MSG, field: 'sessionId' };
    }
    const cur = hub.session ? hub.session.id : null;
    if (cur === null || msg.sessionId !== cur) {
      return { ok: false, reason: LOBBY_REJECT.NO_SESSION, field: 'sessionId' };
    }
  }
  const name = sanitizeLobbyName(msg.name);
  if (name === null) return { ok: false, reason: LOBBY_REJECT.BAD_MSG, field: 'name' };
  return { ok: true, name };
}

/**
 * Kliyentga yuboriladigan AVTORITAR lobby snapshot'i.
 * `you`/`isHost`/`inSession` — har bir ko'ruvchi uchun alohida hisoblanadi.
 */
export function lobbySnapshot (hub, viewerId, { addresses = [], serverTime = 0 } = {}) {
  const s = hub.session;
  const you = viewerId === undefined || viewerId === null ? null : String(viewerId);
  const players = [];
  let isHostFlag = false;
  let inSessionFlag = false;
  if (s) {
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i];
      const host = p.id === s.hostId;
      if (p.id === you) { isHostFlag = host; inSessionFlag = true; }
      players.push({ id: p.id, name: p.name, host, connected: true, joinedAt: p.joinedAt, prefer: p.prefer || null });
    }
  }
  return {
    revision: hub.revision,
    sessionId: s ? s.id : null,
    state: s ? s.state : LOBBY_PHASE.NONE,
    hostId: s ? s.hostId : null,
    capacity: hub.capacity,
    count: players.length,
    you,
    isHost: isHostFlag,
    inSession: inSessionFlag,
    players,
    addresses: addresses.slice(),
    createdAt: s ? s.createdAt : 0,
    startedAt: s ? s.startedAt : 0,
    serverTime
  };
}
