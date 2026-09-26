# NEON STRIKE — POST-P12 PRODUCT / GAMEPLAY / UX / VISUAL / ENGINEERING AUDIT

**Scope:** audit only. No source, test, `package.json`, or asset was modified. The only
file added is this report (plus its JSON twin). P11 remains **PARTIAL — TWO-DEVICE LAN QA
BLOCKED**; nothing here changes that.

**Method:** every finding below is traced to actual source or measured in the real running
game (`node server/index.js` + real Chrome 143, ANGLE/Intel Mesa RPL-P, WebGL2). Root-cause
claims for the camera/aim defects were verified three ways: source trace, a three.js r160
ground-truth projection using the project's own vendored `vendor/three.module.js`, and a live
runtime probe through the game's own `__neon` QA API.

---

## 1. EXECUTIVE SUMMARY

Neon Strike is a **technically sound, architecturally disciplined, productly incomplete**
game. The engineering layer (authoritative server, lobby, synchronization, match/round/score,
HUD-from-server, hardening) is genuinely good and empirically verified. The **player-facing
layer is not yet an FPS**: two independent core-mechanic defects make aiming unusable, the
character/weapon presentation is placeholder-grade, and an entire layer of expected product
surface (settings, audio, animation, multiplayer feedback, scoreboard) does not exist.

**Verdict: NOT a polished playable product.** It is a *correct engine with a prototype game
on top of it*.

### The two blockers (P0) — both measured, not inferred

| # | Defect | Measured evidence |
|---|---|---|
| **B-01** | **Horizontal mouse look is inverted.** Mouse right turns the camera **left**. | `camera-controller.js:31` does `yaw += dx * SENS`. Live probe: `lookBy(+100,0)` → `yaw 0 → 0.22` → view swings toward world `+X`; a projection test proves `+X` renders at **screen-left** (pixel 582 vs 700). Canonical three.js `PointerLockControls` does the opposite: `_euler.y -= movementX`. |
| **B-02** | **The crosshair is not where bullets go.** The shot ray is offset **0.55 m laterally** from the crosshair ray, at *every* distance (parallel rays). | Live: settled `camera=(0.55,1.62,-23.4)` vs `eye=(0,1.62,-20)` → `lateralOffsetM = 0.5500`, `verticalOffsetM = 0`. Aiming the **shot** ray at a real dummy (11.31 m) leaves that dummy at **`ndc.x = +0.5`** — a quarter of the screen away from the crosshair. |

Both share one root cause: **the project builds its horizontal frame from `cross(up, forward)`
where three.js's camera uses `cross(up, −forward)`**. That single wrong-handed choice makes the
yaw axis invert (B-01) *and* mirrors strafe (B-03: at yaw 0, `D` moves world `+X` = screen-left).

### Severity roll-up

| Severity | Count | Meaning |
|---|---|---|
| P0 — game-blocking | 2 | Cannot aim or look correctly; not playable as an FPS |
| P1 — core gameplay broken | 4 | Strafe mirrored; no PvP hit feedback; tracer/VFX origin is a third, unrelated ray; grenade does no enemy damage |
| P2 — major product gap | 8 | Settings absent, audio absent, character/weapon presentation placeholder, solo match cannot end, local kill counters shown as authoritative, round timer never shown, training dummies live on the match map, own model has no team identity |
| P3 — polish / UX | 10 | No recoil, no scoreboard, no media queries, FOV/sensitivity hardcoded, no kill feed across players, weapon not held in hands, etc. |
| P4 — optional | 3 | Dead legacy files, log-artifact hygiene, extra maps/modes |

---

## 2. CURRENT PRODUCT STATE

**Engineering (P1–P12): strong and verified.**
- Authoritative server: 30 Hz sim / 20 Hz snapshots, input sequence + ack, interpolation,
  reconciliation, join-in-progress, idempotent match transitions, bounded queues.
- 304 declared unit tests; P10 measured 257/257, P12 287/287 (suite grew), P2–P11 verifiers green.
- Security: no client→authority path (static scanner), forged team/score/round/HP/ammo rejected.
- Performance headroom is large: **100 FPS** at 2560×1309, 58–89 draw calls, 5.5k–12.4k triangles,
  CPU 0.9 ms/frame, server tick ~0.41 ms against a 33.3 ms budget.

**Product (what a player actually gets): placeholder.**
- 1 procedural map (44×32 m), 4 weapons, 1 game mode (rounds to 5), 2 teams.
- Character = capsule/sphere/box humanoid (14 parts, flat Lambert), no held weapon, no
  aim/fire/reload animation, walk cycle = two leg pivots + a lean.
- **No audio of any kind** (zero audio code in the repository).
- **No settings of any kind** (only a disabled `SETTINGS — TEZ KUNDA` button).
- No scoreboard, no kill feed across players, no damage numbers, no round clock.
- Menu has 2 permanently disabled buttons ("coming soon").

---

## 3. COMPLETE BUG LIST

### P0 — game-blocking

**B-01 — Mouse look Y-axis (horizontal) is inverted**
- Evidence: `client/js/game/camera-controller.js:31` `this.yaw += dx * CAMERA.SENSITIVITY;`
  Runtime: `lookBy(+100,0)` → `yaw 0 → 0.22`, new view dir `+X`; `+X` = screen-left.
  Reference: `three.js r160 PointerLockControls.onMouseMove` → `_euler.y -= movementX * 0.002`.
- Impact: every mouse-drive engagement is unusable.

**B-02 — Crosshair and shot ray are different rays (0.55 m constant lateral offset)**
- Chain: `combat.js:71-84` builds `aimDir` from camera yaw/pitch (correct direction) but
  `aimOrigin` = **player feet + EYE**. The crosshair is the camera's screen-centre ray, whose
  origin is `pivot − fwd·3.4` with `pivot = player + right·SHOULDER(0.55)`. Parallel rays,
  different origins ⇒ constant 0.55 m miss. Server agrees with the client (`session.js:340`
  `aimOrigin = position + PLAYER.EYE`) so the error is systematic, not lag.
- Impact: hits do not occur where you aim. (The playtest's "hits 8 / blocked 22" in training is
  the user unconsciously compensating.)

### P1 — core gameplay broken

**B-03 — Strafe direction is mirrored (same root cause as B-01)**
- `shared/movement.js:70-71`: `wishX = sy*forward + cy*right`, and
  `camera-controller.js:38/48` define `right = (cos yaw, −sin yaw)`. At yaw 0 that is `+X`,
  which the camera renders on the **left**. So `D` strafes left. `three.js` uses the camera's
  local **+X column** for right.
- Source-derived (high confidence); not yet runtime-verified with WASD.

**B-04 — No player-visible feedback for multiplayer hits/kills/damage**
- `client/js/main.js:181` receives `MSG.EVENTS` and **only stores** them for QA
  (`state.lastEvents`). It never calls `hud.hitMarker()`, never spawns a spark, never adds a
  kill-feed line. The only hit feedback path is the **local predictor**, whose target list is
  the training dummies (`TargetRegistry(training, …)`), which contains no remote players.
- Impact: in a real match you fire at an enemy, get **zero** confirmation (no hitmarker, no
  sound, no damage number, no feed), then die or kill invisibly.

