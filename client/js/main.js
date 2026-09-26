// ============================================================
// NEON STRIKE — klient kirish nuqtasi
// 1) Phase 1 gate'lari (WebGL2 / vendored three / WS / latency) — regressiya
//    uchun saqlanadi va WS sessiya davomida TIRIK turadi (har 2 s ping).
// 2) Phase 3: TRAINING (offline) 3D sessiyasi NEON FACILITY mapida
//    (shared/map.js geometriyasi → client/js/mapview.js).
// ============================================================
import { MSG } from '/shared/protocol-consts.js';

const $ = (id) => document.getElementById(id);
const isHeadless = /HeadlessChrome/i.test(navigator.userAgent);
// PHASE 6: ko'rsatiladigan ism (identity EMAS — player ID ni server beradi)
const PLAYER_NAME = (isHeadless ? 'headless-' : 'player-') + Math.floor(Math.random() * 46656).toString(36);

// Klient xatolarini yig'ish (verifikatsiya: "console errors yo'q")
const neonErrors = [];
window.__neonErrors = neonErrors;
window.addEventListener('error', (e) => neonErrors.push({
  type: 'error', message: String(e.message), source: e.filename || '', line: e.lineno || 0
}));
window.addEventListener('unhandledrejection', (e) => neonErrors.push({
  type: 'unhandledrejection', message: String(e.reason && e.reason.message ? e.reason.message : e.reason)
}));

function setBadge (id, cls, text) {
  const el = $(id);
  el.className = 'badge ' + cls;
  el.textContent = text;
}

async function checkWebGL () {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      setBadge('badgeWebgl', 'bad', "WEBGL2 YO'Q");
      return { webgl2: false, renderer: 'none' };
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    setBadge('badgeWebgl', 'ok', 'OK');
    return { webgl2: true, renderer };
  } catch (e) {
    setBadge('badgeWebgl', 'bad', 'XATO');
    return { webgl2: false, renderer: 'err:' + e.message };
  }
}

async function checkThree () {
  try {
    const THREE = await import('/vendor/three.module.js');
    const ok = THREE.REVISION === '160';
    setBadge('badgeThree', ok ? 'ok' : 'bad', ok ? 'OK · r160' : `r${THREE.REVISION} (kutilgan: 160)`);
    return ok;
  } catch (e) {
    console.warn('[phase1] three import xato:', e);
    setBadge('badgeThree', 'bad', 'IMPORT XATO');
    return false;
  }
}

