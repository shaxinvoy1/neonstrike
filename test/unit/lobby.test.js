// ============================================================
// NEON STRIKE — PHASE 6: LAN LOBBY testlari
// Ishlab chiqarish modullari: server/lobby.js (sof qoidalar) + server/app.js
// (real WebSocket oqimi). Mock YO'Q.
// Qoplanadi: sessiya yaratish · host tayinlash · player identity · join/leave ·
// disconnect tozalash · host uzilishi · sig'im · ruxsatsiz host amali ·
// boshlash · lobby holati · buzilgan xabar · bir nechta parallel klient.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import {
  createLobbyHub, createLobbyMember, createSession, joinSession, leaveSession,
  startSession, removeMember, pickHost, findMember, isHost, validateLobbyMessage,
  lobbySnapshot, sanitizeLobbyName,
  LOBBY_PHASE, LOBBY_REJECT, LOBBY_FORBIDDEN_FIELDS
} from '../../server/lobby.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, SERVER_DEFAULTS, SIM } from '../../shared/protocol-consts.js';

// ---------------- yordamchilar ----------------
let NEXT = 0;
const mk = (id, joinedAt = 0) => createLobbyMember({ id, name: 'p' + id, joinedAt, sessionId: 1 });
const hub = (capacity = 8) => createLobbyHub({ capacity });

// ============================================================
// 1) SESSIYA YARATISH
// ============================================================
test('lobby: sessiya yaratiladi — yaratuvchi SERVER tomonidan HOST qilinadi', () => {
  const h = hub(4);
  const a = mk('p1', 100);
  const r = createSession(h, a, 100);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'created');
  assert.equal(h.session.id, 1);
  assert.equal(h.session.state, LOBBY_PHASE.LOBBY);
  assert.equal(h.session.hostId, 'p1');
  assert.equal(h.session.players.length, 1);
  assert.equal(h.session.createdAt, 100);
  assert.equal(h.revision, 1);
  assert.equal(h.sessionsCreated, 1);
});

test('lobby: createSession — a\u2019zo allaqachon ichida bo\u2019lsa idempotent, boshqasi uchun rad', () => {
  const h = hub(4);
  const a = mk('p1', 100);
  const b = mk('p2', 200);
  createSession(h, a, 100);
  // takroriy create (o'zi) — dublikat a'zo QO'SHILMAYDI
  const r2 = createSession(h, a, 150);
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, 'already');
  assert.equal(h.session.players.length, 1);
  // boshqa o'yinchi "men ham host" deb yangi sessiya ocholmaydi
  const r3 = createSession(h, b, 200);
  assert.equal(r3.ok, false);
  assert.equal(r3.reason, LOBBY_REJECT.EXISTS);
  assert.equal(h.session.players.length, 1, 'a\u2019zo qo\u2019shilmadi');
  assert.equal(h.session.hostId, 'p1', 'host o\u2019zgarmadi');
});

test('lobby: player identity SERVER beradi — klient "playerId/host..." da\u2019vo qila olmaydi', () => {
  const h = hub(4);
  const a = mk('p1', 100);
  createSession(h, a, 100);
  for (const f of LOBBY_FORBIDDEN_FIELDS) {
    const r = validateLobbyMessage(h, { type: MSG.JOIN_SESSION, [f]: 'p999' });
    assert.equal(r.ok, false, `${f} qabul qilindi`);
    assert.equal(r.reason, LOBBY_REJECT.FORBIDDEN, `${f} sabab`);
    assert.equal(r.field, f);
  }
  // "men host" / "state in_game" / "count 99" — hammasi rad
  assert.equal(validateLobbyMessage(h, { hostId: 'p999' }).reason, LOBBY_REJECT.FORBIDDEN);
  assert.equal(validateLobbyMessage(h, { state: 'in_game' }).reason, LOBBY_REJECT.FORBIDDEN);
  assert.equal(validateLobbyMessage(h, { count: 99 }).reason, LOBBY_REJECT.FORBIDDEN);
  assert.equal(validateLobbyMessage(h, { capacity: 999 }).reason, LOBBY_REJECT.FORBIDDEN);
});

// ============================================================
// 2) JOIN
// ============================================================
test('lobby: joinSession — mavjud sessiyaga qo\u2019shiladi, host o\u2019zgarmaydi', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  const r = joinSession(h, mk('p2', 200), 200);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'joined');
  assert.equal(h.session.players.length, 2);
  assert.equal(h.session.hostId, 'p1', 'host o\u2019zgardi');
  assert.equal(h.session.state, LOBBY_PHASE.LOBBY);
  assert.equal(h.joinsAccepted, 2);
});

