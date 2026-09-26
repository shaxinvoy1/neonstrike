# NEON STRIKE — PHASE 11 REPORT
## REAL LAN QA / TWO-DEVICE MULTIPLAYER VALIDATION

**STATUS: `P11 PARTIAL — TWO-DEVICE LAN QA BLOCKED`**

This phase's job was to prove the existing authoritative multiplayer game works between **two real physical devices on a real LAN**. That proof **was not obtained**, because this environment contains **one device only**. No part of this report claims otherwise.

Everything below is split into three evidence classes, and the class is named for every claim:

| Class | Meaning | Result |
| --- | --- | --- |
| **AUTOMATED (single host, real LAN interface)** | Real HTTP/WS traffic through the real NIC (`enp2s0`), byte-identical production code, but both endpoints are on this one machine | **13 PASS / 0 FAIL** |
| **MANUAL REQUIRED (physical)** | Only performable with a second physical device | **11 gates NOT PERFORMED (0 verified)** |
| **FORBIDDEN** | Faking physical LAN evidence (two tabs, two Chrome processes on one box, loopback, mocks, synthetic delay) | **not done — see §9** |

---

## 1. Baseline (takeover audit, before any Phase 11 edit)

No git repository (`git status` → `fatal: not a git repository`).

| Suite | Baseline | Final (after P11) |
| --- | --- | --- |
| `npm test` | **257 / 257** | **270 / 270** (+13 `lan-qa`) |
| `verify-phase2` | 42 / 42 | **42 / 42** |
| `verify-phase3` | 25 / 25 | **25 / 25** |
| `verify-phase4` | 22 / 22 | **22 / 22** |
| `verify-phase5` | 18 / 18 | **18 / 18** |
| `verify-phase6` | 21 / 21 | **21 / 21** |
| `verify-phase7` | 33 / 33 | **33 / 33** |
| `verify-phase8` | 28 / 28 | **28 / 28** |
| `verify-phase9` | 34 / 34 | **34 / 34** |
| `verify-phase10` | 21 / 21 | **21 / 21** (re-run after P11 changes) |
| `verify-phase11` | — | **13 automated PASS / 0 FAIL · 11 MANUAL REQUIRED** |

Files inspected: `logs/phase10-report.*`, `server/app.js`, `server/session.js`, `server/lobby.js`, `server/match.js`, `server/chat.js`, `server/metrics.js`, `shared/protocol-consts.js`, `shared/movement.js`, `shared/combat.js`, `shared/hitdetect.js`, `client/js/main.js`, `client/js/game/*`, all `tools/verify-phase*.mjs`, `package.json`.

Audit findings that mattered for P11:

1. The server already binds **`0.0.0.0:3000`** (`SERVER_DEFAULTS.HOST/PORT`) — correct for LAN, no change needed.
2. The client derives its socket from the page origin: `ws://<location.host>/ws` (`client/js/main.js`, verified by a unit test). So **Device B only has to open `http://<DEVICE_A_LAN_IP>:3000`** — no manual IP entry, no hard-coded address, no proxy.
3. `lanAddresses()` logic was **duplicated** in `server/app.js` and `server/index.js` and untestable → extracted to **`server/net.js`** (pure).
4. The server already logs the **real peer IP** on connect (`[net] + connection #N from <ip>`), which is the only honest basis for "a second device connected". There was **no classification** of "is this peer me or someone else" → added `classifyPeer()`.

---

## 2. Devices

### Device A — the authoritative server host (real, measured)

| Property | Value |
| --- | --- |
| Hostname | `te-h6.tash.21-school.uz` |
| OS | Ubuntu 24.04 LTS (Linux 6.8.0-48-generic) |
| CPU / cores / RAM | 13th Gen Intel Core i7-13620H · 16 · 33 GB |
| Network type | **Ethernet** (`enp2s0`) |
| LAN IPv4 | **`10.201.177.74/24`** (gateway `10.201.177.254`) |
| Server bind | `0.0.0.0:<port>` (default `0.0.0.0:3000`; harness uses an ephemeral port) |
| Node | v22.23.2 |
| Firewall | `ufw` **O'CHIRILGAN** (`ENABLED=no` → hech qanday qoida qo'llanmaydi). Haqiqiy host-firewall — School21 `olympiad` iptables to'plami (**root-only, o'qilmadi, o'zgartirilmadi**) |

### Device B — the second physical device

| Property | Value |
| --- | --- |
| Exists | **NO** — not available in this environment |
| OS / browser / network | **NOT APPLICABLE (no device)** |
| Consequence | every physical gate below is **NOT PERFORMED** |

