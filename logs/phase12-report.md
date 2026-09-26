# NEON STRIKE — PHASE 12 — FINAL HARDENING

> Natija: **PHASE 12 STATUS: COMPLETE** (24 PASS / 0 FAIL)
> P11 fizik ikki-qurilma LAN QA: **PARTIAL — MANUAL REQUIRED** (o‘zgartirilmagan)

Protokol: **v6** · Sana: 2026-09-21 · Git: yo‘q (repo emas)

---

## 1. Baseline (takeover audit — haqiqiy o‘lchov)

| To‘plam | Natija |
|---|---|
| `npm test` (P12 dan oldin) | **270 / 270 PASS** |
| Phase 2 | 42/42 |
| Phase 3 | 25/25 |
| Phase 4 | 22/22 |
| Phase 5 | 18/18 |
| Phase 6 | 21/21 |
| Phase 7 | 33/33 |
| Phase 8 | 28/28 |
| Phase 9 | 34/34 |

Audit: `server/` (app, session, lobby, chat, match, metrics, net), `shared/` (protocol-consts,
combat, weapons, movement, health, hitdetect, grenade, respawn), `client/` (main, game/*),
`test/unit/*`, `tools/verify-phase*.mjs`, `logs/phase8–11-*`.
`TODO/FIXME/TEMP/HACK/XXX` — **0** (manba toza).

## 2. Topilgan va tuzatilgan hardening nuqtalari

1. **Takroriy HELLO → “arvoh” lobby a’zosi (real bug).**
   `server/app.js` HELLO ishlovchisi yangi a’zo obyektini yaratardi, lekin **eski** a’zo
   `lobby.session.players` ichida qolib ketardi: lobby ro‘yxati eski `playerId` ni ko‘rsatib,
   ulanishning haqiqiy kimligi boshqa bo‘lib qolardi (host ham eski ID da qolib, o‘yinni
   boshlay olmasdi). Probe bilan tasdiqlandi: `create → ["p1"]`, repeated HELLO → hali ham `["p1"]`,
   lekin ulanish kimligi `p2` edi. **Endi** takroriy HELLO eski a’zolikni **lobby + match**dan
   tozalaydi (chat ham sessiya yopilsa). Yana: `["..."]` arvoh yo‘q.

2. **WebSocket payload chegarasi yo‘q edi.** `ws` kutubxonasi standart **100 MiB** gacha bufer
   yig‘ardi; ilova darajasidagi 16 KiB `too_big` tekshiruvi faqat **xotiraga to‘liq olingandan
   keyin** ishlardi. Endi `SERVER_DEFAULTS.WS_MAX_PAYLOAD_BYTES = 64 KiB` protokol darajasida
   qo‘llanadi → undan katta xabar **xotiraga olinmasdan** rad etiladi (kod **1009**). 16 KiB
   `too_big` javob semantikasi **o‘zgarmagan** (mavjud verifikatsiya buzilmadi).

3. **INPUT da kimlik da’vosi.** `server/session.js` `FORBIDDEN_FIELDS` endi
   `playerId / id / name / senderId / hostId / owner` ni ham qamrab oladi — klient INPUT orqali
   o‘zini “p999/host” deb e’lon qila olmaydi (lobby/chat bilan bir xil qatlamli himoya).

4. **UI release tozalash.** `client/index.html` da eskirgan `Phase 10+` placeholder yorliqlari
   `TEZ KUNDA` ga o‘zgartirildi (test pin qilmagan yagona matn). `__neon.version = 4` /
   `phase4-combat` ataylab **saqlandi** (ko‘plab verified harness shuni pin qiladi).

**Fayllar:** `shared/protocol-consts.js`, `server/app.js`, `server/session.js`,
`client/index.html`, `package.json` (o‘zgardi) · `test/unit/final-hardening.test.js`,
`tools/verify-phase12.mjs`, `tools/lib/authority-scan.mjs` (yangi).
**Bog‘liqliklar:** o‘zgarmagan (faqat mavjud `ws`).

## 3. Statik avtoritet skanerı (yangi: `tools/lib/authority-scan.mjs`)

- 15 manba fayl skanerlandi → **0 topilma** (klient→avtoritet yo‘li yo‘q).
- Plantatsiya (`state.health.hp = msg.hp`) → **darhol ushlanadi** (read + write, 2 topilma).
- Kelgusi-faza terminlari (`spectator/replay/voip/ranking/matchmaking/...`) protokol va
  `__neon` yuzasida → **0**.

## 4. Runtime avtoritet dalillari (haqiqiy server + xom WS)

| Tekshiruv | Natija |
|---|---|
| Forged INPUT maydonlari (damage/hp/ammo/cooldown/position/teamId/score/round/winner/playerId/hostId, 29 ta) | **29/29 rad** (`forbidden_authority`), HP/alive/lastSeq **o‘zgarmadi**, ball o‘zgarmadi |
| NaN / Infinity / -Infinity (pose/aim/move) | **6/6 rad**, holatga kirmadi |
| Buzilgan trafik `bad_json` / `bad_msg` / `unknown_type` / `too_big` | barchasi rad, server TIRIK, tick davom etdi, `tickErrors=0` |
| Payload > 64 KiB | **1009** bilan yopildi; yangi mijoz KEYIN xizmat oldi |
| Takroriy HELLO | sessiya ko‘paymadi, **arvoh a’zo yo‘q** |
| Dublikat JOIN | idempotent (a’zo soni o‘zgarmadi) |
| Chat: forged kimlik / uzun / bo‘sh / flood | `forbidden_authority` / `chat_too_long` / `chat_empty` / `rate_limited=6` |

## 5. Real Chrome / CDP dalili

- **2 mustaqil Chrome JARAYONI** (alohida CDP port 9396/9397, alohida profil/pid, alohida WS).
- GPU: **ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P))** — SwiftShader **EMAS**, headless **EMAS**.
- Ikki brauzer bir sessiyada: server `p1`, `p2` ni ko‘radi; host start → **in_game → LIVE**;
  jamoalar server tayinlagan (A=[p1], B=[p2]).
- HUD **avtoritar holatdan** (`source=server`): HP=100, mag=30, jamoa=A.
- **Real chat A→server→B**: matn yetib bordi, yuboruvchi `playerId` **serverdan** (p1).
- B soketi uzilganda server o‘yinchini o‘chirdi va A da remote **1 → 0** (ghost yo‘q); qayta
  ulanish **yangi** identitet oldi.
- UI regression: crosshair ikki viewportda **markazda (dx=dy=0)**; global `[hidden]{display:none}`
  qoidasi tirik (P4 dagi `.pause`/`display:flex` regressiyasiga qarshi).
- Brauzer istisnosi **0**, `__neonErrors` **0**, server uncaught **0**, `tickErrors` **0**.

## 6. Unumdorlik (P10 ga nisbatan)

- Server tick: `loopMs = 0.41 ms` / byudjet **33.33 ms** (≈1.2%) — regress yo‘q.
- Klient FPS: **~98.8** (yuqori host yuki ~17 ostida).

## 7. To‘liq regressiya (birma-bir, bitta mashinada)

| Buyruq | Natija |
|---|---|
| `npm test` | **287 / 287 PASS** (270 + 17 yangi) |
| `node tools/verify-phase2.mjs` | **42 / 42 PASS** ¹ |
| `node tools/verify-phase3.mjs` | **25 / 25 PASS** |
| `node tools/verify-phase4.mjs` | **22 PASS / 0 FAIL** |
| `node tools/verify-phase5.mjs` | **18 PASS / 0 FAIL** |
| `node tools/verify-phase6.mjs` | **21 PASS / 0 FAIL** |
| `node tools/verify-phase7.mjs` | **33 PASS / 0 FAIL** |
| `node tools/verify-phase8.mjs` | **28 PASS / 0 FAIL** |
| `node tools/verify-phase9.mjs` | **34 PASS / 0 FAIL** |
| `node tools/verify-phase10.mjs` | **21 PASS / 0 FAIL** (5 daqiqalik haqiqiy yuk) |
| `node tools/verify-phase11.mjs` | **13 PASS / 0 FAIL** avtomatik · **11 MANUAL REQUIRED** · **STATUS: PARTIAL** |
| `node tools/verify-phase12.mjs` | **24 PASS / 0 FAIL** |

¹ `verify-phase2.mjs` **tashqi serverni** (`localhost:3000`) talab qiladi — bu harnessning
mavjud xatti-harakati; **o‘zgartirilmadi**, regression paytida server bir vaqtda ishga tushirildi.
Dastlabki ikki urinishda sahifa tayyor bo‘lmagani (yuk ~15) vaqtinchalik edi — server bilan
qayta yugurtirilganda 42/42.

## 8. Cheklovlar (halol)

- **P11 fizik ikki-qurilma LAN QA HALI BAJARILMAGAN** → PARTIAL / MANUAL REQUIRED. P12 COMPLETE
  bo‘lishi P11 ni PASS qilmaydi. Skaner buni o‘qib tasdiqlaydi (P12.5).
- `P12.19` raund idempotentligi **haqiqiy `server/match.js`** orqali tekshirildi; P8 to‘liq qayta
  yugurtirilmadi (P8 alohida regressiya: 28/0).
- Unumdorlik yuqori host yuki ostida o‘lchandi (baribir byudjet ichida).

## 9. P13+ chegara

`P13+` (yoki P11/P12 dan keyingi) hech qanday tizim qo‘shilmagan: statik skaner protokol va
`__neon` yuzasida taqiqlangan terminlarni **topmadi**. Deploy/cloud/account/matchmaking/
spectator/replay/voice — **YO‘Q**.
