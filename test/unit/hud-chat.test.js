// ============================================================
// NEON STRIKE — PHASE 9: HUD / POLISH / CHAT testlari
// Ishlab chiqarish modullari: client/js/game/hud-state.js (sof adapter),
// server/chat.js (sof matn qoidalari) va server/app.js (real WebSocket oqimi).
// Mock YO'Q — chat yo'li HAQIQIY server orqali tekshiriladi.
// Qoplanadi: avtoritar HP/o'q-dori/team/raund/ball HUD qiymatlari · offline
// fallback · raund/match o'tishlari · chat validatsiyasi · kimlik serverda ·
// sessiya-ichida tarqatish · flood himoyasi · buzilgan chat.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WebSocket } from 'ws';

import { buildHudView, connectionState, connectionBadge, roundStateLabel, CONNECTION } from '../../client/js/game/hud-state.js';
import { createChatHub, validateChat, acceptChat, resetChat, chatHistory, CHAT_REJECT, CHAT_FORBIDDEN_FIELDS } from '../../server/chat.js';
import { createNeonServer } from '../../server/app.js';
import { MSG, CHAT, SIM, MATCH_PHASE, TEAM } from '../../shared/protocol-consts.js';

// ============================================================
// 1) HUD ADAPTERI — SOF QIYMATLAR (hisoblash emas, ko'rsatish)
// ============================================================
test('hud: ulanish holati HAQIQIY WS holatidan (connected/connecting/disconnected)', () => {
  assert.equal(connectionState({ connected: true, readyState: 1 }), CONNECTION.CONNECTED);
  assert.equal(connectionState({ connected: false, readyState: 0 }), CONNECTION.CONNECTING);
  assert.equal(connectionState({ connected: false, readyState: 3 }), CONNECTION.DISCONNECTED);
  assert.equal(connectionState({}), CONNECTION.DISCONNECTED);
  assert.equal(connectionBadge(CONNECTION.CONNECTED).cls, 'ok');
  assert.equal(connectionBadge(CONNECTION.DISCONNECTED).cls, 'bad');
});

test('hud: raund holati yorliqlari server qiymatlaridan', () => {
  assert.equal(roundStateLabel('starting'), 'STARTING');
  assert.equal(roundStateLabel('live'), 'LIVE');
  assert.equal(roundStateLabel('round_end'), 'ROUND OVER');
  assert.equal(roundStateLabel('match_end'), 'MATCH OVER');
  assert.equal(roundStateLabel('none'), '—');
});

test('hud: avtoritar HP/o‘q-dori HUD ga SERVERDAN yetib keladi (klient hisoblamaydi)', () => {
  const view = buildHudView({
    authoritative: {
      authoritativeMovement: true, hp: 37, maxHp: 100, alive: true, respawnIn: -1,
      teamId: TEAM.A, playerId: 'p1',
      weapon: { weaponId: 'neon-rifle', slot: 1, mag: 11, magSize: 30, reserve: 88, reloading: true, reloadProgress: 0.42, switching: false }
    },
    // lokal bashorat ATAYIN boshqa qiymatlarda — HUD uni EMAS, serverni ko'rsatishi kerak
    local: { hp: 100, maxHp: 100, alive: true, respawnIn: 0, weapon: { weaponId: 'pulse-pistol', slot: 2, mag: 12, magSize: 12, reserve: 60, reloading: false } }
  });
  assert.equal(view.source, 'server');
  assert.equal(view.authoritative, true);
  assert.equal(view.hp, 37, 'HP serverdan olinmadi');
  assert.equal(view.weapon.mag, 11, 'mag serverdan olinmadi');
  assert.equal(view.weapon.reserve, 88);
  assert.equal(view.weapon.reloading, true);
  assert.equal(view.weapon.reloadProgress, 0.42);
  assert.equal(view.weapon.weaponId, 'neon-rifle');
  assert.deepEqual(view.fromServer, { hp: true, ammo: true });
});

