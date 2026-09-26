# NEON STRIKE — PHASE 6: LAN LOBBY — TAKEOVER REPORT

**Sana:** 2026-09-19
**Loyiha:** `/home/paulinaj/neon-strike`
**Faza:** PHASE 6 — LAN LOBBY
**Holat:** **COMPLETE** (Phase 7+ TEGILMADI)

---

## 1. TAKEOVER BASELINE (o'zgarishdan OLDIN)

| Tekshiruv | Natija |
|---|---|
| Git repozitoriysi | **YO'Q** (`git status` → "not a git repository") |
| `npm test` | **130 / 130 PASS** |
| Phase 2 | 42 / 42 PASS |
| Phase 3 | 25 / 25 PASS |
| Phase 4 | 22 PASS / 0 FAIL |
| Phase 5 | 18 PASS / 0 FAIL |

Phase 5 dan meros (tekshirildi, qayta yozilmadi):

- `server/session.js` — avtoritar combat sessiyasi (har ulanish uchun), **lobby
  tushunchasi YO'Q edi**.
- `server/app.js` — Phase 1 static/echo + Phase 5 avtoritar sim + 30 Hz tick.
  Ulanish hayot sikli: `hello → welcome + session + state`, uzilishda combat
  sessiyasi o'chiriladi. **A'zolik/host/sig'im YO'Q edi.**
- `shared/protocol-consts.js` — `PROTOCOL_VERSION = 2`, 12 ta xabar turi. Lobby
  turlari YO'Q. `SERVER_DEFAULTS` da `MAX_PLAYERS` YO'Q.
- `client/index.html` — **"HOST GAME / JOIN GAME" tugmalari `disabled` va
  Phase 6 deb belgilangan** ("keyingi fazada yoqiladi"), lobby paneli YO'Q.