/** Doimiy WS ulanish (Phase 1 regressiyasi: sessiya davomida tirik qoladi) */
function startNet (gpu) {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  $('wsUrl').textContent = wsUrl;
  const state = {
    wsUrl, connected: false, latency: null, samples: 0, welcome: null, socket: null,
    // ---- PHASE 5: avtoritativ server telemetriyasi (FAQAT server xabarlaridan) ----
    session: null,            // SESSION xabari (server sessiyasi)
    authoritative: null,      // oxirgi STATE (server hal qilgan qiymatlar)
    stateMessages: 0,
    eventBatches: 0,
    eventTotal: 0,
    lastEvents: [],
    sent: 0,
    resetSeq: 0,
    acks: { accepted: 0, rejected: 0, lastReason: '', rejections: {} },
    // ---- PHASE 6: LAN lobby (FAQAT server xabarlaridan) ----
    lobby: null,              // oxirgi LOBBY_STATE (avtoritar)
    lobbyMessages: 0,
    lobbySent: 0,
    lastError: null,
    // ---- PHASE 7: sinxronizatsiya (FAQAT server SNAPSHOT xabarlaridan) ----
    snapshot: null,           // oxirgi avtoritar SNAPSHOT (server hal qilgan)
    snapshotMessages: 0,
    snapshotServerTick: 0,
    snapshotAckSeq: -1,
    // ---- PHASE 9: chat (FAQAT server CHAT_MSG xabarlaridan) ----
    chatMessages: [],         // server tasdiqlagan xabarlar (kimlik SERVERDAN)
    chatCount: 0,
    chatSent: 0,
    chatErrors: 0,
    chatLastError: null
  };
  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch { setBadge('badgeWs', 'bad', 'XATO'); return state; }
  state.socket = ws;

  ws.onerror = () => setBadge('badgeWs', 'bad', 'ULANMADI');
  // PHASE 9: HAQIQIY uzilish — HUD ko'rsatkichi darhol yangilanadi (yashirmaydi)
  ws.onclose = () => {
    state.connected = false;
    state.closedAt = Date.now();
    setBadge('badgeWs', 'bad', 'UZILDI');
    if (game) game.onNetClosed();
  };
  ws.onopen = () => ws.send(JSON.stringify({
    type: MSG.HELLO,
    name: isHeadless ? 'headless-check' : 'real-window'
  }));
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === MSG.WELCOME) {
      state.connected = true;
      state.welcome = msg;
      setBadge('badgeWs', 'ok', `ULANDI · id=${msg.id} · protokol v${msg.protocol}`);
      setBadge('badgeTime', 'ok', new Date(msg.serverTime).toLocaleTimeString());
      ws.send(JSON.stringify({ type: MSG.GPU_REPORT, ...gpu, platform: navigator.platform }));
    } else if (msg.type === MSG.PONG) {
      const ms = Math.round(performance.now() - msg.t);
      state.latency = ms;
      state.samples++;
      setBadge('badgePing', ms < 50 ? 'ok' : 'wait', ms + ' ms');
    } else if (msg.type === MSG.ERROR) {
      console.warn('[net] server error:', msg);
      state.lastError = { code: msg.code, message: msg.message || '' };
      showLobbyError(msg.code, msg.message || '');
      // PHASE 9: chat xatosi — chat panelida ko'rsatiladi (jimgina yutilmaydi)
      if (typeof msg.code === 'string' && msg.code.indexOf('chat') === 0) {
        state.chatErrors += 1;
        state.chatLastError = { code: msg.code, message: msg.message || '' };
        showChatError(msg.code + (msg.message ? ' — ' + msg.message : ''));
      }
    } else if (msg.type === MSG.CHAT_MSG) {
      // PHASE 9: AVTORITAR chat xabari. `playerId`/`name` SERVER bergan —
      // klient ularni o'zgartirmaydi (faqat ko'rsatadi).
      state.chatMessages.push({
        playerId: msg.playerId, name: msg.name, text: msg.text,
        seq: msg.seq, serverTick: msg.serverTick, serverTime: msg.serverTime,
        at: Date.now()
      });
      if (state.chatMessages.length > 50) state.chatMessages.splice(0, state.chatMessages.length - 50);
      state.chatCount += 1;
      renderChat();
    } else if (msg.type === MSG.LOBBY_STATE) {
      // PHASE 6: AVTORITAR lobby holati — sessiya/host/a'zolik serverdan
      state.lobby = msg;
      state.lobbyMessages += 1;
      renderLobby(msg);
      // PHASE 7: in_game bo'lsa sinxronizatsiya yoqiladi (qaror SERVERDA)
      if (game) game.onLobbyState(msg);
    } else if (msg.type === MSG.SNAPSHOT) {
      // PHASE 7: AVTORITAR sinxronizatsiya snapshot'i (20 Hz). Masofaviy
      // o'yinchilar va lokal tuzatish FAQAT shu ma'lumotdan olinadi.
      state.snapshotMessages += 1;
      state.snapshot = msg;
      state.snapshotServerTick = msg.serverTick;
      state.snapshotAckSeq = msg.ackSeq;
      // PHASE 8: match holati SNAPSHOT bilan ham keladi — lobby panelidagi
      // satr ham joriy AVTORITAR qiymatga yangilanadi (eskirib qolmaydi).
      if (msg.match) {
        const you = state.lobby ? state.lobby.you : null;
        if (typeof renderLobbyMatch === 'function') renderLobbyMatch(msg.match, you);
      }
      if (game) game.onSnapshot(msg);
    } else if (msg.type === MSG.SESSION) {
      // server sessiyasi yaratildi — endi holat EGA server
      state.session = {
        sessionId: msg.sessionId, playerId: msg.playerId, protocol: msg.protocol,
        tickHz: msg.tickHz, snapshotHz: msg.snapshotHz, map: msg.map,
        weapons: msg.weapons, targetCount: Array.isArray(msg.targets) ? msg.targets.length : 0
      };
    } else if (msg.type === MSG.STATE) {
      // AVTORITAR holat: bu qiymatlarni SERVER hisoblagan (klient emas)
      state.stateMessages += 1;
      state.authoritative = msg;
    } else if (msg.type === MSG.EVENTS) {
      // AVTORITAR combat hodisalari (shot/hit/kill/blocked/grenade/...)
      state.eventBatches += 1;
      state.eventTotal += msg.events.length;
      state.lastEvents = msg.events.length > 400 ? msg.events.slice(-400) : msg.events;
      // PHASE 1: PvP feedback (hit marker / zarar raqami / zarar yo'nalishi /
      // o'lim) FAQAT shu AVTORITAR hodisalardan hosil bo'ladi — klient
      // bashorati soxta kill/zarar yaratmaydi.
      if (game) game.onCombatEvents(msg.events);
    } else if (msg.type === MSG.INPUT_ACK) {
      if (msg.accepted) state.acks.accepted += 1;
      else {
        state.acks.rejected += 1;
        state.acks.lastReason = msg.reason;
        state.acks.rejections[msg.reason] = (state.acks.rejections[msg.reason] || 0) + 1;
      }
    }
  };

  // PHASE 5: intent yuborish. Klient FAQAT niyat yuboradi — server qaror qiladi.
  state.sendInput = (cmd) => {
    if (ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: MSG.INPUT, ...cmd }));
    state.sent += 1;
    return true;
  };
  state.requestReset = () => {
    if (ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type: MSG.RESET, seq: ++state.resetSeq }));
    return true;
  };

  // PHASE 6: LAN lobby buyruqlari — klient FAQAT niyat yuboradi
  // (playerId/hostId/state/count NI YUBORMAYDI — ularni server hal qiladi)
  const lobbySend = (type) => {
    if (ws.readyState !== 1) return false;
    ws.send(JSON.stringify({ type, name: PLAYER_NAME }));
    state.lobbySent += 1;
    return true;
  };
  state.createLobby = () => lobbySend(MSG.CREATE_SESSION);
  state.joinLobby = () => lobbySend(MSG.JOIN_SESSION);
  state.leaveLobby = () => lobbySend(MSG.LEAVE_SESSION);
  state.startLobby = () => lobbySend(MSG.START_SESSION);

  // PHASE 9: chat — klient FAQAT matn yuboradi (kimlik/vaqt SERVERDA aniqlanadi)
  state.sendChat = (text) => {
    if (ws.readyState !== 1 || typeof text !== 'string') return false;
    ws.send(JSON.stringify({ type: MSG.CHAT, text }));
    state.chatSent += 1;
    return true;
  };

  const ping = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: MSG.PING, t: performance.now() })); };
  setTimeout(ping, 150);
  setTimeout(ping, 400);
  setInterval(ping, 2000);   // tirik ulanish + doimiy latency o'lchovi
  return state;
}