**B-05 — Three different origins for one shot (aim model is inconsistent, not hybrid)**
| Consumer | Origin used | Direction |
|---|---|---|
| Hit resolution (client **and** server) | player eye (`pos + 1.62`) | camera `fwd` (parallel-offset) |
| Crosshair (screen centre) | camera position (`pivot − 3.4·fwd`) | camera `fwd` |
| Tracer + muzzle flash | weapon muzzle (≈0.32 right, 1.28 up, 0.8 fwd) | → local hit point |
- Additionally the local tracer's end point comes from the **local** prediction (dummies/walls),
  not the authoritative result, so in PvP the visible bullet path is not the authoritative path.
- Answer to "muzzle-based / camera-ray / hybrid?" → **none of them: inconsistent.**

**B-06 — Energy Grenade cannot damage enemies**
- `shared/grenade.js:140` `if (kind === 'player') amount *= cfg.selfDamageScale;` with the comment
  *"Phase 4: faqat o'z granatasi"* (only your own grenade). P8 documented this as a limitation.
- Impact: 1 of 4 weapons is non-functional offensively; the "grenade viability" column of any
  map audit is currently moot.

### P2 — major product gap

**B-07 — A solo match can never end (observed live)**
- `match.js: startMatch()` accepts one player → `teams = {A:[p2], B:[]}`;
  `evaluateRound()` returns `null` unless `teamsComplete()`; so state stays `LIVE` forever.
- Compounding: there is **no in-game "leave session" control** (the leave button lives in the
  lobby panel, which is hidden in-game), and `main.js:404`
  (`if (st.state === 'in_game' && !(game && game.running)) startSession()`) auto-re-enters the
  stage whenever a lobby state arrives. The playtest user hit exactly this and had to relaunch.
- Severity note: the *stuck* outcome depends on broadcast timing, but "a solo start creates a
  match that cannot conclude" is unconditional.

**B-08 — Match HUD KILLS/DEATHS are local predictor values, presented as authoritative**
- `hud.js:182-183` reads `snap.stats.kills` / `snap.deaths` unconditionally, even when
  `auth.authoritative === true`. There is no server-side per-player kill counter at all
  (the snapshot carries `alive`/`hp`/`teamId`, not kills). So P9's "HUD is authoritative"
  holds for HP/ammo/team/round/score but **not** for kills/deaths.

**B-09 — Round timing is transmitted but never shown**
- `matchSnapshot()` emits `roundEndsIn` and `roundDurationMs`; `hud-state.js` consumes neither;
  no DOM element exists for a round clock. Dead data / missing player information.

**B-10 — Training dummies are baked into the match map**
- `shared/map.js TRAINING_DUMMIES` = 5 dummies, two of which (`dummy-1/2` at x=−16) sit **inside
  spawn A's zone**. They absorb local shots (producing "hits" that deal no PvP damage) and
  clutter spawn sightlines.

**B-11 — Settings subsystem does not exist** (see §10).

**B-12 — Audio subsystem does not exist** (see §11).

**B-13 — Own player model has no team identity**
- `createPlayer()` uses default (cyan/team-A) materials always; only remotes are team-coloured
  (`multiplayer.js:145-149`). So a team-B player sees a team-A-coloured own body/weapon.

**B-14 — Two menu buttons are permanently dead**
- `client/index.html:23-24`: `SETTINGS` and `HOW TO PLAY`, both `disabled` + "TEZ KUNDA".

### P3 — polish / UX

- **B-15 No recoil model.** Only static per-weapon `spreadDeg.base/moving`; no per-shot kick, no
  pattern, no recovery, no view-punch. `weapons.js` has `spreadDeg` and nothing else.
- **B-16 Asymmetric pitch clamp** `PITCH_MIN -0.95 / PITCH_MAX 0.62` → looking up is capped at 36°.
- **B-17 No scoreboard** (Tab) — teams/scores exist server-side but only appear as a one-line chip.
- **B-18 No cross-player kill feed.** `hud.pushFeed()` is only called from local predictor events.
- **B-19 No damage direction indicator**, no low-HP vignette/heartbeat (HP band only recolours the bar).
- **B-20 No media queries at all in `hud.css`**; all HUD elements are absolutely positioned with
  fixed offsets. Small-viewport behaviour is untested-by-design.
- **B-21 FOV (74) and sensitivity (0.0022) are hardcoded**; no way to change either.
- **B-22 Weapon is not held by the character** — the gun floats on a mount at the right shoulder;
  arms never meet it (kills character believability in third person).
- **B-23 No weapon VFX beyond pooled flash/tracer/spark**; no shell ejection, no impact decals,
  no reload feedback on the model, no weapon bob/sway.
- **B-24 No respawn/spectate state in round mode** — dead = frozen camera on your own body until
  the next round (documented, but a UX dead zone in a 5-round match).

### P4 — optional / hygiene

- **B-25 Dead legacy files** `shared/arena.js`, `client/js/game/arena-mesh.js` (kept deliberately;
  `smoke.test.js:74-79` asserts the new code does **not** reference them).
- **B-26 `logs/` holds 40+ phase screenshots + reports** (~5 MB) — release hygiene only.
- **B-27 No second map, no alternate mode, no unique per-map mechanic.**

---

## 4. COMPLETE MISSING-FEATURE LIST

| Area | Missing |
|---|---|
| Settings | mouse sensitivity, invert Y, FOV, graphics quality, FPS toggle, master/SFX/Music volume, crosshair options, key rebinding, reset-to-defaults, apply/cancel |
| Audio | everything: fire, hit, kill, damage, death, reload, switch, footsteps, round start/end, UI clicks, chat ping |
| Character | held weapon, aim pose, fire pose, reload animation, strafe/idle/death/respawn animation, team identity on own model, nametags |
| Weapons | recoil, ADS (if desired), reload/fire/switch animations, shell/impact FX, muzzle flash quality, ammo pickups |
| Multiplayer feel | hit confirmation, damage numbers, shared kill feed, scoreboard, teammate indicators |
| Match flow | round clock, countdown, round-end/match-end presentation beyond a text banner, rematch, spectator, warmup |
| Menu/UX | settings screen, how-to-play, loading/connect progress, error toasts, confirmations, quit/disconnect control in-game |
| Onboarding | tutorial/practice separation (training is currently the only offline mode and shares the match map) |
| Level design | spawn safety rules, anti-camp, second map, objective mode, more verticality |

---

## 5. CAMERA / AIM / SHOOTING — ROOT-CAUSE ANALYSIS

### 5.1 The architecture as it exists
```
input.js  ──mousemove(pointer-locked)──►  mouseDX/mouseDY  ──►  CameraController.look(dx,dy)
                                                                    │
                                      yaw += dx·0.0022   (B-01 inverted)
                                      pitch = clamp(pitch − dy·0.0022, −0.95, 0.62)
                                                                    │
                                    CameraController.update(): pivot = player + right·0.55 + (0,1.62,0)
                                                             camera = pivot − fwd·3.4   (sweep-clamped)
                                                             camera.lookAt(pivot + fwd·1.8)
                                                                    │
        ┌───────────────────────────────┬───────────────────────────┴────────────────────┐
   CROSSHAIR (screen centre)      SHOT RAY (client + server)                    TRACER / FLASH
   origin = camera position      origin = player feet + EYE(1.62)              origin = weapon muzzle
   dir    = fwd                  dir    = fwd (same!)                           end = LOCAL predictor hit
        └──────── 0.55 m apart, parallel (B-02) ───────────┘                     └── 3rd ray (B-05) ──┘
```