test('hud: avtoritar sessiya bo‘lmasa — lokal bashorat (offline TRAINING) ko‘rsatiladi', () => {
  const view = buildHudView({
    authoritative: { authoritativeMovement: false, hp: 90, weapon: { weaponId: 'neon-rifle', mag: 30, reserve: 120 } },
    local: { hp: 72, maxHp: 100, alive: true, respawnIn: 0, weapon: { weaponId: 'scatter-shot', slot: 3, mag: 2, magSize: 6, reserve: 14, reloading: false } }
  });
  assert.equal(view.source, 'predict');
  assert.equal(view.hp, 72);
  assert.equal(view.weapon.weaponId, 'scatter-shot');
  assert.deepEqual(view.fromServer, { hp: false, ammo: false });
  // hech narsa yo'q bo'lsa ham portlamaydi
  const empty = buildHudView();
  assert.equal(empty.source, 'predict');
  assert.equal(empty.alive, true);
  assert.equal(empty.connection.state, CONNECTION.DISCONNECTED);
});

test('hud: o‘lim holati va raund rejimida respawn yo‘qligi (respawnIn < 0)', () => {
  const view = buildHudView({
    authoritative: { authoritativeMovement: true, hp: 0, maxHp: 100, alive: false, respawnIn: -1, weapon: { mag: 0, reserve: 0 } }
  });
  assert.equal(view.dead, true);
  assert.equal(view.alive, false);
  assert.equal(view.hp, 0);
  assert.equal(view.respawnIn, -1, 'cheksiz respawn qiymati HUD ga o‘tmasligi kerak');
});

test('hud: jamoa/raund/ball SERVER match blokidan (klient hisoblamaydi)', () => {
  const match = {
    matchState: MATCH_PHASE.LIVE, roundState: MATCH_PHASE.LIVE, roundNumber: 3,
    scores: { A: 2, B: 1 }, teams: { A: ['p1', 'p3'], B: ['p2', 'p4'] },
    roundWinner: null, matchWinner: null
  };
  const view = buildHudView({
    authoritative: { authoritativeMovement: true, hp: 100, teamId: null, weapon: { mag: 30, reserve: 120 } },
    snapshot: { match, players: [{ id: 'p3', teamId: TEAM.B, alive: true, hp: 100 }] },
    you: 'p3'
  });
  assert.equal(view.team, TEAM.B, 'jamoa snapshotdan olinmadi');
  assert.equal(view.roundNumber, 3);
  assert.equal(view.roundState, 'live');
  assert.equal(view.matchState, 'live');
  assert.deepEqual(view.scores, { A: 2, B: 1 });
  assert.equal(view.scoreText, 'A 2 : 1 B');
  assert.equal(view.teamText, 'JAMOA B');
  assert.equal(view.roundText, 'RAUND 3 · LIVE');
  assert.equal(view.inMatch, true);
  assert.equal(view.banner.show, false, 'LIVE paytida banner ko‘rinmasligi kerak');
});

test('hud: raund/match o‘tishlari — banner AVTORITAR g‘olib/balldan, keyingi raundda yo‘qoladi', () => {
  const base = {
    authoritative: { authoritativeMovement: true, hp: 100, teamId: TEAM.A, weapon: { mag: 30, reserve: 120 } }
  };
  const at = (match) => buildHudView({ ...base, snapshot: { match, players: [] } });

  // LOBBY → hali match yo'q
  const lobby = at({ matchState: MATCH_PHASE.LOBBY, roundState: 'lobby', roundNumber: 0, scores: { A: 0, B: 0 } });
  assert.equal(lobby.inMatch, false);
  assert.equal(lobby.banner.show, false);

  // STARTING → tayyorgarlik banneri
  const starting = at({ matchState: MATCH_PHASE.STARTING, roundState: MATCH_PHASE.STARTING, roundNumber: 1, scores: { A: 0, B: 0 } });
  assert.equal(starting.banner.show, true);
  assert.equal(starting.banner.title, 'ROUND 1');
  assert.equal(starting.banner.sub, 'GET READY');

  // ROUND_END → g'olib + ball
  const roundEnd = at({ matchState: MATCH_PHASE.LIVE, roundState: MATCH_PHASE.ROUND_END, roundNumber: 1, roundWinner: TEAM.B, scores: { A: 0, B: 1 } });
  assert.equal(roundEnd.banner.show, true);
  assert.equal(roundEnd.banner.title, 'ROUND 1 OVER');
  assert.match(roundEnd.banner.sub, /TEAM B WINS/);
  assert.match(roundEnd.banner.sub, /A 0 : 1 B/);

  // keyingi raund LIVE → banner YO'Q (stale overlay qolmaydi)
  const nextRound = at({ matchState: MATCH_PHASE.LIVE, roundState: MATCH_PHASE.LIVE, roundNumber: 2, scores: { A: 0, B: 1 } });
  assert.equal(nextRound.banner.show, false);
  assert.equal(nextRound.roundNumber, 2);
  assert.deepEqual(nextRound.scores, { A: 0, B: 1 }, 'ball saqlanmadi');

  // MATCH_END → yakuniy natija
  const matchEnd = at({ matchState: MATCH_PHASE.MATCH_END, roundState: MATCH_PHASE.MATCH_END, roundNumber: 6, matchWinner: TEAM.A, scores: { A: 5, B: 1 } });
  assert.equal(matchEnd.banner.show, true);
  assert.equal(matchEnd.banner.title, 'MATCH COMPLETE');
  assert.match(matchEnd.banner.sub, /TEAM A WINS/);
  assert.match(matchEnd.banner.sub, /A 5 : 1 B/);
});

