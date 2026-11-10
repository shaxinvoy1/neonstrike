# Implementation Plan

| Phase | Work | Verification |
|---|---|---|
| 1 Foundation | Shared: jump + crouch in `movement.js` (server-simulated), knife melee + Frag Grenade in `weapons.js`/`combat.js`, snapshot animation fields (weapon, crouch, airborne, fire/reload/throw/melee counters), 10-round match with round timer, lobby team selection, session-wide kill feed. | Unit tests for each rule; full suite green. |
| 2 Model V-773 | One skinned mesh (merged smooth parts, blended skin weights at joints, bones per spec), pearl `MeshPhysicalMaterial` (clearcoat + sheen), eyes as oval sclera + outline + pupil + highlight on the head bone, team accent rim + name tag. Inspection page `client/viewer.html`. | Four-view screenshot compared with Reference A. |
| 3 Animation | Pose-layer animation system: locomotion blend space (idle/walk/run/sprint × fwd/back/strafe/diag) with phase driven by distance travelled (no foot sliding), crouch, jump/fall/land, upper-body layer (aim/shoot/reload/switch/throw/knife), full-body overrides (hit, death, respawn, victory); exponential cross-fade; two-bone IK for the support hand. | Viewer state buttons + screenshots; unit test for state transitions. |
| 4 Camera | Over-the-shoulder camera with collision sweep, aim zoom, sensitivity setting; shot = camera ray → target point → server ray from eye to that point; tracer from muzzle to the server-confirmed hit point. | Automated crosshair/impact alignment check. |
| 5 Arena | New `arena-view.js` for NEON FACILITY using the shared colliders; containers + A-site added to `shared/map.js` (kept point-symmetric); navy/neon materials, floor strips, catwalk rails, lights, bloom-like glow sprites. | Map tests (symmetry, reachability, spawn clearance) + screenshots. |
| 6 Weapons | Five distinct procedural models with muzzle sockets; flashes, impacts, explosion particles, recoil; audio. | E2E: each weapon fires/damages via server. |
| 7 Multiplayer | Remote players driven by snapshot interpolation + synced animation state; multi-client headless test (2 and 4 clients). | Playwright multi-page test against the real server. |
| 8 UI | Reference-B HUD (scores, timer, round x/10, minimap, kill feed, chat, health, weapon panel), menus, lobby with teams, settings, pause, scoreboard, results. | E2E clicks every button. |
| 9 Mobile | Landscape touch layer: joystick, look pad, fire/aim/reload/jump/crouch/sprint/switch/grenade/knife; safe areas; gesture suppression. | Playwright touch emulation. |
| 10 Audio/FX/perf | WebAudio synthesized sounds; Low/Medium/High presets, resolution scale, shadows toggle; measured FPS. | PERFORMANCE_REPORT with real numbers. |
| 11 QA | Docs, README, screenshots, final report with PASS/PARTIAL/FAIL/BLOCKED. | — |

Known external limits up front: there is one machine and no physical phone in this environment, so real phone↔desktop Wi-Fi play can only be simulated (multiple browser clients over the LAN interface); it will be reported as such.
