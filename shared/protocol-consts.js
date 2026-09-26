// ============================================================
// NEON STRIKE — shared protocol constants
// BU FAYL server ham, klient ham ishlatadi (bitta manba).
// Yangi xabar turi faqat shu yerga qo'shiladi.
//
// PHASE 5: avtoritativ server xabarlari QO'SHILDI (additiv).
// PHASE 6: LAN lobby xabarlari QO'SHILDI (additiv).
// PHASE 7: ko'p o'yinchili sinxronizatsiya — SNAPSHOT xabari (additiv).
// PHASE 8: jamoa/raund/ball — MAVJUD SNAPSHOT va LOBBY_STATE ichiga
//   `match` bloki QO'SHILDI (yangi xabar turi YO'Q — ikkinchi sinxronizatsiya
//   kanali YARATILMAYDI).
// PHASE 9: HUD/polish/chat — chat xabarlari QO'SHILDI (additiv):
//   `chat` (klient → server, FAQAT matn) va `chat-msg` (server → sessiya).
//   HUD avtoritar holatni o'qib ko'rsatadi — HUD uchun YANGI xabar turi YO'Q
//   (STATE/SNAPSHOT/LOBBY_STATE allaqachon hammasini beradi).
// Phase 1–8 xabarlari (hello/ping/gpu/welcome/pong/error/input/reset/
// create-session/join-session/snapshot/...) o'zgarishsiz — eski verifikatsiya
// skriptlari buzilmaydi.
// ============================================================

export const PROTOCOL_VERSION = 6;

/** Xabar turlari (msg.type qiymatlari) */
export const MSG = {
  // --- klient -> server (Phase 1) ---
  HELLO: 'hello',       // {name:string} — ulanilgandan keyin birinchi xabar
  PING: 'ping',         // {t:number}    — latency o'lchov (performance.now())
  GPU_REPORT: 'gpu',    // {webgl2:boolean, renderer:string, platform:string}

  // --- server -> klient (Phase 1) ---
  WELCOME: 'welcome',   // {id:number, online:number, serverTime:number, protocol:number}
  PONG: 'pong',         // {t:number, serverTime:number}
  ERROR: 'error',       // {code:string, message:string}

  // --- PHASE 5: klient -> server (FAQAT INTENT — avtoritar ma'lumot EMAS) ---
  INPUT: 'input',       // {seq, pose:{x,y,z,yaw,pitch}, aim:{dir:[x,y,z]},
                        //  intents:{fire,firePressed,reload,switchTo,moving},
                        //  move:{forward,right,sprint}}  <-- PHASE 7 qo'shildi
                        //
                        // PHASE 7: `move` — FAQAT niyat. Sessiya in_game
                        // bo'lsa server `pose.x/z` ni EMAS, shu o'qdan
                        // o'zi simulyatsiya qiladi (avtoritativ harakat).
  RESET: 'reset',       // {seq} — sessiyani qayta boshlash SO'ROVI (server qaror qiladi)

  // --- PHASE 5: server -> klient (AVTORITATIV natijalar) ---
  SESSION: 'session',   // {sessionId, playerId, protocol, tickHz, snapshotHz, map, targets, weapons}
  STATE: 'state',       // avtoritar holat snapshot'i (20 Hz) — server qaror qilgan qiymatlar
  EVENTS: 'events',     // avtoritar combat hodisalari (shot/hit/kill/blocked/...)
  INPUT_ACK: 'input-ack', // {seq, accepted, reason, tick}

  // --- PHASE 6: LAN LOBBY (klient -> server) — FAQAT niyat ---
  CREATE_SESSION: 'create-session',  // {name?} — LAN sessiya yaratish (yaratuvchi HOST bo'ladi)
  JOIN_SESSION: 'join-session',      // {name?, sessionId?} — mavjud LAN sessiyaga qo'shilish
  LEAVE_SESSION: 'leave-session',    // {} — sessiyadan chiqish
  START_SESSION: 'start-session',    // {} — FAQAT host: session state lobby → in_game

  // --- PHASE 6: LAN LOBBY (server -> klient) — AVTORITAR lobby holati ---
  LOBBY_STATE: 'lobby-state', // {sessionId, state, hostId, capacity, count, you, isHost,
                              //  inSession, players[], addresses[], revision, serverTime}

  // --- PHASE 9: CHAT (klient -> server — FAQAT MATN, kimligini SERVER aniqlaydi) ---
  CHAT: 'chat',         // {text:string} — o'yinchi xabari SO'ROVI (playerId YUBORILMAYDI)

  // --- PHASE 9: CHAT (server -> klient — AVTORITAR yuboruvchi kimligi) ---
  CHAT_MSG: 'chat-msg', // {playerId, name, text, seq, serverTick, serverTime}
                        //  playerId/name/seq — SERVER bergan (klient da'vo qilolmaydi)

  // --- PHASE 7: server -> klient — AVTORITAR sinxronizatsiya snapshot'i (20 Hz) ---
  SNAPSHOT: 'snapshot'  // {serverTick, ackSeq, serverTime, players:[{id, sessionId,
                        //  x,y,z, vx,vz, yaw, pitch, faceYaw, alive, speed,
                        //  teamId, hp}], count,
                        //  match:{matchState, roundState, roundNumber, roundWinner,
                        //         matchWinner, scores:{A,B}, teams:{A:[],B:[]},
                        //         lives:{A,B}, roundEndsIn}}
                        //  ackSeq — SHU ulanish uchun; players[] — sessiyadagi hamma.
                        //  PHASE 8: `match` bloki AVTORITAR jamoa/raund/ball holati.
};