test('lobby: joinSession — sessiya yo\u2019q bo\u2019lsa rad (lobby_none)', () => {
  const h = hub(4);
  const r = joinSession(h, mk('p2', 200), 200);
  assert.equal(r.ok, false);
  assert.equal(r.reason, LOBBY_REJECT.NO_SESSION);
  assert.equal(h.joinsRejected, 1);
  assert.equal(h.session, null);
});

test('lobby: dublikat join — ikkinchi marta a\u2019zo QO\u2019SHILMAYDI', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  const b = mk('p2', 200);
  joinSession(h, b, 200);
  const again = joinSession(h, b, 250);
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already');
  assert.equal(h.session.players.length, 2, 'dublikat a\u2019zo qo\u2019shildi');
});

// ============================================================
// 3) SIG'IM (CAPACITY)
// ============================================================
test('lobby: sig\u2019im QAT\u2019IY majburlanadi (to\u2019lganda join rad, chiqish bo\u2019sh joy ochadi)', () => {
  const h = hub(2);
  createSession(h, mk('p1', 100), 100);
  assert.equal(joinSession(h, mk('p2', 200), 200).ok, true);
  assert.equal(h.session.players.length, 2, 'sig\u2019im = 2');

  const full = joinSession(h, mk('p3', 300), 300);
  assert.equal(full.ok, false);
  assert.equal(full.reason, LOBBY_REJECT.FULL);
  assert.equal(h.session.players.length, 2, 'sig\u2019imdan oshib ketdi');
  assert.equal(h.joinsRejected, 1);

  // uzilish/chiqish sig\u2019imni bo'shatadi
  const left = leaveSession(h, 'p2', 400);
  assert.equal(left.ok, true);
  assert.equal(h.session.players.length, 1);

  const nowOk = joinSession(h, mk('p3', 500), 500);
  assert.equal(nowOk.ok, true);
  assert.equal(h.session.players.length, 2);
});

test('lobby: sig\u2019im chegaralari (1..32) xavfsiz qisqartiriladi', () => {
  assert.equal(createLobbyHub({ capacity: 0 }).capacity, 1);
  assert.equal(createLobbyHub({ capacity: -5 }).capacity, 1);
  assert.equal(createLobbyHub({ capacity: 999 }).capacity, 32);
  assert.equal(createLobbyHub({ capacity: NaN }).capacity, 8);
  assert.equal(createLobbyHub({}).capacity, 8);
});

// ============================================================
// 4) LEAVE / DISCONNECT
// ============================================================
test('lobby: leaveSession — a\u2019zo toza chiqadi (stale state qolmaydi)', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  joinSession(h, mk('p2', 200), 200);
  const r = leaveSession(h, 'p2', 300);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'left');
  assert.equal(r.removed.id, 'p2');
  assert.equal(findMember(h, 'p2'), null, 'stale a\u2019zo qoldi');
  assert.equal(h.session.players.length, 1);
  // takroriy leave — xato, lekin nol xavfsiz
  assert.equal(leaveSession(h, 'p2', 400).reason, LOBBY_REJECT.NOT_IN);
  assert.equal(h.session.players.length, 1);
});

test('lobby: oxirgi o\u2019yinchi chiqsa sessiya YOPILADI', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  const r = removeMember(h, 'p1', 200);
  assert.equal(r.closed, true);
  assert.equal(h.session, null, 'bo\u2019sh sessiya qoldi');
  assert.equal(h.revision, 2);
});

test('lobby: to\u2019liq bo\u2019lmagan sessiyada host uzilsa — host o\u2019tkaziladi', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  joinSession(h, mk('p2', 200), 200);
  joinSession(h, mk('p3', 300), 300);
  const info = removeMember(h, 'p1', 400);      // host uzildi
  assert.equal(info.hostChanged, true);
  assert.equal(info.newHostId, 'p2', 'host eng erta qo\u2019shilganga o\u2019tmadi');
  assert.equal(h.session.hostId, 'p2');
  assert.equal(h.session.players.length, 2);
  // keyingi uzilish ham deterministik
  const info2 = removeMember(h, 'p2', 500);
  assert.equal(info2.newHostId, 'p3');
});

