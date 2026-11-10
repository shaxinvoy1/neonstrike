# NEON FACILITY — map specification

Single arena, 44 × 32 m, point-symmetric (180°). Data: `shared/map.js` (used by server and client). View: `client/js/v/world/arena.js`.

| Element | Detail |
|---|---|
| Spawns | Blue (A) x = −19.5, Red (B) x = +19.5, safe zones 5 × 10 m with cyan / red floor strips |
| Mid lane | central open lane with raised REACTOR platform (1.2 m) + glowing core, stairs on both ends |
| Left route (LONG) | north corridor under the catwalk, crates, industrial container |
| Right route (CATWALK) | south elevated walkway (deck 2.2 m, 1.9 m clearance) with rails, reached by stairs at both ends |
| Cover | 10 crates, 4 large containers (2.6 m), dividers with 2 openings each side |
| A-site | area x 8…17, z −16…−4.8, large glowing "A →" sign on the north wall, "A SITE" floor marking |
| Visuals | 7 m navy walls with vertical neon pillars and top strips, merged-batch geometry, background tower blocks with lit windows, upper walkway, fog, PMREM reflections |
| Lights | hemisphere + shadowed moon light + 6 coloured point lights (Medium/High) |

Collision: 64 AABB colliders (`COLLIDERS`), validated by `test/unit/map.test.js` (symmetry, no overlaps on critical kinds, stair step ≤ step height, BFS reachability from spawn to platform, catwalk and lanes, spawn clearance).