/**
 * PHASE 8: jamoa/raund/ball holatlari (SOF — faqat server qaror qiladi).
 * Klient bu qiymatlarni FAQAT ko'rsatadi; qayta hisoblamaydi.
 */
export const TEAM = Object.freeze({ A: 'A', B: 'B' });
export const TEAM_ORDER = Object.freeze([TEAM.A, TEAM.B]);

export const MATCH_PHASE = Object.freeze({
  NONE: 'none',            // match yo'q
  LOBBY: 'lobby',          // yig'ilish (hali boshlanmagan)
  STARTING: 'starting',    // host boshladi — o'yinchilar spawn'larga joylashadi
  LIVE: 'live',            // raund davom etmoqda
  ROUND_END: 'round_end',  // raund tugadi — keyingi raund kutilyapti
  MATCH_END: 'match_end'   // match tugadi (g'olib jamoa aniqlandi)
});

/** Phase 5: server simulyatsiya sozlamalari */
export const SIM = Object.freeze({
  TICK_HZ: 30,
  TICK_MS: 1000 / 30,
  SNAPSHOT_HZ: 20,
  SNAPSHOT_MS: 50,
  /** Bir tick'da qabul qilinadigan maksimal input (to'planish himoyasi) */
  MAX_INPUTS_PER_TICK: 8,
  /** PHASE 7: snapshot ichidagi maksimal o'yinchi (capacitiy bilan mos) */
  MAX_SNAPSHOT_PLAYERS: 8,
  /** PHASE 7: klient interpolatsiya buferi (ms) — 2 snapshot @20 Hz */
  INTERP_DELAY_MS: 100,
  /** Sessiya uzilishda yopiladi (ms) — tirik qolish evristikasi */
  IDLE_TIMEOUT_MS: 30000,
  // ---- PHASE 8: raund/jamoa/ball vaqt sozlamalari (server avtoriteti) ----
  /** STARTING → LIVE o'tish (ms): o'yinchilar spawn'larga joylashadi */
  STARTING_MS: 1200,
  /** Raund tugagach keyingi raundgacha tanaffus (ms) */
  ROUND_END_MS: 3000,
  /** Match g'alabasi uchun kerakli raund g'alabalari */
  ROUNDS_TO_WIN: 5,
  /** Bitta matchdagi maksimal raund (himoya chegarasi) */
  MAX_ROUNDS: 99
});

/**
 * PHASE 9: chat chegaralari (SOF — server ham, klient ham bir xil qiymatni
 * ishlatadi; kodni takrorlamaslik uchun bitta manba).
 * Server bu chegaralarni MAJBURLaydi — klient faqat bir xil ko'rsatadi.
 */
export const CHAT = Object.freeze({
  /** Bitta xabar uchun maksimal uzunlik (belgi) */
  MAX_LEN: 160,
  /** Qisqa "portlash" (burst) oynasida ruxsat etilgan xabar soni */
  BURST: 5,
  /** Portlash oynasi (ms) — shundan keyin yana ruxsat */
  WINDOW_MS: 3000,
  /** Klientda ko'rsatiladigan maksimal tarix (yozuv) */
  HISTORY: 50
});

/** Server standart sozlamalari (Phase 1; MAX_PLAYERS — Phase 6) */
export const SERVER_DEFAULTS = Object.freeze({
  HOST: '0.0.0.0',
  PORT: 3000,
  WS_PATH: '/ws',
  MAX_MSG_BYTES: 16 * 1024,
  /**
   * PHASE 12: `ws` qabul qiladigan eng katta xabar (bayt).
   * `MAX_MSG_BYTES` (16 KiB) — ILOVA darajasidagi tekshiruv: undan kattasi
   * `too_big` xatosi bilan RAD ETILADI (ulanish ochiq qoladi). Ammo `ws`
   * kutubxonasi standart bo'yicha 100 MiB gacha buferga yig'adi — ya'ni 17 KiB
   * va 100 MiB orasidagi xabar avval TO'LIQ XOTIRAGA OLINARDI. Shu sababli
   * protokol darajasida ham qat'iy chegara qo'yiladi: undan katta xabar
   * parse qilinishidan OLDIN rad etiladi (server o'lmaydi, o'sha paytdagi
   * 16 KiB javob semantikasi o'zgarmaydi — 16 KiB ≈ 64 KiB oralig'i).
   */
  WS_MAX_PAYLOAD_BYTES: 64 * 1024,
  /** Phase 6: LAN sessiya qat'iy sig'imi (server majburlaydi) */
  MAX_PLAYERS: 8
});