test('hud: adapter SOF — DOM/window/three.js yo‘q (Node’da test qilinadi)', () => {
  const src = fs.readFileSync(new URL('../../client/js/game/hud-state.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  assert.equal(/\bdocument\b|\bwindow\b|requestAnimationFrame|three|WebSocket|fetch/.test(code), false,
    'hud-state.js brauzerga bog‘langan');
  // import ham yo'q — adapter faqat kiritilgan qiymatlarni normallashtiradi
  assert.equal(/^import\s/m.test(code), false, 'hud-state.js import qilyapti (sof emas)');
});

// ============================================================
// 2) CHAT — SOF QOIDALAR (server/chat.js)
// ============================================================
const member = (id = 'p1', name = 'neon') => ({ id, name });

test('chat: sof modul — socket/DOM/three yo‘q, faqat matn qoidalari', () => {
  const src = fs.readFileSync(new URL('../../server/chat.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  assert.equal(/\bdocument\b|\bwindow\b|three|WebSocket|\.send\(/.test(code), false,
    'chat.js tarmoq/DOM ga bog‘langan');
});

test('chat: matn normallanadi; bo‘sh/probel/boshqaruv belgilari rad etiladi', () => {
  const hub = createChatHub();
  assert.equal(acceptChat(hub, member(), { text: '  salom  ' }, 1000).entry.text, 'salom');
  assert.equal(validateChat({ text: '' }).reason, CHAT_REJECT.EMPTY);
  assert.equal(validateChat({ text: '   ' }).reason, CHAT_REJECT.EMPTY);
  assert.equal(validateChat({ text: 42 }).reason, CHAT_REJECT.BAD_TEXT);
  assert.equal(validateChat({ text: null }).reason, CHAT_REJECT.BAD_TEXT);
  assert.equal(validateChat(null).reason, CHAT_REJECT.BAD_MSG);
  assert.equal(validateChat([]).reason, CHAT_REJECT.BAD_MSG);
  assert.equal(validateChat({ type: 'not-chat', text: 'x' }).reason, CHAT_REJECT.BAD_MSG);
  // boshqaruv belgilari tozalanadi (patchwork matn qolmaydi)
  assert.equal(acceptChat(hub, member(), { text: 'a\u0000b\u001fc' }, 2000).entry.text, 'abc');
});

test('chat: UZUNLIK chegarasi (160) — 161 belgi RAD, 160 belgi o‘tadi', () => {
  const hub = createChatHub();
  assert.equal(validateChat({ text: 'a'.repeat(CHAT.MAX_LEN) }).ok, true);
  const long = validateChat({ text: 'a'.repeat(CHAT.MAX_LEN + 1) });
  assert.equal(long.ok, false);
  assert.equal(long.reason, CHAT_REJECT.TOO_LONG);
  assert.equal(acceptChat(hub, member(), { text: 'x'.repeat(5000) }, 1000).reason, CHAT_REJECT.TOO_LONG);
  assert.equal(hub.accepted, 0, 'rad etilgan xabar tarixga yozildi');
});

test('chat: YUBORUVCHI KIMLIGI — klient playerId/name/seq/vaqt da’vo qila olmaydi', () => {
  const hub = createChatHub();
  for (const f of CHAT_FORBIDDEN_FIELDS) {
    const r = acceptChat(hub, member(), { text: 'hi', [f]: 'p999' }, 1000);
    assert.equal(r.ok, false, `${f} qabul qilindi`);
    assert.equal(r.reason, CHAT_REJECT.FORBIDDEN, `${f} → ${r.reason}`);
    assert.equal(r.field, f);
  }
  // kimlik FAQAT `member` (server sessiyasi) dan olinadi
  const ok = acceptChat(hub, member('p7', 'ali'), { text: 'hi' }, 1000, 12);
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.playerId, 'p7');
  assert.equal(ok.entry.name, 'ali');
  assert.equal(ok.entry.serverTick, 12);
  assert.equal(ok.entry.serverTime, 1000);
  // klient `name` yuborib o'zini boshqa deb ko'rsata olmaydi
  const spoof = acceptChat(hub, member('p7', 'ali'), { text: 'hi', name: 'boshqa' }, 1001);
  assert.equal(spoof.reason, CHAT_REJECT.FORBIDDEN);
});

test('chat: FLOOD himoyasi — portlash (burst) tugagach qisqa kutish', () => {
  const hub = createChatHub({ burst: 3, windowMs: 1000 });
  const ok = [];
  for (let i = 0; i < 6; i++) ok.push(acceptChat(hub, member('p1'), { text: 'm' + i }, 5000 + i).ok);
  assert.deepEqual(ok, [true, true, true, false, false, false], 'chegara ishlamadi');
  assert.equal(hub.rejections[CHAT_REJECT.RATE_LIMITED], 3);
  // oyna o'tgach yana ruxsat (lekin boshqa o'yinchi chegarasi alohida)
  assert.equal(acceptChat(hub, member('p1'), { text: 'later' }, 9000).ok, true);
  assert.equal(acceptChat(hub, member('p2'), { text: 'boshqa' }, 9000).ok, true, 'chegara o‘yinchiga bog‘lanmagan');
});

test('chat: tarix cheklangan va sessiya yopilganda tozalanadi', () => {
  const hub = createChatHub({ history: 3, burst: 99 });
  for (let i = 0; i < 6; i++) acceptChat(hub, member('p1'), { text: 'm' + i }, 1000 + i);
  assert.equal(hub.entries.length, 3, 'tarix chegarasi ishlamadi');
  assert.deepEqual(chatHistory(hub, 3).map((e) => e.text), ['m3', 'm4', 'm5']);
  assert.equal(hub.sequence, 6, 'umumiy ketma-ketlik yo‘qoldi');
  resetChat(hub);
  assert.equal(hub.entries.length, 0);
  assert.equal(hub.sequence, 0);
});

test('chat: a’zo bo‘lmasa hech narsa qabul qilinmaydi', () => {
  const hub = createChatHub();
  assert.equal(acceptChat(hub, null, { text: 'hi' }, 1000).reason, CHAT_REJECT.NO_MEMBER);
  assert.equal(hub.accepted, 0);
  assert.equal(hub.sequence, 0);
});

// ============================================================
// 3) HAQIQIY WEBSOCKET: chat SERVER orqali (klient → server → sessiya)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Navbatdagi eski xabarlarni bo'shatish (qaysi revision kelganini aniq bilish uchun) */
function drain (ws, type) {
  let n = 0;
  while (ws._q.some((m) => m.type === type)) { next(ws, type); n += 1; }
  return n;
}

async function emptyLobby (tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (!server.state.lobby.session) return true;
    await sleep(50);
  }
  return false;
}
async function hello (name) {
  const ws = await connect();
  send(ws, { type: MSG.HELLO, name });
  await next(ws, MSG.WELCOME);
  const session = await next(ws, MSG.SESSION);
  const lobby0 = await next(ws, MSG.LOBBY_STATE);
  return { ws, session, lobby0 };
}
async function closeClient (ws) {
  try { ws.close(); } catch {}
  await sleep(80);
}
/** A'zolar uchun: host + join (ikkalasi server tomonidan tasdiqlangan) */
async function twoInSession () {
  const a = await hello('chat-a');
  send(a.ws, { type: MSG.CREATE_SESSION, name: 'chat-a' });
  const la = await next(a.ws, MSG.LOBBY_STATE);
  assert.equal(la.isHost, true);
  const b = await hello('chat-b');
  send(b.ws, { type: MSG.JOIN_SESSION, name: 'chat-b' });
  let lb = await next(b.ws, MSG.LOBBY_STATE);
  lb = lb.count === 2 ? lb : await next(b.ws, MSG.LOBBY_STATE);
  assert.equal(lb.count, 2, 'guest sessiyaga qo‘shilmadi');
  return { a, b };
}

