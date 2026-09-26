// ============================================================
// NEON STRIKE — PHASE 9: CHAT (SOF QOIDALAR + SOF HOLAT)
//
// Bu modulda socket / DOM / three.js YO'Q — faqat MATN qoidalari:
//   • uzunlik/bo'sh matn tekshiruvi (klient matni ISHONCHSIZ)
//   • yuboruvchi KIMLIGI hech qachon matndan olinmaydi — `member` (server
//     sessiyasi) beradi; klient `playerId`/`name` YUBORSA — rad etiladi
//   • oddiy portlash (burst) chegarasi — flood ko'paytirilmasin
//   • qisqa tarix (telemetriya/verifikatsiya uchun ring bufer)
//
// Chat SERVER orqali tarqatiladi: klient → server (validatsiya) → sessiya
// a'zolariga broadcast. Klient boshqa klientlarga TO'G'RIDAN-TO'G'RI yozmaydi.
// Chat mantig'i combat/match/harakat qarorlariga TA'SIR QILMAYDI.
// ============================================================
import { CHAT } from '../shared/protocol-consts.js';

/** Rad etish sabablari (testlar/telemetriya shu matnlarni o'qiydi) */
export const CHAT_REJECT = Object.freeze({
  BAD_MSG: 'chat_bad_msg',              // obyekt emas / type noto'g'ri
  FORBIDDEN: 'forbidden_authority',     // yuboruvchi kimligini da'vo qilish
  NO_MEMBER: 'chat_no_member',          // hello qilinmagan
  NOT_IN_SESSION: 'chat_no_session',    // sessiyaga a'zo emas
  BAD_TEXT: 'chat_bad_text',            // matn emas (raqam/obyekt/null)
  EMPTY: 'chat_empty',                  // bo'sh yoki faqat probel
  TOO_LONG: 'chat_too_long',            // MAX_LEN dan uzun
  RATE_LIMITED: 'chat_rate_limited'     // flood himoyasi
});

/**
 * Klient YUBORA OLMAYDIGAN avtoritar maydonlar: yuboruvchi kimligi va vaqt
 * SERVER tomonidan aniqlanadi (klient \"men p999\" yoki \"vaqt X\" deya olmaydi).
 */
export const CHAT_FORBIDDEN_FIELDS = Object.freeze([
  'playerId', 'senderId', 'sender', 'from', 'author', 'name', 'id',
  'sessionId', 'hostId', 'teamId', 'team', 'serverTick', 'tick', 'time',
  'serverTime', 'seq', 'revision'
]);

export function createChatHub ({ history = CHAT.HISTORY, burst = CHAT.BURST, windowMs = CHAT.WINDOW_MS } = {}) {
  return {
    history: Math.max(1, Math.floor(Number.isFinite(history) ? history : CHAT.HISTORY)),
    burst: Math.max(1, Math.floor(Number.isFinite(burst) ? burst : CHAT.BURST)),
    windowMs: Math.max(1, Math.floor(Number.isFinite(windowMs) ? windowMs : CHAT.WINDOW_MS)),
    entries: [],              // ring bufer (eng yangi oxirida)
    sequence: 0,
    accepted: 0,
    rejected: 0,
    rejections: {},
    rate: new Map()           // playerId -> [timestamps]
  };
}

/** Sessiya yopilganda tarix/chegaralarni tozalash (stale chat qolmasin) */
export function resetChat (hub) {
  if (!hub) return false;
  hub.entries.length = 0;
  hub.sequence = 0;
  hub.rate.clear();
  return true;
}

/**
 * MATNNI normallashtirish: boshqaruv belgilarini olib tashlash + chekka
 * bo'shliqlarni qirqish. Bo'sh bo'lsa — null (validatsiya EMPTY beradi).
 * Uzunlik BU YERDA kesilmaydi — chegaradan oshgan matn RAD ETILADI.
 */
export function normalizeChatText (raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return text.length ? text : null;
}