The LAN is a shared school network (`21-school.uz`). The ARP/neighbour table shows other hosts exist on the subnet (e.g. the gateway, and one stale IPv4 lease), but they are **not under my control**: I cannot start a browser on them, so they are not evidence of anything.

---

## 3. Connection (what was actually measured)

**Automatic, real, but single-host** — through the real NIC, never loopback:

* `P11.1 PASS` — server bound `0.0.0.0:44511`, listening, and self-reports the interface address.
* `P11.2 PASS` — Device B's URL comes from the **real interface**: `http://10.201.177.74:44511`, and `127.0.0.1` is **not** offered as a LAN address (hard-coding is impossible: `lanUrls()` only emits real non-internal IPv4s).
* `P11.3 PASS` — `GET http://10.201.177.74:44511/ → 200`, 9852 bytes, served over `enp2s0`.
* `P11.4 PASS` — a real WebSocket client connected to `ws://10.201.177.74:44511/ws`; the server observed peer `10.201.177.74`. **Honest classification: `self`** — this is my own address, so it is real LAN-path evidence, *not* two-device evidence.
* `P11.5 PASS` — two clients over the LAN interface: distinct server-assigned ids `p1`, `p2`, one session, `hostId = p1`, capacity 8, no duplicate id.
* `P11.11 PASS` — a **real Chrome** loaded `http://10.201.177.74:44511/`, connected to `ws://10.201.177.74:44511/ws` (`readyState 1`, `connected true`), WebGL2 live on the real Intel Mesa GPU, 0 exceptions. Screenshot: `logs/p11-01-deviceA-lan-url.png`.
* `P11.10 PASS` — firewall state **haqiqiy manbadan** aniqlandi (`ENABLED=no`, `user.rules`=307 bayt bo'sh shablon, `is-active=active` faqat oneshot unit), LAN HTTP+WS proven; **hech qanday firewall qoidasi o'zgartirilmadi**.

**NOT PERFORMED:** Device B connecting from a **different IP** (`P11.M1`), i.e. the actual two-device connection. The server-side detector that would prove it is implemented and reports `remotePeers: []`, `classification {loopback: 0, self: 3, remote: 0}`.

---

## 4. Movement — measured on one host, NOT cross-device

`P11.6 PASS`: after the host started the session, the round reached **LIVE** (`round 1/live`), both clients received **different teams** (`A` / `B`), and 12 real `INPUT` messages per client moved both players **3.2 m** each according to **server-side simulation** (the harness never wrote a position). Evidence: `ko'chish host=3.2 m guest=3.2 m · tick=62`.

**NOT PERFORMED:** "Device A moves → Device B *sees* it" and the reverse (`P11.M3`). Seeing movement requires the second screen.

---

## 5. Combat — measured on one host, NOT cross-device

`P11.7 PASS`: after the server placed both players on the measured clear firing lane, the shooter's held fire produced **5 accepted shots**, the server's own counters recorded `shots=5 hits=5`, the victim's **authoritative HP went 100 → 0**, and the magazine went **30 → 25**. Damage, hits, ammo and death were all computed server-side from the real ray against the real map; the harness only sent intent.

`P11.8 PASS`: while the victim was dead, a forged `{hp: 999, damage: 999, alive: true}` input was sent. The server left `HP 0 → 0` and `alive false → false` unchanged and `tickErrors = 0`. Authority holds over the LAN path too.

**NOT PERFORMED:** A fires at B and B's *HUD* shows the damage, then the reverse (`P11.M4`). `P11.M5` (identical round/score/match on both screens) is likewise physical.

---

## 6. Round / match

Exercised authoritatively on one host as part of `P11.6`/`P11.7` (LIVE round, real elimination, real team assignment). Phase 8's own harness re-verified the full round/score/match-end flow end-to-end in this same session (`verify-phase8` → 28/28, `match_end · g'olib=A · ball A=5 B=0`), and Phase 10 drove 32 rounds with **+1 exactly once per round, zero round-number jumps**.

**NOT PERFORMED:** two-device agreement on round number, score and match winner (`P11.M5`).

---

## 7. Chat

`P11.9 PASS` over the LAN interface: client A sent only `{type: chat, text: "salom device B"}`; the **server** attached the sender identity and broadcast; client B received `[p1] "salom device B"` (`seq=1`). Sender identity is server-derived — the client never sends `playerId`.

**NOT PERFORMED:** "Device A keyboard → server → Device B screen" and the reverse (`P11.M6`). Flood control, oversize/empty/malformed rejection and forged-sender rejection were all exercised in the same session by the Phase 9 harness (34/34) and Phase 10's 5-minute chat load (285 accepted / 1012 rejected, rejections broken down by reason).

---

## 8. Disconnect / rejoin / network interruption / join-in-progress

| Item | Status | Notes |
| --- | --- | --- |
| Physical Device B close → cleanup, no ghost | **NOT PERFORMED** (`P11.M7`) | Single-host equivalent already covered: Phase 10 gate `P10.16` leaves `connections=0 sessions=0 members=0`, and the P11 unit suite asserts the same |
| Device B rejoin | **NOT PERFORMED** (`P11.M8`) | There is **no auto-reconnect** in this project (Phase 6/7 decision) — the supported lifecycle is a fresh connection with a fresh server-assigned id. Phase 10 tested that honestly (`opened−closed = 5/5`) |
| Network interruption (Wi-Fi off/on) | **NOT PERFORMED** (`P11.M9`) | Would also require touching a real adapter; not done, and not simulated |
| Join-in-progress on a second device | **NOT PERFORMED** (`P11.M10`) | The authoritative path it depends on (late joiner receives current team/round/score/alive + spawn) is covered by Phase 8's `join-in-progress` evidence and Phase 7's `P7.23` |

---

## 9. What was deliberately NOT done (anti-fake)

I did not, and will not, present any of the following as LAN evidence: two tabs; two Chrome processes on one machine; two WebSocket clients on one machine; loopback; `127.0.0.1`; a mocked socket; a synthetic network delay; unit tests; or function-level simulation. The P11 harness's own peer classifier is the guard: `classifyPeer()` returns `loopback` / `self` / `remote`, and the harness prints the classification in its summary and asserts it in `test/unit/lan-qa.test.js` (a test explicitly asserts that this-host traffic classifies as `self`, so the "two devices" claim can never be manufactured by accident).

---

## 10. Performance

Distinguishing honestly, as required:

* **LOCAL (this machine, real NIC, both ends on this host):** the P11 automated run is not a performance measurement and is not reported as one. For reference, in the same session on the same tree: client 100 FPS, CPU ~1 ms/frame, server tick avg 0.425 ms / p95 0.690 ms with 0 overruns and 0 tickErrors over a 5-minute 4-player load (Phase 10 artifact).
* **REAL LAN RTT from Device B:** **NOT MEASURED** (`P11.M11`). Any latency figure measured here would be intra-host and would be misleading, so none is given. The client does publish a real latency figure derived from its own PING/PONG exchange; it will be readable on Device B's HUD when a second device exists.

---

## 11. Screenshots / evidence

* `logs/p11-01-deviceA-lan-url.png` — real Chrome rendering the game loaded from `http://10.201.177.74:<port>/` (not localhost), connected over the LAN interface.
* `logs/phase11-report.json` — machine-generated evidence: environment inventory, `physicalLanQa` (`performed: false`, `remotePeers: []`), all 13 automated gate results with measured details, all 11 manual gates with status `MANUAL REQUIRED`, unit counts, browser connection state, and the peer classification.
* `logs/phase6-*.png`, `logs/phase7-*.png`, `logs/phase9-*.png`, `logs/phase10-*.png` — existing single-machine multiplayer evidence (unchanged).

---

## 12. Tests

* `npm test` → **270 / 270 PASS** (257 before P11 + **13** new in `test/unit/lan-qa.test.js`).
* `test/unit/lan-qa.test.js` — deterministic LAN logic only, no pretending: IPv4 normalisation incl. `::ffff:` and zone ids; loopback detection over `127.0.0.0/8` and `::1`; interface enumeration rejecting internal/loopback/IPv6 and accepting numeric `family: 4`; LAN URL derivation from a real interface with an honest `localhost` fallback when no interface exists; the client's `location.host → ws://host/ws` formula asserted against the actual source line; `classifyPeer` for loopback/self/remote/unknown; **"our own addresses must never classify as remote"**; real server bind; real LAN-IP HTTP; real LAN-IP WebSocket with the peer asserted to be our own address; two LAN-interface clients with distinct authoritative ids and a server-assigned host; and teardown with no ghost.
* `tools/verify-phase11.mjs` — 13 automated gates + the 11 manual gates it refuses to mark PASS. It also runs the entire `npm test` list internally as gate `P11.12` (`tests=270 pass=270 fail=0`, 13 files) and scans protocol/telemetry/`__neon` surfaces for Phase 12 scope leakage (`P11.13`, all empty).
* No test was deleted, weakened, skipped or made conditional; no earlier verifier was modified to make anything pass.

---

## 13. Regressions (each run separately, one at a time)

`npm test` 270/270 · `phase2` 42/42 · `phase3` 25/25 · `phase4` 22/22 · `phase5` 18/18 · `phase6` 21/21 · `phase7` 33/33 · `phase8` 28/28 · `phase9` 34/34 · `phase10` 21 PASS / 0 FAIL · `phase11` 13 automated PASS / 0 FAIL + 11 MANUAL REQUIRED.

**One honest note (reported, not hidden).** In one Phase 5 run during this batch, `P5.7`/`P5.8` failed with **0 shots** in the 1-second trigger hold. Root-caused by direct measurement rather than assumption: a temporary probe showed **144 frames during the hold** (so it was *not* frame starvation) but `pointerLockElement === false` — pointer lock had not been granted in that run. The probe then showed that the *same production code*, with the lock actually held, produces **exactly 10 shots / 4 hits** for a 1.0 s hold, and an immediate harness re-run returned **18/18 PASS**. So: pointer-lock grant on this shared, heavily loaded machine is timing-sensitive; the game code and the harness were left untouched. (Phase 6/7/9/10 harnesses all engage the lock successfully in the same session.)

The Phase 5 gate `P5.7` is timing-sensitive by design (it asserts 8–13 shots per 1.0 s at 600 RPM). Anyone re-running the suite should give that harness a settled machine, exactly as the Phase 8–11 prompts instruct.

---

## 14. Code changes (minimal, additive)

**New**
```
server/net.js                   pure LAN logic: normalizeIp / isLoopbackIp / lanInterfaces /
                               lanUrls / wsUrlFor / classifyPeer / localIpv4Addresses
test/unit/lan-qa.test.js        13 deterministic LAN tests
tools/verify-phase11.mjs        13 automated gates + 11 MANUAL REQUIRED gates + remote-peer detector
```

**Changed**
```
server/app.js                   lanAddresses() now uses server/net.js (behaviour identical: real interfaces, localhost fallback)
server/index.js                 startup banner prints the same helper's URLs (duplication removed)
package.json                    lan-qa suite registered in npm test; verify:phase11 script
tools/verify-phase10.mjs        P10.2c unit list updated to include test/unit/lan-qa.test.js so its
                                "same list as npm test" claim stays true (no gate weakened)
```

**Dependencies: unchanged.** No new package. **No protocol change** (still v6). **No gameplay change.** **No firewall change.** `shared/`, the map, combat, movement, lobby and match rules were not touched.

---

## 15. Limitations — everything NOT verified

1. **Two physical devices were never connected.** `P11.M1`–`P11.M11` are NOT PERFORMED; there is **no** cross-device evidence in this report.
2. **No real LAN latency (RTT)** figure exists (would be meaningless from one host).
3. All "LAN" measurements here are **real-interface but same-host**: they prove the LAN *path* (bind, addressing, HTTP, WS, addressing from real interfaces) and nothing about inter-device behaviour such as Wi-Fi jitter, packet loss, or adapter-dependent latency.
4. **No network-interruption test** was performed or simulated.
5. **No auto-reconnect** exists, so rejoin behaviour was not exercised on a second device.
6. Device A'da `ufw` **o'chirilgan** (`ENABLED=no`) — u kiruvchi trafikni TO'SMAYDI. Haqiqiy host-firewall — School21'ning `olympiad` iptables to'plami (`/etc/network/if-pre-up.d/olympiad-iptables` → `iptables-restore < /etc/iptables.olympiad.rules`), fayl `-rw-r----- root:root`, **`Permission denied`** (o'qib ham, o'zgartirib ham bo'lmaydi). Shu sababli qaysi kiruvchi port ruxsat etilganini **root bo'lmasdan sanab bo'lmaydi**. Device B bu L2 segmentga umuman yetib kelmadi (11 daqiqa kuzatuvda ARP yozuvi ham, remote TCP ham paydo bo'lmadi) — ya'ni "School21 barcha kiruvchi portni to'sadi" deb **AYTIB BO'LMAYDI**, chunki bloklanadigan paket hech qachon kelmagan.
7. The Phase 5 pointer-lock timing sensitivity described in §13 remains an open harness/environment fragility (documented, not fixed).

### 15.1 Exactly what is required to finish P11 (root-level permission)

`sudo` is refused on this account — `sudo: PAM account management error: Permission denied` (and `sudo -n` reports a password is required). With no privilege escalation available, **none** of the following can be performed from inside this session:

| # | What is needed | Exact command (needs root) | Why it is needed |
|---|---|---|---|
| 1 | Prove whether an inbound port is ALREADY permitted | `sudo iptables-save` (or `sudo cat /etc/iptables.olympiad.rules`) | The ruleset is `-rw-r----- root:root`; no readable duplicate exists anywhere under `/etc`, `/usr/local`, `/var/lib` — so allowed inbound ports cannot be enumerated without root |
| 2 | Allow the test port for the two-device run | `sudo iptables -I INPUT 1 -p tcp --dport 3000 -j ACCEPT` | Must be re-added after any link-up event, because `/etc/network/if-pre-up.d/olympiad-iptables` re-restores the school ruleset on **every** interface pre-up |
| 3 | Or: obtain an exception | School21 administrator excludes this machine from the `olympiad` profile | `/etc/olympiad-whitelist-domains.txt` shows an exam/olympiad lockdown profile (cppreference.com, cms.robocontest.uz, docs.python.org) |

**Important ordering caveat:** ufw is disabled and nftables is empty, so requests 1–2 are needed **only if** Device B is first confirmed to be on the `10.201.177.0/24` L2 segment and TCP still fails. If Device B is on another subnet, behind a VPN, or subject to Wi-Fi client isolation, **no** firewall change on Device A can help — the two devices must share the same L2 segment. That determination is still open: in 11 minutes of monitoring the running server, **no ARP entry and no inbound TCP** from any non-self address ever appeared.

---

## 16. How to complete the physical test (reproducible procedure)

On Device A:

```bash
cd /home/paulinaj/neon-strike
node tools/verify-phase11.mjs --wait-remote=300
```

The harness prints the URL to open on Device B, e.g. `http://10.201.177.74:<port>`, and then waits up to 300 s for a peer whose address is **not** one of this host's addresses.

On Device B (any other physical device on the same Wi-Fi/Ethernet/hotspot):

1. open the printed URL in a browser (no IP entry needed — the client connects to `ws://<that host>/ws` automatically);
2. press **QO'SHILISH / JOIN** in the lobby panel;
3. when the harness detects the peer, `P11.M1`/`P11.M2` become PASS with **server-side** evidence (remote IP, server-assigned id, session membership).

If Device B cannot reach the server: check, in order (1) `ss -ltnp | grep <port>` (listening) and that the bind is `0.0.0.0` not `127.0.0.1`; (2) on Device B, that its own IP starts with `10.201.177.` — a different subnet, a VPN, or Wi-Fi client-isolation will fail **before** any firewall is involved; (3) `ping <DEVICE_A_IP>` from Device B, then `nc -vz <DEVICE_A_IP> <port>`; (4) on Device A, `ip neigh show` — if Device B's IP never appears, the packets are not reaching this L2 segment; (5) only then suspect the `olympiad` iptables ruleset, and note that neither reading it nor adding a rule is possible without **root** (`sudo` itself is refused on this account: `PAM account management error: Permission denied`). Do **not** bother checking `ufw` — it is disabled and enforces nothing. The remaining `P11.M3`–`P11.M11` gates then require playing a match on both devices.

---

## 17. Final verdict

```
PHASE 11 STATUS: P11 PARTIAL — TWO-DEVICE LAN QA BLOCKED

Two physical devices:      NOT PERFORMED (only one device exists in this environment)
Server reachable over LAN: VERIFIED on one host (real NIC enp2s0, real HTTP/WS, never loopback)
Distinct identities:       VERIFIED on one host (p1/p2, one session, server-assigned host)
Movement / combat / chat:  VERIFIED on one host over the LAN interface, 100% server-authoritative
Round / team / score:      VERIFIED on one host (Phase 8 harness re-run 28/28 + P10's 32-round load)
Cross-device anything:     NOT VERIFIED
Real LAN latency:          NOT MEASURED
Network interruption:      NOT TESTED
Disconnect / rejoin:       NOT TESTED on a second device (single-host lifecycle verified instead)
P2–P10 regressions:        GREEN (42/25/22/18/21/33/28/34/21) + npm test 270/270
P11 automated gates:       13 PASS / 0 FAIL
P11 manual gates:          11 NOT PERFORMED
P12 scope:                 NOT implemented (P11.13 scan empty; no deploy/cloud/account/hardening)
Evidence:                  logs/phase11-report.json, logs/p11-01-deviceA-lan-url.png, this file

REQUIRED TO CLOSE: a second physical device on the same LAN (see §16).
Until then this phase is PARTIAL, not COMPLETE.
```
