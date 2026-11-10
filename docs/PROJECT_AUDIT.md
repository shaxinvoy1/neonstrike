# NEON STRIKE — Project Audit (baseline, before the V-773 rebuild)

Date: 2026-11-10 · Branch: `claude/telefon-koʻrish-boshqarish-8woq8e` · Base commit `5ab910d`.

## Method
- Read all of `shared/`, `server/`, `client/`; ran `npm test` and the live server; opened the client in headless Chromium (WebGL via ANGLE/SwiftShader) and captured screenshots (`docs/screenshots/00-before-*.png`).
- Git status was clean before any change. No user modifications were present to preserve.

## Stack
- Node ≥ 20 server (`ws` only dependency), plain ES modules, vendored three.js r160 (`vendor/three.module.js`), no bundler.
- `shared/` = pure rules used by both server and client (collision, movement, map, weapons, combat, grenade, health, hit detection, aim, protocol constants).
- `server/` = HTTP static server + WebSocket, LAN lobby (`lobby.js`), per-player authoritative session (`session.js`), match/round state machine (`match.js`), chat, metrics.
- `client/` = one HTML page, `main.js` (menus/network), `game/*` (render, input, camera, combat view, HUD).

## Test baseline
`npm test` → **313 / 313 pass** (unit + in-process server integration). The Playwright `tools/verify-phase*.mjs` scripts drive the old client.

## What is sound (kept)
| Area | Evidence |
|---|---|
| Host-authoritative server, 30 Hz sim / 20 Hz snapshots, input seq/ack, forbidden-field rejection | `server/session.js`, `test/unit/server-authority.test.js` |
| Shared movement/collision (AABB slide, step-up, gravity) used by server and client prediction | `shared/movement.js`, `shared/collision.js` |
| Weapons/hit detection/falloff/spread/grenade physics, friendly-fire block | `shared/weapons.js`, `shared/combat.js`, `shared/grenade.js` |
| LAN lobby, host, join-in-progress, disconnect handling, chat with server-side identity | `server/lobby.js`, `server/app.js`, `server/chat.js` |
| Map NEON FACILITY: 44×32 m, point-symmetric colliders, reachability BFS test | `shared/map.js`, `test/unit/map.test.js` |

## Defects / gaps vs. the mission spec
| # | Severity | Finding |
|---|---|---|
| G-01 | P0 | Character is a dark capsule/box humanoid (Lambert, 14 primitives) — nothing like Model V-773 (Reference A). No rig, no skinning. |
| G-02 | P0 | Animation = two leg pivots + lean. None of the 29 required states. Weapon not held. |
| G-03 | P1 | Arena visuals are flat boxes with trim lines; no containers, no A-site sign, no catwalk railings/material variation (Reference B). |
| G-04 | P1 | Weapons: 4 of 5 (no knife). One generic view model. Grenade named "Energy" not "Frag". |
| G-05 | P1 | Movement: no jump, no crouch (spec requires both, server-validated). |
| G-06 | P1 | Match: first-to-5, MAX_ROUNDS 99, no round timer — spec needs a 10-round structure with timer. |
| G-07 | P1 | Snapshot carries no animation state (weapon, crouch, firing, reload) → remote players cannot animate correctly. |
| G-08 | P1 | No team selection in lobby (auto-assign only). |
| G-09 | P2 | HUD is a debug panel (FPS chips, pointer-lock chip, position readout) — not Reference B. No minimap, no cross-player kill feed, no scoreboard. |
| G-10 | P2 | No settings (sensitivity, quality, resolution, shadows, volume). Two permanently disabled menu buttons. |
| G-11 | P2 | No audio at all. |
| G-12 | P2 | No mobile touch controls (desktop keyboard/mouse only). |
| G-13 | P3 | Many developer badges/labels in the player-facing menu ("Phase 6 · HOST", WebGL gate rows). |

## Decision
Keep `server/` and `shared/` (extend additively; every existing test keeps passing or is updated only where the spec deliberately changes a rule, documented in TEST_REPORT.md). Replace the client presentation layer with a new modular client (character, rig, animation, camera, arena view, weapons view, HUD, menus, input, audio, settings). The old client modules that unit tests import (`sync-math.js`, `hud-state.js`) stay in place.