- `client/js/main.js` — WS hayot sikli Phase 1/5 uchun tirik; lobby UI/API YO'Q.
- `test/unit/combat.test.js` ichida **chegara testlari Phase 6 lobby ni
  TAQIQLAGAN** edi (`MSG` kalitlarida `lobby` bo'lmasligi shart; `server/app.js`
  da `lobby` termini bo'lmasligi shart).

**Xulosa:** Phase 5 avtoritativ poydevor tayyor edi, lekin sessiya a'zoligi,
host, sig'im va lobby oqimi butunlay yo'q edi.

---

## 2. INSPEKSIYA QILINGAN FAYLLAR

`server/app.js`, `server/session.js`, `server/index.js`, `server/logger.js`,
`shared/protocol-consts.js`, `shared/weapons.js`, `shared/combat.js`,
`client/index.html`, `client/css/hud.css`, `client/js/main.js`,
`client/js/game/{index,combat,input}.js`, `test/unit/*.js`,
`tools/verify-phase{2,3,4,5}.mjs`, `tools/lib/shot-helpers.js`,
`logs/phase5-report.md`.

---

## 3. LOBBY ARXITEKTURASI

```
NETWORK CONNECTION   (Phase 1)   — /ws handshake, ping, latency
        ↓
LAN LOBBY / SESSION  (Phase 6)   — a'zolik, host, sig'im, sessiya holati   ← YANGI
        ↓
GAME SESSION         (Phase 5)   — har o'yinchi uchun avtoritar combat sessiyasi
        ↓
GAMEPLAY AUTHORITY   (Phase 5)   — o'q-dori/cooldown/reload/hit/zarar/HP/o'lim
```

- **Yangi modul: `server/lobby.js`** — SOF qoidalar (three.js/DOM/socket YO'Q).
  Lobby **combat mantig'ini bilmaydi**; combat `shared/combat.js` +
  `server/session.js` da qoladi (chegara testi buni tekshiradi).
- Lobby **bir LAN sessiya** modelini ishlatadi (bitta host server = bitta
  yig'ilish). `lobby-state` har bir ko'ruvchi uchun **alohida** hisoblanadi
  (`you` / `isHost` / `inSession`).
- Bitta kontseptual oqim: `null`/yo'q holat → `lobby` → `in_game`.

---

## 4. PROTOKOL QO'SHIMCHALARI (additiv)

`PROTOCOL_VERSION`: **2 → 3**. Phase 1–5 xabarlari **o'zgarishsiz saqlangan**.

| Yo'nalish | Tur | Maqsad |
|---|---|---|
| k→s | `create-session` | `{name?}` — LAN sessiya yaratish (yaratuvchi HOST bo'ladi) |
| k→s | `join-session` | `{name?, sessionId?}` — mavjud sessiyaga qo'shilish |
| k→s | `leave-session` | `{}` — chiqish |
| k→s | `start-session` | `{}` — FAQAT host: `lobby → in_game` |
| s→k | `lobby-state` | `{sessionId, state, hostId, capacity, count, you, isHost, inSession, players[], addresses[], revision, serverTime}` |

`SERVER_DEFAULTS.MAX_PLAYERS = 8`.

**Rad etish kodlari** (`MSG.ERROR` ichida): `bad_lobby`, `forbidden_authority`,
`lobby_none`, `lobby_exists`, `lobby_full`, `lobby_in_game`, `lobby_not_member`,
`not_host`, `lobby_already_started`, `no_session`.

---

## 5. SESSIYA HAYOT SIKLI

| Amal | Serverda | Natija |
|---|---|---|
| `create-session` | `lobbyCreate()` | yangi sessiya, **host = yaratuvchi**, count 1 |
| `create` (a'zo allaqachon ichida) | idempotent | `ok/already` (dublikat a'zo YO'Q) |
| `create` (boshqa o'yinchi) | `lobby_exists` | rad |
| `join-session` | `lobbyJoin()` | count +1, **host o'zgarmaydi** |
| `join` (sessiya yo'q) | `lobby_none` | rad |
| `join` (dublikat) | idempotent | dublikat qo'shilmaydi |
| `join` (to'la) | `lobby_full` | rad, count o'zgarmaydi |
| `join` (in_game) | `lobby_in_game` | rad |
| `leave-session` | `lobbyLeave()` | a'zo chiqadi; oxirgi bo'lsa sessiya **yopiladi** |
| `start-session` | `lobbyStart()` | **FAQAT host**; `lobby → in_game`, `startedAt` belgilanadi |
| uzilish (socket close) | `lobbyRemove()` | a'zo o'chadi + host o'tkaziladi + broadcast |

**Player identity:** `playerId` ni **server** beradi (Phase 5 combat sessiyasining
`p<sessionId>` qiymati lobby a'zosining id si bo'ladi). Klient `playerId`,
`hostId`, `host`, `isHost`, `owner`, `state`, `status`, `count`, `capacity`,
`maxPlayers`, `players`, `started`, `startedAt`, `revision` yuborsa — butun
buyruq `forbidden_authority` bilan rad etiladi.

---

## 6. HOST XATTI-HARAKATI (deterministik)

- Host — **server tayinlaydi**: sessiya yaratuvchi.
- **Host uzilsa/chiqsa:** qolganlar ichidan `joinedAt` eng erta bo'lgani host
  bo'ladi; teng bo'lsa `playerId` raqami kichigi (asc). Agar o'yinchi qolmasa —
  **sessiya yopiladi** (`hub.session = null`), ya'ni stale holat qolmaydi.
- Har o'zgarish `revision` ni oshiradi va barcha a'zolarga `lobby-state`
  yuboriladi.
- Unit testlar: 3 a'zoli sessiyada host uzilishi (`p1→p2→p3`), teng vaqtda
  `p10/p2/p7 → p2`, oxirgi a'zo chiqsa yopilish.

---

## 7. SIG'IM (CAPACITY)

- `capacity` server sozlamasi (`SERVER_DEFAULTS.MAX_PLAYERS = 8`), 1..32 oralig'iga
  xavfsiz qisqartiriladi (`0 → 1`, `999 → 32`, `NaN → 8`).
- `join` da `players.length >= capacity` bo'lsa → **`lobby_full`** (server count
  oshmaydi).
- Uzilish/chiqish joy bo'shatadi → navbatdagi klient qo'shiladi.
- Testlarda: 2 sig'imli hub, to'ldirish → rad → chiqish → qayta qo'shilish OK;
  brauzer harnessida 8/8 to'ldirib 9-klient `lobby_full` oldi.

---

## 8. UZILISH (DISCONNECT) XATTI-HARAKATI

- Socket `close` → combat sessiyasi (`state.sessions`) **va** lobby a'zoligi
  (`server.state.lobby`) tozalanadi; keyin barcha qolganlarga yangi
  `lobby-state` yuboriladi.
- Phase 3 dagi **takroriy `close` himoyasi saqlandi** (`closeLogged` guard) —
  dublikat tozalash/log yo'q.
- Unit test: host uzilsa host o'tadi, `findMember` `null` (stale yo'q), takroriy
  close dublikat qilmaydi, `lobby-state` qolgan klientga yetadi.

---

## 9. O'ZGARGAN FAYLLAR

**Yangi**
- `server/lobby.js` — sof lobby modeli (sessiya/host/sig'im/validatsiya/snapshot)
- `test/unit/lobby.test.js` — 26 ta Phase 6 testi
- `tools/verify-phase6.mjs` — ikki klientli real-Chrome harness (21 gate)
- `logs/phase6-report.json`, `logs/phase6-report.md` — ushbu hisobot
- `logs/p6-01-in-game.png`, `logs/p6-02-lobby-panel.png` — artefaktlar

**O'zgartirilgan**
- `shared/protocol-consts.js` — lobby turlari + `MAX_PLAYERS` + `PROTOCOL_VERSION = 3`
- `server/app.js` — lobby hub, a'zolik, 4 ta lobby buyrug'i, LAN manzillar,
  `broadcastLobby`, uzilish tozalash, telemetriya (`lobby`, `addresses`)
- `client/index.html` — lobby paneli + HOST/JOIN tugmalari **yoqildi**
- `client/css/hud.css` — lobby uslublari **+ `.menu[hidden]`/`.stage[hidden]` tuzatishi**
- `client/js/main.js` — `lobby-state` qabul, `renderLobby`, tugma simlari,
  QA API (`lobbyState`, `hostLobby`, `joinLobby`, `leaveLobby`, `startLobby`, ...)
- `test/unit/smoke.test.js` — protokol v3 + lobby konstantalari
- `test/unit/combat.test.js` — chegara testlari: Phase 6 lobby **bor**,
  Phase 7+ **yo'q**; yangi `server/lobby.js` chegarasi
- `package.json` — `verify:phase6` + test ro'yxatiga `lobby.test.js`

**TEGILMAGAN:** `shared/combat.js`, `weapons.js`, `health.js`, `hitdetect.js`,
`respawn.js`, `grenade.js`, `map.js`, `collision.js`, `server/session.js`
(mantiq), `client/js/game/*`, `tools/verify-phase{2,3,4,5}.mjs`.

---

## 10. TEST NATIJALARI — ANIQ SONLAR

| Suite | Natija |
|---|---|
| `npm test` | **157 / 157 PASS** (130 baseline + 26 lobby + 1 chegara) |
| `node tools/verify-phase2.mjs` | **42 / 42 PASS** |
| `node tools/verify-phase3.mjs` | **25 / 25 PASS** |
| `node tools/verify-phase4.mjs` | **22 PASS / 0 FAIL** |
| `node tools/verify-phase5.mjs` | **18 PASS / 0 FAIL** |
| `node tools/verify-phase6.mjs` | **21 PASS / 0 FAIL** |

`test/unit/lobby.test.js` qamrovi (26 test, 20 talab + qo'shimchalar):
sessiya yaratish/idempotentlik · host serverda · **player identity da'vosi rad**
(barcha `LOBBY_FORBIDDEN_FIELDS`) · join/valid/invalid/dublikat · **sig'im QAT'IY**
(+ bo'shatish) · sig'im chegaralari · leave/disconnect tozalash · oxirgi a'zo →
sessiya yopilishi · **host uzilishida o'tkazish** · host tanlovi determinizmi ·
ruxsatsiz host amali rad · start (yo'q/allaqachon) · startdan keyin join yopiq ·
snapshot (`you`/`isHost`/`inSession` har ko'ruvchi uchun) · buzilgan xabar
(null/matn/massiv/NaN/kasr/Infinity/sessionId nomuvofiq/taqiqlangan maydon) ·
ism sanitizatsiyasi · **real WebSocket**: 2 mustaqil klient, broadcast,
soxta amallar rad, malformed (`bad_json`/`unknown_type`/`too_big`) server tirik,
HOST start → `in_game`, sig'im to'ldirish/bo'shatish, uzilish + host o'tkazish,
5 parallel klient, telemetriya.

---

## 11. IKKI KLIENTLI BRAUZER DALILI (21/21 PASS)

`node tools/verify-phase6.mjs` — real oyna, real GPU.

- **GPU:** `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6)` — SwiftShader EMAS
- **Ikki klient usuli:** bitta Chrome jarayoni · **ikki mustaqil page target**
  (alohida WS ulanish + alohida `window.__neon`) — bitta sahifada "ikkinchi
  klient" simulyatsiya qilinmadi.
  - `page A` target `DB5544AF…` → playerId **p1**
  - `page B` target `64E6D1CC…` → playerId **p2**

| Gate | Dalil |
|---|---|
| P6.1 | real WebGL2 + real Intel GPU |
| P6.2 | ikkala klient WS ulandi (serverda 2 ulanish, protokol v3) |
| P6.2b | har klientga **server bergan** alohida ID (`p1`, `p2`) |
| P6.3 | real klik `HOST LAN SESSION` → server xotirasida `sessionId=1`, `state=lobby`, count 1 |
| P6.4 | `hostId = p1` (server tayinlagan), A `you=p1 isHost=true` |
| P6.5 | B real klik `JOIN` → serverda 2 a'zo (`p1,p2`) |
| P6.6 | A va B UI ro'yxati ikkala o'yinchini ko'rsatadi (HOST/SIZ belgilari bilan) |
| P6.7 | UI `2 / 8` = server `count=2 capacity=8` |
| P6.8 | 8/8 to'ldirildi → 9-klient `lobby_full` → server count 8 da qoldi |
| P6.8b | uzilish sig'imni bo'shatdi → count 2 |
| P6.9 | guest `START` rad: UI tugma o'chiq **va** server `not_host` qaytardi, holat `lobby` |
| P6.9b | xom klientdan `playerId`/`hostId`/`state` da'vosi → `forbidden_authority` |
| P6.10 | host real klik `START` → `in_game`, `startedAt` serverda |
| P6.11 | `in_game` ikkala klientga yetdi + A'da o'yin sessiyasi boshlandi |
| P6.12 | B sahifasi yopildi → **server** a'zoni o'chirdi (stale yo'q) |
| P6.13 | server tirik: `tickErrors=0`, tick davom etdi |
| P6.14 | A yangilangan lobby oldi: count 1, B ro'yxatdan yo'qoldi, UI `1 / 8` |
| P6.15 | 30 Hz loop: 600 ms da 18 tick, loop 0.02 ms, `tickErrors=0` |
| P6.16 | console=0, window.error=0, exception=0, loop=0, serverTick=0 |
| P6.17 | Phase 1–5 regressiya: P4=v4, P5=v5, P6=v6, protokol v3, NEON FACILITY 44×32, 60 kollayder |
| P6.18 | LAN bind `0.0.0.0` va LAN manzil orqali real ulanish |

**Dalil manbasi:** harness serverni o'zi ishga tushiradi va `server.state.lobby`
ni **to'g'ridan-to'g'ri o'qiydi** — DOM matnidan xulosa chiqarilmaydi. Har bir
gate'da server xotirasi asosiy dalil, UI esa qo'shimcha tasdiq.

---

## 12. HAQIQIY LAN DALILI VA CHEKLOV

- Muhitda **bitta** non-internal IPv4 interfeys bor: `10.201.177.74`.
- Harness `host: '0.0.0.0'`, port `3000` da server ko'tardi va **o'sha LAN
  manzil orqali** (afzallik: standart port band bo'lsa ephemeral portga tushadi)
  HTTP (`/` → NEON STRIKE) **va** WebSocket (`/ws` → `welcome` + `session`)
  ulanishini amalga oshirdi → `lan-interface`.
- Server avtomatik aniqlangan LAN manzilni lobbyda ko'rsatadi
  (`addresses: ["http://10.201.177.74:45993"]`) — hard-code qilingan IP yo'q;
  faqat `os.networkInterfaces()` IPv4 non-internal.

**CHEKLOV (halol):** bu **bitta mashinada** — `0.0.0.0` bind + LAN interfeys
manzili orqali ulanish isbotlandi, lekin **haqiqiy ikkinchi qurilma** (telefon/
boshqa kompyuter) sinovi bu muhitda **o'tkazilmadi**. Shu sababli "real ikki
qurilma LAN QA" deb da'vo qilinmaydi; u **Phase 11** ishi. Ikki mustaqil klient
esa real (ikki page target, ikki WS) tarzda isbotlandi.

---

## 13. TOPILGAN VA TUZATILGAN HAQIQIY XATO (regressiya ildizi)

Lobby paneli qo'shilgach **Phase 4 P4.7/P4.14 buzildi**. Ildiz sabab: `.menu`
uchun `.menu{display:flex}` qoidasi HTML `hidden` atributi beradigan UA
`display:none` ni **yengib ketardi**, ya'ni o'yin ichida menyu ko'rinmasa ham
**joy egallab turardi**. Ilgari `body{overflow:hidden}` buni kesib qolardi.
Sahifaga skroll qo'shilgach skrollbar paydo bo'lib, viewport markazi ~8 px
surilib, crosshair skrinshoti/aniqligi va o'q tegish gate'larini buzgan.

**Tuzatish (kod, cheat emas):**
```css
.menu[hidden],.stage[hidden]{display:none!important}
```
Shundan keyin Phase 4 **22/22** ga qaytdi. (Bu ilgari yashiringan haqiqiy
xatoni ham yopdi: menyu o'yin orqasida render bo'lib turardi.)

---

## 14. REGRESSIYALAR

| Tekshiruv | Natija |
|---|---|
| `npm test` | **157/157** |
| Phase 2 | **42/42** |
| Phase 3 | **25/25** |
| Phase 4 | **22/0** |
| Phase 5 | **18/0** |
| Phase 6 | **21/0** |

`verify-phase2/3/4/5.mjs` **o'zgartirilmadi**. Phase 4 klient markeri
(`version: 4`) va Phase 5 markeri (`serverAuthority.version: 5`) ataylab
saqlanadi; Phase 6 alohida: `window.__neon.lobby = { version: 6, phase:
'phase6-lan-lobby' }`. Shu sababli eski gate'lar buzilmadi.

---

## 15. UNUMDORLIK / BARQARORLIK

- Server 30 Hz loop: `loopMs = 0.0245 ms`, `tickErrors = 0`, 341 tick davomida
  barqaror; sessiya yopilganda interval oqib ketmaydi.
- Klient: lobby `lobby-state` faqat o'zgarishda yuboriladi (davriy spam yo'q);
  har kadrda qo'shimcha ish yo'q.
- Uzilishda listener/sessiya/a'zolik sizib chiqishi yo'q; takroriy `close`
  guard saqlangan.

---

## 16. MA'LUM, BLOKLANMAYDIGAN MASALALAR

1. **Bitta LAN sessiya** modeli (bitta host server = bitta yig'ilish) — Phase 6
   uchun ataylab minimal; room browser ko'p-sessiya — kelajak fazalar.
2. **`sessionId` faqat selуektor**: mavjud sessiya id siga mos kelishi shart,
   aks holda `lobby_none` (klient sesiyani "yaratib" yubora olmaydi).
3. **Avtomatik LAN discovery (UDP broadcast) YO'Q** — spetsifikatsiya ruxsat
   bergan minimal qo'lda manzil oqimi qo'llanildi (lobbyda LAN manzil
   ko'rsatiladi).
4. Klient Phase 4 lokal combatni render/prediktor sifatida saqlaydi — Phase 7
   ishi (prediktsiya/reconciliation/interpolatsiya).
5. `IDLE_TIMEOUT_MS` (Phase 5) hali ishlatilmagan (kelajakdagi hardening).

---

## 17. PHASE 7+ TASDIQLANMAGAN

**Phase 7+ (o'yinchi pozitsiyasini sinxronlash, interpolatsiya, reconciliation,
rollback, lag compensation, snapshot interpolation, network smoothing, teams,
rounds, score, kill feed, chat, voice chat, matchmaking, internet backend,
accounts, ranking, Phase 8–12) HECH NARSASI QILINMADI.**

Testlar bilan tasdiqlangan:
- `protocol-consts` da interp/reconcil/rollback/team/round/score/chat/voice/
  rank/matchmak/room turi **yo'q**.
- `server/app.js` da shu terminlar **yo'q** (chegara testi).
- `server/lobby.js` combat mantig'ini (`resolveShot`/`computeDamage`/`stepCombat`/
  `stepGrenade`/damage) **bilmaydi** (chegara testi).
- Phase 5 avtoriteti tegmagan: P5 gate'lari va unit testlar o'tadi.

Phase 6 **faqat** LAN yig'ilish ko'prigi: a'zolik, host, sig'im, sessiya holati,
connection hayot sikli — Phase 7 xavfsiz iste'mol qilishi uchun.
