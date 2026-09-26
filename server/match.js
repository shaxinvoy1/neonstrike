// ============================================================
// NEON STRIKE — PHASE 8: JAMOA / RAUND / BALL (SOF QOIDALAR, SOF HOLAT)
// three.js / DOM / socket YO'Q — faqat avtoritar match qoidalari.
// Server EGASI (authority): klient hech narsani da'vo qila olmaydi:
//   • teamId      → SERVER tayinlaydi (klient "men TEAM_A" deya olmaydi)
//   • roundState  → SERVER o'tkazadi (klient "raund tugadi" deya olmaydi)
//   • roundWinner → SERVER aniqlaydi
//   • scores      → SERVER hisoblaydi (klient "score += 1" yubora olmaydi)
//
// Combat mantig'i BU YERDA YO'Q — u shared/combat.js + server/session.js da.
// Bu modul faqat match holatini va o'tishlarini boshqaradi (BITTA egasi:
// lobby sessiyasiga bog'langan `match` obyekti — parallel tizim yo'q).
//
// RAUND OQIMI:
//   LOBBY → (host start) → STARTING → LIVE → (jamoa yo'q qilindi) → ROUND_END
//         → (ball chegarasi) → MATCH_END   |   → (keyingi raund) → LIVE
//
// IDEMPOTENTLIK: endRound FAQAT LIVE holatdan ishlaydi → dublikat o'lim/
// uzilish hodisalari ballni IKKI MARTA oshira olmaydi.
// ============================================================
import { MATCH_PHASE, TEAM, TEAM_ORDER, SIM } from '../shared/protocol-consts.js';

export { MATCH_PHASE, TEAM, TEAM_ORDER };

/** Match qoidalari (o'zgartirilsa — faqat shu yerda) */
export const MATCH_RULES = Object.freeze({
  ROUNDS_TO_WIN: SIM.ROUNDS_TO_WIN,
  ROUND_END_MS: SIM.ROUND_END_MS,
  STARTING_MS: SIM.STARTING_MS,
  MAX_ROUNDS: SIM.MAX_ROUNDS
});

/** Rad etish sabablari (testlar/telemetriya shu matnlarni o'qiydi) */
export const MATCH_REJECT = Object.freeze({
  NOT_LIVE: 'round_not_live',
  NO_MATCH: 'no_match',
  ALREADY: 'round_already_ended',
  TEAMS_INCOMPLETE: 'teams_incomplete'
});

/** Bo'sh (matchsiz) holat */
export function createMatch () {
  return {
    state: MATCH_PHASE.NONE,
    roundNumber: 0,
    roundState: MATCH_PHASE.NONE,
    roundWinner: null,
    matchWinner: null,
    scores: { A: 0, B: 0 },
    teams: { A: [], B: [] },        // playerId lar (deterministik tartib)
    lives: { A: 0, B: 0 },          // tirik a'zolar (har tick server yangilaydi)
    /** Raund BOSHIDAGI jamoa kattaliklari — raund tugashini baholash uchun */
    teamsAtRoundStart: { A: 0, B: 0 },
    roundStartedAt: 0,
    roundEndsAt: 0,
    liveAt: 0,                      // STARTING → LIVE vaqti
    revision: 0,
    roundsPlayed: 0
  };
}

/** Holatni to'liq nolga qaytarish (sessiya yopilganda) */
export function resetMatch (match) {
  if (!match) return null;
  match.state = MATCH_PHASE.NONE;
  match.roundNumber = 0;
  match.roundState = MATCH_PHASE.NONE;
  match.roundWinner = null;
  match.matchWinner = null;
  match.scores.A = 0;
  match.scores.B = 0;
  match.teams.A.length = 0;
  match.teams.B.length = 0;
  match.lives.A = 0;
  match.lives.B = 0;
  match.teamsAtRoundStart.A = 0;
  match.teamsAtRoundStart.B = 0;
  match.roundStartedAt = 0;
  match.roundEndsAt = 0;
  match.liveAt = 0;
  match.roundsPlayed = 0;
  match.revision += 1;
  return match;
}

/** O'yinchi qaysi jamoada (yo'q bo'lsa null) */
export function teamOf (match, playerId) {
  if (!match || playerId === undefined || playerId === null) return null;
  const id = String(playerId);
  if (match.teams.A.indexOf(id) >= 0) return TEAM.A;
  if (match.teams.B.indexOf(id) >= 0) return TEAM.B;
  return null;
}

export function teamSize (match, team) {
  return match.teams[team] ? match.teams[team].length : 0;
}