### 5.2 Why the look inverts (B-01)
`yaw` is defined so that `fwd = (sin yaw, 0, cos yaw)`. At `yaw = 0` the camera looks down `+Z`,
and the camera's local `+X` (screen right) evaluates to `(−1, 0, 0)`. Therefore `d(fwd)/d(yaw) =
(cos yaw, 0, −sin yaw) = −screenRight` — **increasing yaw turns the view left**. Because the input
adds `+dx`, mouse-right turns left. Verified twice:
- three.js ground truth (`vendor/three.module.js`): `viewDir=[0,0,1]`, `SCREEN-RIGHT=[−1,0,0]`;
  world `x=+2, z=10` projects to `px.x = −0.265` (left).
- Live game: `+2` east of the player → pixel **582**, `−2` → pixel **700** (centre 640).

### 5.3 Why the shot misses the crosshair (B-02)
The two ray origins differ by `sep = eye − camera = screenRight·SHOULDER + fwd·DISTANCE`.
The `fwd` component does not change the line; the residual `screenRight·0.55` is **perpendicular**,
so the shot ray is a *parallel translation* of the crosshair ray. A parallel offset never closes:
the miss is **0.55 m at 2 m and 0.55 m at 60 m**. Measured: `lateralOffsetM = 0.5500`.
At 11.31 m the target sits at `ndc.x = +0.5` after being hit — the player is given no visual
reason to connect crosshair to impact.

### 5.4 The correct target model (one coherent authoritative aim)
Pick **one** model and apply it in `shared/` so client and server cannot drift:

**Recommended: eye/muzzle origin + converged direction (the standard third-person solution).**
1. Compute the crosshair's world target once per frame from the **camera**: `P = camera.position +
   fwd · AIM_DISTANCE`, where `AIM_DISTANCE` = distance to the first solid hit along the camera ray
   (reuse `rayAABB` over `SOLID_BOXES`) so `P` lands on real geometry, not empty air.
2. Shot direction = `normalize(P − shotOrigin)`.
3. `shotOrigin` = **server-owned** (`server/session.js` already owns it; keep it that way —
   never accept a client origin).
4. `aimDir` in the INPUT message becomes that **converged** direction (not raw `fwd`).
5. Tracer/flash draw from the muzzle **to the resolved hit point** so the visual and the
   authoritative outcome agree.

Alternative if first-person is chosen instead: collapse `SHOULDER → 0`, `DISTANCE → 0` so
camera ≡ eye, and B-02 disappears by construction. **This is a product decision** (see §8).

### 5.5 The one-line danger
Do **not** "just invert the sign". B-01 and B-03 share the same handedness error in two files
(`camera-controller.js:38/48` and `shared/movement.js:70-71`). Fixing only the mouse leaves
strafing mirrored; fixing only strafe leaves the mouse mirrored. Introduce **one** shared
`basisFromYaw(yaw)` helper in `shared/` and make both call sites use it.

---

## 6. CHARACTER / 3D PRESENTATION AUDIT

| Item | Current | Target direction |
|---|---|---|
| Construction | `player.js` — capsules/spheres/boxes, 14 parts, `MeshLambertMaterial` + 3 `MeshBasicMaterial` accents | Stylized low-poly tactical silhouette, readable at 30 m |
| Silhouette | Roughly human; no helmet/visor volume, no shoulder pads, no chest rig | Distinct head/shoulder/torso read; identity at distance |
| Materials | Flat Lambert, no metalness/roughness, no rim light; "neon" is 3 basic-material strips | Emissive trim + contrasting body; strong rim on dark bg |
| Weapon | **Not held** (`weapon-view.js` mounts at `(0.3,1.28,0.18)` on the rig, arms never connect) | Rifle in hands, muzzle aligned to the aim ray |
| Blob shadow | Canvas radial-gradient plane, `shadowMap` off — cheap and effective | Keep (P10-friendly) |
| Team identity | Remotes coloured by team (`multiplayer.js:145-149`); **own model always cyan** | Own model + weapon trim also team-coloured |
| Animation | `animateHumanoid` — 2 leg pivots + 2 arm pivots + 0.07 rad lean | idle/walk/run/strafe/aim/fire/reload/death/respawn |
| Remote presentation | Interpolated transform only (`RemotePlayer`) | + animation state, nametag, alive/dead pose |

Feasibility: everything above is reachable **procedurally or with a small hand-built low-poly
glTF** (one ~1–2k-triangle character + one gun mesh). No asset pack is required, no texture
larger than 512², and no animation library — a hand-authored 6–10 clip set driven by the existing
`RemotePlayer`/local state machine suffices. Estimated cost: **+1–3 draw calls per character**
(merge the body into 2–3 meshes with vertex-coloured team trim instead of 14 meshes).

---

## 7. WEAPON SYSTEM AUDIT

| Weapon | Damage / TTK (100 HP) | Cadence | Mag | Range | Assessment |
|---|---|---|---|---|---|
| NEON RIFLE | 26 body → 4 shots (~400 ms); 52 head → 2 shots | 600 rpm auto | 30/120 | 60 m | Sound baseline. Spread 0.6°/1.4° |
| PULSE PISTOL | 34 → 3 shots (~300 ms + trigger pacing) | 400 rpm semi | 12/60 | 50 m | **Overtuned**: more per-shot damage *and* tighter spread (0.35°) than the rifle, with 50 m range. Likely beats the rifle at range |
| SCATTER SHOT | 9×12 = 108 close → 27 at 18 m | 75 rpm semi | 6/30 | 18 m | Fine; falloff is steep and readable |
| ENERGY GRENADE | 95 at centre — **vs nobody** | 60 rpm | 1/2 | 60 m | **Non-functional in PvP (B-06)** |

| System | State |
|---|---|
| Fire cadence / cooldown | ✅ server-authoritative, deterministic (`tryFire` + `nextFireAt`) |
| Ammo / reserve / reload | ✅ authoritative, deterministic PRNG spread, `MAX_PELLETS` bound |
| Switching | ✅ 300 ms draw with fire lockout; per-slot ammo persists |
| Falloff | ✅ linear, per weapon |
| Recoil | ❌ absent (spread only) |
| Spread | ✅ static per stance; ❌ no accumulation, no recovery, no pattern |
| VFX | ⚠️ pooled flash/tracer/spark/blast/puff — cheap and correct, but tracer origin/end wrong (B-05) |
| Hit feedback | ❌ none in PvP (B-04) |
| Weapon model | ⚠️ procedural boxes+box; serviceable placeholder, not production |
| Grenade | ⚠️ projectile physics + bounce + fuse exist and are correct; blast only self-damages |

Weapon balance note: distances in the map reach ~54 m diagonal, so the rifle covers the whole map
and the scatter's 18 m cap is the only genuine constraint. Any tuning pass should be paired with
the map work (P16) so that "rifle lanes" vs "shotgun rooms" actually exist.

---

## 8. MAP / LEVEL DESIGN AUDIT

**Geometry** (`shared/map.js`): 44×32 m, **180° centre-point symmetric**, 60 AABBs
(4 wall, 4 divider, 1 platform, 1 core, 28 stair, 2 catwalk, 10 pillar, 10 crate), 2 spawn zones
(5×3 m) at x = ∓19.5, lane strips rendered instanced.

| Principle (see §18) | Assessment |
|---|---|
| Lane structure | 3 lanes (MID / LONG / CATWALK) exists in data (`LANES`) — **good foundation** |
| Max engagement distance | **Too long**: spawn A → spawn B is a ~39 m straight, mostly open MID sightline. Valorant deliberately caps its longest fights at ~⅔ of Dust2's and adds angle density; here the single longest line runs from spawn door to spawn door **with no buy phase to absorb it** |
| Spawn safety | **Weak**: spawn zones are open-ended to MID; nothing prevents a straight-line peek into spawn |
| Cover in MID | Reactor platform (9×8 m, h 1.2) is the only hard mid cover; crates cluster toward lanes |
| Verticality | Limited: catwalk deck y 2.2 and reactor 1.2 → total 2 levels, 2.2 m. No vertical flanking above the deck |
| Chokepoints | 4 divider gaps at `|x| ∈ [11,13]` — widths are uniform (2 m), which matches the "standardised choke" principle |
| Off-angles | Divider tops are 3 m against a 4 m wall → you cannot shoot over them, but they create many near-degenerate crouch angles at the gaps |
| Training props on the match map | ❌ 5 dummies + 3 rings live permanently on the map (B-10); two dummies sit **inside spawn A** |
| Readability | ✅ callout plates + spawn plates + lane strips + reactor beam give usable landmarks; symmetric so both sides read identically |
| Lighting/contrast | ⚠️ hemisphere + 2 directional, fog 26→82, `shadowMap` off, blob shadows only. Dark-on-dark 0x0d1330 floor vs 0x141c46 walls with little value separation |
| Grenade viability | ❌ moot while B-06 exists |
| Team readability | ⚠️ remotes are team-coloured, but there is no nametag/outline — at 30 m a teammate and an enemy silhouette are identical apart from trim colour |

**Recommended direction (no rebuild):** keep the 3-lane skeleton and the symmetry; instead
(a) break the spawn-to-spawn line with mid cover, (b) pull the map's effective fight distance
down (Valorant's rationale: shorter = more consistent fights *and* cheaper rendering),
(c) give the catwalk a reason to exist (vertical flank with one more access), and
(d) move all training props into a separate practice scene (§17, B-10).

---

## 9. HUD / UI / UX AUDIT

**HUD element inventory** (`client/index.html`, `hud.css`, `hud.js`, `hud-state.js`)

| Element | State |
|---|---|
| Crosshair (spread-reactive) | ✅ present, correct, `--gap` driven by spread; live-verified centred (`dx=dy=0`) |
| HP + band colour | ✅ authoritative (`source:"server"` verified live) |
| Mag / reserve | ✅ authoritative |
| Weapon name + slot chips 1–4 | ✅ |
| Reload bar + % | ✅ |
| Team chip / own ID chip | ✅ from server |
| Round / score line + match HUD | ✅ from server |
| Round-end / match-end banner | ✅ from server winner |
| Connection chip | ✅ real WS state (verified: `ULANISH: SERVER` / ok) |
| Dead overlay | ✅ `ELIMINATED` (waits round) vs `DOWNED` (respawn timer) |
| Kill feed (`chFeed`) | ⚠️ local events only — no cross-player feed (B-18) |
| KILLS / DEATHS | ❌ local predictor values in match mode (B-08) |
| Round clock | ❌ missing though data exists (B-09) |
| Scoreboard | ❌ missing |
| Chat panel | ✅ session-local, server-routed, 160-char limit, `T`/Enter, maxlength enforced |
| Pause overlay | ✅ correct `hidden ⇒ display:none`; global `[hidden]{display:none!important}` at `hud.css:83` prevents the historical regression class. Live scan for hidden-but-visible found **none** across training→menu→match transitions |
| Settings screen | ❌ absent |
| How-to-play | ❌ absent |
| Loading/connect feedback | ⚠️ badges only; no blocking progress state |

**Transitions:** lobby → starting → live → round end → next round → match end all resolve through
the authoritative `match` block ✅ (verified live: `RAUND 1 · LIVE`, `JAMOA A`). The only
transition defect is the **in-game exit** (B-07) and stale-state risk is low because overlays are
driven from server state each frame.

**Layout:** no media queries; every cluster is absolutely positioned at fixed offsets
(top 14px/18px, bottom 14px/18px). At narrow viewports the top chip row (7 chips), the chat panel
(bottom-right) and the ammo block can collide. "Responsive" currently means "does not crash".

---

## 10. SETTINGS AUDIT

**Currently: nothing exists.** The only trace is `<button class="mbtn" disabled>SETTINGS <small>TEZ
KUNDA</small></button>`. There is no settings module, no persistence, no key remapping, no
quality/volume/FOV/sensitivity control anywhere in `client/js`.

Minimum professional set for **this** game (each must actually change behaviour):

| Setting | Why this project needs it | Type |
|---|---|---|
| Mouse sensitivity | Hardcoded `CAMERA.SENSITIVITY = 0.0022`; unusable across devices/DPIs | slider 0.0005–0.008 |
| Invert Y | Standard accessibility, cheap | toggle |
| FOV | Hardcoded 74; third-person OTS benefits from 70–90 | slider 65–100 |
| Graphics quality | Only available lever is DPR (currently capped 1.75) + antialias + fog distance | presets Low/Med/High → DPR/antialias |
| FPS counter | Exists (`hudFps`) but always on; make it a toggle | toggle |
| Master / SFX volume | Prerequisite for §11 audio | 2 sliders |
| Crosshair (colour + gap scale + dot) | Crosshair is already CSS-variable driven (`--gap`) — trivial to expose | 3 controls |
| Reset defaults | Standard | button |
| Key bindings | Lower priority; the existing set (WASD/R/1-4/T/F3/P/Shift) is small and documented in the HUD hint | defer to P3 |

Explicitly **not** needed: matchmaking, accounts, cloud sync, graphics API selection, resolution
pickers — they add surface area without improving this game.

---

## 11. AUDIO AUDIT

**Current: zero.** `grep -rn "AudioContext|new Audio|.play()|Howler|audio" client/ shared/` → **no
matches**. The game is completely silent.

Lightweight implementation path (no copyright risk, no dependency, ~0 bytes of assets):
1. **Synthesise with WebAudio** at runtime — an `OscillatorNode`+`GainNode`+noise buffer graph can
   produce a credible neon-sci-fi laser/reload/UI-click set in <200 lines. This matches the
   project's existing "procedural, no external assets" convention (`player.js` blob texture,
   `mapview.js` geometry, `effects.js` meshes).
2. Unlock the `AudioContext` on the same user gesture that requests pointer lock.
3. Voice budget: pool ~8 voices; hard cap so a 600 rpm rifle cannot spawn 10 nodes/frame.
4. Priority list: **fire → hit confirm → death/kill → reload → switch → UI click → round
   start/end → damage taken**. Footsteps last (needs listener/occlusion work; skip for now).

Keep `AudioContext` created lazily so headless verifiers are unaffected, and drive volume from
the §10 settings.

---

## 12. ANIMATION AUDIT

| Clip | Current | Needed for product |
|---|---|---|
| idle | ❌ static | subtle breathing + weapon idle sway |
| walk / run | ⚠️ single phase-driven leg/arm swing (same clip, frequency scaled by speed) | distinct walk/run cadence, foot plant |
| strafe | ❌ (walk clip plays; no lateral lean) | lateral lean + leg crossover or at minimum lean |
| aim | ❌ none — body yaw is *movement* direction (`faceYaw`), unrelated to aim yaw | upper-body aim layer (spine twist toward camera yaw) |
| fire | ❌ none | recoil punch + muzzle climb on the model |
| reload | ❌ none (only a HUD bar) | mag-out/in + bolt, ~60% of `reloadMs` |
| weapon switch | ❌ none (mesh appears/disappears) | lower/raise the weapon |
| death | ❌ none — body remains standing, HUD shows ELIMINATED | ragdoll-lite (fall/collapse) |
| respawn | ❌ none (teleport) | spawn-in effect |

The critical one is **aim**: `movement.faceYaw` lerps toward the *velocity* direction
(`shared/movement.js` end), and the weapon mount compensates with
`mount.rotation.y = camYaw − playerYaw`. Without an upper-body aim layer, the character always
faces where it walks while shooting sideways — a visible third-person defect in every engagement.

---

## 13. MULTIPLAYER AUDIT

Verified intact (P7–P12 + this audit's probes). Do not weaken:

| Property | Status |
|---|---|
| Server authority (HP/damage/death/ammo/cooldown/weapon/team/score/round) | ✅ |
| Input as *intent* only; `pose.x/z` ignored in-game (`session.js:315-339`, `poseIgnored` counter) | ✅ |
| `aimOrigin` computed server-side from authoritative position (`session.js:340-342, 401-404`) | ✅ *(this is exactly why the B-02 fix must stay server-side)* |
| Sequence/ack, 20 Hz snapshots, interpolation buffer (24 cap), reconciliation thresholds | ✅ (live: `snapshots:293`, `reconciliation.smoothings:292`, `maxError 0.28`) |
| Join-in-progress, disconnect cleanup, duplicate HELLO/JOIN/LEAVE idempotence | ✅ |
| Malformed/forged input containment | ✅ (`forbidden_authority`, `bad_pose`, `bad_aim`, `bad_seq`, `too_big`, close 1009) |
| Static client→authority scan | ✅ 0 violations (`tools/lib/authority-scan.mjs`) |

**Gaps (product, not security):** no per-player kill/death counters; no name tags; no team
indicator above remotes; EVENTS not consumed for feedback (B-04); no reconnect flow (honest
limitation); no spectator. Two-device LAN QA still unperformed (P11 PARTIAL, unchanged).

---

## 14. PERFORMANCE AUDIT

Measured on this machine (Intel i7-13620H, Intel RPL-P, ANGLE/Mesa, Chrome 143):

| Metric | Measured | Verdict |
|---|---|---|
| Client FPS | **100** (`fpsMin 99.01`), frame 10.0 ms, CPU 0.9 ms | Excellent headroom |
| Draw calls / triangles | 58 calls / 5,538 tri (settled) — 89 / 12,418 (busy) | Well within budget |
| Resolution | 2560×1309, DPR 1 | — |
| Shadows | `shadowMap: false`, blob shadows | Correct choice |
| Server tick (P10) | avg 0.425 ms, p95 0.69 ms, max 3.197 ms vs 33.3 ms budget (~1.3%) | Excellent |
| Server heap (P10 long run) | 12.3 → 50.8 MB, containers constant | Bounded |
| HUD DOM writes | 436 writes / 81,247 skips | ✅ measurement-backed |

**Budget for the roadmap:** the scene is currently ~60 draw calls and ~6–12k triangles at 100 FPS.
A stylized character (+2–4 calls each, up to 4 players ≈ +12), a held weapon (+1), impact decals
(1 pooled instanced mesh), and a WebAudio graph are all affordable **provided** the project keeps:
`shadowMap` off, no post-processing chain, textures ≤512², pooled effects (the existing pattern),
and procedural/vertex-colour materials instead of per-part meshes. Any phase that proposes
real-time shadows, SSR/bloom, or >1k-triangle characters must justify it against the P10 numbers.

---

## 15. SECURITY / AUTHORITY AUDIT

No new authority risk was found, and the existing posture is strong:

- Client-supplied `damage/hp/ammo/cooldown/hit/alive/teamId/score/roundState/roundWinner/playerId/
  senderId` are all rejected or ignored (`server/session.js` FORBIDDEN list; `shared/combat.js`
  never reads them).
- Identity is issued by the server (HELLO → server-assigned `pN`); host is server-assigned with
  deterministic transfer.
- Chat sender identity is server-derived; length/burst/window limits enforced.
- Payload ceiling 64 KiB at protocol level + 16 KiB app-level `too_big`.
- Static scan: 0 client→authority paths; a planted violation is detected (self-test).
- **Watch item for the polish phases:** the settings/audio/character work must not introduce a
  client-side HP/ammo/score mirror that is *displayed as authoritative*, nor a client-supplied
  shot origin. Keep §5.4's rule: **direction may come from the client, origin never may.**

---

## 16. TECHNICAL DEBT AUDIT

| Item | Classification | Evidence |
|---|---|---|
| No TODO/FIXME/XXX/HACK/TEMP markers anywhere | ✅ good | `grep` across `client/ shared/ server/ test/ tools/` → 0 |
| Dead legacy modules kept intentionally | P4 cleanup | `shared/arena.js`, `client/js/game/arena-mesh.js`; `smoke.test.js:74-79` asserts non-use |
| **Duplicated handedness constant in 2 places** | **P0 risk** | `camera-controller.js:38,48` and `shared/movement.js:70-71` each encode `right`; B-01/B-03 must be fixed at a single source or they will drift again |
| Phase labels inside player-visible copy | P3 | `index.html` "PHASE 9 — HUD · POLISH · CHAT", "PHASE 1 GATES (regressiya)", the whole Phase-1 dev panel visible on the menu, "PHASE 6 — LAN LOBBY" |
| The Phase-1 syscheck panel + Phase-6 lobby panel are always visible on the title screen | P3 UX | Reads as a dev build, not a product |
| Kill/death counters sourced from prediction | P2 | `hud.js:182-183` |
| Transmitted-but-unused match fields | P2 | `roundEndsIn`, `roundDurationMs` |
| Static (non-reactive) UI state | P3 | Training dummies on the match map, no nametags |
| Log/artifact sprawl | P4 | 40+ PNGs + 12 phase reports in `logs/` |
| Comments are thorough and accurate (Uzbek) | ✅ good | Consistent module headers; P10/P12 notes are honest |
| Repeated identical values in three places | ⚠️ watch | `PLAYER_MAX`, `SHOULDER`, weapon stats are single-sourced ✅ — keep it that way when adding settings |

---

## 17. VISUAL GAP ANALYSIS — CURRENT vs TARGET

| Aspect | HAVE | BROKEN | MISSING | PLACEHOLDER | NEEDS POLISH | DO NOT CHANGE |
|---|---|---|---|---|---|---|
| Camera | OTS 3.4 m, shoulder 0.55, sweep collision, smoothing | yaw inversion (B-01); crosshair/aim divergence (B-02) | FOV control, aim-distance convergence | — | pitch clamp asymmetry | collision sweep, damping, blob shadow |
| Aim/shooting | server-authoritative hitscan, falloff, hit zones, PRNG spread | crosshair ≠ shot; 3 different origins (B-05) | recoil, PvP feedback | — | tracer endpoints | determination of spread, hit zones, cooldowns |
| Character | procedural humanoid + team colours on remotes | own model not team-coloured | held weapon, aim layer, 8 clips | whole model | silhouette, materials, proportions | blob shadow, pooling |
| Weapons | 4 weapons, ammo/reload/switch/falloff authoritative | grenade no PvP damage | recoil, animations, VFX depth | gun meshes (boxes) | models, alignment to aim ray | state machine, cadence, server authority |
| Map | 44×32 symmetric, 3 lanes, 60 colliders, instanced | spawn-to-spawn sightline; dummies in spawn | cover plan, vertical flank, second map | training dummies on match map | cover placement, value contrast | symmetry, collider data format, instancing |
| Lighting | hemisphere + 2 directional + fog + neon trim | — | rim/emissive polish, contrast pass | palette | value separation | no-shadow choice, DPR cap |
| HUD | authoritative HP/ammo/team/round/score + chat | kills/deaths from prediction | scoreboard, round clock, feed | Phase-1 dev panel on the title screen | layout, hierarchy, responsiveness | server-driven state path, `[hidden]` rule |
| Menu/UX | host/join/leave/start flows all functional | in-game exit trap (B-07) | settings, how-to-play, loading, errors | 2 disabled buttons | visual language, copy (remove phase labels) | lobby protocol, server authority |
| Audio | — | — | everything | — | — | — |
| Multiplayer | interpolation + reconciliation + authority | no hit/kill feedback | nametags, scoreboard, spectator | — | netcode polish | authority model, snapshot cadence, queue bounds |

---

## 18. PROFESSIONAL FPS DESIGN PRINCIPLES (sourced)

**three.js `PointerLockControls` (r160, official example) — the reference input contract**
- Yaw uses an `Euler(0,0,0,'YXZ')` and applies `_euler.y -= movementX * 0.002 * pointerSpeed`;
  pitch applies `_euler.x -= movementY * …` and is clamped to the polar range.
  → *Mouse-right must decrease yaw in a Y-up, `-Z`-forward convention.* Neon Strike adds instead
  (B-01).
- `moveRight()` translates along `matrixColumn(camera.matrix, 0)` — the camera's **local +X**.
  → *Strafe must use the camera's right column*, not `cross(up, forward)`. Neon Strike uses the
  latter (B-03).
- `moveForward()` = `cross(camera.up, cameraRight)` — i.e. the horizontal projection of view
  direction. Neon Strike's forward vector matches this ✅ (only `right` is wrong).

**Tactical-FPS map principles (Valorant vs Counter-Strike design analysis, amist.co; Riot level
design; general 3-lane/choke doctrine)**
1. **Bound the maximum engagement distance.** Valorant deliberately keeps its longest sightlines
   at ~⅔ of Dust2's (≈ Inferno). Benefits stated by the designer: fights stay consistent, utility
   stays in range, and rendering cost drops. → Neon Strike's ~39 m spawn-to-spawn line should be
   broken.
2. **Standardise chokepoint widths** so a single area-denial tool can always contest them.
   → Neon Strike's 2 m divider gaps already follow this ✅ — keep the width uniform when adding
   cover.
3. **Raise the density of angles and corners to check.** Dense maps reduce "killed by a pixel
   across the map" and increase the meaning of every corner. → MID is currently one long box.
4. **Avoid headshot-only, impenetrable cover.** Valorant makes most walls/windows/doorways
   *penetrable*, explicitly to reduce defender advantage and the "duck in and out" frustration.
   → Neon Strike's hitscan already stops on walls; consider whether cover should be penetrable
   for the highest-tier rifle (a cheap, high-impact rules change) — **only if** the shot-origin
   model (B-02) is fixed first, otherwise penetration makes the aim error worse.
5. **Spawn areas are large but their cost is absorbed by a buy phase.** Neon Strike has no buy
   phase, so *spawn exposure must be solved geometrically*, not temporally.
6. **Give each map a unique mechanic** to differentiate it from commodity maps. → A candidate for
   the second map (P16), not a requirement for v1.

*(No assets, code, layouts, names, or content were copied — principles only.)*

---

## 19. PRIORITIZED REMEDIATION BACKLOG

Severity: P0 blocker · P1 core · P2 major gap · P3 polish · P4 optional.
Order = implementation order (dependency-respecting).

| ID | Title | Sev | Current state | Target state | Why it matters | Deps | Implementation notes | Verification |
|---|---|---|---|---|---|---|---|---|
| **R-01** | Fix horizontal look inversion | P0 | `yaw += dx·SENS` → mouse-right turns left | mouse-right turns right | Nothing else matters if you cannot look | — | Single shared `basisFromYaw()` in `shared/`; yaw sign per three.js reference (`−movementX`). Fix **both** `camera-controller.js:31` and the basis at `:38/:48` | Live: `lookBy(+100,0)` must move the view toward **screen-right**; a point at `+2 m` east must move toward centre |
| **R-02** | Fix strafe handedness | P0 | `D` strafes screen-left | `D` strafes screen-right | Same root cause as R-01; half-fixing leaves the frame mirrored | R-01 (shared helper) | Use the camera's local **+X** in `shared/movement.js:70-71`; delete the duplicate constant | Unit: at yaw 0, `right=+1` must produce `wishX` matching the camera's local +X; live A/D probe |
| **R-03** | Correct the aim model (crosshair ≡ shot) | P0 | parallel ray, constant 0.55 m offset | shot dir converges on the crosshair's world point; origin stays server-side | Core FPS correctness; every engagement is affected | R-01/R-02 (basis) | Per §5.4: compute the camera-ray world point (ray vs `SOLID_BOXES`), then `dir = normalize(P − origin)`; send the **converged** `aim.dir`; keep `aimOrigin` server-owned | Unit: `lateralOffset` between crosshair ray and shot ray → 0 at 2/10/40 m; live: aimed dummy sits at `ndc.x ≈ 0`; hit training dummy at 10/25/40 m with crosshair on it |
| **R-04** | One origin for VFX and hit | P1 | tracer from muzzle → **local** hit; hit from eye ray | tracer/flash from muzzle → **authoritative** hit point | You must be able to trust what you see | R-03 | Render tracers from authoritative EVENTS; keep local prediction only for the muzzle flash | Live: tracer endpoint equals the server event point; two-client test |
| **R-05** | Consume authoritative EVENTS for feedback | P1 | `main.js:181` stores events, shows nothing | hitmarker on hit, damage numbers, kill feed, death flash | PvP currently gives zero confirmation | R-03 | Translate EVENTS → `hud.hitMarker()`, feed entries, sparks; keep DOM writes cached (P10 pattern) | Two-client browser: A fires, B takes damage, **A sees a hitmarker**; server event ↔ client DOM evidence |
| **R-06** | Grenade damages enemies | P1 | self-damage only (`grenade.js:140`) | authoritative area damage to all players, falloff by distance, LOS-aware; keep self-damage at 0.6 | 1 of 4 weapons is dead content | R-03 | Server-side only; reuse `computeDamage` falloff curve; add a fuse/cook indicator to the HUD | Unit: enemy in radius takes scaled damage; server tick applies it exactly once; two-client proof |
| **R-07** | Settings system | P2 | none; disabled button | sensitivity, invert-Y, FOV, quality, FPS toggle, volumes, crosshair, reset | Without sensitivity/FOV the game is unplayable for many users; volume is a prerequisite for audio | — (FOV/sens interact with R-03) | `localStorage` persistence; a pure `settings.js` consumed by `CameraController` (sens/FOV) and renderer (DPR/antialias) | Unit: settings clamp/persist/defaults; live: change sens → measured yaw delta scales; change FOV → `camera.fov` changes |
| **R-08** | Remove training props from the match map | P2 | 5 dummies + 3 rings live on the map; 2 inside spawn A | match map clean; training runs in its own scene | Dummies eat shots and pollute spawn | — (independent) | Split `Training` scenes; server stops spawning dummies in-game | Live: match map has 0 dummies; existing P8/P9 match verifiers still pass |
| **R-09** | Solo-match lifecycle fix | P2 | 1-player start → `LIVE` forever; no in-game exit | refuse start without ≥1 per team **or** auto-end on unanimity; add in-game "leave match" | The playtest user was trapped and had to relaunch | — | Server decision; client gets a real exit control; keep auto-enter but gate it on membership | Unit: solo start rejected (or auto-concluded) deterministically; live: exit from a live match returns to lobby and frees the slot |
| **R-10** | Scoreboard + round clock + kill/death from server | P2 | kills/deaths from prediction; no clock; no scoreboard | server tracks per-player kills/deaths, ships them; Tab scoreboard; visible round clock | Removes a contradictory HUD (B-08) and dead data (B-09) | R-05 (event loop) | Add counters in `server/session.js`, fields in the snapshot, DOM in `hud.css` | Unit: server counters match kills; live: HUD kills == server kills after N kills |
| **R-11** | Team readability | P2 | no nametags; own model always cyan | nametags + team outline/trim for remotes; own model team-coloured | "Team identity immediately readable" | R-13 | Sprite/HTML tag projected from the snapshot; vertex-coloured trim | Live: two-client screenshot shows distinct team + tag; own model matches own team |
| **R-12** | Recoil + spread model | P2 | static spread only | per-shot kick with recovery, moving/air penalties, view punch | Weapons feel flat; skill expression is missing | R-03 (aim must be correct first) | Deterministic pattern in `shared/weapons.js` so the server reproduces it | Unit: deterministic kick sequence; live: N-shot group grows measurably |
| **R-13** | Character rebuild + animation set | P2 | 14-part capsule rig, no held weapon, 2-clip swing | stylized low-poly character holding the weapon, 8–10 procedural clips incl. aim layer | The reference target is a clean stylized tactical silhouette | — | Procedural or one hand-built low-poly; team trim via vertex colours; ≤1–3 draw calls; keep blob shadows | Live: silhouette readable at 30 m; aim layer visible; ≤+4 draw calls measured vs P10 baseline |
| **R-14** | Map gameplay revision | P2 | 39 m spawn line, thin mid cover, dummies, 2.2 m max verticality | bounded fight distances, mid cover, a vertical flank, 4+ angle clusters | Level design determines whether the weapons work | R-03/R-12 (shooting must be correct before balance) | Data-only edits in `shared/map.js` (+ mirrors); keep 180° symmetry; keep chokepoint widths uniform | Unit: symmetry + BFS reachability still pass; live: measurable spread of engagement distances; no spawn-to-spawn LOS |
| **R-15** | Menu/UX completion | P2 | dev-looking title screen, 2 dead buttons, no loading/errors | settings/how-to-play screens, loading state, error toasts, phase labels removed from player-facing copy | First impression; "no dead buttons" | R-07 | Keep the existing visual language and panel CSS | Live: every button does something; no "TEZ KUNDA" left; console clean |
| **R-16** | Audio layer | P2 | none | synth-driven fire/hit/kill/damage/reload/switch/UI/round cues + volume settings | The single largest game-feel gap | R-07 (volumes), R-05 (hit events) | WebAudio oscillators/noise; pooled voices; unlock on pointer-lock gesture; lazy init for headless | Live: each cue fires on its trigger; ≤8 concurrent voices; no errors when muted; verifiers unaffected |
| **R-17** | Weapon presentation | P3 | box meshes, no animation | recognizable weapon meshes, fire/reload/switch animation, shell + impact decals | "Production-ready weapons" | R-13/R-12 | Reuse the muzzle `Object3D` contract; pooled instanced decals | Live: reload animation duration == `reloadMs`; decals pooled ≤N |
| **R-18** | Responsive + accessibility pass | P3 | no media queries; fixed offsets | survives 1024×600 and 1280×720 without overlap; readable contrast | Smaller laptops are a real audience | R-15 | Add 2 breakpoints; scale HUD with `clamp()`; verify crosshair stays centred | Live: geometry overlap scan at 2 viewports + screenshot |
| **R-19** | Damage direction + low-HP feedback | P3 | none | directional hit indicator + low-HP vignette | Readability of being shot | R-05 | HUD-only, driven by server events | Live: indicator points at the attacker |
| **R-20** | Legacy/hygiene cleanup | P4 | dead arena files; 40+ log artifacts | remove or archive | Release cleanliness | — | Delete files + update the smoke assertion that guards them (behaviour assertion unchanged) | `npm test` still green |
| **R-21** | Second map / alternate mode | P4 | 1 map, 1 mode | a second map with a unique mechanic | Content depth | R-14 | Data-driven map registry | All map tests parameterised |

---

## 20. NEON STRIKE — POST-P12 PRODUCT COMPLETION ROADMAP

Historical Phase 1–12 reports are untouched. This is a **new** roadmap that begins *after* P12.
Dependency order is mandatory: **do not polish VFX before the shot direction is correct; do not
finalise weapon presentation before weapon state is stable; do not balance the map before
movement and shooting are correct; do not optimise effects before the final visual architecture
exists.**

### P13 — CORE CAMERA + AIM CORRECTION *(unblocks everything)*
Work: R-01, R-02, R-03, R-04 (minimal VFX origin), plus R-07's sensitivity/FOV plumbing.
**Acceptance:** mouse-right turns right (live probe); `D` strafes right (live probe); crosshair↔shot
lateral offset `≈ 0` at 2/10/40 m; a crosshair-aimed dummy is hit and sits at `ndc.x ≈ 0`; the
visible tracer terminates at the authoritative hit point; no P1–P12 regression; no new authority
surface (origin still server-computed).

### P14 — COMBAT FEEL + MULTIPLAYER FEEDBACK
Work: R-05, R-06, R-12, R-10, R-19.
**Acceptance:** hitting a remote player produces a hitmarker within one snapshot; enemy deaths
appear in a shared feed; grenade damages enemies with distance falloff exactly once; recoil is
deterministic and reproducible by the server; server owns kill/death counters and the HUD shows
server values (verified equal after N kills); two-client browser proof for each.

### P15 — CHARACTER + ANIMATION
Work: R-13, R-17, R-11.
**Acceptance:** character silhouette readable at 30 m; weapon held in hands and aligned to the aim
ray; aim layer decouples body facing from camera yaw; 8+ clips triggered by real state; own model
and remotes carry correct team trim; ≤+6 draw calls vs the P10 baseline; FPS ≥ P10 −10%.

### P16 — MAP GAMEPLAY + MATCH FLOW
Work: R-08, R-14, R-09.
**Acceptance:** no spawn-to-spawn line of sight; engagement-distance histogram shows ≥3 distinct
bands; catwalk reachable by two routes with a reason to hold it; 0 training props in the match
scene; symmetry + BFS map tests still pass; solo/1-team starts have a defined, tested outcome;
leaving a live match returns to the lobby and frees the slot.

### P17 — HUD / MENU / SETTINGS / UX
Work: R-07 (full screen), R-15, R-18.
**Acceptance:** every setting measurably changes behaviour; settings persist across reload; no
dead buttons; no "coming soon" copy; phase labels removed from player-facing text; title screen
reads as a product; HUD survives 1024×600 and 1280×720 with no overlap and a centred crosshair;
all lobby/round/match transitions clean with no stale overlay.

### P18 — AUDIO + VFX
Work: R-16, R-04 (final), weapon FX polish.
**Acceptance:** all priority cues present and volume-controlled; ≤8 concurrent voices under a
600 rpm burst; lazy init so headless verifiers still pass; no console errors; FPS unchanged at
load; frame-time p95 within P10 tolerance.

### P19 — FINAL QA / RELEASE HARDENING
Work: full regression (npm test + P2…P12 verifiers), two-client end-to-end playthrough on the new
aim model, authority re-scan, perf re-measure against §14, R-20 cleanup, and a documented
"known limitations" list (P11 two-device LAN QA still PARTIAL).
**Acceptance:** no P0/P1 open; all verifiers green **with actual counts reported**; performance
within the §14 budget; no client→authority path; no P8+ scope leakage; two-client browser evidence
for look, aim, hit feedback, grenade, rounds and chat.

---

## 21. FINAL DECISION

### A. TOP 10 BLOCKERS
1. **B-01** mouse look inverted (P0).
2. **B-02** crosshair ≠ shot, 0.55 m constant offset (P0).
3. **B-03** strafe mirrored (P0, same root cause).
4. **B-05** three conflicting shot origins; tracer uses the local predictor (P1).
5. **B-04** no PvP hit/kill/damage feedback (P1).
6. **B-06** grenade cannot damage enemies (P1).
7. **B-07** solo match cannot end + no in-game exit (P2).
8. **B-12** no audio (P2).
9. **B-11** no settings (P2).
10. **B-13/B-22** character is placeholder: no held weapon, no team identity, no animation (P2).

### B. TOP 10 HIGH-VALUE IMPROVEMENTS
1. Recoil + spread model (skill expression).
2. Server-owned kill/death counters + Tab scoreboard.
3. Round clock + round/match presentation.
4. Team nametags/outlines → instant team readability.
5. Bounded map fight distances + mid cover + a vertical flank.
6. Directional damage indicator + low-HP feedback.
7. Practice range separated from the match map.
8. Responsive HUD at 1024×600.
9. Penetrable high-tier cover (only after R-03).
10. Second map with a unique mechanic.

### C. THINGS THAT MUST NOT BE CHANGED
- The authoritative server model and the client's intent-only INPUT message.
- `aimOrigin` computed server-side; `pose.x/z` ignored in-game.
- 30 Hz sim / 20 Hz snapshots / interpolation + reconciliation architecture.
- Deterministic PRNG spread, hit zones, falloff, cadence, reload and switching state machines.
- Bounded queues/buffers, payload ceilings, idempotent match transitions, duplicate-close guards.
- `shadowMap:false` + blob shadows, DPR cap, pooled effects, instanced map geometry.
- The single `shared/`-source rule (client and server share movement/weapons/combat rules).
- `[hidden]{display:none!important}` and the server-driven HUD state path.
- The 180° centre-point map symmetry and its tests.

### D. THINGS THAT SHOULD BE REBUILT
1. The **aim/origin model** (one ray, converged, server-owned) — rebuild, don't patch.
2. The **horizontal basis** — one shared helper instead of two duplicated `right` constants.
3. The **character rig** — from 14 loose parts to a held-weapon stylized model with an animation
   layer.
4. The **HUD's kill/death source** — from prediction to server.
5. The **title screen** — from tech demo to product.

### E. THINGS THAT ONLY NEED POLISH
- Netcode (already correct; only feedback wiring is missing).
- HUD element set (add scoreboard/clock/indicator; existing elements are correct).
- Map geometry (keep the skeleton; revise cover and distances).
- Menu flows (functional; needs copy, states, and the disabled buttons filled in).
- Effects (pooling is right; needs better shapes/decals and correct endpoints).
- Palette/lighting contrast.

### F. EXACT IMPLEMENTATION ORDER
`P13 (R-01,R-02,R-03,R-04min)` → `P14 (R-05,R-06,R-12,R-10,R-19)` → `P15 (R-13,R-17,R-11)` →
`P16 (R-08,R-14,R-09)` → `P17 (R-07,R-15,R-18)` → `P18 (R-16,R-04final)` → `P19 (QA, R-20)`.
R-07's sensitivity/FOV plumbing lands in P13 because the aim fix depends on the camera basis;
the settings **screen** is P17.

### G. DEFINITION OF DONE — THE WHOLE GAME
1. Mouse look, strafing and aiming are correct and verifiable in the live browser.
2. The crosshair is the shot direction; what you see is what the server resolves.
3. Every shot, hit, kill, reload and death produces immediate visual + audio feedback, in
   multiplayer, from authoritative events.
4. Settings exist and measurably change sensitivity, FOV, quality, FPS display and volume;
   settings persist.
5. Audio covers the core loop.
6. The character is a readable stylized silhouette holding its weapon, with aim/fire/reload/death
   animation, and correct team identity on both own and remote bodies.
7. The map bounds its fight distances, offers ≥3 meaningful routes and a vertical option, and
   contains no training props.
8. A solo or unbalanced start has a defined, tested outcome; a live match can always be exited.
9. HUD: authoritative HP/ammo/team/round/score/kills + scoreboard + round clock + shared feed +
   directional damage; no stale or contradictory state.
10. No dead UI; no "coming soon" in the shipped menu.
11. `shadowMap` off, no post-processing, no dependency growth; FPS within 10% of the P10 baseline;
    server tick and memory within the P10 envelope.
12. All verifiers green with **actual** reported counts; authority scan clean; P11 still honestly
    PARTIAL until a real two-device test is performed.

---

### Reproduction / evidence appendix
- Server: `cd /home/paulinaj/neon-strike && npm start` (binds `0.0.0.0:3000`, WS `/ws`, protocol v6).
- Client: real Chrome → `http://localhost:3000`; live GPU `ANGLE (Intel, Mesa Intel(R) Graphics
  (RPL-P), OpenGL 4.6)`, WebGL2 true.
- Live probes used (read-only): `__neon.startTraining/stopTraining`, `setView`, `lookBy`,
  `diagnostics`, `probeScene`, `probeWorld`, `multiplayerQa`, `perf`.
- three.js ground-truth check: `node --input-type=module` importing `./vendor/three.module.js`,
  `camera.lookAt(fwd)` then reading `matrixWorld` columns.
- Screenshots captured during the audit: `/tmp/neon-audit-01-training.png`,
  `/tmp/neon-playtest-01-training.png`, `/tmp/neon-playtest-02-session.png`.
