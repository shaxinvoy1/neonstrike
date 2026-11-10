# Architecture

```
browser client (client/)                      Node server (server/)                shared rules (shared/)
──────────────────────────                     ─────────────────────                ─────────────────────
js/v/app.js        menus, lobby, settings      app.js   HTTP static + WS, tick      movement.js  walk/sprint/jump/crouch
js/v/net.js        WebSocket, ping, seq        session.js per-player authority     collision.js AABB slide, step-up
js/v/game/game.js  loop, prediction, events    lobby.js   room, host, prefer team  map.js       NEON FACILITY colliders, spawns, A-site
js/v/game/camera.js OTS camera, aim ray        match.js   10 rounds, timer, draw   weapons.js   5 weapons, fire/reload/switch
js/v/game/input.js keyboard/mouse + touch      chat.js    server-side identity     combat.js    hitscan, melee, grenades, peers
js/v/game/players.js avatars, interpolation    metrics.js                          grenade.js   projectile physics, blast
js/v/game/effects.js flashes/tracers/sparks                                        hitdetect.js zones (crouch-scaled)
js/v/game/hud.js   Reference-B HUD, minimap                                         protocol-consts.js messages, SIM rules
js/v/character/    model.js (V-773), animator.js, ik.js
js/v/weapons/      models.js (5 procedural weapons + HUD icons)
js/v/world/        arena.js (map view), env.js (PMREM)
js/v/audio.js, settings.js
```

## Authority
- The client sends **intent only** (`input`: seq, yaw/pitch, aim dir, fire/reload/switch, move axis + sprint/jump/crouch).
- The server simulates movement with the same `shared/movement.js`, resolves shots from the server-computed eye position, applies damage, ammo, reload, fire rate, grenades, knife range, kills, scores, rounds. Forbidden fields (`damage`, `hp`, `team`, …) are rejected (`server/session.js FORBIDDEN_FIELDS`, static scan test).
- Team choice is an *intent* (`set-team {prefer}`) honoured at start with a ±1 balance rule.

## Network
- 30 Hz server tick, 20 Hz `snapshot` (players incl. animation fields, grenades, match block with kill feed), 20 Hz per-player `state` (HP, ammo, full loadout), `events` per tick for the owning player.
- Client prediction: local `stepMovement` at the server's 30 Hz step; soft reconciliation toward server position plus latency lead, applied through collision (never into walls); hard snap on respawn/teleport.
- Remote players: 100 ms interpolation buffer, animation driven from synced state (velocity, crouch, airborne, weapon, shots counter, reloading, alive).

## Rendering
- One `SkinnedMesh` per character, static arena merged by material (≈20 batches), PMREM environment from a procedural neon room, ACES tone mapping. Quality presets Low/Medium/High (pixel ratio, shadows, material model, particle budget) + resolution scale.

## Lifecycle
- `Game.dispose()` removes listeners, disposes geometries/materials/textures/renderer; menu scene is disposed before the game starts and recreated after it ends.