/**
 * DETERMINISTIK muvozanatli jamoa tayinlash:
 *   A a'zolari <= B a'zolari → A ; aks holda B.
 * Shu sababli 1v1, 2v2, toq sonlar ham barqaror taqsimlanadi
 * (toq bo'lsa — A bir kishi ko'p; hujjatlashtirilgan xatti-harakat).
 * @returns {string|null} tayinlangan jamoa
 */
export function assignTeam (match, playerId) {
  if (!match || playerId === undefined || playerId === null) return null;
  const id = String(playerId);
  const cur = teamOf(match, id);
  if (cur) return cur;
  const t = match.teams.A.length <= match.teams.B.length ? TEAM.A : TEAM.B;
  match.teams[t].push(id);
  match.revision += 1;
  return t;
}

/** A'zoni jamoadan chiqarish (uzilish/chiqish) — dublikatga chidamli */
export function removePlayer (match, playerId) {
  if (!match) return false;
  const id = String(playerId);
  let removed = false;
  for (const t of TEAM_ORDER) {
    const arr = match.teams[t];
    const i = arr.indexOf(id);
    if (i >= 0) { arr.splice(i, 1); removed = true; }
  }
  if (removed) match.revision += 1;
  return removed;
}

/** Ikkala jamoada ham a'zo bo'lganmi (raund tugashi uchun shart) */
export function teamsComplete (match) {
  return match.teamsAtRoundStart.A > 0 && match.teamsAtRoundStart.B > 0;
}

/** Yangi raundni boshlash (faqat server ichki o'tishi) */
export function beginRound (match, roundNumber, now = 0) {
  if (!match) return null;
  match.roundNumber = Math.min(MATCH_RULES.MAX_ROUNDS, roundNumber);
  match.roundState = MATCH_PHASE.LIVE;
  match.state = MATCH_PHASE.LIVE;
  match.roundWinner = null;
  // Raund boshidagi jamoa kattaligi qayd etiladi: keyinchalik o'yinchi
  // uzilsa ham raund TO'G'RI baholanadi (a'zosi yo'q jamoa yutqazadi),
  // lekin boshidanoq toq (1 kishilik) match "avtomatik g'alaba" bermaydi.
  match.teamsAtRoundStart.A = match.teams.A.length;
  match.teamsAtRoundStart.B = match.teams.B.length;
  match.roundStartedAt = now;
  match.roundEndsAt = 0;
  match.liveAt = 0;
  match.roundsPlayed += 1;
  match.revision += 1;
  return match;
}

/**
 * Matchni boshlash: jamoalarni tayinlaydi va STARTING holatiga o'tadi.
 * Raund FAQAT serverda belgilangan `STARTING_MS` dan keyin LIVE bo'ladi.
 * @returns {{ok:boolean, reason?:string, match:object}}
 */
export function startMatch (match, playerIds, now = 0) {
  if (!match) return { ok: false, reason: MATCH_REJECT.NO_MATCH };
  match.scores.A = 0;
  match.scores.B = 0;
  match.matchWinner = null;
  match.roundWinner = null;
  match.roundsPlayed = 0;
  match.teams.A.length = 0;
  match.teams.B.length = 0;
  match.lives.A = 0;
  match.lives.B = 0;
  match.teamsAtRoundStart.A = 0;
  match.teamsAtRoundStart.B = 0;
  const list = Array.isArray(playerIds) ? playerIds : [];
  for (const id of list) assignTeam(match, id);   // deterministik tartib (qo'shilish tartibi)
  match.roundNumber = 0;
  match.roundState = MATCH_PHASE.STARTING;
  match.state = MATCH_PHASE.STARTING;
  match.liveAt = now + MATCH_RULES.STARTING_MS;
  match.roundEndsAt = 0;
  match.revision += 1;
  return { ok: true, reason: 'starting', match };
}

/**
 * Raund g'olibini aniqlash. FAQAT ikkala jamoada ham a'zo bo'lsa va
 * raund LIVE bo'lsa. (Bir kishilik sessiya "avtomatik g'alaba" bermaydi.)
 * @param {{A:number,B:number}} lives tirik a'zolar
 * @returns {string|null} TEAM.A | TEAM.B | null
 */
export function evaluateRound (match, lives) {
  if (!match || match.roundState !== MATCH_PHASE.LIVE) return null;
  if (!teamsComplete(match)) return null;
  const a = lives ? lives.A : match.lives.A;
  const b = lives ? lives.B : match.lives.B;
  if (a > 0 && b === 0) return TEAM.A;
  if (b > 0 && a === 0) return TEAM.B;
  return null;
}

/**
 * Raundni tugatish — IDEMPOTENT (faqat LIVE holatdan; dublikat chaqiruv
 * ballni oshirmaydi). Ball oshadi, MATCH_END tekshiriladi.
 * @returns {{ok:boolean, reason?:string, winner?:string, scores?:object, matchEnded?:boolean}}
 */
