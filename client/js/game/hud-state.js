// ============================================================
// NEON STRIKE — PHASE 9: HUD HOLATI ADAPTERI (SOF — DOM/three.js YO'Q)
//
// Bitta savolga javob beradi: "HUD nimani ko'rsatishi kerak?" — va javob
// FAQAT avtoritar server holatidan olinadi:
//
//   SERVER (STATE/SNAPSHOT/LOBBY_STATE)
//        ↓
//   buildHudView()  ← shu modul (sof funksiya)
//        ↓
//   HUD render (hud.js / index.js)
//
// QOIDA (§5): avtoritar HP/o'q-dori/team/raund/ball MAVJUD bo'lsa — HUD
// o'sha qiymatlarni ko'rsatadi. Faqat avtoritar sessiya BO'LMAGANDA (offline
// TRAINING) HUD lokal bashoratni (Phase 4 predictor) ko'rsatadi — bashorat
// AVTORITETGA aylanmaydi, u shunchaki mavjud bo'lmagan server holatining
// o'rnini bosadi.
//
// Import YO'Q (shared/health.js ham, three.js ham) → Node'da bevosita
// test qilinadi: test/unit/hud-chat.test.js
// ============================================================

/** Ulanish holati yorliqlari (WS holatidan — taxmin emas) */
export const CONNECTION = Object.freeze({
  CONNECTED: 'connected',
  CONNECTING: 'connecting',
  DISCONNECTED: 'disconnected'
});

/** Serverdan kelgan WS holatini yorliqqa aylantirish (0..3 — WebSocket readyState) */
export function connectionState ({ connected = false, readyState = 3 } = {}) {
  if (connected === true) return CONNECTION.CONNECTED;
  if (readyState === 0 || readyState === 1) return CONNECTION.CONNECTING;
  return CONNECTION.DISCONNECTED;
}

export function connectionBadge (state) {
  switch (state) {
    case CONNECTION.CONNECTED: return { state, text: 'ULANISH: SERVER', cls: 'ok' };
    case CONNECTION.CONNECTING: return { state, text: 'ULANISH: …', cls: 'wait' };
    default: return { state: CONNECTION.DISCONNECTED, text: 'ULANISH: UZILDI', cls: 'bad' };
  }
}

/** Raund holati yorlig'i (server qiymati → HUD matni) */
export function roundStateLabel (roundState) {
  switch (roundState) {
    case 'starting': return 'STARTING';
    case 'live': return 'LIVE';
    case 'round_end': return 'ROUND OVER';
    case 'match_end': return 'MATCH OVER';
    case 'lobby': return 'LOBBY';
    default: return '—';
  }
}

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/** Qurol blokini normallashtirish (manba qanday bo'lishidan qat'i nazar) */
function weaponBlock (src) {
  const w = src && typeof src === 'object' ? src : {};
  return {
    weaponId: w.weaponId || null,
    weaponName: w.weaponName || null,
    slot: num(w.slot, 1),
    mag: num(w.mag, 0),
    magSize: num(w.magSize, 0),
    reserve: num(w.reserve, 0),
    reloading: !!w.reloading,
    reloadProgress: num(w.reloadProgress, 0),
    switching: !!w.switching
  };
}

/**
 * HUD ko'rinishini qurish. KIRISH — FAQAT o'qish: hech qanday holat
 * o'zgartirilmaydi, hech narsa hisoblanmaydi (ball/HP SERVERDAN keladi).
 *
 * @param {object} o
 * @param {object|null} o.authoritative — oxirgi server STATE xabari
 * @param {object|null} o.snapshot      — oxirgi server SNAPSHOT xabari
 * @param {object|null} o.lobby         — oxirgi server LOBBY_STATE xabari
 * @param {object|null} o.local         — lokal bashorat (combat snapshot)
 * @param {string} o.connection         — connectionState() natijasi
 * @param {string|null} o.you           — server bergan player ID
 * @returns {object} HUD ko'rinishi (faqat o'qish uchun qiymatlar)
 */