// ============================================================
// PHASE 2 — TRAINING sessiyasi (offline 3D)
// ============================================================
let GameClass = null;
let game = null;
let gates = null;
let netState = null;

function hudRefs () {
  return {
    // Phase 2/3 qatlami (frozen format)
    timer: $('hudTimer'), position: $('hudPos'), speed: $('hudSpeed'),
    targets: $('hudTargets'), fps: $('hudFps'), pointer: $('hudPointer'),
    // PHASE 4 combat qatlami
    root: $('combatHud'),
    crosshair: $('chCrosshair'), hitmarker: $('chHitmarker'), damage: $('chDamage'),
    // PHASE 1: avtoritar hit feedback elementlari (server EVENTS)
    dmgNum: $('chDmgNum'), dmgDir: $('chDmgDir'),
    healthBar: $('chHealthBar'), healthFill: $('chHealthFill'), hp: $('chHp'),
    kills: $('chKills'), deaths: $('chDeaths'),
    ammoBlock: $('chAmmoBlock'), weaponName: $('chWeaponName'), weaponSlot: $('chWeaponSlot'),
    mag: $('chMag'), reserve: $('chReserve'),
    reload: $('chReload'), reloadFill: $('chReloadFill'), reloadText: $('chReloadText'),
    slots: $('chSlots'), feed: $('chFeed'), dead: $('chDead'), respawnIn: $('chRespawnIn'),
    // PHASE 8: minimal match HUD (faqat server snapshot'idan)
    matchLine: $('matchHud'), matchTeam: $('mhTeam'), matchRound: $('mhRound'), matchScore: $('mhScore'),
    // PHASE 9: ulanish/jamoa/ID chip'lari + raund banneri + o'lim ekrani satri
    conn: $('hudConn'), team: $('hudTeam'), me: $('hudMe'),
    banner: $('roundBanner'), bannerTitle: $('rbTitle'), bannerSub: $('rbSub'),
    deadTitle: $('chDeadTitle'), deadRespawn: $('chDeadRespawn'), deadWait: $('chDeadWait')
  };
}

function updatePauseOverlay () {
  const inGame = !!game && game.running && $('stage').hidden === false;
  $('pause').hidden = !(inGame && !game.input.pointerLocked);
}

function startSession () {
  if (!GameClass) return false;
  $('menu').hidden = true;
  $('stage').hidden = false;
  document.body.classList.add('in-game');
  if (!game) {
    game = new GameClass({ canvas: $('gl'), debugEl: $('debugOverlay'), hud: hudRefs() });
    game.init();
    game.input.onLockChange = () => updatePauseOverlay();
  } else {
    game.resetSession();
  }
  // PHASE 5: intent adapteri — combat intents avtoritativ serverga yuboriladi
  game.net = netState;
  game.start();          // jest ichida: Pointer Lock so'rovi shu yerda bo'ladi
  updatePauseOverlay();
  return true;
}

function stopSession () {
  if (!game) return;
  game.stop();
  $('pause').hidden = true;
  $('stage').hidden = true;
  $('menu').hidden = false;
  document.body.classList.remove('in-game');
}

// ============================================================
// PHASE 6 — LAN LOBBY UI (faqat RENDER: barcha qarorlar serverda)
// ============================================================
function clearLobbyError () {
  const el = $('lobbyError');
  if (el) { el.hidden = true; el.textContent = ''; }
}

function showLobbyError (code, message) {
  const el = $('lobbyError');
  if (!el) return;
  el.hidden = false;
  el.textContent = `SERVER RAD ETDI: ${code}${message ? ' — ' + message : ''}`;
}

/**
 * PHASE 8: lobby panelidagi match satri. LOBBY_STATE ham, SNAPSHOT ham bir
 * xil AVTORITAR `match` blokini beradi — shu sababli ikki ko'rinish (lobby va
 * o'yin HUD) hech qachon bir-biriga zid bo'lmaydi.
 */
function renderLobbyMatch (m, you) {
  const lm = $('lobbyMatch');
  if (!lm) return;
  if (!m || m.matchState === 'none') {
    lm.className = 'badge wait';
    lm.textContent = '—';
    return;
  }
  const myTeam = you
    ? (m.teams && m.teams.A && m.teams.A.indexOf(you) >= 0 ? 'A'
      : (m.teams && m.teams.B && m.teams.B.indexOf(you) >= 0 ? 'B' : '—'))
    : '—';
  lm.className = 'badge ok';
  lm.textContent = `JAMOA ${myTeam} · R${m.roundNumber} ${String(m.roundState || '').toUpperCase()} · ` +
    `A ${m.scores ? m.scores.A : 0}:${m.scores ? m.scores.B : 0} B`;
}