test('lobby: host tanlovi deterministik — teng vaqtda kichik playerId ustun', () => {
  const players = [mk('p10', 100), mk('p2', 100), mk('p7', 100)];
  assert.equal(pickHost(players).id, 'p2');
  assert.equal(pickHost([]), null);
  assert.equal(pickHost([mk('p5', 50), mk('p1', 10)]).id, 'p1', 'joinedAt ustuvor');
});

// ============================================================
// 5) START (server qarori)
// ============================================================
test('lobby: faqat HOST boshlay oladi (ruxsatsiz amal rad)', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  joinSession(h, mk('p2', 200), 200);
  // a'zo bo'lmagan
  assert.equal(startSession(h, 'p9', 300).reason, LOBBY_REJECT.NOT_IN);
  // a'zo, lekin host emas
  assert.equal(startSession(h, 'p2', 300).reason, LOBBY_REJECT.NOT_HOST);
  assert.equal(h.session.state, LOBBY_PHASE.LOBBY, 'holat o\u2019zgardi');
  assert.equal(isHost(h, 'p2'), false);
});

test('lobby: sessiya yo\u2019q bo\u2019lsa yoki allaqachon boshlangan bo\u2019lsa start rad', () => {
  const h = hub(4);
  assert.equal(startSession(h, 'p1', 100).reason, LOBBY_REJECT.NO_SESSION);
  createSession(h, mk('p1', 100), 100);
  const ok = startSession(h, 'p1', 150);
  assert.equal(ok.ok, true);
  assert.equal(h.session.state, LOBBY_PHASE.IN_GAME);
  assert.equal(h.session.startedAt, 150);
  assert.equal(startSession(h, 'p1', 160).reason, LOBBY_REJECT.ALREADY_STARTED);
});

test('lobby: PHASE 7 join-in-progress — o\u2019yin boshlangach ham qo\u2019shilish OCHIQ, sig\u2019im qat\u2019iy', () => {
  const h = hub(2);
  createSession(h, mk('p1', 100), 100);
  startSession(h, 'p1', 150);
  assert.equal(h.session.state, LOBBY_PHASE.IN_GAME);
  // Phase 6 da bu YOPIQ edi (LOBBY_REJECT.IN_GAME); Phase 7 sinxronizatsiya
  // uchun join-in-progress OCHILDI — yangi a'zo joriy avtoritar holatni oladi.
  const r = joinSession(h, mk('p2', 200), 200);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'joined');
  assert.equal(h.session.players.length, 2);
  // sig'im baribir SERVER tomonidan qat'iy majburlanadi
  const full = joinSession(h, mk('p3', 300), 300);
  assert.equal(full.ok, false);
  assert.equal(full.reason, LOBBY_REJECT.FULL);
  assert.equal(h.session.players.length, 2, 'sig\u2019imdan oshib ketdi');
  // dublikat qo'shilish idempotent (player identity takrorlanmaydi)
  assert.equal(joinSession(h, mk('p2', 200), 310).reason, 'already');
  assert.equal(h.session.players.length, 2);
});

// ============================================================
// 6) SNAPSHOT (lobby holati)
// ============================================================
test('lobby: lobbySnapshot — har ko\u2019ruvchi uchun you/isHost/inSession to\u2019g\u2019ri', () => {
  const h = hub(3);
  createSession(h, mk('p1', 100), 100);
  joinSession(h, mk('p2', 200), 200);
  const asHost = lobbySnapshot(h, 'p1', { addresses: ['http://10.0.0.5:3000'], serverTime: 1000 });
  assert.equal(asHost.sessionId, 1);
  assert.equal(asHost.state, 'lobby');
  assert.equal(asHost.hostId, 'p1');
  assert.equal(asHost.count, 2);
  assert.equal(asHost.capacity, 3);
  assert.equal(asHost.you, 'p1');
  assert.equal(asHost.isHost, true);
  assert.equal(asHost.inSession, true);
  assert.equal(asHost.players.length, 2);
  assert.deepEqual(asHost.players.map((p) => [p.id, p.host]), [['p1', true], ['p2', false]]);
  assert.deepEqual(asHost.addresses, ['http://10.0.0.5:3000']);
  assert.equal(asHost.serverTime, 1000);

  const asGuest = lobbySnapshot(h, 'p2', {});
  assert.equal(asGuest.isHost, false);
  assert.equal(asGuest.inSession, true);

  const asOutsider = lobbySnapshot(h, 'p9', {});
  assert.equal(asOutsider.isHost, false);
  assert.equal(asOutsider.inSession, false, 'begona a\u2019zo deb ko\u2019rsatildi');
  assert.equal(asOutsider.you, 'p9');

  const empty = lobbySnapshot(createLobbyHub({ capacity: 4 }), 'p1', {});
  assert.equal(empty.sessionId, null);
  assert.equal(empty.state, 'none');
  assert.equal(empty.hostId, null);
  assert.equal(empty.count, 0);
  assert.equal(empty.players.length, 0);
  assert.equal(empty.inSession, false);
});

