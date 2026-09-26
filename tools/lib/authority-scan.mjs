// ============================================================
// NEON STRIKE — PHASE 12: STATIK AVTORITET SKANERI (SOF modul)
//
// Maqsad: "fake authority" regressiyasiga qarshi STATIK to'siq. Runtime
// forged-message testlari ALOHIDA (final-hardening.test.js / verify-phase12).
// Bu modul faqat MATNNI o'qiydi — hech narsani import qilmaydi, I/O yo'q
// (chaqiruvchi fayl ro'yxatini beradi).
//
// Nima tekshiriladi:
//   1) server/shared manbalarida klient xabaridan AVTORITAR maydon
//      (`msg.<damage|hp|ammo|teamId|score|roundWinner|...>`) O'QILMASIN.
//      Klient faqat INTENT yuboradi — bu maydonlar FORBIDDEN ro'yxatlari
//      orqali rad etiladi, hech qachon o'qilmaydi.
//   2) Klient xabaridan avtoritar maydonga TO'G'RIDAN-TO'G'RI yozuv
//      (`state.health.hp = msg...`) BO'LMASIN.
//   3) Protokol/`__neon` yuzalarida kelgusi-faza (P13+) tizim terminlari
//      BO'LMASIN.
// ============================================================

/** Klient xabaridan HECH QACHON o'qilmasligi shart bo'lgan avtoritar maydonlar */
export const AUTHORITY_FIELDS = Object.freeze([
  'damage', 'damageDealt', 'hp', 'health', 'targetHp', 'targetHealth',
  'hit', 'hits', 'kill', 'kills', 'death', 'died', 'alive', 'dead',
  'ammo', 'mag', 'magazine', 'reserve', 'cooldown', 'nextFireAt',
  'reloadEndsAt', 'explode', 'explosion', 'score', 'scores',
  'position', 'pos', 'velocity', 'vx', 'vy', 'vz', 'spread', 'seed', 'recoil',
  'authoritative', 'teamId', 'team', 'teams', 'roundState', 'roundNumber',
  'roundWinner', 'matchState', 'matchWinner', 'lives', 'round',
  // PHASE 9: yuboruvchi kimligi ham klientdan OLINMAYDI (server beradi)
  'playerId', 'senderId', 'sender', 'from', 'author',
  // PHASE 6: host/a'zolik da'volari
  'hostId', 'host', 'isHost', 'owner', 'started', 'startedAt',
  'capacity', 'maxPlayers', 'count',
  // server vaqtini ham klient belgilay olmaydi
  // (Diqqat: INPUT `seq` — qonuniy VALIDATSIYA qilinadigan kirish tartib raqami,
  //  avtoritar qiymat EMAS; shu sababli bu ro'yxatda YO'Q.)
  'serverTick', 'serverTime', 'tick'
]);

/** Kelgusi fazalarda ham RUXSAT ETILMAYDIGAN tizim terminlari (P13+) */
export const FUTURE_SCOPE_TERMS = Object.freeze([
  'spectat', 'replay', 'voip', 'voice', 'matchmak', 'ranking', 'scoreboard',
  'killfeed', 'inventory', 'friend', 'clan', 'achievement', 'profil',
  'account', 'deploy', 'cloud', 'monetiz', 'payment', 'subscription', 'analytics'
]);

/**
 * Manba matnini skanerlash (holat o'zgarmaydi).
 * @param {string} src
 * @param {string} label — topilmalarda ko'rsatiladigan fayl nomi
 * @param {{authorityFields?:string[], deadline?:number}} [opts]
 * @returns {{file:string, kind:string, detail:string}[]}
 */
export function scanSource (src, label, opts = {}) {
  const fields = new Set(opts.authorityFields || AUTHORITY_FIELDS);
  const findings = [];

  // 1) `msg.<authorityField>` o'qishi (klient xabaridan avtoritar maydon)
  const reRead = /\bmsg\s*\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = reRead.exec(src))) {
    if (fields.has(m[1])) {
      findings.push({
        file: label, kind: 'client-authority-read',
        detail: `msg.${m[1]} o'qilgan (klient bu maydonni boshqarmasligi kerak)`
      });
    }
  }

  // 2) klient xabaridan avtoritar maydonga to'g'ridan-to'g'ri yozuv
  const reWrite = /\.(hp|health|damage|mag|reserve|alive|dead|teamId|scores?|roundState|roundNumber|roundWinner|matchWinner|matchState)\s*=\s*[^;\n]*\b(msg|m)\s*\./g;
  while ((m = reWrite.exec(src))) {
    findings.push({
      file: label, kind: 'client-authority-write',
      detail: `avtoritar maydonga klient qiymati yozilgan: ${m[0].slice(0, 60)}`
    });
  }

  return findings;
}

/**
 * Fayllar ro'yxatini skanerlash. `readFile` — `(absPath) => string|null`.
 * @returns {{file:string, kind:string, detail:string}[]}
 */
export function scanFiles (files, readFile, opts = {}) {
  const out = [];
  for (const f of files) {
    const src = readFile(f);
    if (typeof src !== 'string') continue;
    out.push(...scanSource(src, f, opts));
  }
  return out;
}

/**
 * Protokol/`__neon` yuzasidagi kelgusi-faza terminlarini skanerlash.
 * @param {string[]} keys — xabar turlari / API kalitlari
 * @returns {{key:string, term:string}[]}
 */
export function scanFutureScope (keys) {
  const out = [];
  for (const k of keys) {
    const s = String(k).toLowerCase();
    for (const term of FUTURE_SCOPE_TERMS) {
      if (s.includes(term)) out.push({ key: String(k), term });
    }
  }
  return out;
}