function renderLobby (st) {
  if (!st) return;
  const badge = (id, cls, text) => {
    const el = $(id);
    if (el) { el.className = 'badge ' + cls; el.textContent = text; }
  };
  const connected = !!(netState && netState.connected);
  badge('lobbyNet', connected ? 'ok' : 'wait', connected ? 'ULANDI · /ws' : 'ulanmoqda…');
  badge('lobbyState', st.state === 'none' ? 'wait' : 'ok',
    st.state === 'in_game' ? `O‘YNASHDA · #${st.sessionId}`
      : st.state === 'lobby' ? `LOBBY · #${st.sessionId}` : 'sessiya yo‘q');
  badge('lobbyYou', st.you ? 'ok' : 'wait', st.you ? `${st.you}${st.isHost ? ' · HOST' : ''}` : '—');
  badge('lobbyCount', 'ok', `${st.count} / ${st.capacity}`);

  // PHASE 8: AVTORITAR match holati (jamoa/raund/ball) — server yuboradi
  renderLobbyMatch(st.match, st.you);

  const addr = $('lobbyAddress');
  if (addr) addr.textContent = (st.addresses && st.addresses[0]) || '—';

  const list = $('lobbyPlayers');
  if (list) {
    list.textContent = '';
    if (!st.players || !st.players.length) {
      const li = document.createElement('li');
      li.className = 'lp-empty';
      li.textContent = 'hoziroq o‘yinchi yo‘q — HOST LAN SESSION bilan sessiya oching';
      list.appendChild(li);
    } else {
      for (const p of st.players) {
        const li = document.createElement('li');
        if (p.host) li.classList.add('host');
        const nm = document.createElement('span');
        nm.textContent = p.name || p.id;
        const id = document.createElement('span');
        id.className = 'lp-id';
        id.textContent = p.id;
        li.append(nm, id);
        if (p.id === st.you) {
          const you = document.createElement('span');
          you.className = 'lp-you';
          you.textContent = 'SIZ';
          li.appendChild(you);
        }
        if (p.host) {
          const h = document.createElement('span');
          h.className = 'lp-host';
          h.textContent = 'HOST';
          li.appendChild(h);
        }
        list.appendChild(li);
      }
    }
  }

  // tugmalar FAQAT server holatiga qarab yoqiladi
  const dis = (id, v) => { const b = $(id); if (b) b.disabled = !!v; };
  dis('btnHost', !connected || st.state !== 'none');
  // PHASE 7: JOIN-IN-PROGRESS — in_game paytida ham qo'shilish OCHIQ. Server
  // buni qabul qiladi, yangi a'zoga JORIY avtoritar holatni (SNAPSHOT) yuboradi
  // va uni avtoritativ harakatga qo'shadi. Faqat allaqachon a'zo bo'lsa yopiladi.
  dis('btnJoin', !connected || st.state === 'none' || st.inSession);
  dis('btnLobbyStart', !(connected && st.isHost && st.state === 'lobby'));
  dis('btnLobbyLeave', !(connected && st.inSession));

  // START FLOW: host boshlagach o'yin sessiyasi lobby oqimi orqali ochiladi
  if (st.state === 'in_game' && !(game && game.running)) startSession();
}

// ============================================================
// PHASE 9 — CHAT UI (faqat RENDER + YUBORISH niyati)
// Xabar yo'li: klient → SERVER (validatsiya/kimlik/chegara) → sessiya
// a'zolariga broadcast → shu panel. Klient boshqa klientga to'g'ridan-to'g'ri
// yozmaydi va yuboruvchi kimligini O'ZI ANIQLAMAYDI.
// ============================================================
let chatOpen = false;

function showChatError (text) {
  const el = $('chatError');
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
}

function clearChatError () {
  const el = $('chatError');
  if (el) { el.hidden = true; el.textContent = ''; }
}

/** Server CHAT_MSG xabarlarini panelga chizish (server tartibida) */
function renderChat () {
  const list = $('chatLog');
  if (!list) return 0;
  const msgs = (netState && netState.chatMessages) ? netState.chatMessages : [];
  list.textContent = '';
  if (!msgs.length) {
    const li = document.createElement('li');
    li.className = 'chat-empty';
    li.textContent = 'xabar yo‘q — T / ENTER bilan yozing';
    list.appendChild(li);
    return 0;
  }
  const tail = msgs.slice(-12);
  for (const m of tail) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = '[' + (m.playerId || '?') + ']';
    const span = document.createElement('span');
    span.textContent = m.text;
    li.append(b, span);
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
  return tail.length;
}

function openChat () {
  const p = $('chatPanel');
  const i = $('chatInput');
  if (!p || !i) return false;
  chatOpen = true;
  p.classList.add('open');
  const hint = $('chatHint');
  if (hint) hint.textContent = 'ENTER — yuborish · ESC — yopish';
  i.focus();
  return true;
}