// ============================================================
// 7) VALIDATSIYA
// ============================================================
test('lobby: buzilgan lobby xabari rad etiladi (JSON turi/name/sessionId/NaN)', () => {
  const h = hub(4);
  createSession(h, mk('p1', 100), 100);
  const cases = [
    [null, LOBBY_REJECT.BAD_MSG],
    ['salom', LOBBY_REJECT.BAD_MSG],
    [[], LOBBY_REJECT.BAD_MSG],
    [{ name: 42 }, LOBBY_REJECT.BAD_MSG],                        // matn emas
    [{ sessionId: NaN }, LOBBY_REJECT.BAD_MSG],                   // NaN
    [{ sessionId: 1.5 }, LOBBY_REJECT.BAD_MSG],                   // butun emas
    [{ sessionId: Infinity }, LOBBY_REJECT.BAD_MSG],
    [{ sessionId: 99 }, LOBBY_REJECT.NO_SESSION],                 // mos kelmaydi
    [{ playerId: 'p9' }, LOBBY_REJECT.FORBIDDEN],
    [{ host: true }, LOBBY_REJECT.FORBIDDEN]
  ];
  for (const [msg, reason] of cases) {
    const r = validateLobbyMessage(h, msg);
    assert.equal(r.ok, false, `${JSON.stringify(msg)} qabul qilindi`);
    assert.equal(r.reason, reason, `${JSON.stringify(msg)} → ${r.reason}`);
  }
  // to'g'ri xabar
  const good = validateLobbyMessage(h, { name: 'Neon', sessionId: 1 });
  assert.equal(good.ok, true);
  assert.equal(good.name, 'Neon');
  assert.equal(validateLobbyMessage(h, {}).ok, true);
  assert.equal(validateLobbyMessage(h, { sessionId: 1 }).ok, true);
});

test('lobby: ism xavfsizligi — boshqaruv belgilari olib tashlanadi, uzunlik cheklanadi', () => {
  assert.equal(sanitizeLobbyName(undefined), '');
  assert.equal(sanitizeLobbyName(null), '');
  assert.equal(sanitizeLobbyName(123), null, 'matn bo\u2019lmagan ism qabul qilindi');
  assert.equal(sanitizeLobbyName('a\u0000b\u001fc'), 'abc');
  assert.equal(sanitizeLobbyName('  x  '), 'x');
  assert.equal(sanitizeLobbyName('x'.repeat(100)).length, 24);
});

// ============================================================
// 8) HAQIQIY WEBSOCKET: ko'p klientli lobby
// ============================================================
const server = createNeonServer({ port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const PORT = server.httpServer.address().port;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._q = []; ws._waiters = [];
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
      for (let i = 0; i < ws._waiters.length; i++) {
        const w = ws._waiters[i];
        if (!w.type || w.type === m.type) { ws._waiters.splice(i, 1); clearTimeout(w.to); return w.resolve(m); }
      }
      ws._q.push(m);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function next (ws, type = null, timeout = 5000) {
  for (let i = 0; i < ws._q.length; i++) {
    if (!type || ws._q[i].type === type) return Promise.resolve(ws._q.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`msg timeout (${type})`)), timeout);
    ws._waiters.push({ type, resolve, to });
  });
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));

/** Oldingi testdan stale lobby qolmaganini tasdiqlash (test izolyatsiyasi) */
async function emptyLobby (tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (!server.state.lobby.session) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** hello → welcome + session + lobby-state (state='none') */
async function hello (name) {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name });
  await next(ws, MSG.WELCOME);
  const session = await next(ws, MSG.SESSION);
  const lobby0 = await next(ws, MSG.LOBBY_STATE);
  return { ws, session, lobby0 };
}
const lobbyNow = () => server.state.lobby;
const waitLobby = (ws, pred, tries = 20) => new Promise((resolve, reject) => {
  let n = 0;
  const tick = async () => {
    try {
      const st = await next(ws, MSG.LOBBY_STATE, 1000);
      if (!pred || pred(st)) return resolve(st);
      if (++n >= tries) return resolve(st);
      return tick();
    } catch (e) { reject(e); }
  };
  tick();
});