test.after(async () => { await server.close(); });

test('WS chat: a’zo BO‘LMAGANDA rad etiladi (hello yo‘q / sessiya yo‘q)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  // hello qilinmagan ulanish
  const raw = await connect();
  send(raw, { type: MSG.CHAT, text: 'salom' });
  const e1 = await next(raw, MSG.ERROR);
  assert.equal(e1.code, CHAT_REJECT.NO_MEMBER);
  await closeClient(raw);

  // hello bor, lekin sessiyaga a'zo emas
  const { ws } = await hello('yolgiz');
  send(ws, { type: MSG.CHAT, text: 'salom' });
  const e2 = await next(ws, MSG.ERROR);
  assert.equal(e2.code, CHAT_REJECT.NOT_IN_SESSION);
  await closeClient(ws);
});

test('WS chat: klient A → SERVER → A va B (sessiya-ichida tarqatiladi)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  resetChat(server.state.chat);
  const { a, b } = await twoInSession();

  // A yuboradi → A ham, B ham oladi (klient klientga to'g'ridan-to'g'ri yozmaydi)
  send(a.ws, { type: MSG.CHAT, text: 'gg hammaga' });
  const gotA = await next(a.ws, MSG.CHAT_MSG);
  const gotB = await next(b.ws, MSG.CHAT_MSG);
  assert.equal(gotA.text, 'gg hammaga');
  assert.equal(gotB.text, 'gg hammaga');
  assert.equal(gotA.playerId, a.session.playerId, 'yuboruvchi kimligi serverdan emas');
  assert.equal(gotB.playerId, a.session.playerId);
  assert.equal(gotA.seq, gotB.seq, 'xabar tartibi mos emas');
  assert.ok(Number.isFinite(gotB.serverTick) && gotB.serverTick >= 0);

  // B javob beradi → tartib raqami ortadi (server ketma-ketligi)
  send(b.ws, { type: MSG.CHAT, text: 'omad' });
  const back = await next(a.ws, MSG.CHAT_MSG);
  assert.equal(back.playerId, b.session.playerId);
  assert.equal(back.text, 'omad');
  assert.equal(back.seq, gotA.seq + 1, 'xabar ketma-ketligi uzildi');

  // server xotirasi (dalil DOM emas)
  const tel = server.telemetry();
  assert.equal(tel.chat.accepted, 2);
  assert.equal(tel.chat.lastSeq, 2);
  assert.equal(tel.chat.last.text, 'omad');
  assert.equal(tel.chat.last.playerId, b.session.playerId);

  await closeClient(a.ws); await closeClient(b.ws);
});