function closeChat () {
  const p = $('chatPanel');
  const i = $('chatInput');
  chatOpen = false;
  if (p) p.classList.remove('open');
  if (i) { i.value = ''; i.blur(); }
  const hint = $('chatHint');
  if (hint) hint.textContent = 'T / ENTER — yozish';
  return true;
}

/**
 * Xabar yuborish (HAQIQIY yo'l: WebSocket → server). Bo'sh matn yuborilmaydi.
 * @returns {boolean} yuborildi/yuborilmadi
 */
function sendChatText (text) {
  const raw = (text === undefined || text === null)
    ? ($('chatInput') ? $('chatInput').value : '')
    : String(text);
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (!netState || typeof netState.sendChat !== 'function' || !netState.sendChat(trimmed)) return false;
  const i = $('chatInput');
  if (i) i.value = '';
  clearChatError();
  return true;
}

window.addEventListener('DOMContentLoaded', async () => {
  // 1) Phase 1 gate'lari (regressiya)
  const gpu = await checkWebGL();
  await checkThree();
  netState = startNet(gpu);
  gates = { gpu, net: netState };

  // 2) Phase 2 modulini oldindan yuklash — TRAINING klikida await bo'lmasligi uchun
  //    (Pointer Lock foydalanuvchi jesti ichida so'ralishi kerak)
  import('/js/game/index.js')
    .then((mod) => {
      GameClass = mod.Game;
      $('btnTraining').dataset.ready = '1';
      setBadge('badgeGame', 'ok', 'TAYYOR · 3D sahna');
      setBadge('badgeThree', 'ok', 'OK · r160');
    })
    .catch((err) => {
      console.error('[phase3] game moduli yuklanmadi:', err);
      setBadge('badgeGame', 'bad', 'MODUL XATO');
    });

  // 3) Tugmalar
  $('btnTraining').addEventListener('click', () => startSession());
  $('btnResume').addEventListener('click', () => { if (game) game.requestLock(); });
  $('btnBackMenu').addEventListener('click', () => stopSession());
  document.addEventListener('pointerlockchange', () => updatePauseOverlay());

  // PHASE 6: LAN lobby tugmalari (har biri serverga niyat yuboradi)
  const lobbyClick = (fn) => () => { clearLobbyError(); if (netState) fn(netState); };
  $('btnHost').addEventListener('click', lobbyClick((n) => n.createLobby()));
  $('btnJoin').addEventListener('click', lobbyClick((n) => n.joinLobby()));
  $('btnLobbyStart').addEventListener('click', lobbyClick((n) => n.startLobby()));
  $('btnLobbyLeave').addEventListener('click', lobbyClick((n) => n.leaveLobby()));

  // PHASE 9: chat UI (yuborish FAQAT serverga — tarqatish serverni ishi)
  renderChat();
  const chatInput = $('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!sendChatText()) return; }
      else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
    });
  }
  if ($('chatSend')) $('chatSend').addEventListener('click', () => sendChatText());
  // T / ENTER — chatni ochadi (o'yin ichida). Yozilayotganda o'yin tugmalari
  // ishlamaydi — input.js `activeElement` ni tekshiradi.
  window.addEventListener('keydown', (e) => {
    if (!game || !game.running || $('stage').hidden) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 't' || e.key === 'T' || e.key === 'Enter') { e.preventDefault(); openChat(); }
  });

  // 4) Avtomatik verifikatsiya uchun o'qish/yozish API'si (o'yin mantig'ini
  //    chetlab o'tmaydi — faqat diagnostika va teleport)
  window.__neon = {
    version: 4,
    phase: 'phase4-combat',
    errors: window.__neonErrors || [],
    get loaded () { return !!GameClass; },
    get running () { return !!(game && game.running); },
    get gates () { return gates ? { webgl2: gates.gpu.webgl2, renderer: gates.gpu.renderer, ws: netState.connected, latency: netState.latency, samples: netState.samples, protocol: netState.welcome && netState.welcome.protocol } : null; },
    diagnostics: () => (game ? game.diagnostics() : null),
    probeScene: () => (game ? game.probeScene() : null),
    probePixel: (x, y) => (game ? game.probePixel(x, y) : null),
    ndcToPixel: (x, y) => (game ? game.ndcToPixel(x, y) : null),
    probeWorld: (x, y, z) => (game ? game.probeWorld(x, y, z) : null),
    probePlayer: () => (game ? game.probePlayer() : null),
    startTraining: () => startSession(),
    stopTraining: () => { stopSession(); return true; },
    requestLock: () => (game ? game.requestLock() : false),
    setView: (x, z, yaw, pitch, y) => (game ? game.teleport(x, z, yaw, pitch, y) : null),
    setDebug: (v) => (game ? game.toggleDebugVisible(v) : false),
    setMapVisible: (v) => (game ? game.setMapVisible(v) : false),
    lookBy: (dx, dy) => (game ? game.lookBy(dx, dy) : null),
    captureFrame: () => (game ? game.captureFrame() : null),
    setPlayerVisible: (v) => (game ? game.setPlayerVisible(v) : false),
    setTrainingVisible: (v) => (game ? game.setTrainingVisible(v) : false),
    probePlayer: () => (game ? game.probePlayer() : null),
    reset: () => { if (game) game.resetSession(); return true; },

    // ---------- PHASE 4 COMBAT (QA API) ----------
    // Diqqat: quyidagilar HAQIQIY ishlab chiqarish yo'lidan o'tadi
    // (input.consumeIntents → shared/combat.js stepCombat). Mock YO'Q.
    get combat () { return game && game.combat ? game.combat : null; },
    combatQa: () => (game && game.combat ? game.combat.qa() : null),
    combatSnapshot: () => (game && game.combat ? game.combat.snapshot() : null),
    weaponProbe: () => (game && game.combat ? game.combat.weaponProbe() : null),
    hudState: () => (game && game.combat ? game.combat.hud.state(game.combat.snapshot()) : null),
    probeTarget: (id) => (game && game.combat ? game.combat.registry.probe(id) : null),
    aimAt: (id) => (game && game.combat ? game.combat.aimAtTarget(id) : null),
    aimAtPoint: (x, y, z) => (game && game.combat ? game.combat.aimAtPoint(x, y, z) : null),
    /** Trigger holatini input manager orqali o'rnatish (real yo'l) */
    setFire: (down) => {
      if (!game) return null;
      if (down) { game.input.buttons.add('fire'); game.input.firePressedCount += 1; }
      else game.input.buttons.delete('fire');
      return { fire: game.input.firing };
    },
    /** Semi-auto uchun yagona "yangi bosish" (trigger edge) */
    tapFire: () => {
      if (!game) return null;
      game.input.buttons.add('fire');
      game.input.firePressedCount += 1;
      return true;
    },
    releaseFire: () => { if (game) game.input.buttons.delete('fire'); return true; },
    requestReload: () => { if (game) { game.input.reloadPressed = true; return true; } return false; },
    switchWeapon: (slot) => { if (game) { game.input.switchQueue = slot; return slot; } return 0; },
    /** Lokal o'yinchiga zarar (shared damagePlayer — o'z granatasi yo'li) */
    damagePlayer: (amount, source = 'test') => (game && game.combat ? game.combat.damage(amount, source) : null),
    addTestTarget: (x, z, id) => (game && game.combat ? !!game.combat.addTestTarget(x, z, id) : false),

    // ---------- PHASE 5: AVTORITATIV SERVER (QA API) ----------
    // Diqqat: quyidagi qiymatlar FAQAT server xabarlaridan (STATE/EVENTS/ACK)
    // to'ldiriladi — klient ularni hisoblamaydi. Shu sababli ular server
    // qarorining dalili bo'ladi ("fake authority" EMAS).
    serverAuthority: { version: 5, phase: 'phase5-authoritative-server' },
    serverSession: () => (netState && netState.session ? { ...netState.session } : null),
    serverState: () => (netState && netState.authoritative ? netState.authoritative : null),
    serverTargets: () => (netState && netState.authoritative ? netState.authoritative.targets : null),
    serverAcks: () => (netState ? {
      sent: netState.sent, states: netState.stateMessages, eventBatches: netState.eventBatches,
      events: netState.eventTotal, accepted: netState.acks.accepted,
      rejected: netState.acks.rejected, lastReason: netState.acks.lastReason,
      rejections: { ...netState.acks.rejections }
    } : null),
    serverEvents: () => (netState ? netState.lastEvents : null),
    requestServerReset: () => (netState ? netState.requestReset() : false),

    // ---------- PHASE 6: LAN LOBBY (QA API) ----------
    // Qiymatlar FAQAT server LOBBY_STATE xabarlaridan — klient hisoblamaydi.
    lobby: { version: 6, phase: 'phase6-lan-lobby' },
    lobbyState: () => (netState && netState.lobby ? netState.lobby : null),
    lobbyPlayerId: () => (netState && netState.lobby ? netState.lobby.you : null),

    // ---------- PHASE 7: KO'P O'YINCHILI SINXRONIZATSIYA (QA API) ----------
    // Qiymatlar FAQAT server SNAPSHOT xabarlari va haqiqiy klient
    // rekonsiliatsiya/interpolatsiya holatidan — mock EMAS.
    multiplayer: { version: 7, phase: 'phase7-multiplayer-sync' },
    multiplayerQa: () => (game ? game.multiplayerQa() : null),
    serverSnapshots: () => (netState ? {
      messages: netState.snapshotMessages,
      players: netState.snapshot && Array.isArray(netState.snapshot.players)
        ? netState.snapshot.players.length : 0,
      ids: netState.snapshot && Array.isArray(netState.snapshot.players)
        ? netState.snapshot.players.map((p) => p.id) : [],
      serverTick: netState.snapshotServerTick,
      ackSeq: netState.snapshotAckSeq,
      last: netState.snapshot
        ? { serverTick: netState.snapshot.serverTick, ackSeq: netState.snapshot.ackSeq, count: netState.snapshot.count }
        : null,
      // snapshot ichidagi o'yinchi maydonlari (Phase 8+ maydonlari yo'qligini
      // tekshirish uchun — faqat o'qish, hech narsa o'zgartirmaydi)
      shape: netState.snapshot && Array.isArray(netState.snapshot.players) && netState.snapshot.players[0]
        ? Object.keys(netState.snapshot.players[0]).sort()
        : []
    } : null),
    // ---------- PHASE 8: JAMOA / RAUND / BALL (avtoritar) ----------
    // Qiymatlar FAQAT server SNAPSHOT/LOBBY_STATE xabarlaridan — klient
    // hech narsani hisoblamaydi (fake authority YO'Q).
    phase8: { version: 8, phase: 'phase8-round-team-score' },
    matchState: () => (netState && netState.snapshot && netState.snapshot.match
      ? netState.snapshot.match : (netState && netState.lobby ? netState.lobby.match || null : null)),
    matchQa: () => (game ? game.matchQa() : null),
    lobbyMatchBadge: () => {
      const el = $('lobbyMatch');
      return el ? { text: el.textContent, className: el.className } : null;
    },
    matchHud: () => {
      const el = $('matchHud');
      return el ? {
        hidden: !!el.hidden,
        team: $('mhTeam') ? $('mhTeam').textContent : null,
        round: $('mhRound') ? $('mhRound').textContent : null,
        score: $('mhScore') ? $('mhScore').textContent : null
      } : null;
    },
    lobbyNet: () => (netState ? {
      connected: netState.connected, received: netState.lobbyMessages,
      sent: netState.lobbySent, lastError: netState.lastError
    } : null),
    lobbyError: () => {
      const el = $('lobbyError');
      return el ? { text: el.textContent, hidden: el.hidden } : null;
    },
    lobbyRoster: () => {
      const el = $('lobbyPlayers');
      return el ? [...el.querySelectorAll('li')].map((li) => li.textContent.trim()) : null;
    },
    hostLobby: () => { clearLobbyError(); return netState ? netState.createLobby() : false; },
    joinLobby: () => { clearLobbyError(); return netState ? netState.joinLobby() : false; },
    leaveLobby: () => { clearLobbyError(); return netState ? netState.leaveLobby() : false; },
    startLobby: () => { clearLobbyError(); return netState ? netState.startLobby() : false; },
    enterGame: () => startSession(),

    // ---------- PHASE 9: HUD / POLISH / CHAT (QA API) ----------
    // Qiymatlar FAQAT avtoritar server holatidan (STATE/SNAPSHOT/LOBBY_STATE)
    // va HAQIQIY chat yo'lidan — mock EMAS. HUD hech narsani hisoblamaydi.
    phase9: { version: 9, phase: 'phase9-hud-chat' },
    /** HUD KO'RINISHI (server qiymatlari) — manba `source: 'server'|'predict'` */
    hudView: () => (game ? game.hudView() : null),
    /** HUD DOM matni + qaysi manbadan olingani (dalil: DOM ↔ server mos) */
    hudAuthority: () => {
      if (!game) return null;
      const v = game.hudView();
      const s = game.combat ? game.combat.hud.state(game.combat.snapshot()) : null;
      return {
        source: v.source,
        view: {
          hp: v.hp, maxHp: v.maxHp, alive: v.alive, respawnIn: v.respawnIn,
          mag: v.weapon.mag, magSize: v.weapon.magSize, reserve: v.weapon.reserve,
          reloading: v.weapon.reloading, weaponId: v.weapon.weaponId,
          team: v.team, playerId: v.playerId,
          roundNumber: v.roundNumber, roundState: v.roundState, matchState: v.matchState,
          scores: { ...v.scores }, roundWinner: v.roundWinner, matchWinner: v.matchWinner,
          connection: v.connection.state
        },
        dom: s
          ? { hp: s.hp, mag: s.mag, reserve: s.reserve, weapon: s.weapon, dead: s.dead, respawnIn: s.respawnIn, source: s.source }
          : null
      };
    },
    /** Ulanish holati (HAQIQIY WebSocket holatidan) */
    connection: () => {
      const el = $('hudConn');
      return {
        connected: !!(netState && netState.connected),
        readyState: netState && netState.socket ? netState.socket.readyState : -1,
        badge: el ? { text: el.textContent, className: el.className } : null
      };
    },
    /** Raund/match tugash banneri (matn AVTORITAR g'olib/balldan) */
    overlay: () => {
      const el = $('roundBanner');
      if (!el) return null;
      const visible = !el.hidden && getComputedStyle(el).display !== 'none';
      return {
        hidden: !!el.hidden, visible,
        kind: el.dataset.kind || null,
        title: $('rbTitle') ? $('rbTitle').textContent : null,
        sub: $('rbSub') ? $('rbSub').textContent : null
      };
    },
    /** HUD chip'lari (jamoa / o'z ID / ulanish) */
    hudChips: () => ({
      conn: $('hudConn') ? $('hudConn').textContent : null,
      team: $('hudTeam') ? $('hudTeam').textContent : null,
      me: $('hudMe') ? $('hudMe').textContent : null,
      matchLine: $('matchHud') ? { hidden: !!$('matchHud').hidden, team: $('mhTeam').textContent, round: $('mhRound').textContent, score: $('mhScore').textContent } : null
    }),
    /** HUD elementlarining HAQIQIY ko'rinishi (yashirilgan overlay dalili) */
    overlayVisibility: () => {
      const ids = ['pause', 'roundBanner', 'chDead', 'chatPanel', 'matchHud'];
      const out = {};
      for (const id of ids) {
        const el = $(id);
        out[id] = el
          ? { hidden: !!el.hidden, display: getComputedStyle(el).display, topAtCenter: false }
          : null;
      }
      const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      for (const id of ids) {
        if (out[id] && top && top.closest && top.closest('#' + id)) out[id].topAtCenter = true;
      }
      out.topAtCenter = top ? (top.id || top.className || top.tagName) : null;
      return out;
    },
    // ---------- PHASE 9: chat (server orqali) ----------
    chat: { version: 9, phase: 'phase9-chat' },
    chatState: () => (netState ? {
      messages: netState.chatMessages.length,
      received: netState.chatCount,
      sent: netState.chatSent,
      errors: netState.chatErrors,
      lastError: netState.chatLastError,
      last: netState.chatMessages.length ? netState.chatMessages[netState.chatMessages.length - 1] : null
    } : null),
    chatLog: () => {
      const el = $('chatLog');
      return el ? [...el.querySelectorAll('li')].map((li) => li.textContent) : null;
    },
    /**
     * HAQIQIY uzilish (diagnostika): socket close() — bu SOXTA holat emas,
     * WS haqiqatan yopiladi va HUD ko'rsatkichi shuni aks ettirishi shart.
     */
    dropSocket: () => {
      if (!netState || !netState.socket) return false;
      try { netState.socket.close(); return true; } catch { return false; }
    },
    chatOpen: () => chatOpen,
    openChat: () => openChat(),
    closeChat: () => closeChat(),
    /** Xabar yuborish — HAQIQIY yo'l (WebSocket → server validatsiyasi) */
    chatSend: (text) => { openChat(); return sendChatText(text); },
    chatInputValue: () => ($('chatInput') ? $('chatInput').value : null),
    chatError: () => {
      const el = $('chatError');
      return el ? { text: el.textContent, hidden: !!el.hidden } : null;
    },

    // ---------- PHASE 10: PERFORMANCE / STABILITY (O'LCHOV QA API) ----------
    // Bu blok HECH NARSA qilmaydi va holatni O'ZGARTIRMAYDI — faqat HAQIQIY
    // hisoblagichlarni (kadr/HUD/DOM/tarmoq/sinxronizatsiya) o'qib beradi.
    // Qiymatlar haqiqiy ish bajarilganda to'planadi (mock EMAS).
    phase10: { version: 10, phase: 'phase10-perf-stability' },
    perf: () => {
      const d = game ? game.diagnostics() : null;
      const qa = game ? game.multiplayerQa() : null;
      const hudEl = $('combatHud');
      const chatEl = $('chatLog');
      const mem = (typeof performance !== 'undefined' && performance.memory)
        ? {
            // Chrome'ga xos (non-standard) — mavjud bo'lsa HAQIQIY JS heap
            usedHeapMb: Math.round((performance.memory.usedJSHeapSize / 1048576) * 100) / 100,
            totalHeapMb: Math.round((performance.memory.totalJSHeapSize / 1048576) * 100) / 100,
            limitMb: Math.round((performance.memory.jsHeapSizeLimit / 1048576) * 100) / 100
          }
        : null;
      return {
        fps: d ? d.fps : null,
        frame: { cpuMs: d ? d.cpuMs : null },
        render: d ? d.render : null,
        // HUD: nechta kadr, nechta ko'rinish qurilishi, nechta DOM yozuvi
        // (domSkips >> domWrites bo'lishi kerak — keshlash ishlayapti)
        hud: d && d.perf
          ? {
              frames: d.perf.frames,
              viewBuilds: d.perf.hudViews,
              domWrites: d.perf.hudDomWrites,
              domSkips: d.perf.hudDomSkips
            }
          : null,
        dom: {
          total: document.getElementsByTagName('*').length,
          hudChildren: hudEl ? hudEl.getElementsByTagName('*').length : 0,
          chatItems: chatEl ? chatEl.getElementsByTagName('li').length : 0
        },
        memory: mem,
        net: netState ? {
          connected: netState.connected,
          readyState: netState.socket ? netState.socket.readyState : -1,
          sent: netState.sent,
          states: netState.stateMessages,
          snapshots: netState.snapshotMessages,
          eventBatches: netState.eventBatches,
          events: netState.eventTotal,
          lobbyMessages: netState.lobbyMessages,
          chatReceived: netState.chatCount,
          chatSent: netState.chatSent,
          chatErrors: netState.chatErrors,
          acks: { accepted: netState.acks.accepted, rejected: netState.acks.rejected },
          lastSnapshotAgo: qa ? qa.lastSnapshotAgo : null
        } : null,
        sync: qa ? {
          enabled: qa.enabled,
          snapshots: qa.snapshots,
          remotes: qa.remoteCount,
          remotesCreated: qa.added,
          remotesDisposed: qa.removed,
          pendingInputs: qa.pendingInputs,
          bounds: qa.bounds,
          interpolation: qa.interpolation,
          reconciliation: qa.reconciliation
        } : null,
        errors: {
          neon: (window.__neonErrors || []).length,
          loop: d ? d.loopErrors : 0
        }
      };
    }
  };

  console.log('[phase4] klient tayyor — TRAINING tugmasi + combat HUD faol');
});