test('WS: yangi klient lobby holatini oladi (sessiya yo\u2019q → state=none)', async () => {
  assert.equal(await emptyLobby(), true, 'boshida stale lobby bor');
  const { ws, session, lobby0 } = await hello('solo');
  assert.equal(lobby0.state, 'none');
  assert.equal(lobby0.sessionId, null);
  assert.equal(lobby0.capacity, SERVER_DEFAULTS.MAX_PLAYERS);
  assert.equal(lobby0.you, session.playerId, 'identity server bilan mos emas');
  assert.equal(lobby0.isHost, false);
  assert.ok(Array.isArray(lobby0.addresses) && lobby0.addresses.length >= 1, 'LAN manzil yo\u2019q');
  assert.match(lobby0.addresses[0], /^http:\/\/[^/]+:\d+$/);
  await leaveAndClose(ws);
});

/** Klientni toza yopish + server a'zoligi tozalanishini kutish */
async function leaveAndClose (ws) {
  try { ws.close(); } catch {}
  await new Promise((r) => setTimeout(r, 60));
}

test('WS: ikki mustaqil klient — host + join, lobby ikkalasida ko\u2019rinadi', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const a = await hello('host-a');
  send(a.ws, { type: MSG.CREATE_SESSION, name: 'host-a' });
  const la = await waitLobby(a.ws, (s) => s.count === 1 && s.isHost === true);
  assert.equal(la.isHost, true);
  assert.equal(la.hostId, a.session.playerId);
  assert.equal(la.count, 1);
  assert.deepEqual(la.players.map((p) => p.id), [a.session.playerId]);

  const b = await hello('guest-b');
  assert.equal(b.lobby0.state, 'lobby', 'ikkinchi klient sessiyani ko\u2019rmadi');
  assert.equal(b.lobby0.count, 1);
  assert.equal(b.lobby0.inSession, false);

  send(b.ws, { type: MSG.JOIN_SESSION, name: 'guest-b' });
  const lb = await waitLobby(b.ws, (s) => s.count === 2 && s.inSession === true);
  assert.equal(lb.count, 2);
  assert.equal(lb.isHost, false);
  assert.equal(lb.hostId, a.session.playerId, 'host o\u2019zgardi');

  // A ham yangilangan ro'yxatni oladi (broadcast)
  const la2 = await waitLobby(a.ws, (s) => s.count === 2);
  assert.equal(la2.count, 2);
  assert.deepEqual(la2.players.map((p) => p.id).sort(), [a.session.playerId, b.session.playerId].sort());
  assert.equal(la2.players.find((p) => p.id === a.session.playerId).host, true);

  // SERVER xotirasida haqiqatan 2 a'zo
  assert.equal(lobbyNow().session.players.length, 2);
  assert.equal(lobbyNow().session.hostId, a.session.playerId);

  // B chiqadi → A yangilanadi
  send(b.ws, { type: MSG.LEAVE_SESSION });
  const la3 = await waitLobby(a.ws, (s) => s.count === 1);
  assert.equal(la3.count, 1);
  assert.equal(lobbyNow().session.players.length, 1);

  await leaveAndClose(b.ws);
  await leaveAndClose(a.ws);
});

