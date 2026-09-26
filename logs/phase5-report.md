# NEON STRIKE — PHASE 5: AUTHORITATIVE SERVER — TAKEOVER REPORT

**Sana:** 2026-09-19
**Loyiha:** `/home/paulinaj/neon-strike`
**Faza:** PHASE 5 — AUTHORITATIVE SERVER
**Holat:** **COMPLETE** (Phase 6+ TEGILMADI)

---

## 1. TAKEOVER BASELINE (o'zgarishdan OLDIN)

| Tekshiruv | Natija |
|---|---|
| Git repozitoriysi | **YO'Q** (`git status` → "not a git repository") |
| `npm test` | **104 / 104 PASS** |
| Phase 2 | 42 / 42 PASS (server `localhost:3000` da turishi kerak) |
| Phase 3 | 25 / 25 PASS |
| Phase 4 | 22 PASS / 0 FAIL |

Phase 4 dan meros qolgan holat (tekshirildi, qayta yozilmadi):

- `shared/weapons.js`, `health.js`, `hitdetect.js`, `respawn.js`, `grenade.js`,
  `combat.js` — **to'liq va testlangan**. `combat.js` sarlavhasida aniq yozilgan:
  *"Bu modul PHASE 5 da serverda AYNAN shu ko'rinishda ishlatiladi"*.
- `server/app.js` — **faqat Phase 1**: HTTP static + WebSocket `hello/ping/gpu`
  echo. Combat haqida hech qanday tushuncha yo'q. Avtoritar YO'Q.
- `shared/protocol-consts.js` — faqat 6 ta Phase 1 xabar turi, `PROTOCOL_VERSION = 1`.
- `client/js/game/combat.js` — Phase 4 **lokal** combat controller; sarlavhasida:
  *"Tarmoq YO'Q (Phase 4 lokal) — Phase 5 da shu controller server natijasini
  ko'rsatuvchi adapterga aylanadi."*
- `client/js/game/input.js` — `consumeIntents()` izohi: *"PHASE 5: shu obyekt
  serverga combat request bo'ladi."*
- `client/js/main.js` — WS ulanish Phase 1 regressiyasi uchun tirik, lekin hech
  qanday sessiya/holat tushunchasi yo'q.
- `test/unit/combat.test.js` ichida **2 ta chegara testi** Phase 5 ni
  TAQIQLAGAN edi (`MSG` kalitlari aynan Phase 1 ro'yxati bo'lishi shart;
  `server/app.js` da `damage|combat|weapon` so'zi BO'LMASLIGI shart).

**Xulosa:** Phase 4 combat qoidalari serverga tayyor edi; server tomoni butunlay
yo'q edi. Shu sababli ish **qoidalarni qayta yozmasdan**, faqat server
avtoritetini qurishdan iborat bo'ldi.

---

## 2. ARXITEKTURA O'ZGARISHLARI

```
       OLDIN (Phase 1–4)                     KEYIN (Phase 5)
  ┌───────────────────────┐            ┌───────────────────────┐
  │ klient                │            │ klient                │
  │  input.consumeIntents │            │  input.consumeIntents │
  │  ↓                    │            │  ↓                    │
  │  Lokal combat (shared)│            │  Lokal combat (Phase 4│
  │  = HAQIQAT            │            │  training/prediktor)  │
  └──────────┬────────────┘            │  ↓ MSG.INPUT (intent) │
             │ WS: hello/ping          └──────────┬────────────┘
             ▼                                    │ WS: hello/ping/gpu
  ┌───────────────────────┐            ┌──────────▼────────────┐
  │ server                │            │ server                │
  │  static + echo        │            │  + server/session.js  │
  │  (o'yin holati YO'Q)  │            │  30 Hz AVTORITAR SIM  │
  └───────────────────────┘            │  = HAQIQAT            │
                                       │  → STATE/EVENTS (20 Hz)│
                                       └───────────────────────┘
```

