# Final QA report — NEON STRIKE (V-773 rebuild)

Legend: **PASS** = verified by an automated test or an inspected screenshot in this environment · **PARTIAL** = implemented, only partly verified or with a known limitation · **BLOCKED** = cannot be verified here (reason given) · **FAIL** = not done.
Evidence: `docs/TEST_REPORT.md`, `docs/PERFORMANCE_REPORT.md`, `docs/screenshots/*`.

## Character
| Item | Status | Evidence |
|---|---|---|
| Model V-773 matches Reference A | PASS | `01-character-4-views-unarmed.png` vs `reference/reference-A-character.jpg` |
| Large round head | PASS | r 0.36 m, ≈41 % of height |
| Two oval eyes (outline, sclera, pupil, highlight) | PASS | close-up checked; eyes on head bone |
| Body proportions (small torso, short rounded limbs) | PASS | screenshots |
| Pearl material | PASS | MeshPhysical clearcoat + sheen + iridescence (High) |
| Front / left / right / back | PASS | `/viewer.html` four-view |
| Walk, run, sprint, strafe, diagonal, back | PASS | viewer states + game (remote animation states read in E2E) |
| Turning (in place, planted feet + steps) | PASS | viewer `turn` |
| Crouch / crouch walk / stand | PASS | viewer + mobile & keyboard E2E (server `crouch`) |
| Jump / fall / land | PASS | viewer + E2E (`jumps` counter, server airborne) |
| Aim / shoot / reload / switch | PASS | viewer + weapons E2E (reload animation state) |
| Grenade throw / knife attack | PASS | viewer + weapons E2E |
| Hit reaction, death, respawn, victory | PASS | viewer; death state observed on a remote client in multiplayer E2E |
| Weapon held by both hands | PASS | IK gap measured: rifle ≤ 3.7 cm, pistol 0, shotgun ≤ 1.5 cm (inside the hand mitt) |
Note: animation is a layered procedural system (pose functions + blending + two-bone IK, phase from distance travelled), not keyframed clip files.

## Arena
| Item | Status | Evidence |
|---|---|---|
| One complete NEON FACILITY map | PASS | `04-arena-overview.png` |
| Reference-B look (navy, blue/cyan neon, floor strips) | PASS | `05`, `07` screenshots |
| Tactical cover, containers, crates | PASS | 10 crates + 4 containers |
| Elevated walkway + stairs, raised reactor | PASS | map tests (BFS reachability) |
| A-site marker | PASS | `04b-a-site.png` |
| Balanced spawns | PASS | point symmetry test |
| Collision | PASS | map/collision unit tests; client prediction & camera use the same colliders |
| No inaccessible required areas | PASS | BFS test |
| No major visual defects | PASS | screenshots inspected (fog lightened after the top-down check) |

## Combat
| Item | Status |
|---|---|
| Rifle, pistol, shotgun, grenade, knife | PASS (weapons E2E) |
| Reloading, ammunition, reserve | PASS |
| Damage / hit detection (server) | PASS (training + PvP) |
| Crosshair ↔ bullet alignment | PASS (0.5 px / 1.3 px; near-cover case handled) |
| Effects | PASS (flash, tracer, sparks, explosion, screen shake — screenshots) |
| Sound | PARTIAL — WebAudio synthesised sounds for every required event are implemented; not audible/verified in a headless environment |

## Multiplayer
| Item | Status |
|---|---|
| Room creation / joining | PASS |
| Two-player test | PASS (2 separate Chromium processes) |
| Four-player test | PARTIAL — 2 browser clients + 2 protocol clients; 4 GPU browsers exceeded the container memory limit |
| Player / position / rotation sync | PASS (reconciliation error 0.000 m; host view Δ 0.00 m) |
| Animation-state sync | PASS (weapon, crouch, sprint, airborne, shots, reloading, alive in snapshot; remote death state verified) |
| Shooting sync | PARTIAL — remote muzzle/tracer driven by the server `shots` counter; not asserted pixel-wise |
| Damage / death / score sync | PASS |
| Disconnect handling | PASS (player removed on others) |
| Host disconnect | PARTIAL — server lobby logic unchanged from P6 (tested there); new client shows "connection lost" and returns to menu; not re-tested end-to-end |
| Reconnection | FAIL — not implemented (a reconnecting player joins as a new player) |

## UI
| Item | Status |
|---|---|
| Main menu, multiplayer, lobby, team selection | PASS (E2E clicks) |
| HUD (scores, timer, round x/10, minimap, kill feed, health, ammo, weapon list, grenades) | PASS (`07-desktop-hud.png`, `06-combat…png`) |
| Chat | PARTIAL — works across clients; it is session-wide (labelled by team), not team-only |
| Scoreboard (Tab) | PASS |
| Settings (sensitivity, touch sensitivity, FOV, quality, resolution, shadows, effects, volume, invert Y, FPS) | PASS (UI present; persisted in localStorage) |
| Pause | PASS (used in cleanup test) |
| Results screen + host restart | PARTIAL — implemented; server restart path unit-tested; full 6-win match end not played through in a browser |

## Desktop and mobile
| Item | Status |
|---|---|
| Keyboard movement & actions (real key events) | PASS (W/D move, Space, C, 3, Tab) |
| Mouse camera / mouse fire | PARTIAL — pointer-lock mouse look and LMB/RMB implemented; pointer lock is unavailable in headless Chromium, so the mouse path is not automated (fire was verified via the same input state) |
| Mobile joystick, touch camera, fire, weapon controls | PASS (real CDP touch events) |
| Responsive HUD | PASS (desktop 1280×720 and phone 863×360 screenshots) |
| Phone ↔ desktop LAN | PARTIAL / BLOCKED — phone-emulated client joined the desktop-hosted match via the LAN IP and played (PASS); a physical phone on real Wi-Fi is not available here (BLOCKED) |

## Engineering
| Item | Status |
|---|---|
| Build | PASS (no build step; ES modules served by `npm start`) |
| Unit + integration tests | PASS 324/324 |
| E2E tests | PASS (6 runs, 98 checks) |
| Known critical / high defects | none known |
| Performance measured | PARTIAL — measured honestly, but only on CPU SwiftShader (no GPU here) |
| Resource cleanup | PASS (3 cycles, no growth) |
| Documentation | PASS |

## Known limitations
1. Real-GPU FPS and a physical phone on Wi-Fi were not available for testing.
2. No reconnection; chat is not team-only; no armour/shield (HUD shows 0).
3. Animations are procedural, not motion-captured clips.
4. The legacy client is kept at `/legacy.html` with its old verify scripts; it is no longer the product UI.
