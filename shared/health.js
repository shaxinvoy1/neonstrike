// ============================================================
// NEON STRIKE — PHASE 4: HAYOT/ZARAR MODELI (SOF QOIDALAR)
// three.js / DOM / timer YO'Q → node testlar ham, PHASE 5 SERVER ham
// aynan shu modelni ishlatadi (avtoritar zarar keyin shu yerda hisoblanadi).
//  - createHealth() : max/hp/alive/deaths + dublikat eventId himoyasi
//  - applyDamage()  : validatsiya (NaN/manfiy/nol), o'limdan keyin zarar YO'Q,
//                     deterministik o'lim o'tishi (died bir marta)
// ============================================================

export const HEALTH = Object.freeze({
  PLAYER_MAX: 100,
  TARGET_MAX: 100,
  RING_MAX: 60,
  PLAYER_RESPAWN_MS: 2500,
  TARGET_RESPAWN_MS: 2500,
  DEDUPE_CAPACITY: 128,     // takroriy damage event'lar uchun yod (bounded FIFO)
  LOG_CAPACITY: 24          // HUD/debug uchun zarar jurnali (bounded ring)
});

/**
 * Hayot holati. `_result` — applyDamage() natijasi (QAYTA ISHLATILADI:
 * har chaqiruvda ustiga yoziladi → kadr ichida allokatsiya yo'q).
 */
export function createHealth (max = HEALTH.TARGET_MAX, { label = '' } = {}) {
  return {
    max,
    hp: max,
    alive: true,
    deaths: 0,
    label,
    lastAmount: 0,
    lastSourceId: '',
    lastZone: '',
    lastAt: -1,
    seen: new Set(),
    seenOrder: [],
    log: [],
    logIndex: 0,
    _result: { accepted: false, reason: '', amount: 0, hp: max, died: false, sourceId: '', zone: '', eventId: '' }
  };
}

/** To'liq tiklash (respawn / sessiya qayta boshlash) */
export function resetHealth (h) {
  h.hp = h.max;
  h.alive = true;
  h.lastAmount = 0;
  h.lastSourceId = '';
  h.lastZone = '';
  h.lastAt = -1;
  h.seen.clear();
  h.seenOrder.length = 0;
  return h;
}

export function isDead (h) { return !h.alive; }

/**
 * Zarar qo'llash (yagona kirish nuqtasi).
 * @param {object} h createHealth() natijasi
 * @param {{amount:number, sourceId?:string, eventId?:string, zone?:string, distance?:number, at?:number}} dmg
 * @returns {object} h._result — {accepted, reason, amount, hp, died, ...}
 *  reason: '' (qabul) | 'dead' | 'invalid' | 'duplicate'
 */
export function applyDamage (h, dmg = {}) {
  const r = h._result;
  r.accepted = false;
  r.reason = '';
  r.amount = 0;
  r.hp = h.hp;
  r.died = false;
  r.sourceId = dmg.sourceId || '';
  r.zone = dmg.zone || '';
  r.eventId = dmg.eventId || '';

  const amount = dmg.amount;
  if (!Number.isFinite(amount) || amount <= 0) { r.reason = 'invalid'; return r; }
  if (!h.alive) { r.reason = 'dead'; return r; }              // o'limdan keyin zarar YO'Q

  if (dmg.eventId) {                                          // takroriy hodisani yutish
    if (h.seen.has(dmg.eventId)) { r.reason = 'duplicate'; return r; }
    h.seen.add(dmg.eventId);
    h.seenOrder.push(dmg.eventId);
    if (h.seenOrder.length > HEALTH.DEDUPE_CAPACITY) {
      const old = h.seenOrder.shift();
      h.seen.delete(old);
    }
  }

  const applied = Math.min(h.hp, amount);
  h.hp = Math.max(0, h.hp - amount);
  h.lastAmount = amount;
  h.lastSourceId = r.sourceId;
  h.lastZone = r.zone;
  h.lastAt = Number.isFinite(dmg.at) ? dmg.at : -1;

  r.accepted = true;
  r.amount = applied;
  r.hp = h.hp;
  if (h.hp <= 0) {                                            // deterministik o'lim
    h.alive = false;
    h.deaths += 1;
    r.died = true;
  }

  // bounded zarar jurnali (HUD/debug/QA dalili)
  let entry = h.log[h.logIndex];
  if (!entry) {
    entry = { sourceId: '', amount: 0, zone: '', hp: 0, at: -1, distance: 0 };
    h.log[h.logIndex] = entry;
  }
  entry.sourceId = r.sourceId;
  entry.amount = applied;
  entry.zone = r.zone;
  entry.hp = h.hp;
  entry.at = Number.isFinite(dmg.at) ? dmg.at : -1;
  entry.distance = Number.isFinite(dmg.distance) ? dmg.distance : 0;
  h.logIndex = (h.logIndex + 1) % HEALTH.LOG_CAPACITY;

  return r;
}

/** Jurnaldagi oxirgi zarar yozuvi (HUD/debug uchun) */
export function lastDamage (h) {
  if (!h.log.length) return null;
  const idx = (h.logIndex - 1 + HEALTH.LOG_CAPACITY) % HEALTH.LOG_CAPACITY;
  return h.log[idx] || null;
}