export function buildHudView ({
  authoritative = null, snapshot = null, lobby = null,
  local = null, connection = CONNECTION.DISCONNECTED, you = null
} = {}) {
  // Avtoritar rejim: server harakatni ham boshqarayotgan sessiya
  const serverMode = !!(authoritative && authoritative.authoritativeMovement === true);
  const lw = weaponBlock(local && local.weapon);
  const aw = weaponBlock(authoritative && authoritative.weapon);

  const match = (snapshot && snapshot.match) || (lobby && lobby.match) || null;
  const selfEntry = (snapshot && Array.isArray(snapshot.players) && you)
    ? (snapshot.players.find((p) => p && p.id === you) || null)
    : null;

  // ---- HP / o'lim: avtoritar bo'lsa — server qiymati ----
  const hp = serverMode ? num(authoritative.hp, 0) : num(local && local.hp, 0);
  const maxHp = serverMode
    ? num(authoritative.maxHp, num(local && local.maxHp, 100))
    : num(local && local.maxHp, 100);
  const alive = serverMode ? authoritative.alive !== false : !(local && local.alive === false);
  const respawnIn = serverMode ? num(authoritative.respawnIn, -1) : num(local && local.respawnIn, 0);

  // ---- o'q-dori / reload: avtoritar bo'lsa — server qiymati ----
  const weapon = serverMode ? aw : lw;

  // ---- jamoa: SERVER qiymati (draw: STATE.teamId → SNAPSHOT player.teamId) ----
  const team = (authoritative && authoritative.teamId) ||
    (selfEntry && selfEntry.teamId) || null;

  // ---- raund / ball: SERVER match bloki ----
  const matchState = match ? match.matchState : 'none';
  const roundState = match ? match.roundState : 'none';
  const roundNumber = num(match && match.roundNumber, 0);
  const scores = { A: num(match && match.scores && match.scores.A, 0), B: num(match && match.scores && match.scores.B, 0) };
  const inMatch = matchState !== 'none' && matchState !== 'lobby';
  const roundWinner = (match && match.roundWinner) || null;
  const matchWinner = (match && match.matchWinner) || null;

  // ---- ekran yozuvlari (P8 formatiga mos — o'zgartirilmaydi) ----
  const teamText = team ? `JAMOA ${team}` : '—';
  const roundText = `RAUND ${roundNumber} · ${roundStateLabel(roundState)}`;
  const scoreText = `A ${scores.A} : ${scores.B} B`;

  // ---- raund/match tugashi bannerlari (AVTORITAR g'olib) ----
  let banner = { show: false, title: '', sub: '' };
  if (matchState === 'match_end') {
    banner = {
      show: true,
      title: 'MATCH COMPLETE',
      sub: `${matchWinner ? 'TEAM ' + matchWinner + ' WINS' : 'NO WINNER'} · ${scoreText}`
    };
  } else if (roundState === 'round_end') {
    banner = {
      show: true,
      title: `ROUND ${roundNumber} OVER`,
      sub: `${roundWinner ? 'TEAM ' + roundWinner + ' WINS' : 'NO WINNER'} · ${scoreText}`
    };
  } else if (roundState === 'starting') {
    banner = { show: true, title: `ROUND ${roundNumber}`, sub: 'GET READY' };
  }

  const conn = connectionBadge(connection);

  return {
    /** 'server' — HUD avtoritar qiymatlarni ko'rsatadi; 'predict' — offline bashorat */
    source: serverMode ? 'server' : 'predict',
    authoritative: serverMode,
    hp: Math.max(0, Math.round(hp)),
    maxHp: Math.max(1, Math.round(maxHp)),
    hpPct: Math.max(0, Math.min(1, hp / Math.max(1, maxHp))),
    alive: !!alive,
    dead: !alive,
    respawnIn,
    weapon,
    team,
    playerId: you || (authoritative && authoritative.playerId) || null,
    matchState,
    roundState,
    roundNumber,
    roundWinner,
    matchWinner,
    scores,
    inMatch,
    teamText,
    roundText,
    scoreText,
    banner,
    connection: conn,
    // dalil uchun: HP/o'q-dori qayerdan olinganini aniq ko'rsatadi
    fromServer: { hp: serverMode, ammo: serverMode }
  };
}