test('WS chat: DA’VO QILINGAN kimlik/vaqt qabul qilinmaydi, xabar tarqatilmaydi', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  resetChat(server.state.chat);
  const { a, b } = await twoInSession();
  const before = server.telemetry().chat.accepted;

  for (const forged of [
    { playerId: 'p999' }, { name: 'hacker' }, { teamId: TEAM.B },
    { sessionId: 1 }, { seq: 999 }, { serverTick: 12345 }
  ]) {
    send(a.ws, { type: MSG.CHAT, text: 'soxta', ...forged });
    const err = await next(a.ws, MSG.ERROR);
    assert.equal(err.code, CHAT_REJECT.FORBIDDEN, `${JSON.stringify(forged)} qabul qilindi`);
  }
  await sleep(120);
  assert.equal(server.telemetry().chat.accepted, before, 'soxta xabar qabul qilindi');
  // B ga hech narsa yetib kelmagan
  let leaked = false;
  try { await next(b.ws, MSG.CHAT_MSG, 250); leaked = true; } catch { leaked = false; }
  assert.equal(leaked, false, 'soxta xabar tarqatildi');
  await closeClient(a.ws); await closeClient(b.ws);
});

test('WS chat: uzun/bo‘sh/buzilgan chat — server YIQILMAYDI va keyin ishlaydi', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  resetChat(server.state.chat);
  const { a, b } = await twoInSession();
  const tel0 = server.telemetry();

  send(a.ws, { type: MSG.CHAT, text: 'x'.repeat(CHAT.MAX_LEN + 1) });
  assert.equal((await next(a.ws, MSG.ERROR)).code, CHAT_REJECT.TOO_LONG);
  send(a.ws, { type: MSG.CHAT, text: '   ' });
  assert.equal((await next(a.ws, MSG.ERROR)).code, CHAT_REJECT.EMPTY);
  send(a.ws, { type: MSG.CHAT, text: 42 });
  assert.equal((await next(a.ws, MSG.ERROR)).code, CHAT_REJECT.BAD_TEXT);
  // buzilgan JSON va noma'lum tur — ikkalasi ham xato, server tirik qoladi
  a.ws.send('{ bu JSON emas');
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'bad_json');
  send(a.ws, { type: 'chat-noma-lum', text: 'x' });
  assert.equal((await next(a.ws, MSG.ERROR)).code, 'unknown_type');

  // server hali tirik: to'g'ri xabar ishlaydi
  try {
    send(a.ws, { type: MSG.CHAT, text: 'hamma yaxshimi?' });
    const ok = await next(b.ws, MSG.CHAT_MSG);
    assert.equal(ok.text, 'hamma yaxshimi?');
    const tel = server.telemetry();
    assert.equal(tel.tickErrors, 0, 'server tick xatosi');
    assert.equal(tel.chat.accepted - tel0.chat.accepted, 1, 'to‘g‘ri xabar qabul qilinmadi');
    assert.ok(tel.chat.rejected - tel0.chat.rejected >= 3, 'buzilgan chatlar rad etilmadi');
  } finally {
    await closeClient(a.ws); await closeClient(b.ws);
  }
});

