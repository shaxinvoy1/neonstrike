# NEON STRIKE — PHASE 4 (COMBAT) TAKEOVER REPORT

Generated: 2026-09-18 · Mode: real-window (real GPU) · Machine: linux, DISPLAY=:0

This is a **takeover completion** report: Phase 4 was already partially implemented
by a previous agent. Nothing was restarted from scratch. Every PASS below corresponds
to a real executed check.

---

## 1. Starting state (takeover audit)

- Repository: `/home/paulinaj/neon-strike` — **no git repository** (filesystem only).
- Baseline `npm test`: **102 / 102 PASS** (6 unit test files).
- Phase 0–3: complete. Phase 4: partially implemented. Phase 5+: not started.

### What was already complete (Cline) — verified, NOT rewritten

| File | State |
|---|---|
| `shared/weapons.js` | Complete: 4 weapons, cadence, ammo, reload, switch, deterministic spread, falloff, HIT_ZONES |
| `shared/health.js` | Complete: HP, duplicate damage-event guard, deterministic death, bounded damage log |
| `shared/hitdetect.js` | Complete: reuses `rayAABB`, origin validation, wall blocking, tie→wall, hit zones |
| `shared/respawn.js` | Complete: `validateSpawn` (`headroomClear`+`groundHeight`), `pickSpawn`, `applyRespawn` |
| `shared/grenade.js` | Complete: gravity, sub-stepped AABB bounce, rest budget, fuse, radial damage, LOS, self-scale |
| `shared/combat.js` | Complete engine: targets, hitscan, grenades, player damage/death/respawn, snapshot, allocation-free frames |
| `client/js/game/weapon-view.js` | Complete: procedural low-poly weapons + muzzle nodes |
| `client/js/game/effects.js` | Present: pooled flash/tracer/spark/blast |
| `client/js/game/input.js` | Present: Phase 4 intents (fire/firePressed/reload/switchQueue) |
| `test/unit/{weapons,combat,grenade}.test.js` | Present and passing |
| `tools/verify-phase2.mjs`, `tools/verify-phase3.mjs`, `tools/lib/shot-helpers.js` | Present, untouched |

### What was missing / broken (the actual work)

1. **`client/js/game/combat.js` did not exist** — no client combat controller (intents → engine → VFX/HUD wiring).
2. **`client/js/game/hud.js` did not exist** — no combat HUD (crosshair/weapon/ammo/HP/reload/feedback).
3. **`client/index.html` / `client/css/hud.css`** had no combat HUD markup/styles.
4. **`client/js/game/index.js`** never created or stepped a combat state; `main.js` had no combat QA surface.
5. **`tools/verify-phase4.mjs` did not exist** — no Phase 4 browser verification.
6. **`client/js/game/targets.js` was broken**: it called `state.addTarget(...)` / `state.removeTarget(...)`
   as *methods*, but `shared/combat.js` exports them as **free functions**. Registration would throw;
   combat was unusable end-to-end.
7. **`shared/combat.js`**: `stats.damageTaken` was never initialised → `damagePlayer()` produced `NaN`.
8. **`client/js/game/effects.js`**: `update()` read `e.mesh.material.opacity` on a `THREE.Group`
   (blast) → `undefined.opacity` crash whenever a blast was active.
9. **`client/js/game/hud.js` (new)**: the crosshair spread variable must be set with
   `style.setProperty('--gap', …)`, not `style['--gap']` (the latter is silently ignored).
10. Session reset did not reset per-slot weapon stats → ammo accounting (`mag+reserve+shotsFired`) broke after reset.
11. `R` was bound to "reset session"; the Phase 4 spec requires `R = reload`, so reset moved to `P`.

---

## 2. What I changed

### Created
- `client/js/game/combat.js` — local combat controller. Owns the shared `createCombatState`
  (position aliased to `Movement.pos`), computes the aim ray from camera yaw/pitch + eye height,
  maps intents → `stepCombat`, translates result events into pooled VFX + HUD, syncs target
  visuals, handles respawn (camera + movement reset). No networking, no Three.js rules.
- `client/js/game/hud.js` — combat HUD manager (cached DOM writes): dynamic crosshair (spread-based gap),
  hit-marker, damage flash, weapon name/slot chips, ammo, reload bar, HP bar/band, kills/deaths,
  kill-feed, downed/respawn overlay.
- `tools/verify-phase4.mjs` — real Chrome CDP harness, self-hosted ephemeral server, gates P4.1–P4.20.
- `logs/phase4-report.md` (this file).

### Modified
- `shared/combat.js` — initialise `stats.damageTaken: 0` (fixes NaN accounting).
- `client/js/game/targets.js` — use **free functions** `addTarget`/`removeTarget`; added real
  600 ms death fade (scale-down → hide) and clean respawn restore; added `probe()` for QA.
- `client/js/game/effects.js` — added pooled **death puff**, `POOL.PUFF`, per-instance spark tint,
  and recursive `_setOpacity` (fixes the Group-material crash).
- `client/js/game/index.js` — instantiate `CombatController`; step it each frame with intents;
  `P` = reset session; combat block in `diagnostics()`.
- `client/js/game/debug-overlay.js` — COMBAT line (weapon/ammo/HP/status).
- `client/js/main.js` — combat HUD refs, `version: 4`, `phase: 'phase4-combat'`, full QA API
  (`combatQa`, `combatSnapshot`, `weaponProbe`, `hudState`, `probeTarget`, `aimAt`, `targetVisuals`, …).
- `client/index.html` — Phase 4 title/labels, combat HUD markup (crosshair, hitmarker, ammo, HP, reload,
  slots, feed, downed overlay), updated hint (`LMB` fire, `R` reload, `1–4` weapons, `P` spawn).