export function endRound (match, winner, now = 0) {
  if (!match) return { ok: false, reason: MATCH_REJECT.NO_MATCH };
  if (match.roundState !== MATCH_PHASE.LIVE) {
    return { ok: false, reason: MATCH_REJECT.ALREADY };
  }
  if (winner !== TEAM.A && winner !== TEAM.B) {
    return { ok: false, reason: MATCH_REJECT.TEAMS_INCOMPLETE };
  }
  match.roundWinner = winner;
  match.scores[winner] += 1;
  match.roundState = MATCH_PHASE.ROUND_END;
  match.roundEndsAt = now + MATCH_RULES.ROUND_END_MS;
  const matchEnded = match.scores[winner] >= MATCH_RULES.ROUNDS_TO_WIN;
  if (matchEnded) {
    match.matchWinner = winner;
    match.state = MATCH_PHASE.MATCH_END;
  } else {
    match.state = MATCH_PHASE.ROUND_END;
  }
  match.revision += 1;
  return { ok: true, winner, scores: { A: match.scores.A, B: match.scores.B }, matchEnded };
}

/**
 * Vaqtga bog'liq o'tishlar (har tick chaqiriladi — SERVER vaqti bilan):
 *   STARTING  → LIVE          (birinchi raund)
 *   ROUND_END → MATCH_END     (ball chegarasi) yoki yangi raund → LIVE
 * @returns {{roundStarted:boolean, matchEnded:boolean, event:string}}
 */
export function stepMatch (match, now = 0) {
  const ev = { roundStarted: false, matchEnded: false, event: 'idle' };
  if (!match) return ev;
  if (match.state === MATCH_PHASE.STARTING && now >= match.liveAt) {
    beginRound(match, 1, now);
    ev.roundStarted = true;
    ev.event = 'round-start';
    return ev;
  }
  if (match.state === MATCH_PHASE.ROUND_END && now >= match.roundEndsAt) {
    const w = match.roundWinner;
    if (w && match.scores[w] >= MATCH_RULES.ROUNDS_TO_WIN) {
      match.matchWinner = w;
      match.state = MATCH_PHASE.MATCH_END;
      ev.matchEnded = true;
      ev.event = 'match-end';
      return ev;
    }
    if (match.roundNumber >= MATCH_RULES.MAX_ROUNDS) {
      // himoya chegarasi: raundlar tugadi — ball bo'yicha g'olib
      match.matchWinner = match.scores.A >= match.scores.B ? TEAM.A : TEAM.B;
      match.state = MATCH_PHASE.MATCH_END;
      ev.matchEnded = true;
      ev.event = 'match-end-max';
      return ev;
    }
    beginRound(match, match.roundNumber + 1, now);
    ev.roundStarted = true;
    ev.event = 'round-start';
    return ev;
  }
  return ev;
}

/**
 * KLIENTGA yuboriladigan AVTORITAR match snapshot'i.
 * `out` qayta ishlatiladi (allocatsiya minimal: ichki obyektlar joyida
 * yangilanadi). Klient buni FAQAT ko'rsatadi.
 */
export function matchSnapshot (match, out = {}, now = 0) {
  const scores = out.scores || (out.scores = { A: 0, B: 0 });
  const teams = out.teams || (out.teams = { A: [], B: [] });
  const lives = out.lives || (out.lives = { A: 0, B: 0 });
  out.matchState = match ? match.state : MATCH_PHASE.NONE;
  out.roundState = match ? match.roundState : MATCH_PHASE.NONE;
  out.roundNumber = match ? match.roundNumber : 0;
  out.roundWinner = match ? match.roundWinner : null;
  out.matchWinner = match ? match.matchWinner : null;
  scores.A = match ? match.scores.A : 0;
  scores.B = match ? match.scores.B : 0;
  lives.A = match ? match.lives.A : 0;
  lives.B = match ? match.lives.B : 0;
  teams.A.length = 0;
  teams.B.length = 0;
  if (match) {
    for (let i = 0; i < match.teams.A.length; i++) teams.A.push(match.teams.A[i]);
    for (let i = 0; i < match.teams.B.length; i++) teams.B.push(match.teams.B[i]);
  }
  out.roundsToWin = MATCH_RULES.ROUNDS_TO_WIN;
  out.roundEndsIn = match && match.roundState === MATCH_PHASE.ROUND_END && Number.isFinite(match.roundEndsAt)
    ? +Math.max(0, (match.roundEndsAt - now) / 1000).toFixed(2)
    : 0;
  out.roundDurationMs = match && match.roundState === MATCH_PHASE.LIVE && match.roundStartedAt
    ? Math.max(0, Math.round(now - match.roundStartedAt))
    : 0;
  return out;
}