test('WS chat: flood himoyasi serverda (matn ko‘paytirib yuborilmaydi)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  resetChat(server.state.chat);
  const { a, b } = await twoInSession();

  const before = server.telemetry();
  const acceptedBefore = before.chat.accepted;
  const limitedBefore = before.chat.rejections[CHAT_REJECT.RATE_LIMITED] || 0;
  try {
    for (let i = 0; i < CHAT.BURST + 4; i++) {
      send(a.ws, { type: MSG.CHAT, text: 'flood-' + i });
    }
    await sleep(400);
    // B qancha xabar olganini sanaymiz (haqiqiy tarqatish dalili)
    let delivered = 0;
    while (b.ws._q.some((m) => m.type === MSG.CHAT_MSG)) {
      await next(b.ws, MSG.CHAT_MSG);
      delivered += 1;
    }
    const tel = server.telemetry();
    assert.equal(delivered, CHAT.BURST, `tarqatilgan xabar soni noto‘g‘ri (${delivered})`);
    assert.equal(tel.chat.accepted - acceptedBefore, CHAT.BURST, 'qabul qilingan xabar soni');
    assert.ok((tel.chat.rejections[CHAT_REJECT.RATE_LIMITED] || 0) - limitedBefore >= 4,
      'flood himoyasi ishlamadi');
  } finally {
    await closeClient(a.ws); await closeClient(b.ws);
  }
});