/**
 * Kliyent xabarini TEKSHIRISH (holat o'zgarmaydi).
 * @returns {{ok:boolean, reason:string, field?:string, text?:string}}
 */
export function validateChat (msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, reason: CHAT_REJECT.BAD_MSG };
  }
  if (msg.type !== undefined && msg.type !== 'chat') {
    return { ok: false, reason: CHAT_REJECT.BAD_MSG, field: 'type' };
  }
  for (const f of CHAT_FORBIDDEN_FIELDS) {
    if (msg[f] !== undefined) return { ok: false, reason: CHAT_REJECT.FORBIDDEN, field: f };
  }
  if (typeof msg.text !== 'string') {
    return { ok: false, reason: CHAT_REJECT.BAD_TEXT, field: 'text' };
  }
  const text = normalizeChatText(msg.text);
  if (!text) return { ok: false, reason: CHAT_REJECT.EMPTY, field: 'text' };
  if (text.length > CHAT.MAX_LEN) {
    return { ok: false, reason: CHAT_REJECT.TOO_LONG, field: 'text' };
  }
  return { ok: true, reason: '', text };
}

/**
 * Flood himoyasi: `burst` ta xabar `windowMs` ichida ruxsat etiladi,
 * keyin qisqa kutish. Muvaffaqiyatli qabul vaqtini yozadi.
 */
export function rateLimitOk (hub, playerId, now) {
  if (!hub) return true;
  const key = String(playerId);
  const t = Number.isFinite(now) ? now : Date.now();
  let list = hub.rate.get(key);
  if (!list) { list = []; hub.rate.set(key, list); }
  // eski yozuvlarni tozalash (oyna tashqarisi)
  let i = 0;
  while (i < list.length && t - list[i] >= hub.windowMs) i += 1;
  if (i > 0) list.splice(0, i);
  if (list.length >= hub.burst) return false;
  list.push(t);
  return true;
}

function noteReject (hub, reason) {
  hub.rejected += 1;
  hub.rejections[reason] = (hub.rejections[reason] || 0) + 1;
}

/**
 * Xabarni QABUL QILISH: matn tekshiriladi, kimlik SERVERDAN (`member`) olinadi,
 * chegara tekshiriladi, tarixga yoziladi. `type` maydoni qabul qilinmaydi —
 * yuboruvchi hech narsani da'vo qilmaydi.
 * @param {object} hub
 * @param {{id:string, name:string}} member — server sessiyasi (klient emas)
 * @param {object} msg — klient xabari (faqat `text`)
 * @param {number} now
 * @param {number} serverTick
 * @returns {{ok:boolean, reason:string, field?:string, entry?:object}}
 */
export function acceptChat (hub, member, msg, now = Date.now(), serverTick = 0) {
  if (!hub || !member) return { ok: false, reason: CHAT_REJECT.NO_MEMBER };
  const v = validateChat(msg);
  if (!v.ok) { noteReject(hub, v.reason); return v; }
  if (!rateLimitOk(hub, member.id, now)) {
    noteReject(hub, CHAT_REJECT.RATE_LIMITED);
    return { ok: false, reason: CHAT_REJECT.RATE_LIMITED };
  }
  hub.sequence += 1;
  const entry = {
    seq: hub.sequence,
    playerId: String(member.id),                 // SERVER bergan kimlik
    name: String(member.name || member.id).slice(0, 24),
    text: v.text,
    serverTick: Number.isFinite(serverTick) ? serverTick : 0,
    serverTime: now
  };
  hub.entries.push(entry);
  if (hub.entries.length > hub.history) hub.entries.splice(0, hub.entries.length - hub.history);
  hub.accepted += 1;
  return { ok: true, reason: '', entry };
}

/** Tarix nusxasi (telemetriya/verifikatsiya — faqat o'qish) */
export function chatHistory (hub, limit = hub ? hub.history : 0) {
  if (!hub) return [];
  const n = Math.max(0, Math.min(hub.entries.length, Math.floor(limit) || 0));
  return hub.entries.slice(hub.entries.length - n);
}
