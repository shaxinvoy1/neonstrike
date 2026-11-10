# Performance report (measured — `npm run perf`)

**Important:** this container has **no GPU**. WebGL runs through ANGLE → SwiftShader (CPU rasteriser): `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)`. Frame rates below are therefore CPU-software-rendering numbers and are **not** representative of phones or desktop GPUs. No FPS figure for real hardware is claimed.

## Training scene, 1280×720, mid-map view (5 dummies + player)
| Preset | Pixel ratio | Avg frame | p95 frame | FPS (SwiftShader) | JS `update()` | Draw calls | Triangles | Geometries / textures | JS heap |
|---|---|---|---|---|---|---|---|---|---|
| Low | 0.50 | 358 ms | 533 ms | 2.8 | 1.76 ms | 115 | 114 952 | 147 / 24 | 11.2 MB |
| Medium | 0.67 | 975 ms | 1350 ms | 1.0 | 2.59 ms | 115 | 114 952 | 147 / 25 | 11.5 MB |
| High | 1.00 | 1468 ms | 2033 ms | 0.7 | 1.30 ms | 115 | 114 952 | 147 / 25 | 11.6 MB |

Interpretation:
- Game logic (prediction, animation of 6 skinned characters with IK, effects, HUD) costs **≈1.3–2.6 ms per frame** on this CPU — well inside a 16.7 ms (60 FPS) budget; the rest of each frame is SwiftShader rasterisation, which scales with pixel ratio.
- 115 draw calls and ~115k triangles are modest for any WebGL2-capable GPU (static arena merged by material; one draw per character mesh). Most triangles are the 6 V-773 meshes (~15k each).
- `renderer.info.render.calls` reported the same value for all presets; whether it includes the shadow pass in r160 was not verified.

## Resource cleanup (menu → training → quit, 3 cycles)
| Cycle | Geometries in game | Textures in game | JS heap after quit + GC | Game object left | HUD/touch nodes left |
|---|---|---|---|---|---|
| 1 | 147 | 24 | 7.6 MB | no | 0 |
| 2 | 147 | 24 | 9.5 MB | no | 0 |
| 3 | 147 | 24 | 9.7 MB | no | 0 |
No growth in GPU resources across cycles; heap stays within GC noise.

## Server
Existing metrics (P10 report in `logs/`) measured ~0.4 ms per 30 Hz tick; this rebuild added jump/crouch, knife and grenade snapshot lists — not re-profiled under 8 players.

## Knobs available to players
Quality Low/Medium/High (pixel ratio, shadows, PBR model, particle budget, 3D menu on/off), resolution scale 50–125 %, shadows toggle, effects 25–100 %, FOV.
