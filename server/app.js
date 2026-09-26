// ============================================================
// NEON STRIKE — server (HTTP static + WebSocket + PHASE 5 AVTORITATIV SIM)
// ------------------------------------------------------------------
// PHASE 1 (regressiya): static xizmat + /ws handshake (hello/ping/gpu)
// PHASE 5: har bir ulanish uchun SERVER EGASIDAGI o'yinchi sessiyasi.
//   Klient FAQAT intent yuboradi; cooldown/o'q-dori/reload/hit/zarar/HP/
//   o'lim/respawn/granata — SERVER hal qiladi (server/session.js).
//   30 Hz simulyatsiya tick'i, 20 Hz avtoritar holat snapshot'i.
// PHASE 7: ko'p o'yinchili sinxronizatsiya — in_game rejimida server
//   harakatni O'ZI simulyatsiya qiladi va 20 Hz SNAPSHOT tarqatadi
//   (barcha o'yinchilar holati bitta xabarda).
// PHASE 8: match (jamoa/raund/ball) — server/match.js (SOF qoidalar).
// PHASE 9: chat — klient FAQAT matn yuboradi; yuboruvchi kimligini SERVER
//   aniqlaydi va xabar sessiya a'zolariga tarqatiladi (server/chat.js).
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, CHAT } from '../shared/protocol-consts.js';
import { WEAPON_ORDER } from '../shared/weapons.js';
import { MAP, TRAINING_DUMMIES, TRAINING_RINGS, SPAWNS, SOLID_BOXES } from '../shared/map.js';
import { validateSpawn } from '../shared/respawn.js';
import { createLogger } from './logger.js';
import { lanUrls } from './net.js';   // PHASE 11: LAN manzil mantiqi (bir manba)
import {
  createSession, applyInput, stepSession, resetSession, sessionSnapshot,
  setAuthoritativeMovement, playerSyncState, placePlayerAt, applyPeerTargets,
  setRoundHold
} from './session.js';
import {
  createLobbyHub, createLobbyMember, validateLobbyMessage, lobbySnapshot,
  createSession as lobbyCreate, joinSession as lobbyJoin, leaveSession as lobbyLeave,
  startSession as lobbyStart, removeMember as lobbyRemove, LOBBY_PHASE
} from './lobby.js';
// PHASE 8: jamoa / raund / ball — SOF qoidalar (server/session.js combat'idan alohida)
import {
  createMatch, resetMatch, startMatch, stepMatch, evaluateRound, endRound,
  assignTeam, teamOf, removePlayer as matchRemovePlayer, matchSnapshot,
  MATCH_PHASE, TEAM, MATCH_RULES
} from './match.js';
// PHASE 9: chat — SOF matn qoidalari + chegara (kimlik SERVERDAN olinadi)
import { createChatHub, acceptChat, resetChat, CHAT_REJECT } from './chat.js';
// PHASE 10: o'lchov (SOF modul) — tick/snapshot vaqti, resurs hayoti, xotira.
// Hech narsani hisoblamaydi va holatni o'zgartirmaydi: faqat o'lchaydi.
import { createMetrics, activeResources } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.map':  'application/json'
};

// Statik marshrutlar — faqat ruxsat etilgan kataloglar (uzun prefiks birinchi).
// server/, test/, node_modules/, package.json — HECH QACHON xizmat qilmaydi.
const ROUTES = [
  { prefix: '/vendor/', dir: path.join(ROOT, 'vendor') },
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/',        dir: path.join(ROOT, 'client') }
];

function send (res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function staticHandler (req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return send(res, 400, 'Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const route = ROUTES.find(r => pathname.startsWith(r.prefix));
  if (!route) return send(res, 404, 'Not found');
  const rel = pathname.slice(route.prefix.length);
  const filePath = path.resolve(route.dir, rel);
  // Path traversal himoyasi: yechilgan yo'l rostdan route.dir ichida bo'lishi shart
  if (filePath !== route.dir && !filePath.startsWith(route.dir + path.sep)) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

function safeSend (socket, obj) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj));
}
function sendErr (socket, code, message) {
  safeSend(socket, { type: MSG.ERROR, code, message });
}