test('WS: soxta lobby amallari rad (identity/host da\u2019vosi, ruxsatsiz start)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const a = await hello('forger-a');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await waitLobby(a.ws, (s) => s.count === 1);

  const b = await hello('forger-b');
  send(b.ws, { type: MSG.JOIN_SESSION });
  await waitLobby(b.ws, (s) => s.count === 2);

  // (a) klient o'zini boshqa player deb da'vo qiladi
  send(b.ws, { type: MSG.JOIN_SESSION, playerId: 'p999' });
  const e1 = await next(b.ws, MSG.ERROR);
  assert.equal(e1.code, 'forbidden_authority');

  // (b) klient "men host" deb boshlashga urinadi
  assert.notEqual(server.state.lobby.session.hostId, b.session.playerId);
  send(b.ws, { type: MSG.START_SESSION });
  const e2 = await next(b.ws, MSG.ERROR);
  assert.equal(e2.code, 'not_host');
  assert.equal(server.state.lobby.session.state, 'lobby', 'holat o\u2019zgartirildi!');

  // (c) host bo'lmagan klient hostId/state ni yuborsa — butunlay rad
  send(b.ws, { type: MSG.START_SESSION, hostId: b.session.playerId, state: 'in_game' });
  const e3 = await next(b.ws, MSG.ERROR);
  assert.equal(e3.code, 'forbidden_authority');
  assert.equal(server.state.lobby.session.state, 'lobby');

  // (d) mavjud bo'lmagan sessiya id bilan join
  send(b.ws, { type: MSG.JOIN_SESSION, sessionId: 999 });
  assert.equal((await next(b.ws, MSG.ERROR)).code, 'lobby_none');

  // (e) buzilgan JSON / noma'lum tur / katta xabar
  b.ws.send('{{{ bu json emas');
  assert.equal((await next(b.ws, MSG.ERROR)).code, 'bad_json');
  send(b.ws, { type: 'create_lobby_cheat', host: true });
  assert.equal((await next(b.ws, MSG.ERROR)).code, 'unknown_type');
  b.ws.send(JSON.stringify({ type: MSG.JOIN_SESSION, pad: 'x'.repeat(40000) }));
  assert.equal((await next(b.ws, MSG.ERROR)).code, 'too_big');

  // (f) server tirik
  send(b.ws, { type: MSG.PING, t: 5 });
  assert.equal((await next(b.ws, MSG.PONG)).t, 5);
  assert.equal(server.telemetry().tickErrors, 0);
  assert.equal(lobbyNow().session.players.length, 2, 'soxta amal a\u2019zolikni buzdi');

  await leaveAndClose(b.ws);
  await leaveAndClose(a.ws);
});

test('WS: HOST boshlaydi — holat in_game; PHASE 7 join-in-progress OCHIQ + snapshot', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const a = await hello('starter');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await waitLobby(a.ws, (s) => s.isHost === true && s.count === 1);

  send(a.ws, { type: MSG.START_SESSION });
  const started = await waitLobby(a.ws, (s) => s.state === 'in_game');
  assert.equal(started.state, 'in_game');
  assert.equal(started.isHost, true);
  assert.ok(started.startedAt > 0, 'startedAt serverda belgilanmagan');
  assert.equal(lobbyNow().session.state, 'in_game');
  // PHASE 7: in_game → avtoritativ harakat + sinxronizatsiya YOQILGAN
  assert.equal(server.telemetry().sync.mode, 'authoritative');
  assert.equal(server.telemetry().sync.authoritativeSessions, 1);

  // PHASE 7 join-in-progress: yangi o'yinchi qo'shiladi va DARHOL joriy
  // avtoritar holatni (snapshot) oladi.
  const b = await hello('late');
  send(b.ws, { type: MSG.JOIN_SESSION });
  const joined = await waitLobby(b.ws, (s) => s.inSession === true);
  assert.equal(joined.state, 'in_game');
  assert.equal(lobbyNow().session.players.length, 2);

  const snap = await next(b.ws, MSG.SNAPSHOT);
  assert.equal(Array.isArray(snap.players), true, 'snapshot players yo\u2019q');
  assert.equal(snap.players.length >= 2, true, 'yangi a\u2019zo joriy holatni olmadi');
  assert.equal(Number.isFinite(snap.serverTick), true);
  assert.equal(server.telemetry().sync.authoritativeSessions, 2);

  await leaveAndClose(b.ws);
  await leaveAndClose(a.ws);
});

