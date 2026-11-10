# Model V-773 — character specification (implemented)

Source: `client/js/v/character/model.js`, inspection page `/viewer.html` (`?single=1&yaw=…&state=…&weapon=…`).
Reference: `docs/reference/reference-A-character.jpg`.

| Property | Value |
|---|---|
| Height | 1.75 m (= `PLAYER.HEIGHT`, collision capsule height) |
| Head | ellipsoid r = 0.36 m centred at 1.39 m (≈41 % of height), rigid (head bone only) |
| Eyes | two large ovals: black outline, white glossy sclera, black pupil, white highlight; parented to the head bone, sitting on the sphere surface |
| Face | no nose, mouth, brows, ears, hair, helmet |
| Body | lathe "bean" torso, rounded shoulders, short capsule arms with round mitt hands + thumb bump, short rounded legs, rounded feet |
| Material | `MeshPhysicalMaterial` pearl white (roughness .34, clearcoat .55, sheen, light iridescence on High); `MeshStandardMaterial` on Low |
| Team identity | white body kept; subtle fresnel rim in team colour, team-coloured ground ring, name + triangle marker |
| Geometry | parts merged into **one** skinned geometry; vertex weights from distance to bone segments (2 nearest) → joints bend smoothly, no gaps |

## Rig
`root → hips → spine → chest → neck → head`, `chest → shoulder.L/R → upperArm → forearm → hand`, `hips → upperLeg.L/R → knee → ankle → foot`.
Sockets: `gripR`, `gripL`, `head`.

## Animation (`animator.js`)
- Locomotion: phase advanced by cadence(speed); stance foot moves backward at exactly body speed (no foot sliding); swing foot arcs; two-bone IK for legs; diagonal hip twist with counter-rotated chest; crouch via hip drop + IK; jump/fall tuck; landing spring; idle breathing/weight shift and two idle variations; in-place turning with planted feet and stepping.
- Upper body: weapon anchor around a shoulder pivot follows aim pitch; both hands IK-attached to weapon grip/support points (measured gap ≤ 3.7 cm, inside the hand mitt); bladed stance for long guns; sprint carry; recoil spring; reload (magazine hidden, support hand to belt and back); weapon switch (lower/raise); grenade throw arc; knife slash.
- Full body: hit flinch + red flash, death fall, respawn materialise, victory hop.
- All 24 states selectable in the viewer; `docs/screenshots/02-animation-states.png`.