- `client/css/hud.css` — combat HUD styling.
- `test/unit/combat.test.js` — 2 new tests: real grenade self-damage path (straight-down throw → detonation
  → `selfDamage`/`damageTaken` accounting) and damage-accounting finiteness.
- `test/unit/smoke.test.js` — phase marker updated to Phase 4 and **strengthened**
  (asserts `version: 4`, `combatQa`/`aimAt` hooks, `combatHud`/`chCrosshair`/`chReload` elements).

**Not touched:** `tools/verify-phase2.mjs`, `tools/verify-phase3.mjs`, `server/`, `shared/map.js`,
`shared/protocol-consts.js`, `shared/collision.js`, `client/js/game/training.js` (frozen/regression-safe).

---

## 3. Results

### Unit tests — `npm test`
```
# tests 104
# pass 104
# fail 0
```
(102 baseline + 2 new Phase 4 tests.)

### Browser verification (real Chrome, real GPU)

| Harness | Result | Note |
|---|---|---|
| `node tools/verify-phase2.mjs` | **42 / 42 PASS** | requires `npm start` (port 3000) — Phase 2 harness does not self-host |
| `node tools/verify-phase3.mjs` | **25 / 25 PASS** | ephemeral server, real window |
| `node tools/verify-phase4.mjs` | **22 PASS / 0 FAIL** | gates P4.1–P4.20, ephemeral server, real window |

Phase 4 gate coverage:

```
P4.1  real WebGL2 + real GPU (SwiftShader rejected)
P4.2  combat module loaded
P4.3  Phase 4 version (__neon.version=4 + combat engine v4)
P4.4  Phase 1 WebSocket baseline alive
P4.5  real click starts TRAINING + combat HUD/API active
P4.6  Pointer Lock acquired
P4.7  crosshair present, centred, really painted (DOM capture validated + pixel diff)
P4.8  procedural weapon on screen (muzzle projection) + hidden-frame diff
P4.9  aim math (camera yaw/pitch -> ray, |dir|=1, muzzle aligns)
P4.10 REAL LMB fire (ammo consumed via production path)
P4.11 cooldown: ~11 shots per 1.0 s hold (600 RPM) + in-interval rejects
P4.12 ammo integrity: mag+reserve+shotsFired = const, never negative
P4.13 reload via real R: blocks fire, refills exact deficit
P4.14 real damage to dummy-1 (HP 100 -> 74)
P4.15 wall blocks shot (blocked counted, HP unchanged) behind crate-2
P4.16 target death (600 ms fade) and respawn after 2500 ms
P4.17 real grenade self-damage + player death -> auto respawn (HP/ammo/spawn restored)
P4.18 weapon switching (draw blocks fire) + grenade thrown & detonated
P4.19 zero console/runtime errors
P4.20a performance under fire, P4.20b Phase 3 regression
```

### GPU evidence
```
renderer = "ANGLE (Intel, Mesa Intel(R) Graphics (RPL-P), OpenGL 4.6)"
software = false   (no SwiftShader / llvmpipe)
webgl2   = true
```
`--headless` intentionally **FAILS P4.1** (headless here only exposes SwiftShader); the harness
is designed to be run in real-window mode for GPU evidence.

### Performance (measured while holding fire)
```
FPS ema 99.97 · avg 100 · min 99.01 · max 101.01   (240-frame window)
CPU submit 1.2 ms   (budget < 16.6 ms)   [1.4–1.5 ms across runs]
draw calls 156      (budget <= 165)
triangles  22538    (budget <= 32000)
real-time shadows: OFF
```
Gameplay cadence proof: 600 RPM rifle fired exactly 10 shots per 1.0 s hold, with 90 cooldown rejects.

### Screenshots / artifacts
- `logs/phase4-report.json` — full machine-readable report (gates, GPU, perf, errors, artifact list).
- `logs/p4-01-weapon-on.png`, `logs/p4-02-weapon-off.png` — weapon visibility evidence.
- `logs/p4-04-hud-on.png`, `logs/p4-05-hud-crosshair-off.png`, `logs/p4-06-hud-all-off.png` —
  HUD/crosshair paint evidence (DOM-capture-validated composited screenshots).
- `logs/p4-03-final.png` — final gameplay frame.
- Phase 2/3 artifacts (`phase2-report.json`, `phase3-report.json`, `p2-*`, `p3-*`) preserved.

---

## 4. Known non-blocking issues

- **Phase 2 harness needs a running server.** `tools/verify-phase2.mjs` uses
  `NEON_URL || http://localhost:3000` and does not self-host. Run `npm start` first
  (as done here). Not a regression; unchanged by Phase 4.
- **Headless mode has no real GPU here** → P4.1 will fail by design under `--headless`
  (SwiftShader only). Also, headless throttles to ~20 FPS so Phase 3's FPS gate fails there too.
- `Page.captureScreenshot` can return a stale composited frame; the harness now mitigates this by
  waiting for settled DOM paint and validating capture with a sentinel element before trusting a diff.
- The player "self-damage" path is exercised two ways: a **real thrown grenade** at a wall (P4.17a) and
  the shared `damagePlayer(..., 'grenade')` application path (P4.17b, the same call the detonation uses).
  No PvP / networked damage exists (by scope).

## 5. Phase 5+ confirmation

Phase 5+ was **NOT** implemented. No authoritative/server-side combat, PvP, lobby, snapshots,
reconciliation, interpolation, teams, rounds, score, chat, matchmaking, accounts, or networking
gameplay was added. `server/app.js` is unchanged (still handshake/ping only), `protocol-consts.js`
is unchanged, and combat logic lives in pure, DOM-free, Three.js-free `shared/` modules ready for a
later authoritative reuse. Phase 4 is a local/offline combat + training implementation only.