Yangi modul: **`server/session.js`** — server egasidagi sessiya. Combat
qoidalari **shared/combat.js** dan qayta ishlatiladi (`stepCombat`); dublikat
combat mantiq yaratilmadi. Server `now` ni **o'zi** beradi (klient vaqti emas).

---

## 3. SERVER AVTORITET MODELI

**Trust modeli:** klient — *ishonchsiz*. U faqat niyat yuboradi; server qaror qiladi.

| Qaror | Kim | Qanday |
|---|---|---|
| O'q uzish mumkinmi | **SERVER** | `tryFire()` cooldown/reload/draw/o'q-dori/trigger-edge |
| O'q uzish kadansi | **SERVER** | `intervalMs = 60000/rpm`, server tick vaqti |
| O'q-dori | **SERVER** | `mag -= 1`, `reserve`, refill |
| Reload boshlanishi/tugashi | **SERVER** | `startReload()` / `stepLoadout(serverNow)` |
| Qurol almashish + draw | **SERVER** | `switchTo()` + `WEAPON_SWITCH_MS` |
| Nishon yo'nalishi (nur) | **SERVER** | `resolveShot()` (shared, xarita AABB lari) |
| Zarar miqdori | **SERVER** | `computeDamage(weapon, distance, zone)` |
| Nishon/o'yinchi HP | **SERVER** | `applyDamage()` |
| O'lim | **SERVER** | HP ≤ 0 → `alive=false`, `deaths++` |
| Respawn taymeri | **SERVER** | `respawnAt = deathTime + 2500 ms` |
| Granata fizikasi/portlash | **SERVER** | `createGrenade/stepGrenade/explodeGrenade` |
| Spread tasodifiyligi | **SERVER** | `spreadDirections(seed, shotId)` (klient seedi emas) |
| Origin (ko'z nuqtasi) | **SERVER** | `pose.y + PLAYER.EYE` — klient origin yubormaydi |

**"Fake authority"ga qarshi qat'iy qoida:** klient xabarida quyidagi
maydonlardan biri bo'lsa — **butun buyruq rad etiladi** (`forbidden_authority`):

```
damage damageDealt hp health targetHp targetHealth hit hits kill kills
death died alive dead ammo mag magazine reserve cooldown nextFireAt
reloadEndsAt explode explosion score scores
```

Shu bilan klient zarar/HP/o'q-dori/o'limni "tahrirlab" yubora olmaydi.

### 30 Hz simulyatsiya + 20 Hz snapshot

- `SIM.TICK_HZ = 30` (`TICK_MS = 33.333`), `SIM.SNAPSHOT_HZ = 20` (`50 ms`).
- Har tick: barcha sessiyalar uchun `stepSession()`. Hodisa bo'lsa → `MSG.EVENTS`;
  50 ms o'tgan bo'lsa → `MSG.STATE`.
- Loop `unref()` qilingan (testlar jarayonni ushlab qolmaydi).

### Input validatsiyasi (har bir buyruq)

| Tekshiruv | Rad sababi |
|---|---|
| Obyekt emas / massiv | `bad_msg` |
| Klient avtoritar maydoni | `forbidden_authority` |
| `seq` chekli butun son emas | `bad_seq` |
| `seq` takroriy | `duplicate_seq` |
| `seq` eski (replay) | `stale_seq` |
| Poza NaN/Infinity | `bad_pose` |
| Poza xaritadan tashqari | `pose_bounds` |
| Poza kollayder ichida (`headroomClear`) | `pose_blocked` |
| Yo'nalish NaN / nol | `bad_aim` |
| `intents` obyekt emas | `bad_intent` |
| Mavjud bo'lmagan qurol | `bad_weapon` |
| Tick'da haddan ziyod input | `too_many_inputs` |
| Sessiyasiz input | `no_session` |

---

## 4. PROTOKOL O'ZGARISHLARI (additiv)

`PROTOCOL_VERSION`: **1 → 2**. Phase 1–4 xabarlari **o'zgarishsiz saqlangan**
(`hello/ping/gpu/welcome/pong/error`).

| Yo'nalish | Tur | Maqsad |
|---|---|---|
| k→s | `input` | `{seq, pose{x,y,z,yaw,pitch}, aim{dir}, intents{fire,firePressed,reload,switchTo,moving}}` |
| k→s | `reset` | sessiyani qayta boshlash so'rovi |
| s→k | `session` | sessiya e'loni (map, nishonlar, qurollar, tick/snapshot Hz) |
| s→k | `state` | avtoritar holat snapshot'i (20 Hz) |
| s→k | `events` | avtoritar combat hodisalari |
| s→k | `input-ack` | `{seq, accepted, reason, tick}` |

---

## 5. O'ZGARGAN FAYLLAR

**Yangi fayllar**
- `server/session.js` — avtoritar sessiya + validatsiya + sim qadami + snapshot
- `test/unit/server-authority.test.js` — 26 ta server-avtoritet testi
- `tools/verify-phase5.mjs` — real Chrome + server xotirasi + soxta klient harness
- `logs/phase5-report.json`, `logs/phase5-report.md` — ushbu hisobot

**O'zgartirilgan**
- `shared/protocol-consts.js` — Phase 5 xabar turlari + `SIM` + `PROTOCOL_VERSION = 2`
- `server/app.js` — sessiyalar, input qabul/rad, `SETUP/RESET`, 30 Hz loop, telemetriya
- `server/index.js` — startup banner (Phase 5, tick/snapshot Hz)
- `client/js/game/index.js` — `net` adapteri: har kadr **faqat intent** yuborish
- `client/js/game/combat.js` — `moving` getter (spread + intent uchun)
- `client/js/main.js` — SESSION/STATE/EVENTS/ACK qabul, `sendInput`, `serverAuthority` QA API
- `test/unit/smoke.test.js` — protokol v2 + sessiya tekshiruvi; navbatli WS helper
- `test/unit/combat.test.js` — eski "Phase 5 taqiqlangan" chegaralari → Phase 5
  **mavjud** + Phase 6+ **yo'q** chegaralariga almashtirildi
- `package.json` — `verify:phase5` skripti + test ro'yxatiga yangi test fayli

**TEGILMAGAN (ataylab):** `shared/weapons.js`, `health.js`, `hitdetect.js`,
`respawn.js`, `grenade.js`, `combat.js`, `map.js`, `collision.js`,
`tools/verify-phase2.mjs`, `tools/verify-phase3.mjs`, `tools/verify-phase4.mjs`.

---

## 6. TESTLAR — ANIQ SONLAR

| Suite | Natija |
|---|---|
| `npm test` | **130 / 130 PASS** (104 baseline + 26 yangi) |
| `node tools/verify-phase2.mjs` | **42 / 42 PASS** |
| `node tools/verify-phase3.mjs` | **25 / 25 PASS** |
| `node tools/verify-phase4.mjs` | **22 PASS / 0 FAIL** |
| `node tools/verify-phase5.mjs` | **18 PASS / 0 FAIL** |

`test/unit/server-authority.test.js` qamrovi (26 test):

sessiya yaratilishi · nishon seed · buzilgan buyruq validatsiyasi (14 holat) ·
avtoritar maydon taqiqlari (barcha `FORBIDDEN_FIELDS`) · replay/duplicate seq ·
poza→server holati + origin serverda · cooldown/o'q-dori server qarori ·
1 s da 600 RPM kadans · reload (to'liq mag rad, vaqt serverda) · draw bloklash ·
hit/zarar server formulasi · devor to'sishi · quruq otish · o'lik otmasligi ·
nishon o'lim + 2500 ms respawn · granata spawn/gravitatsiya/fuse/portlash ·
granata self-damage ×0.6 · o'yinchini faqat server o'ldiradi + server respawn ·
snapshot · reset · **real WebSocket**: hello→welcome+session+state, avtoritar
oqim (wire = server xotirasi), soxta buyruqlar rad, sessiyasiz input,
uzilganda tozalash, 30 Hz loop.

**Muhim:** eski 2 ta "chegarasi" testi o'chirilmadi/yumshatilmadi — ular Phase 5
endi avtorizatsiya qilingani uchun **kuchaytirildi** (Phase 1–4 turlari saqlangan +
Phase 5 turlari bor + Phase 6+ turlari yo'q; `server/app.js` endi combatni biladi
lekin lobby/round/team/score/chat/interpolatsiya/reconciliation YO'Q).

---

## 7. REAL BRAUZER VERIFIKATSIYASI (18/18 PASS)

`node tools/verify-phase5.mjs` (real oyna, real GPU):

- **GPU:** `ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6)` — **SwiftShader EMAS**
- **protokol:** v2

| Gate | Dalil |
|---|---|
| P5.1 | real WebGL2 + real Intel GPU |
| P5.2 | `serverAuthority.version = 5`, Phase 4 qatlami (`version = 4`) saqlangan |
| P5.3 | **real klik** bilan TRAINING → server xotirasida `sessionId=1`, `playerId=p1` |
| P5.4 | server sessiyasi: 8 nishon (5 dummy + 3 halqa), 4 qurol, HP=100 |
| P5.5 | klient 200 ta intent yubordi, server 37 tasini qabul qildi (`rad=0`) |
| P5.6 | `mag = magSize − server shots`; wire `mag` = **server xotirasi** |
| P5.7 | 1.0 s ushlashda serverda **9 o'q** (600 RPM) |
| P5.8 | `dummy-1` HP server xotirasida 100 → 0; wire aynan mos; hits=4 |
| P5.9 | devor server tomonda to'sdi (blocked 0→1), nishon HP **o'zgarmadi** |
| P5.10 | R → **server** `reloading=true`, `fireReasons.reloading=3`, mag 27→30, reserve 117 |
| P5.11 | faol qurol serverda `pulse-pistol`, draw rad=2, pistol o'qlari 0→1 |
| P5.12 | **6 ta soxta buyruqning hammasi rad** (quyida) |
| P5.13 | `bad_json`/`unknown_type`/`too_big`/`no_session` + `pong` → server tirik, `tickErrors=0` |
| P5.14 | granata: otish → parvoz → portlash, hammasi **server xotirasida** |
| P5.15a | **100 FPS**, CPU **1.4 ms**, **156 draw call**, **22 538 tri**, shadow OFF |
| P5.15b | 3 s da **96 server tick**, loop **0.22 ms**, `tickErrors=0` |
| P5.15c | Phase 3 regressiya: NEON FACILITY 44×32, 60 kollayder, WASD 5.20 m/s |
| P5.16 | console=0, window.error=0, exception=0, loop=0, serverTick=0 |

**Dalil manbasi (anti-fake):** harness serverni **o'zi** ishga tushiradi va
`server.state.sessions` ni **to'g'ridan-to'g'ri o'qiydi** — bu brauzer da'vosi
emas, haqiqiy avtoritar xotira. Har bir `state` gate'ida wire qiymati server
xotirasi bilan **aynan** solishtirildi.

---

## 8. SOXTA (FORGED) INPUT TESTLARI

Xom WebSocket klienti (`RawClient`, brauzerdan tashqari) orqali:

| Soxta buyruq | Server javobi | Holat |
|---|---|---|
| `damage:100, targetHp:0, hit:true, alive:false, ammo:9999` | **`forbidden_authority`** | HP 100→100, mag 30→30, dummy 100→100 |
| `hp:0` | **`forbidden_authority`** | o'zgarmadi |
| `cooldown:0` (cooldown bypass) | **`forbidden_authority`** | o'zgarmadi |
| `aim.dir:[NaN,0,1]` | **`bad_aim`** | o'zgarmadi |
| `pose.x:Infinity` | **`bad_pose`** | o'zgarmadi |
| `switchTo:'nuke'` | **`bad_weapon`** | o'zgarmadi |
| takroriy `seq` | **`duplicate_seq`** | o'zgarmadi |
| buzilgan JSON / noma'lum tur / 40 KB xabar / sessiyasiz | `bad_json` / `unknown_type` / `too_big` / `no_session` | server tirik, `pong` qaytdi |

Unit testlar ham buni qoplaydi (`FORBIDDEN_FIELDS` ning **hammasi** bo'yicha
alohida assert).

---

## 9. UNUMDORLIK

- Klient (o'q ostida): **100 FPS** ema, o'rt 100 · CPU **1.4 ms** · **156** draw
  call · **22 538** tri · `shadowMap=false` (Phase 3/4 bilan bir xil).
- Server: 30 Hz tick, **loop 0.2155 ms** (budjet 33.3 ms; `< 16.6 ms` talab bajarildi),
  `tickErrors = 0`, 542 tick davomida barqaror.
- Sim loop allokatsiyani minimallashtiradi; `events` massivi faqat hodisa bo'lganda
  yaratiladi; interval `unref()` — oqib ketuvchi timer yo'q; uzilishda sessiya
  o'chiriladi (listener/sessiya sizib chiqishi yo'q).

---

## 10. REGRESSIYALAR

| Tekshiruv | Natija |
|---|---|
| `npm test` | **130/130** |
| Phase 2 | **42/42** |
| Phase 3 | **25/25** |
| Phase 4 | **22/0** |
| Phase 5 | **18/0** |

`verify-phase2/3/4.mjs` **o'zgartirilmadi**. Phase 4 klient markeri
(`window.__neon.version = 4`, `phase = 'phase4-combat'`) ataylab **saqlanadi**,
Phase 5 markasi alohida: `window.__neon.serverAuthority = { version: 5, ... }`.
Shu sababli P4.3 gate buzilmadi va Phase 4 22/22 da qoldi.

---

## 11. MA'LUM, BLOKLANMAYDIGAN MASALALAR

1. **Klient hali lokal combatni ham ishlatadi.** Phase 5 da holat EGASI — server;
   brauzer esa Phase 4 lokal combatni render/prediktor sifatida saqlaydi (Phase 4
   verifikatsiyasi shunga tayanadi). Klientni server snapshot'iga to'liq
   bog'lash, prediktsiya/reconciliation/interpolatsiya — **Phase 7** ishi. Bu
   Phase 5 chegarasidan chiqmaslik uchun ataylab qilinmadi.
2. **Headless rejim** faqat SwiftShader beradi, shuning uchun P5.1
   `--headless` da FAIL bo'ladi (dizayn bo'yicha) — real oynada o'tadi.
3. **Phase 2 harness** server allaqachon `localhost:3000` da turishini kutadi
   (avvaldan shunday); harness o'zgartirilmadi.
4. Bitta `RawClient` sessiyasi `IDLE_TIMEOUT_MS` bilan hali bog'lanmagan
   (kelajakdagi hardening uchun konstanta tayyor).

---

## 12. PHASE 6+ TASDIQLANMAGAN

**Phase 6+ (LAN lobby, room browser, matchmaking, teams, rounds, score, chat,
accounts, internet backend, interpolatsiya, reconciliation, Phase 8–12) HECH
QANDAY QILINMADI.**

Buni testlar bilan ham tasdiqladik:
- `protocol-consts` da lobby/matchmaking/round/team/score/chat/interp/reconcil
  turi **yo'q**.
- `server/app.js` da shu terminlar **yo'q** (chegara testi).
- `npm test` da chegara testlari yashil.

Phase 5 **faqat** avtoritativ server simulyatsiyasi/API poydevorini yaratdi —
Phase 6 va Phase 7 xavfsiz iste'mol qilishi uchun.
