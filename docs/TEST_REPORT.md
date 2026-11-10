# Test report

Environment: Linux container, 4 vCPU, Node 22, Playwright Chromium (WebGL via ANGLE → **SwiftShader, CPU only — no GPU**). Date 2026-11-10.

## Unit + integration (`npm test`)
**324 / 324 pass.** 15 original suites plus `test/unit/v773-foundation.test.js` (12 tests: jump, ceiling hit, crouch speed/headroom, knife no-ammo + cooldown, 10-round structure and draws, round timer, team preference balance, live-server prefer/snapshot fields/server-side jump & crouch/knife kill → kill feed, knife range, host return-to-lobby restart, round spawn keeps kills/deaths and reopens death accounting).

### Existing tests changed on purpose (rule changes demanded by the mission)
| Test | Old expectation | New | Reason |
|---|---|---|---|
| weapons / core-gameplay / server-authority | 4 weapons | 5 (combat knife, mode `melee`, slot 5) | §7 knife required |
| smoke `protocol-consts` | ROUNDS_TO_WIN 5 | 6, MAX_ROUNDS 10 | §8 ten-round match |
| map `60 colliders` | 60 | 64 (+4 containers) | §5 large industrial containers |
| combat boundary scan | `killfeed`, `scoreboard` forbidden on server | removed from the forbidden list | §8/§10 kill feed and scoreboard required |
| smoke client files / `GET /` | old `index.html` → `js/main.js` | new `index.html` → `js/v/app.js`; old page kept as `legacy.html` | client replaced |
No test was deleted or skipped.

## Browser E2E (real Chromium clients, `npm run test:e2e`)
| Suite | Result | What it proves |
|---|---|---|
| `weapons.e2e.mjs` | 15/15 PASS | switch 2 → pistol; pistol semi-auto hits + ammo; shotgun pellets (several hits per shot); rifle auto hits; reload 24→30 with reload animation; knife (V) hits at 1.5 m, misses at 6 m (server range); grenade (G) thrown → fuse/explode → blast damage/kill; inventory 3→2; return to previous weapon |
| `aim.e2e.mjs` | 6/6 PASS | server hit point **0.5 px** from crosshair (target, 7.7 m); open wall **1.3 px** (9 m); near-cover case: crosshair turns BLOCKED and server impact = client-shown block point (Δ 0.02 m) |
| `mobile.e2e.mjs` | 18/18 PASS | Pixel 7 landscape, real CDP touch events: joystick move 3.2 m, knob recentres, right-side drag turns camera, fire (ammo 30→23), AIM/crouch toggles, jump, reload, swap, grenade 3→2, knife; buttons don't cover the crosshair; no page scroll/zoom |
| `multiplayer.e2e.mjs 2` | 19/19 PASS | create room, join, team pick, start, both in LIVE, server teams = choice, remote V-773 visible, movement sync (reconciliation error 0.000 m), PvP damage through server, victim death on server, kill feed (data + HUD names), round won by B, ROUND 2/10 with respawn, scoreboard, chat, disconnect removes the player, 0 console errors |
| `multiplayer.e2e.mjs 2 2` (4 players) | 20/20 PASS | 2 browser clients + 2 protocol clients (same WS protocol): snapshot carries 4 players, each browser renders 3 remote V-773s, bot movement visible in a browser, then the same combat/round/chat/disconnect checks |
| `MOBILE=1 multiplayer.e2e.mjs 2` | 20/20 PASS | second player is a **phone-emulated** client (touch, mobile UA) loading the game from the server's **LAN IP** (`http://192.0.2.2:<port>/`, proxy bypassed) and playing against the desktop host |

Test-harness note: E2E positions players with the server's own `placePlayerAt` (in-process server) only to set up line of sight; all movement, aiming, shooting, damage, death, scoring and UI happen through the real clients.

## Not verified / blocked
- A **physical phone** on real Wi-Fi joining a desktop host: no physical device here → BLOCKED (closest proof: phone-emulated client over the LAN interface above).
- 4 **GPU browser** clients at once: the container's memory limit killed the 4th SwiftShader browser → 4-player run uses 2 browsers + 2 protocol clients.
- Legacy `tools/verify-phase*.mjs` scripts drive the old client (`legacy.html`); they were not re-run against the new client.