export function createNeonServer ({ host = SERVER_DEFAULTS.HOST, port = SERVER_DEFAULTS.PORT, log = createLogger() } = {}) {
  const httpServer = http.createServer(staticHandler);
  // PHASE 12: protokol darajasidagi payload chegarasi. Ilova darajasidagi
  // `MAX_MSG_BYTES` (16 KiB) tekshiruvi SAQLANADI (mavjud `too_big` javobi va
  // eski verifikatsiya o'zgarmaydi), lekin `ws` standart 100 MiB o'rniga qat'iy
  // chegara qo'yamiz — undan katta xabar XOTIRAGA OLINMASDAN rad etiladi.
  const wss = new WebSocketServer({
    server: httpServer,
    path: SERVER_DEFAULTS.WS_PATH,
    maxPayload: SERVER_DEFAULTS.WS_MAX_PAYLOAD_BYTES
  });

  const state = {
    connections: new Set(),
    nextId: 1,
    startedAt: Date.now(),
    // ---- PHASE 5 ----
    sessions: new Map(),          // sessionId -> session (server egasidagi holat)
    nextSessionId: 1,
    tick: 0,
    tickAt: 0,
    loopMs: 0,
    tickErrors: 0,
    totals: { inputs: 0, accepted: 0, rejected: 0, events: 0, shots: 0, ticks: 0, lobbyActions: 0, lobbyRejected: 0, snapshots: 0, chatAccepted: 0, chatRejected: 0 },
    // ---- PHASE 6: LAN LOBBY (server egasidagi sessiya/a'zolik/host) ----
    lobby: createLobbyHub({ capacity: SERVER_DEFAULTS.MAX_PLAYERS }),
    // ---- PHASE 7: sinxronizatsiya (20 Hz SNAPSHOT) ----
    lastSyncAt: 0,
    sync: { frames: 0, players: 0, lastTickAt: 0 },
    _syncPlayers: [],           // qayta ishlatiladigan player obyektlari (alloc yo'q)
    // ---- PHASE 8: match (jamoa/raund/ball) — BITTA egasi: lobby sessiyasi ----
    match: createMatch(),
    _matchSnap: {},             // SNAPSHOT uchun qayta ishlatiladigan match bloki
    _lobbyMatchSnap: {},        // LOBBY_STATE uchun
    _peerScratch: [],           // peer nishon deskriptorlari (qayta ishlatiladi)
    matchEvents: 0,
    // ---- PHASE 9: chat (server egasidagi chegara/history — klient EMAS) ----
    chat: createChatHub(),
    // ---- PHASE 10: o'lchov yadrosi (P11/P12 tizimi EMAS — faqat metriika) ----
    metrics: createMetrics({ budgetMs: SIM.TICK_MS })
  };
  const metrics = state.metrics;
  const sessionBySocket = new WeakMap();
  const memberBySocket = new WeakMap();

  // ---------------- PHASE 6/11: LAN manzillar (faqat real, hard-code YO'Q) ----------------
  // PHASE 11: mantiq `server/net.js` ga ko'chirildi (takror yo'q + unit-testlanadi)
  function lanAddresses () {
    const addr = httpServer.address();
    const port = addr && typeof addr === 'object' ? addr.port : SERVER_DEFAULTS.PORT;
    return lanUrls(os.networkInterfaces(), port);
  }

  /**
   * @param {string} viewerId
   * @param {number} nowTs
   * @param {string[]|null} addresses — PHASE 10: bir marta hisoblangan manzillar
   *   (broadcast'da har a'zo uchun `os.networkInterfaces()` chaqirilmasin)
   */
  function lobbyPayload (viewerId, nowTs, addresses = null) {
    return {
      type: MSG.LOBBY_STATE,
      ...lobbySnapshot(state.lobby, viewerId, {
        addresses: addresses || lanAddresses(), serverTime: nowTs
      }),
      // PHASE 8: AVTORITAR match holati (jamoa/raund/ball) — lobby ko'rinishi
      match: matchSnapshot(state.match, state._lobbyMatchSnap, nowTs)
    };
  }

  /** Barcha ulangan o'yinchilarga avtoritar lobby holatini yuboradi */
  function broadcastLobby (nowTs = Date.now()) {
    // PHASE 10: manzillar BIR MARTA hisoblanadi. Ilgari `lanAddresses()` har
    // bir a'zo uchun chaqirilib, `os.networkInterfaces()` (o'lchandi ≈65 µs)
    // ni L marta takrorlardi — 8 a'zoda ≈0.5 ms/broadcast.
    const addresses = lanAddresses();
    for (const socket of state.connections) {
      const member = memberBySocket.get(socket);
      if (!member) continue;
      safeSend(socket, lobbyPayload(member.id, nowTs, addresses));
    }
  }

  // ---------------- PHASE 9: CHAT (faqat SESSIYA a'zolariga) ----------------
  /**
   * Chat xabari sessiya a'zolariga tarqatiladi. Yuboruvchi kimligi `entry`
   * dan olinadi (u SERVER sessiyasidan — klient da'vosi EMAS). Sessiya
   * bo'lmasa hech kimga yuborilmaydi (chat sessiya-ichida qoladi).
   * @returns {number} xabar yuborilgan a'zolar soni
   */
  function broadcastChat (entry, nowTs) {
    const s = state.lobby.session;
    if (!s) return 0;
    const payload = {
      type: MSG.CHAT_MSG,
      playerId: entry.playerId,
      name: entry.name,
      text: entry.text,
      seq: entry.seq,
      serverTick: entry.serverTick,
      serverTime: nowTs
    };
    let n = 0;
    for (const m of s.players) {
      if (!m.socket) continue;
      safeSend(m.socket, payload);
      n += 1;
    }
    return n;
  }

  // ---------------- PHASE 7: AVTORITATIV SINXRONIZATSIYA ----------------
  /** Sessiya ↔ lobby a'zosi bog'lanishi (null bo'lishi mumkin) */
  function sessionOf (member) {
    return member && member.socket ? sessionBySocket.get(member.socket) : null;
  }

  /**
   * in_game rejimini yoqadi: lobby a'zolarining sessiyalari endi harakatni
   * SERVER tomondan simulyatsiya qiladi va darhol boshlang'ich snapshot
   * oladi (join-in-progress: yangi a'zo JORIY avtoritar holatni ko'radi).
   * Faqat SERVER qaror qiladi — klient buni yoqolmaydi.
   * @returns {number} shu qadamda yoqilgan sessiyalar soni
   */
  function enableGameplaySync (nowTs) {
    const s = state.lobby.session;
    if (!s || s.state !== LOBBY_PHASE.IN_GAME) return 0;
    let turned = 0;
    for (const m of s.players) {
      const session = sessionOf(m);
      if (!session) continue;
      if (!session.authoritativeMovement) { setAuthoritativeMovement(session, true); turned += 1; }
    }
    sendSnapshots(nowTs);
    return turned;
  }

  // ---------------- PHASE 8: MATCH (jamoa / raund / ball) ----------------
  /**
   * Jamoa spawn nuqtasi. `index/count` — jamoadagi tartib (deterministik
   * siljish) → o'yinchilar ustma-ust tug'ilmaydi. Siljish xarita chetidan
   * chiqsa yoki kolliziyaga tushsa — asosiy spawn qaytariladi.
   */
  function teamSpawnFor (team, index, count) {
    const base = team === TEAM.B ? SPAWNS.B : SPAWNS.A;
    const off = (index - (count - 1) / 2) * 1.6;
    if (Math.abs(off) < 1e-6) return base;
    const cand = { x: base.x, y: base.y, z: base.z + off, yaw: base.yaw };
    const v = validateSpawn(cand, { boxes: SOLID_BOXES, floorY: MAP.FLOOR_Y });
    return v.valid ? cand : base;
  }

  /** Lobby a'zolariga jamoalarni tayinlash + sessiyalarga yozish (server qarori) */
  function assignTeams () {
    const s = state.lobby.session;
    if (!s) return 0;
    let n = 0;
    for (const m of s.players) {
      if (!teamOf(state.match, m.id)) n += 1;
      const team = assignTeam(state.match, m.id);
      const session = sessionOf(m);
      if (session) session.teamId = team;
    }
    return n;
  }

  /** Barcha a'zolarni o'z JAMOA spawn'iga joylashtirish (raund boshi) */
  function spawnTeams (nowTs) {
    const s = state.lobby.session;
    if (!s) return 0;
    const sizeA = state.match.teams.A.length;
    const sizeB = state.match.teams.B.length;
    let n = 0;
    for (const m of s.players) {
      const session = sessionOf(m);
      if (!session) continue;
      const team = teamOf(state.match, m.id) || TEAM.A;
      const size = team === TEAM.B ? sizeB : sizeA;
      const idx = Math.max(0, state.match.teams[team].indexOf(String(m.id)));
      session.teamId = team;
      setAuthoritativeMovement(session, true);
      placePlayerAt(session, teamSpawnFor(team, idx, size), nowTs);
      setRoundHold(session, false);           // raund boshida hamma tirik
      n += 1;
    }
    return n;
  }

  /**
   * Host sessiyani boshladi → MATCH boshlanadi (STARTING → LIVE).
   * Jamoalar, spawn'lar va sinxronizatsiya — hammasi SERVER qarori.
   */
  function startMatchFlow (nowTs) {
    const s = state.lobby.session;
    if (!s) return null;
    const ids = s.players.map((p) => p.id);
    const res = startMatch(state.match, ids, nowTs);
    assignTeams();
    spawnTeams(nowTs);
    state.matchEvents += 1;
    log.info(`[match] boshlandi — A=[${state.match.teams.A.join(',')}] B=[${state.match.teams.B.join(',')}] (start → ${state.match.state})`);
    return res;
  }

  /**
   * PHASE 8: join-in-progress. Raund davomida qo'shilgan o'yinchi DARHOL
   * ishtirok etadi: jamoasi tayinlanadi, jamoa spawn'ida to'liq HP bilan
   * tug'iladi (keyingi raundni KUTMAYDI — eng sodda deterministik xatti-harakat).
   */
  function joinMatchFlow (member, nowTs) {
    const s = state.lobby.session;
    if (!s || s.state !== LOBBY_PHASE.IN_GAME) return null;
    const team = assignTeam(state.match, member.id);
    const session = sessionOf(member);
    if (session) {
      session.teamId = team;
      setAuthoritativeMovement(session, true);
      const size = state.match.teams[team].length;
      const idx = Math.max(0, state.match.teams[team].indexOf(String(member.id)));
      placePlayerAt(session, teamSpawnFor(team, idx, size), nowTs);
      setRoundHold(session, state.match.roundState === MATCH_PHASE.LIVE);
    }
    return team;
  }

  /** A'zo matchdan chiqadi (leave/uzilish) — jamoa, nishon, rejim tozalanadi */
  function exitMatchFlow (member) {
    const session = sessionOf(member);
    const removed = matchRemovePlayer(state.match, member.id);
    if (session) {
      session.teamId = null;
      applyPeerTargets(session, state._peerScratch.length ? state._peerScratch : []);
      setRoundHold(session, false);
      setAuthoritativeMovement(session, false);
    }
    if (removed) state.matchEvents += 1;
    return removed;
  }

  /** Matchni butunlay tozalash (lobby sessiyasi yopilganda) */
  function resetMatchFlow () {
    resetMatch(state.match);
    state._peerScratch.length = 0;
    for (const session of state.sessions.values()) {
      session.teamId = null;
      setRoundHold(session, false);
      setAuthoritativeMovement(session, false);
      applyPeerTargets(session, state._peerScratch);
    }
  }

  /**
   * PHASE 8: peer nishonlarni yangilash. FAQAT raund LIVE paytida boshqa
   * o'yinchilar otish nishonasi bo'ladi (standalone/training o'zgarmaydi).
   * Do'stona o'q — bir jamoadagi nishon `friendly=true` (zarar YO'Q).
   */
  function syncPeers (nowTs) {
    const s = state.lobby.session;
    const live = !!s && s.state === LOBBY_PHASE.IN_GAME &&
      state.match.roundState === MATCH_PHASE.LIVE;
    const scratch = state._peerScratch;
    for (const session of state.sessions.values()) {
      if (!session.authoritativeMovement) { setRoundHold(session, false); continue; }
      scratch.length = 0;
      if (live) {
        const mine = session.teamId;
        for (const other of state.sessions.values()) {
          if (other === session) continue;
          if (!other.authoritativeMovement) continue;
          if (!other.teamId) continue;
          const st = other.state;
          scratch.push({
            id: other.playerId,
            x: st.position.x, y: st.position.y, z: st.position.z,
            health: st.health,
            alive: st.health.alive,
            teamId: other.teamId,
            friendly: !!mine && mine === other.teamId,
            // PHASE 1: jabrlanuvchi sessiyasiga shaffof havola — o'q tegsa
            // uning `incoming` qutisi to'ldiriladi (avtoritar feedback)
            owner: other
          });
        }
      }
      applyPeerTargets(session, scratch);
      setRoundHold(session, live);   // raund LIVE → o'lik qoladi
      // PHASE 1: raund TUGAGANDA (ROUND_END/MATCH_END) o'q uzib bo'lmaydi.
      // STARTING — raund oldi bosqichi (o'yinchilar allaqachon spawn'da), shu
      // sababli otish mumkin; match yo'q bo'lsa (`NONE`) cheklov QO'YILMAYDI
      // (standalone/training xatti-harakati o'zgarmaydi).
      session.roundActive = state.match.state === MATCH_PHASE.NONE
        ? undefined
        : (live || state.match.state === MATCH_PHASE.STARTING);
    }
  }

  /**
   * Raund natijasini baholash: tirik a'zolar soni → jamoa yo'q qilindi → ball.
   * IDEMPOTENT: endRound faqat LIVE holatdan o'tadi → dublikat ball YO'Q.
   */
  function evaluateMatchRound (nowTs) {
    const s = state.lobby.session;
    if (!s) return null;
    if (state.match.roundState !== MATCH_PHASE.LIVE) return null;
    const lives = state.match.lives;
    lives.A = 0; lives.B = 0;
    for (const m of s.players) {
      const session = sessionOf(m);
      if (!session || !session.authoritativeMovement) continue;
      if (!session.state.health.alive) continue;
      const t = teamOf(state.match, m.id);
      if (t === TEAM.A) lives.A += 1;
      else if (t === TEAM.B) lives.B += 1;
    }
    const winner = evaluateRound(state.match, lives);
    if (!winner) return null;
    const res = endRound(state.match, winner, nowTs);
    if (res.ok) {
      state.matchEvents += 1;
      log.info(`[match] raund #${state.match.roundNumber} tugadi — g'olib ${winner} ` +
        `(A:${state.match.scores.A} B:${state.match.scores.B})${res.matchEnded ? ' · MATCH_END' : ''}`);
    }
    return res;
  }

  /**
   * 20 Hz avtoritar SNAPSHOT: faqat in_game sessiyalari uchun. O'yinchilar
   * ro'yxati bir marta quriladi; har bir sessiya o'z `ackSeq` ini oladi.
   * @returns {number} snapshotga kirgan o'yinchilar soni (0 — rejim o'chiq)
   */
  function sendSnapshots (nowTs) {
    const players = state._syncPlayers;
    const matchBlock = matchSnapshot(state.match, state._matchSnap, nowTs);
    let n = 0;
    for (const session of state.sessions.values()) {
      if (!session.authoritativeMovement) continue;
      let o = players[n];
      if (!o) o = players[n] = {};
      playerSyncState(session, o);
      n += 1;
    }
    if (!n) { players.length = 0; return 0; }
    players.length = n;

    state.sync.frames += 1;
    state.sync.players = n;
    state.sync.lastTickAt = nowTs;
    state.totals.snapshots += n;
    const serverTick = state.tick;
    for (const session of state.sessions.values()) {
      if (!session.authoritativeMovement) continue;
      session.syncFrames += 1;
      safeSend(session.socket, {
        type: MSG.SNAPSHOT,
        serverTick,
        ackSeq: session.lastSeq,
        serverTime: nowTs,
        count: n,
        players,
        // PHASE 8: AVTORITAR match holati (jamoa/raund/ball) — alohida
        // kanal YO'Q, mavjud SNAPSHOT kengaytirildi.
        match: matchBlock
      });
    }
    return n;
  }

  // ---------------- PHASE 5: avtoritar tick ----------------
  function sendState (session, nowTs) {
    session.lastSnapshotAt = nowTs;
    const snap = sessionSnapshot(session, session._snapshot);
    snap.serverTime = nowTs;
    safeSend(session.socket, { type: MSG.STATE, ...snap });
  }

  /** Bitta simulyatsiya qadami (barcha sessiyalar). Testlar ham chaqiradi. */
  function tickAll (nowTs = Date.now()) {
    const t0 = process.hrtime.bigint();
    const lobbySess = state.lobby.session;
    const inGame = !!lobbySess && lobbySess.state === LOBBY_PHASE.IN_GAME;

    // PHASE 8: match vaqt o'tishlari (STARTING → LIVE, ROUND_END → keyingi raund)
    if (inGame) {
      const ev = stepMatch(state.match, nowTs);
      if (ev.roundStarted) {
        // 1-raund: o'yinchilar `startMatchFlow` da allaqachon jamoa spawn'ida
        // (STARTING paytida ko'chib ketgan bo'lsa ham QAYTA TELEPORT QILINMAYDI —
        // kutilmagan sakrash bo'lmasin). KEYINGI raundlarda hamma tiklanadi.
        if (state.match.roundNumber > 1) spawnTeams(nowTs);
        state.matchEvents += 1;
        log.info(`[match] raund #${state.match.roundNumber} boshlandi — ` +
          `A=[${state.match.teams.A.join(',')}] B=[${state.match.teams.B.join(',')}]`);
      } else if (ev.matchEnded) {
        state.matchEvents += 1;
        log.info(`[match] MATCH_END — g'olib ${state.match.matchWinner} ` +
          `(A:${state.match.scores.A} B:${state.match.scores.B})`);
      }
    } else if (state.match.state !== MATCH_PHASE.NONE) {
      resetMatchFlow();
    }

    // PHASE 8: peer nishonlar (faqat raund LIVE) — otishdan OLDIN yangilanadi
    syncPeers(nowTs);

    for (const session of state.sessions.values()) {
      try {
        const R = stepSession(session, nowTs, SIM.TICK_MS);
        // PHASE 10: o'q qabul/rad hisobi (o'lchov — mantiq o'zgarmaydi)
        if (R) metrics.recordShots(R.shotsAccepted ? 1 : 0, R.shotsRejected ? 1 : 0);
        if (session.events.length) {
          safeSend(session.socket, {
            type: MSG.EVENTS, sessionId: session.id, tick: session.tick,
            serverTime: nowTs, events: session.events
          });
          state.totals.events += session.events.length;
          metrics.recordEvents(session.events.length);
        }
        if (nowTs - session.lastSnapshotAt >= SIM.SNAPSHOT_MS) sendState(session, nowTs);
      } catch (err) {
        state.tickErrors += 1;
        log.error(`[sim] sessiya #${session.id} tick xatosi: ${err.message}`);
      }
    }
    state.tick += 1;
    state.tickAt = nowTs;
    state.totals.ticks += 1;
    // PHASE 8: raund natijasi (o'lim/uzilishdan keyin) — SERVER qarori
    if (inGame) evaluateMatchRound(nowTs);

    // PHASE 7: 20 Hz avtoritar sinxronizatsiya (in_game bo'lmasa — no-op)
    if (nowTs - state.lastSyncAt >= SIM.SNAPSHOT_MS) {
      state.lastSyncAt = nowTs;
      // PHASE 10: snapshot generatsiyasi+vuborish vaqti alohida o'lchanadi
      const s0 = process.hrtime.bigint();
      const sentPlayers = sendSnapshots(nowTs);
      metrics.recordSnapshot(Number(process.hrtime.bigint() - s0) / 1e6, sentPlayers);
    }
    state.loopMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // PHASE 10: HAQIQIY o'lchov — tick davomiyligi + xotira namunasi.
    // `recordTick` O(1) (ring bufer, allokatsiya yo'q) → tick narxi o'zgarmaydi.
    metrics.recordTick(state.loopMs);
    metrics.sampleMemory(nowTs);
    return state.tick;
  }

  wss.on('connection', (socket, req) => {
    const id = state.nextId++;
    const ip = req.socket.remoteAddress;
    state.connections.add(socket);
    metrics.lifecycle('connections');
    log.info(`[net] + connection #${id} from ${ip} (online=${state.connections.size})`);

    socket.on('message', (raw) => {
      // PHASE 10: har bir RAD ETILGAN kirish o'lchanadi (error containment
      // ko'rinadigan bo'lishi kerak — yashirin try/catch EMAS)
      if (raw.length > SERVER_DEFAULTS.MAX_MSG_BYTES) {
        metrics.recordMalformed();
        return sendErr(socket, 'too_big', 'message too large');
      }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); }
      catch { metrics.recordMalformed(); return sendErr(socket, 'bad_json', 'message is not valid JSON'); }
      if (!msg || typeof msg.type !== 'string') {
        metrics.recordMalformed();
        return sendErr(socket, 'bad_msg', 'missing .type');
      }
      switch (msg.type) {
        case MSG.HELLO: {
          const name = String(msg.name ?? '').slice(0, 24);
          safeSend(socket, {
            type: MSG.WELCOME,
            id,
            online: state.connections.size,
            serverTime: Date.now(),
            protocol: PROTOCOL_VERSION
          });
          log.info(`[net] hello #${id} name="${name}"`);

          // PHASE 5: server egasidagi sessiya yaratiladi (klient holatni EGA EMAS)
          const old = sessionBySocket.get(socket);
          if (old) { state.sessions.delete(old.id); metrics.lifecycle('sessionsClosed'); }
          // PHASE 12: takroriy HELLO — eski a'zolik LOBBY va MATCHDAN ham
          // tozalanadi. Ilgari faqat yangi a'zo obyekti yaratilib, eski obyekt
          // `lobby.session.players` ichida QOLIB KETARDI: lobby ro'yxati eski
          // playerId ni ko'rsatib, ulanishning haqiqiy kimligi boshqa bo'lib
          // qolardi (host ham eski ID da qolib, o'yinni boshlay olmasdi). Bu
          // "takroriy HELLO a'zolikni KO'PAYTIRMAYDI" shartini buzardi.
          const prevMember = memberBySocket.get(socket);
          if (prevMember) {
            metrics.lifecycle('membersRemoved');
            matchRemovePlayer(state.match, prevMember.id);
            const info = lobbyRemove(state.lobby, prevMember.id, Date.now());
            if (info) {
              broadcastLobby();
              if (info.closed) {
                metrics.lifecycle('chatEntriesDropped', state.chat.entries.length);
                resetChat(state.chat);
              }
            }
          }
          const session = createSession({
            id: state.nextSessionId++,
            name,
            now: Date.now()
          });
          metrics.lifecycle('sessions');
          session.socket = socket;
          sessionBySocket.set(socket, session);
          state.sessions.set(session.id, session);
          // PHASE 6: a'zolik — playerId SERVER beradi (klient da'vo qila olmaydi)
          const member = createLobbyMember({
            id: session.playerId,
            name,
            socket,
            joinedAt: Date.now(),
            sessionId: session.id
          });
          memberBySocket.set(socket, member);
          metrics.lifecycle('members');

          const nowTs = Date.now();
          safeSend(socket, {
            type: MSG.SESSION,
            sessionId: session.id,
            playerId: session.playerId,
            name: session.name,
            protocol: PROTOCOL_VERSION,
            tickHz: SIM.TICK_HZ,
            snapshotHz: SIM.SNAPSHOT_HZ,
            map: { name: MAP.NAME, width: MAP.WIDTH, depth: MAP.DEPTH },
            weapons: WEAPON_ORDER.slice(),
            targets: [
              ...TRAINING_DUMMIES.map((t) => ({ ...t, kind: 'dummy' })),
              ...TRAINING_RINGS.map((t) => ({ ...t, kind: 'ring' }))
            ],
            serverTime: nowTs,
            lan: lanAddresses()
          });
          sendState(session, nowTs);
          // PHASE 6: joriy lobby holati (sessiya bo'lmasa ham — state='none')
          safeSend(socket, lobbyPayload(member.id, nowTs));
          log.info(`[sim] sessiya #${session.id} (${session.playerId}) yaratildi — nishon=${session.state.targets.length}`);
          break;
        }
        // ---------------- PHASE 6: LAN LOBBY buyruqlari ----------------
        case MSG.CREATE_SESSION:
        case MSG.JOIN_SESSION:
        case MSG.LEAVE_SESSION:
        case MSG.START_SESSION: {
          state.totals.lobbyActions += 1;
          const kind = msg.type === MSG.CREATE_SESSION ? 'create'
            : msg.type === MSG.JOIN_SESSION ? 'join'
              : msg.type === MSG.LEAVE_SESSION ? 'leave' : 'start';
          const member = memberBySocket.get(socket);
          if (!member) {
            metrics.recordLobby(false);
            return sendErr(socket, 'no_session', 'sessiya yo‘q — avval hello yuboring');
          }
          const v = validateLobbyMessage(state.lobby, msg);
          if (!v.ok) {
            state.totals.lobbyRejected += 1;
            metrics.recordLobby(false);
            return sendErr(socket, v.reason,
              `lobby ${kind} rad etildi${v.field ? ' (' + v.field + ')' : ''}`);
          }
          if (v.name) member.name = v.name;
          const nowTs = Date.now();
          const res = kind === 'create' ? lobbyCreate(state.lobby, member, nowTs)
            : kind === 'join' ? lobbyJoin(state.lobby, member, nowTs)
              : kind === 'leave' ? lobbyLeave(state.lobby, member.id, nowTs)
                : lobbyStart(state.lobby, member.id, nowTs);
          if (!res.ok) {
            state.totals.lobbyRejected += 1;
            metrics.recordLobby(false);
            return sendErr(socket, res.reason, `lobby ${kind} rad etildi`);
          }
          metrics.recordLobby(true);
          log.info(`[lobby] ${kind} ${member.id} ok=${res.reason} state=${state.lobby.session ? state.lobby.session.state : LOBBY_PHASE.NONE} players=${state.lobby.session ? state.lobby.session.players.length : 0}`);
          // PHASE 7/8: host boshlagach (yoki in_game paytida qo'shilganda)
          // avtoritativ harakat + sinxronizatsiya yoqiladi (faqat server qarori)
          if (kind === 'start') {
            startMatchFlow(nowTs);
            const turned = enableGameplaySync(nowTs);
            if (turned) log.info(`[sync] avtoritativ harakat yoqildi: +${turned} sessiya`);
          } else if (kind === 'join') {
            const team = joinMatchFlow(member, nowTs);
            if (team) log.info(`[match] ${member.id} qo'shildi — jamoa ${team} (match=${state.match.state})`);
            const turned = enableGameplaySync(nowTs);
            if (turned) log.info(`[sync] avtoritativ harakat yoqildi: +${turned} sessiya`);
          } else if (kind === 'leave') {
            const gone = exitMatchFlow(member);
            if (gone) log.info(`[match] ${member.id} matchdan chiqdi — jamoa tozalandi`);
            evaluateMatchRound(nowTs);   // chiqish raund natijasini o'zgartirishi mumkin
            // PHASE 9: sessiya yopilsa chat tarixi ham tozalanadi (stale chat yo'q)
            if (!state.lobby.session) {
              metrics.lifecycle('chatEntriesDropped', state.chat.entries.length);   // PHASE 10
              resetChat(state.chat);
            }
          }
          broadcastLobby(nowTs);
          break;
        }
        case MSG.PING:
          safeSend(socket, { type: MSG.PONG, t: msg.t, serverTime: Date.now() });
          break;
        // ---------------- PHASE 9: CHAT (matn ISHONCHSIZ) ----------------
        // Klient FAQAT `text` yuboradi. Yuboruvchi kimligi, sessiya a'zoligi,
        // chegara va tarqatish — hammasi SERVERDA hal qilinadi.
        case MSG.CHAT: {
          const member = memberBySocket.get(socket);
          if (!member) {
            state.totals.chatRejected += 1;
            metrics.recordChat(false);
            return sendErr(socket, CHAT_REJECT.NO_MEMBER, 'chat rad etildi — avval hello yuboring');
          }
          const s = state.lobby.session;
          const inSession = !!s && s.players.some((p) => p.id === member.id);
          if (!inSession) {
            state.totals.chatRejected += 1;
            metrics.recordChat(false);
            return sendErr(socket, CHAT_REJECT.NOT_IN_SESSION, 'chat rad etildi — sessiyaga a\u2019zo emas');
          }
          const nowTs = Date.now();
          const res = acceptChat(state.chat, member, msg, nowTs, state.tick);
          if (!res.ok) {
            state.totals.chatRejected += 1;
            metrics.recordChat(false);
            return sendErr(socket, res.reason,
              `chat rad etildi${res.field ? ' (' + res.field + ')' : ''}`);
          }
          state.totals.chatAccepted += 1;
          metrics.recordChat(true);
          metrics.lifecycle('chatEntries');
          const sent = broadcastChat(res.entry, nowTs);
          log.info(`[chat] ${res.entry.playerId} (${res.entry.text.length} belgi) → ${sent} a'zo`);
          break;
        }
        case MSG.GPU_REPORT: {
          const renderer = String(msg.renderer ?? '?').slice(0, 90);
          const platform = String(msg.platform ?? '?').slice(0, 60);
          log.info(`[gpu] #${id} webgl2=${!!msg.webgl2} renderer="${renderer}" platform="${platform}"`);
          break;
        }
        // ---------------- PHASE 5: intent (AVTORITAR MA'LUMOT EMAS) ----------------
        case MSG.INPUT: {
          const session = sessionBySocket.get(socket);
          if (!session) return sendErr(socket, 'no_session', 'sessiya yo‘q — avval hello yuboring');
          state.totals.inputs += 1;
          const nowTs = Date.now();
          const res = applyInput(session, msg, nowTs);
          metrics.recordInput(res.ok);
          if (res.ok) {
            state.totals.accepted += 1;
            safeSend(socket, {
              type: MSG.INPUT_ACK, seq: res.seq, accepted: true, reason: '',
              tick: session.tick, serverTime: nowTs
            });
          } else {
            // validatsiya rad etdi → HOLAT O'ZGARMAYDI (klient raqami qabul qilinmadi)
            state.totals.rejected += 1;
            safeSend(socket, {
              type: MSG.INPUT_ACK, seq: Number.isFinite(msg.seq) ? msg.seq : null,
              accepted: false, reason: res.reason, field: res.field || '',
              tick: session.tick, serverTime: nowTs
            });
          }
          break;
        }
        case MSG.RESET: {
          const session = sessionBySocket.get(socket);
          if (!session) return sendErr(socket, 'no_session', 'sessiya yo‘q — avval hello yuboring');
          const nowTs = Date.now();
          resetSession(session, nowTs);
          sendState(session, nowTs);
          log.info(`[sim] sessiya #${session.id} reset (resets=${session.resets})`);
          break;
        }
        default:
          metrics.recordMalformed();
          sendErr(socket, 'unknown_type', `unknown message type "${msg.type}"`);
      }
    });

    let closeLogged = false;
    const onClose = () => {
      if (closeLogged) return;   // 'close' ba'zan ikki marta chaqiriladi — bir marta loglaymiz
      closeLogged = true;
      state.connections.delete(socket);
      metrics.lifecycle('connectionsClosed');
      const session = sessionBySocket.get(socket);
      if (session) {
        state.sessions.delete(session.id);   // sessiya serverdan o'chiriladi
        metrics.lifecycle('sessionsClosed');
      }
      // PHASE 6: lobby a'zoligidan toza chiqarish (host o'tkazish deterministik)
      const member = memberBySocket.get(socket);
      if (member) {
        // PHASE 8: match a'zoligidan ham chiqarish (uzilgan o'yinchi "tirik"
        // hisoblanib qolmasin). Dublikat 'close' → dublikat ball YO'Q
        // (endRound faqat LIVE holatdan ishlaydi).
        // PHASE 10: a'zo obyekti HAR DOIM yo'q qilinadi (lobby'ga kirmagan
        // bo'lsa ham) — aks holda `opened − closed` hisobi leak ko'rsatadi.
        metrics.lifecycle('membersRemoved');
        const hadTeam = matchRemovePlayer(state.match, member.id);
        const info = lobbyRemove(state.lobby, member.id, Date.now());
        if (info) {
          log.info(`[lobby] - ${member.id} chiqdi hostChanged=${info.hostChanged} newHost=${info.newHostId || '—'} closed=${info.closed}`);
          if (hadTeam) log.info(`[match] ${member.id} jamoadan chiqarildi`);
          broadcastLobby();
          const ls = state.lobby.session;
          if (ls && ls.state === LOBBY_PHASE.IN_GAME) evaluateMatchRound(Date.now());
          // PHASE 9: oxirgi a'zo chiqdi → sessiya yopildi → chat ham tozalanadi
          if (info.closed) {
            metrics.lifecycle('chatEntriesDropped', state.chat.entries.length);   // PHASE 10
            resetChat(state.chat);
          }
        }
      }
      log.info(`[net] - #${id} disconnected (online=${state.connections.size})`);
    };
    socket.on('close', onClose);
    socket.on('error', (err) => log.info(`[net] ! #${id} socket error: ${err.message}`));
  });

  // ---------------- sim loop boshqaruvi ----------------
  let loop = null;
  const startLoop = () => {
    if (loop) return loop;
    loop = setInterval(() => {
      try { tickAll(Date.now()); } catch (err) {
        state.tickErrors += 1;
        log.error(`[sim] tick xatosi: ${err.message}`);
      }
    }, SIM.TICK_MS);
    if (typeof loop.unref === 'function') loop.unref();   // testlar jarayonni ushlab qolmasin
    return loop;
  };
  const stopLoop = () => { if (loop) { clearInterval(loop); loop = null; } };

  const listen = () => new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      startLoop();
      resolve();
    });
  });

  /**
   * SERVERNI TO'XTATISH (PHASE 10 hardening).
   *
   * Ilgari: `wss.close(() => httpServer.close(() => resolve()))` — ya'ni HTTP
   * server FAQAT ws callback'i chaqirilgandan keyin yopilardi. `ws` kutubxonasi
   * ba'zi holatlarda (klient allaqachon terminate qilingan bo'lsa) callback'ni
   * CHAQIRMASLIGI mumkin edi → port ochiq qolib, promise HECH QACHON
   * hal bo'lmasdi (test buni ushladi: jarayon tugamadi, TCPServerWrap tirik).
   *
   * Endi: majburiy ulanish yopish + `closeAllConnections()` (keep-alive
   * soketlar) + CHEGARALANGAN kafolat (hech qanday holatda osilib qolmaydi).
   */
  const close = () => new Promise((resolve) => {
    stopLoop();
    state.sessions.clear();
    for (const s of state.connections) { try { s.terminate(); } catch {} }
    state.connections.clear();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { wss.close(); } catch {}                       // callback'ga BOG'LANMAYMIZ
    if (typeof httpServer.closeAllConnections === 'function') {
      try { httpServer.closeAllConnections(); } catch {}   // keep-alive soketlar
    }
    try { httpServer.close(() => finish()); } catch { finish(); }
    const guard = setTimeout(finish, 1500);              // kafolat: osilib qolmaydi
    if (typeof guard.unref === 'function') guard.unref();
  });

  /** Telemetriya (testlar/verifikatsiya — SERVER xotirasidagi haqiqat) */
  const telemetry = () => ({
    protocol: PROTOCOL_VERSION,
    tick: state.tick,
    tickHz: SIM.TICK_HZ,
    snapshotHz: SIM.SNAPSHOT_HZ,
    tickMs: SIM.TICK_MS,
    loopMs: +state.loopMs.toFixed(4),
    sessions: state.sessions.size,
    online: state.connections.size,
    totals: { ...state.totals },
    tickErrors: state.tickErrors,
    lobby: {
      sessionId: state.lobby.session ? state.lobby.session.id : null,
      state: state.lobby.session ? state.lobby.session.state : LOBBY_PHASE.NONE,
      hostId: state.lobby.session ? state.lobby.session.hostId : null,
      count: state.lobby.session ? state.lobby.session.players.length : 0,
      capacity: state.lobby.capacity,
      revision: state.lobby.revision
    },
    addresses: lanAddresses(),
    // ---- PHASE 9: chat (server xotirasidagi chegara/hisob) ----
    chat: {
      accepted: state.chat.accepted,
      rejected: state.chat.rejected,
      rejections: { ...state.chat.rejections },
      maxLen: CHAT.MAX_LEN,
      burst: state.chat.burst,
      windowMs: state.chat.windowMs,
      entries: state.chat.entries.length,
      lastSeq: state.chat.sequence,
      last: state.chat.entries.length ? { ...state.chat.entries[state.chat.entries.length - 1] } : null
    },
    // ---- PHASE 8: match (jamoa/raund/ball) — server xotirasidagi haqiqat ----
    match: {
      state: state.match.state,
      roundState: state.match.roundState,
      roundNumber: state.match.roundNumber,
      roundWinner: state.match.roundWinner,
      matchWinner: state.match.matchWinner,
      scores: { A: state.match.scores.A, B: state.match.scores.B },
      teams: { A: state.match.teams.A.slice(), B: state.match.teams.B.slice() },
      lives: { A: state.match.lives.A, B: state.match.lives.B },
      teamsAtRoundStart: { ...state.match.teamsAtRoundStart },
      roundEndsAt: state.match.roundEndsAt,
      roundsToWin: MATCH_RULES.ROUNDS_TO_WIN,
      events: state.matchEvents,
      revision: state.match.revision
    },
    // ---- PHASE 7 ----
    sync: {
      mode: state.lobby.session && state.lobby.session.state === LOBBY_PHASE.IN_GAME
        ? 'authoritative' : 'standalone',
      authoritativeSessions: [...state.sessions.values()]
        .filter((s) => s.authoritativeMovement).length,
      frames: state.sync.frames,
      players: state.sync.players,
      snapshotHz: SIM.SNAPSHOT_HZ,
      lastTickAt: state.sync.lastTickAt
    },
    // ---- PHASE 10: HAQIQIY o'lchov (mock EMAS) ----
    // `perf` — ish bajarilganda yozilgan vaqt/metrika; `resources` — HAQIQIY
    // konteynerlar o'lchami + aktiv Node resurslari (runaway timer/soket dalili).
    perf: metrics.snapshot(),
    resources: {
      connections: state.connections.size,
      sessions: state.sessions.size,
      lobbyMembers: state.lobby.session ? state.lobby.session.players.length : 0,
      lobbyState: state.lobby.session ? state.lobby.session.state : LOBBY_PHASE.NONE,
      chatEntries: state.chat.entries.length,
      activeResources: activeResources(),
      opened: {
        connections: state.metrics.raw().life.connections,
        sessions: state.metrics.raw().life.sessions,
        members: state.metrics.raw().life.members
      },
      closed: {
        connections: state.metrics.raw().life.connectionsClosed,
        sessions: state.metrics.raw().life.sessionsClosed,
        members: state.metrics.raw().life.membersRemoved
      }
    }
  });

  return {
    httpServer, wss, state, listen, close, telemetry, tickAll,
    startLoop, stopLoop,
    // PHASE 10: o'lchov yadrosi (verifikatsiya oynani tozalab qayta o'lchashi mumkin)
    metrics
  };
}