test('WS: sig\u2019im to\u2019lganda join rad, uzilish joy ochadi', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const cap = SERVER_DEFAULTS.MAX_PLAYERS;
  const hostWs = await hello('cap-host');
  send(hostWs.ws, { type: MSG.CREATE_SESSION });
  await waitLobby(hostWs.ws, (s) => s.count === 1);

  const guests = [];
  for (let i = 0; i < cap - 1; i++) {
    const g = await hello(`cap-${i}`);
    send(g.ws, { type: MSG.JOIN_SESSION });
    await waitLobby(g.ws, (s) => s.inSession === true);
    guests.push(g);
  }
  assert.equal(lobbyNow().session.players.length, cap, `sig\u2019im ${cap} to\u2019lmadi`);

  const overflow = await hello('cap-overflow');
  send(overflow.ws, { type: MSG.JOIN_SESSION });
  assert.equal((await next(overflow.ws, MSG.ERROR)).code, 'lobby_full');
  assert.equal(lobbyNow().session.players.length, cap, 'sig\u2019imdan oshib ketdi');

  // bitta mehmon chiqadi → bo'sh joy
  guests[0].ws.close();
  for (let i = 0; i < 60; i++) {
    if (lobbyNow().session && lobbyNow().session.players.length === cap - 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(lobbyNow().session.players.length, cap - 1, 'uzilish sig\u2019imni bo\u2019shatmadi');

  send(overflow.ws, { type: MSG.JOIN_SESSION });
  const joined = await waitLobby(overflow.ws, (s) => s.inSession === true);
  assert.equal(joined.inSession, true);
  assert.equal(lobbyNow().session.players.length, cap);

  await leaveAndClose(overflow.ws);
  for (const g of guests.slice(1)) await leaveAndClose(g.ws);
  await leaveAndClose(hostWs.ws);
});

test('WS: uzilish a\u2019zoni tozalaydi + host o\u2019tadi (takroriy close dublikat qilmaydi)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const a = await hello('dc-host');
  send(a.ws, { type: MSG.CREATE_SESSION });
  await waitLobby(a.ws, (s) => s.count === 1);
  const b = await hello('dc-guest');
  send(b.ws, { type: MSG.JOIN_SESSION });
  await waitLobby(b.ws, (s) => s.count === 2);

  // host uziladi
  a.ws.close();
  let migrated = null;
  for (let i = 0; i < 80; i++) {
    const l = lobbyNow();
    if (l.session && l.session.hostId === b.session.playerId) { migrated = l.session; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(migrated, 'host o\u2019tkazilmadi');
  assert.equal(migrated.hostId, b.session.playerId);
  assert.equal(migrated.players.length, 1);
  assert.equal(findMember(lobbyNow(), a.session.playerId), null, 'stale a\u2019zo qoldi');

  // B host holatini KO'RADI (server broadcast)
  const lb = await waitLobby(b.ws, (s) => s.isHost === true);
  assert.equal(lb.isHost, true);

  // takroriy close hodisasi dublikat tozalashga olib kelmasin
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lobbyNow().session.players.length, 1);

  await leaveAndClose(b.ws);
});

test('WS: bir nechta parallel klient — server sessiyalar va a\u2019zolar mos', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const clients = [];
  for (let i = 0; i < 5; i++) clients.push(await hello('multi-' + i));
  send(clients[0].ws, { type: MSG.CREATE_SESSION });
  await waitLobby(clients[0].ws, (s) => s.count === 1);
  for (let i = 1; i < clients.length; i++) {
    send(clients[i].ws, { type: MSG.JOIN_SESSION });
    await waitLobby(clients[i].ws, (s) => s.inSession === true);
  }
  const l = lobbyNow();
  assert.equal(l.session.players.length, 5);
  assert.equal(server.state.sessions.size >= 5, true, 'combat sessiyalari yo\u2019q');
  const ids = l.session.players.map((p) => p.id);
  assert.equal(new Set(ids).size, 5, 'player identity takrorlandi');
  for (const c of clients) await leaveAndClose(c.ws);
});

test('server: telemetriya lobby holatini ko\u2019rsatadi + session yopilganda none', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const t0 = server.telemetry();
  assert.equal(t0.lobby.state, 'none');
  assert.equal(t0.lobby.count, 0);
  assert.equal(t0.lobby.capacity, SERVER_DEFAULTS.MAX_PLAYERS);
  assert.ok(Array.isArray(t0.addresses) && t0.addresses.length >= 1);
  assert.equal(t0.protocol, 6);
  assert.equal(t0.tickErrors, 0);
  // PHASE 7: sinxronizatsiya telemetriyasi (in_game bo'lmasa — standalone)
  assert.equal(t0.sync.mode, 'standalone');
  assert.equal(t0.sync.authoritativeSessions, 0);
  assert.equal(t0.sync.snapshotHz, SIM.SNAPSHOT_HZ);
  // PHASE 8: match telemetriyasi (sessiya yo'q → match ham yo'q)
  assert.equal(t0.match.state, 'none');
  assert.equal(t0.match.scores.A, 0);
  assert.equal(t0.match.scores.B, 0);
  assert.equal(t0.match.roundsToWin, SIM.ROUNDS_TO_WIN);
});

test.after(() => server.close());
