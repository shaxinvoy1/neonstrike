# NEON STRIKE — PHASE 7 hisoboti
## KO'P O'YINCHILI SINXRONIZATSIYA (Multiplayer Synchronization)

**Sana:** 2026-09-19
**Holat:** **TAYYOR (COMPLETE)** — real brauzer, real GPU, ikki mustaqil klient, 33/33 darvoza PASS
**Mashina:** `0.0.0.0:3000` · LAN IPv4 `10.201.177.74` · GPU: `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6)` (SwiftShader EMAS)

---

## 1. Boshlang'ich holat (takeover baseline)

Git repozitoriysi **YO'Q** (o'zgarmagan). PHASE 6 dan keyingi tasdiqlangan baseline:

| To'plam | Natija |
|---|---|
| `npm test` | **157 / 157 PASS** |
| `node tools/verify-phase2.mjs` | 42 / 42 PASS |
| `node tools/verify-phase3.mjs` | 25 / 25 PASS |
| `node tools/verify-phase4.mjs` | 22 / 22 PASS |
| `node tools/verify-phase5.mjs` | 18 / 18 PASS |
| `node tools/verify-phase6.mjs` | 21 / 21 PASS |

PHASE 6 holati: `server/lobby.js` (sessiya/host/sig'im), avtoritar lobby protokoli v3,
ikki mustaqil brauzer klienti, join/leave/disconnect tozalash, LAN manzil ko'rsatish.
**Phase 7 dan oldin server HARAKATNI boshqarmasdi** — klient `pose` (x,y,z) yuborardi
va server uni VALIDATSIYADAN o'tkazib o'z holatiga yozardi (Phase 5 yo'li). Faqat
combat (cooldown/o'q-dori/reload/hit/zarar/HP/o'lim/granata) avtoritar edi.

---

## 2. Takeover auditi (nima bor / nima yo'q)

**Tekshirilgan fayllar:** `package.json`; `shared/{protocol-consts,combat,weapons,health,hitdetect,respawn,grenade,collision,map}.js`;
`server/{index,app,logger,session,lobby}.js`; `client/js/main.js`; `client/index.html`;
`client/css/hud.css`; `client/js/game/{index,input,movement,camera-controller,player,combat,hud,targets,effects,training,weapon-view,debug-overlay}.js`;
`tools/verify-phase{2,3,4,5,6}.mjs`; `tools/lib/shot-helpers.js`; `test/unit/*.test.js`;
`logs/*-report.{md,json}`.

**Muhim topilma (audit):** `client/js/game/movement.js` deyarli SOF edi — u faqat
`shared/collision.js` + `shared/map.js` ni import qilardi (three.js/DOM YO'Q). Shu sababli
server uchun HARAKAT MANTIG'INI QAYTA YOZISH SHART EMAS edi: mavjud kod ajratib olinib
BITTA manbadan (klient + server) ishlatildi. Bu Phase 3 xatti-harakatini saqlab qoladi.

---

## 3. Protokol o'zgarishlari (additiv — Phase 1–6 buzilmagan)

`shared/protocol-consts.js`:

| O'zgarish | Tafsilot |
|---|---|
| `PROTOCOL_VERSION` | `3 → 4` |
| `MSG.SNAPSHOT` (**yangi**) | `'snapshot'` — server→klient avtoritar sinxronizatsiya (20 Hz) |
| `MSG.INPUT` (kengaytirildi) | ixtiyoriy `move:{forward,right,sprint}` maydoni (FAQAT niyat) |
| `SIM.MAX_SNAPSHOT_PLAYERS` | 8 (sig'im bilan mos) |
| `SIM.INTERP_DELAY_MS` | 100 (klient interpolatsiya buferi) |

Phase 1 (`hello/ping/gpu/welcome/pong/error`), Phase 5 (`input/reset/session/state/events/input-ack`),
Phase 6 (`create-session/join-session/leave-session/start-session/lobby-state`) turlari
**o'zgarishsiz**. Eski verifikatsiya skriptlari o'zgartirilmagan.

---

## 4. Server arxitekturasi

### 4.1 Simulyatsiya tick'i (30 Hz)
Mavjud yagona tick ishlatiladi (`server/app.js → tickAll`, `setInterval(SIM.TICK_MS)`) — Yangi
raqobatdosh loop YARATILMAGAN. Har bir tick: kiritmalarni iste'mol → avtoritar harakat
simulyatsiyasi → `stepCombat` (Phase 5) → holat yangilash → 20 Hz snapshot tarqatish.

### 4.2 Avtoritativ harakat
* Har bir sessiyada `movement` holati bor: `shared/movement.js → createMovementState()`.
  `movement.pos` — `state.position` BILAN **AYNAN bir obyekt** (yagona haqiqat): LOS/hit
  va harakat bir xil pozitsiyani o'qiydi.
* `setAuthoritativeMovement(session, true)` — FAQAT server qarori bilan (`in_game`).
* `in_game` da `applyInput` klient `pose.x/y/z` ni **pozitsiya sifatida QABUL QILMAYDI**;
  faqat `move` niyati navbatga qo'yiladi. `stepSession` har tick `stepMovement()` ni
  chaqiradi (klient bilan bir xil qoidalar → bashorat xatosi kichik).
* `standalone` (lobby yo'q / Phase 4–6 yo'li) da Phase 5 xatti-harakati **aynan** saqlanadi
  (validatsiyadan o'tgan poza pozitsiya bo'ladi) — eski verifikatsiya buzilmaydi.

### 4.3 Input ketma-ketligi (seq/ack)
* Klient har kadrda `seq` ni oshiradi (`game.netSeq`); server `lastSeq` bilan
  takroriy/eski/NaN ketma-ketlikni rad etadi (`duplicate_seq` / `stale_seq` / `bad_seq`).
* Tasdiqlangan `lastSeq` **`ackSeq`** sifatida STATE va SNAPSHOT da qaytariladi.

### 4.4 Snapshot (20 Hz)
`{type:'snapshot', serverTick, ackSeq, serverTime, count, players:[{id,sessionId,x,y,z,vx,vz,speed,yaw,pitch,faceYaw,airborne,alive,hp}]}`
* O'yinchilar ro'yxati tick'da **bir marta** quriladi (qayta ishlatiladigan obyektlar —
  hot path'da allocatsiya yo'q); har bir sessiya o'z `ackSeq` ini oladi.
* Faqat `authoritativeMovement` sessiyalarga yuboriladi (in_game bo'lmasa — NO-OP).
* Oq-dori/cooldown kabi o'yin natijalari sinxronizatsiya paketiga **chiqmaydi**.

### 4.5 Mavjud sinxronizatsiya telemetriyasi
`server.telemetry().sync = {mode, authoritativeSessions, frames, players, snapshotHz, lastTickAt}`.

---

## 5. Klient arxitekturasi

### 5.1 `client/js/game/sync-math.js` (**yangi, SOF**)
three.js/DOM yo'q — Node'da test qilinadi:
* `sampleBuffer(buffer, renderT)` — ikki snapshot orasida chiziqli interpolatsiya +
  yaw uchun eng qisqa yo'l (`angleLerp`); `interpolated` / `extrapolated` bayroqlari.
* `computeReconcile(pending, ackSeq, server, threshold)` — bashorat xatosini hisoblaydi,
  `snap` (xato > 0.6 m) yoki `smooth` qarorini beradi. **Server holati USTUN.**
* `applyCorrection(movement, correction, rate)` — `snap`: pozitsiya serverdan olinadi va
  tezlik nollanadi; `smooth`: server tomon yumshoq tortish (12 %).

### 5.2 `client/js/game/multiplayer.js` (**yangi**)
* `RemotePlayer` — `player.js` dagi mavjud humanoid model + blob shadow (yangi geometriya
  YO'Q), snapshot buferi (24), interpolatsiya, `alive` bo'lmaganda mesh yashiriladi.
* `MultiplayerSync` — `onSnapshot()`: masofaviylar FAQAT server ro'yxatidan yaratiladi va
  server ro'yxatida yo'q bo'lganlari **dispose** qilinadi (stale remote yo'q);
  `recordLocalInput()` / `applyTo()` — lokal rekonsiliatsiya; `qa()` — verifikatsiya uchun.
* Interpolatsiya kechikishi: `SIM.INTERP_DELAY_MS` (100 ms) — render `now − 100 ms` da.

### 5.3 Integratsiya
* `game/index.js`: har kadrda `move` niyati yuboriladi; `multiplayer.update()` masofaviylarni
  interpolatsiya qiladi; `multiplayer.applyTo(movement)` tuzatishni qo'llaydi; `onLobbyState()`
  faqat `in_game` da sinxronizatsiyani yoqadi (qaror SERVERDA).
* `main.js`: `MSG.SNAPSHOT` → `state.snapshot` + `game.onSnapshot()`; `__neon.multiplayerQa()`
  va `__neon.serverSnapshots()` QA API (mock EMAS — haqiqiy ishlab chiqarish holati).

---

## 6. Real topshilgan va tuzatilgan defektlar (Phase 7)

1. **UI join-in-progress'ni bloklardi (haqiqiy integratsiya bo'shlig'i).**
   `renderLobby()` `btnJoin` ni `state === 'in_game'` bo'lganda o'chirardi (Phase 6 qoidasi),
   garchi server Phase 7 da in_game join'ni qabul qilsa ham. Shu sababli brauzerdan
   join-in-progress **umuman ishlamasdi** (D diagnostikasi: `C join klik = false`,
   `C.inSession = false`). Tuzatildi: `btnJoin` endi faqat sessiya yo'q bo'lsa yoki
   allaqachon a'zo bo'lsa o'chiriladi.
2. **Server foydalanmayotgan pozani tekshirardi.** `in_game` (avtoritativ harakat) rejimida
   server hali `pose` chegarasi/kolliziyasini tekshirardi — holbuki pozitsiya ishlatilmaydi.
   Endi `in_game` da faqat cheklilik (`Number.isFinite`) majburiy; `standalone` da
   chegara + `headroomClear` tekshiruvi **aynan** saqlanadi.
3. **`MOVEMENT` mantig'ining ikki nusxasi xavfi.** Server uchun alohida harakat kodi
   yozilmadi — mavjud Phase 3 yadrosi `shared/movement.js` ga ajratildi (klient + server
   bitta manba). Phase 3 = 25/25 buni tasdiqlaydi.

---

## 7. O'zgartirilgan/qo'shilgan fayllar

**Yangi:** `shared/movement.js`, `client/js/game/sync-math.js`, `client/js/game/multiplayer.js`,
`test/unit/multiplayer.test.js`, `tools/verify-phase7.mjs`, `logs/phase7-report.json`, `logs/phase7-report.md`

**O'zgartirilgan:** `shared/protocol-consts.js`, `server/session.js`, `server/app.js`,
`server/lobby.js`, `client/js/game/movement.js` (delegatsiya), `client/js/game/index.js`,
`client/js/main.js`, `test/unit/lobby.test.js`, `test/unit/smoke.test.js`,
`test/unit/combat.test.js`, `package.json`

**O'zgartirilmagan:** `tools/verify-phase{2,3,4,5,6}.mjs`, `tools/lib/shot-helpers.js`,
`shared/{combat,weapons,health,hitdetect,respawn,grenade,collision,map}.js`,
`client/js/game/{input,player,camera-controller,combat,hud,targets,effects,training,weapon-view}.js`

### Test o'zgarishlari (yashirish EMAS — faza evolyutsiyasi)
* `lobby.test.js`: "in_game da qo'shilish YOPIQ" → **"join-in-progress OCHIQ + sig'im qat'iy"**
  (kuchaytirilgan: sig'im/dublikat/telemetriya qo'shildi).
* `smoke.test.js` / `combat.test.js`: chegara testlari Phase 6 → **Phase 7 ruxsat etildi,
  Phase 8+ taqiqlangan** (team/round/score/chat hali ham YO'Q).
* `multiplayer.test.js` — **yangi, 29 test**.
* Hech bir mavjud test o'chirilmagan yoki zaiflashtirilmagan.

---

## 8. Testlar (haqiqiy natijalar)

| To'plam | Natija |
|---|---|
| `npm test` | **186 / 186 PASS** (157 baseline + 29 yangi Phase 7) |
| `node tools/verify-phase2.mjs` | **42 / 42 PASS** |
| `node tools/verify-phase3.mjs` | **25 / 25 PASS** |
| `node tools/verify-phase4.mjs` | **22 / 22 PASS** |
| `node tools/verify-phase5.mjs` | **18 / 18 PASS** |
| `node tools/verify-phase6.mjs` | **21 / 21 PASS** |
| `node tools/verify-phase7.mjs` | **33 PASS / 0 FAIL** (yakuniy `logs/phase7-report.json`) |

`test/unit/multiplayer.test.js` qamrovi (29 test): avtoritativ harakat (poza e'tiborsizligi,
devor kolliziyasi, sprint, determinizm) · `move` validatsiyasi (NaN/Infinity/tur) ·
seq/ack (takroriy/eski/NaN) · avtoritet chegaralari (position/velocity/tick/hp/damage) ·
`playerSyncState` qurilishi (allocatsiya yo'q) · `movement.pos === state.position` ·
reset tiklash · interpolatsiya (chiziqli, yaw eng qisqa yo'l, bufer chegaralari,
extrapolyatsiya YO'Q) · rekonsiliatsiya (smooth/snap, server ustunligi) ·
xom WebSocket oqimi: ikki klient sinxronizatsiyasi, disconnect, join-in-progress,
soxta xabarlar, combat avtoriteti, snapshot kadansi · Phase 8+ chegarasi.

---

## 9. Ikki klientli brauzer dalillari (P7.1–P7.29 + qo'shimcha darvozalar)

**Usul:** bitta Chrome jarayoni, **ikki mustaqil page target** (alohida WebSocket, alohida
`window.__neon`, alohida o'yin tsikli) + uchinchi sahifa (join-in-progress) + xom WS klientlar.
Bitta sahifada "ikkinchi klient" SIMULYATSIYA QILINMAGAN. Quyidagi raqamlar yakuniy
`logs/phase7-report.json` dan olingan (spetsifikatsiya raqamlanishi P7.1–P7.29; `3b/7b/11b/21b/23b`
— qo'shimcha dalil darvozalari, jami **33**).

| Darvoza | Natija | Dalil (qisqartirilgan) |
|---|---|---|
| P7.1 | PASS | tickHz=30, snapshotHz=20, protocol=v4, ulanish=2 |
| P7.2 | PASS | unit to'plam: tests=186 pass=186 fail=0 |
| P7.3 | PASS | A ws=true · B ws=true · real Intel GPU |
| P7.3b | PASS | render tsikli bir vaqtda: A +120 kadr, B +64 kadr |
| P7.4 | PASS | A=p2, B=p1 (server bergan, ikki xil) |
| P7.5 | PASS | sessiya=1, a'zolar=[p2,p1] |
| P7.6 | PASS | host REAL DOM klik → `state=in_game` |
| P7.7 | PASS | ikki sessiyada `authoritativeMovement=true` (A.sess=2, B.sess=1) |
| P7.7b | PASS | ikkala klientda o'yin tsikli ishga tushdi |
| P7.8 | PASS | A real `W` klaviatura; yuborilgan seq=238 |
| P7.9 | PASS | server qabul=252, rad=0, harakat ticklari=108 |
| P7.10 | PASS | **A siljish=3.20 m (server simulyatsiyasi), B siljish=0.000 m** |
| P7.11b | PASS | B ko'rgan A = server qiymati (farq 0.00 m) |
| P7.12 | PASS | B masofaviy A ni RENDER qildi (visible=true, buffer=24) |
| P7.13 | PASS | B real `D` klaviatura; qabul=418 |
| P7.14 | PASS | A B ning avtoritar holatini oldi (B siljish=8.83 m, farq 0.78 m) |
| P7.15 | PASS | A masofaviy B ni RENDER qildi (visible=true) |
| P7.16 | PASS | snapshot `serverTick=445` / `375`; server.tick=457 |
| P7.17 | PASS | A `ackSeq=484` (snapshot ham 445) |
| P7.18 | PASS | ackSeq 484 → 544 (monotonik) |
| P7.19 | PASS | `[forbidden_authority×3, bad_move]` · qabul qilingan buyruq=0 · pozitsiya (-19.50, 0.00) ≠ (-13,-11) |
| P7.20 | PASS | `[bad_json, unknown_type×2, too_big]` · tickErrors=0 · tick 645→657 |
| P7.23 | PASS | C (p5) in_game da qo'shildi → snapshot playerlar=3, ids=[p1,p2,p5] |
| P7.24 | PASS | A remoteIds=[p1,p5] — o'zi YO'Q, dublikat YO'Q, uzunlik = avtoritativ−1 (3−1) |
| P7.21b | PASS | C uzildi → A oldin ko'rgan (true) → endi remoteIds=[p1] |
| P7.23b | PASS | xom klient D in_game da joriy holatni oldi ([p1,p2,p6]) |
| P7.21 | PASS | D uzildi → E: [p1,p2,p6,p7] → [p1,p2,p7] |
| P7.22 | PASS | F qo'shildi (E ko'rdi) → F uzildi (E dan olib tashlandi) |
| P7.25 | PASS | interpolatsiya namunalari: A=1233, B=833 (kechikish 100 ms) |
| P7.26 | PASS | rekonsiliatsiya: A 206 namuna / 206 tuzatish, maks xato 0.089 m; B 206/206, 0.168 m |
| P7.27 | PASS | real sichqoncha: otish 0→5 qabul, server mag 30→25 |
| P7.28 | PASS | snapshot maydonlari=[airborne,alive,faceYaw,hp,id,pitch,sessionId,speed,vx,vz,x,y,yaw,z] — team/round/score/chat YO'Q |
| P7.29 | PASS | CDP istisno=0 · console.error=0 · `__neonErrors`=0 · loop xatosi=0 · server tickErrors=0 |

**Skrinshotlar:** `logs/p7-12-remote-A-in-B.png` (B da masofaviy A),
`logs/p7-15-remote-B-in-A.png` (A da masofaviy B), `logs/p7-23b-remote-C-in-A.png`
(A da join-in-progress klient C). Skrinshot yolg'iz dalil EMAS — yuqoridagi har bir darvoza
server XOTIRASI + klient holatidan tekshiriladi.

**Server tomonidagi dalillar:** harness serverni o'zi ishga tushiradi va `server.state.sessions`
ni to'g'ridan-to'g'ri o'qiydi: `authoritativeMovement:[true,true]`, `serverTick=749`,
`positions A=(-16.3, 0)`, `B=(-19.5, -8.84)`, `sync.mode=authoritative`,
`totals={inputs:2379, accepted:2372, rejected:7}`, `snapshots=549`, `tickErrors=0`,
`lobby.hostId=p2`, `addresses=["http://10.201.177.74:46675"]` (LAN interfeysi, hard-code EMAS).

---

## 10. Ishlash (performance)

| Ko'rsatkich | Qiymat |
|---|---|
| Server tick davomiyligi (`loopMs`) | **0.39 ms** (byudjet 33.3 ms) |
| Tick / snapshot xatolari | tickErrors **0** |
| Snapshot kadansi | 20 Hz (243–244 kadr, 2 o'yinchi; jami 549 snapshot) |
| Input oqimi | 2379 yuborilgan · 2372 qabul · 7 rad (noto'g'ri/soxta) |
| Render tsikli (fon tab'da ham) | A +120 kadr / B +64 kadr @ ~1.2 s |
| Klient loop xatolari / istisnolar | 0 |
| Phase 3 regressiya | 100 FPS o'rt · CPU 0.9 ms · 157 draw call · 22 550 tri · shadow O'CHIQ |

Phase 3 ko'rsatkichlari **o'zgarmagan** (harakat yadrosi ko'chirilgandan keyin ham).
Yangi bog'liqlik qo'shilmagan; CSP/asset budjeti o'zgarmagan.

---

## 11. Cheklovlar (halol ro'yxat)

1. **`snap` tarmog'i ishlamadi (faqat `smooth`).** Lokal tarmoqda bashorat xatosi
   katta bo'lmadi (maks 0.217 m < 0.6 m chegarasi), shu sababli faqat yumshoq tuzatish
   yo'li ishlatildi. Rekonsiliatsiya YO'LI haqiqiy ma'lumot bilan ishlagan
   (209/208 namuna, 208/207 tuzatish qo'llandi), `snap` shoxobchasi esa birlik testida
   tekshirilgan (`multiplayer.test.js`) — brauzerda induksiyalangan kechikish bilan
   sinovdan O'TKAZILMAGAN.
2. **Masofaviy o'yinchi o'limi brauzerda TEKSHIRILMAGAN (NOT VERIFIED).** `alive=false`
   bo'lganda mesh yashirilishi kodda bor va `alive` snapshotda uzatiladi, lekin Phase 4/5
   qoidalarida o'yinchi faqat O'Z granatasi bilan zarar oladi — shu sababli brauzer
   darvozasi uchun masofaviy o'yinchini o'ldirish talab qilinadi. Birlik darajasida
   uzatiladi, brauzerda ataylab sinovdan o'tkazilmadi.
3. **Ikki qurilmali LAN sinovi YO'Q.** Ikkala klient ham SHU mashinada (localhost + LAN
   interfeysi). Haqiqiy ikkinchi qurilma sinovi Phase 11 (Real LAN QA) ishi — buni Phase 7
   deb da'vo qilmayman.
4. **Lokal HUD hali Phase 4 combat holatidan oziqlanadi.** Server HP/o'q-dori AVTORITAR
   (server xotirasi + wire bilan tasdiqlangan), ammo lokal HUD ni server holatiga to'liq
   bog'lash HUD/polish ishi (Phase 9). Bu Phase 7 sinxronizatsiya qatlamiga ta'sir qilmaydi.
5. **Harnesslar yakka tartibda ishga tushirilishi kerak.** Mashina yuklamasi yuqori bo'lganda
   (load average ~13.5) vaqtga sezgir darvozalar beqaror bo'ldi: fazalarni ketma-ket
   zanjirlab ishga tushirganda Phase 4 bir marta 19/22 va Phase 5 17/18 berdi; HAR BIRINI
   YAKKA ishga tushirganda 22/22 va 18/18 PASS. Bu Phase 7 o'zgarishlariga bog'liq emas
   (Phase 3/4/5/6 harnesslari o'zgartirilmagan va yakka holda to'liq PASS).
6. **`npm start` talab qilinadigan Phase 2 harnessi** o'zi server ko'tarmaydi (mavjud
   xatti-harakat) — Phase 2 ni ishga tushirishdan oldin server qo'lda ko'tarildi.

---

## 12. Phase 8+ chegarasi (TASDIQ)

Phase 8+ **AMALGA OSHIRILMAGAN**. Chegara testlari va P7.28 tasdiqlaydi:
* Protokolda team/round/score/chat/voice/rank/matchmaking xabar turlari **YO'Q**.
* Snapshot o'yinchi maydonlarida team/score/round maydonlari **YO'Q**.
* Lobby a'zo modelida team/score **YO'Q**.
* `server/session.js`, `client/js/game/multiplayer.js`, `client/js/game/sync-math.js`
  da Phase 8+ terminlari **YO'Q** (birlik testi).
* Server hech qachon interpolatsiya/rekonsiliatsiya qilmaydi (u avtoritet) — birlik testi
  bilan tasdiqlangan (`sampleBuffer|computeReconcile|applyCorrection` server kodida YO'Q).
* Interpolatsiya/rekonsiliatsiya protokol turi sifatida qo'shilmagan (ular klient ichida).

Phase 5 combat avtoriteti **saqlangan** (P7.27 + `server-authority.test.js` + Phase 5 = 18/18).

---

## 13. Xulosa

Phase 7 server avtoritar zanjirni buzmasdan ko'p o'yinchili sinxronizatsiyani o'rnatdi:
klient **intent** yuboradi → server **harakatni o'zi simulyatsiya qiladi** → **20 Hz SNAPSHOT**
→ klient masofaviylarni **interpolatsiya** qiladi va lokal bashoratni **rekonsiliatsiya**
qiladi (server holati ustun). Ikki mustaqil klient, join-in-progress, disconnect tozalash,
soxta kiritma rad etilishi va Phase 1–6 regressiyalari real brauzer + real GPU + server
xotirasi bilan tasdiqlangan.