test('WS chat: sessiya yopilganda chat tarixi tozalanadi va a’zo bo‘lmagan yubora olmaydi', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  const { a, b } = await twoInSession();
  const acceptedBefore = server.telemetry().chat.accepted;
  try {
    send(a.ws, { type: MSG.CHAT, text: 'yakkalanib qoldim' });
    await next(a.ws, MSG.CHAT_MSG);
    assert.ok(server.state.chat.entries.length > 0, 'chat tarixi yozilmadi');

    // A sessiyadan chiqadi → endi a'zo EMAS → chat yubora olmaydi
    drain(a.ws, MSG.LOBBY_STATE);
    send(a.ws, { type: MSG.LEAVE_SESSION });
    const la = await next(a.ws, MSG.LOBBY_STATE);
    assert.equal(la.inSession, false, 'chiqqandan keyin ham a\u2019zo deb ko\u2019rsatildi');
    send(a.ws, { type: MSG.CHAT, text: 'endi yubora olmayman' });
    const err = await next(a.ws, MSG.ERROR);
    assert.equal(err.code, CHAT_REJECT.NOT_IN_SESSION);
    assert.equal(server.telemetry().chat.accepted - acceptedBefore, 1,
      'chiqqan a\u2019zo xabari qabul qilindi');
    assert.ok(server.state.chat.entries.length > 0, 'sessiya davomida tarix SAQLANADI');
  } finally {
    await closeClient(a.ws);
    await closeClient(b.ws);
  }

  // oxirgi a'zo chiqdi → sessiya YOPILADI → chat tarixi tozalanadi
  assert.equal(await emptyLobby(), true, 'sessiya yopilmadi');
  assert.equal(server.state.chat.entries.length, 0, 'stale chat tarixi qoldi');
});

test('WS chat: sessiya ochilganda BOSHQA sessiya a’zolari xabar olmaydi (session-local)', async () => {
  assert.equal(await emptyLobby(), true, 'oldingi testdan stale lobby');
  resetChat(server.state.chat);
  const outsider = await hello('tashqarida');
  const { a, b } = await twoInSession();
  send(a.ws, { type: MSG.CHAT, text: 'faqat sessiya uchun' });
  await next(b.ws, MSG.CHAT_MSG);
  let leaked = false;
  try { await next(outsider.ws, MSG.CHAT_MSG, 300); leaked = true; } catch { leaked = false; }
  assert.equal(leaked, false, 'sessiyadan tashqariga chat ketdi');
  await closeClient(a.ws); await closeClient(b.ws); await closeClient(outsider.ws);
});

// ============================================================
// 4) FAZA CHEGARASI (Phase 10+ kirmagan)
// ============================================================
test('p9/chegara: chat HUD ni AVTORITETGA aylantirmaydi (server qarorlari saqlanadi)', async () => {
  // HUD adapteri ball/HP ni HISOBLAMAYDI — faqat kiritilgan qiymatni qaytaradi.
  const match = { matchState: MATCH_PHASE.LIVE, roundState: MATCH_PHASE.LIVE, roundNumber: 4, scores: { A: 9, B: 8 }, roundWinner: null, matchWinner: null };
  const v = buildHudView({
    authoritative: { authoritativeMovement: true, hp: 3, teamId: TEAM.B, weapon: { mag: 0, reserve: 0 } },
    snapshot: { match, players: [] }
  });
  assert.deepEqual(v.scores, { A: 9, B: 8 }, 'ball klientda o‘zgartirildi');
  assert.equal(v.hp, 3);
  assert.equal(v.weapon.mag, 0);
  // chat moduli combat/match qoidalariga TEGMAYDI
  const chatSrc = fs.readFileSync(new URL('../../server/chat.js', import.meta.url), 'utf8');
  const chatCode = chatSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  // (kimlik maydonlari RO'YXATI — bu "qaror" emas: ular RAD ETILADIGAN maydonlar)
  assert.equal(/\b(resolveShot|computeDamage|applyDamage|stepCombat|stepGrenade|matchSnapshot|evaluateRound|endRound|assignTeam|stepMovement)\b/.test(chatCode),
    false, 'chat modulida o‘yin qarorlari bor');
  assert.equal(/from\s+['"].*(weapons|health|combat|hitdetect|match)\.js/.test(chatCode), false,
    'chat moduli o‘yin modullarini import qilyapti');
  // PHASE 10+: spectator/replay/voip/matchmaking yo'q
  const proto = await import('../../shared/protocol-consts.js');
  const p10 = /spectat|replay|voip|voice|matchmak|ranking|scoreboard|killfeed|lobbybrowser|friend|clan/i;
  for (const k of Object.keys(proto.MSG)) {
    assert.equal(p10.test(k), false, `Phase 10+ xabar turi kirmagan: ${k}`);
  }
  assert.equal(SIM.TICK_HZ, 30, 'server tick o‘zgardi');
  assert.equal(SIM.SNAPSHOT_HZ, 20, 'snapshot chastotasi o‘zgardi');
});
