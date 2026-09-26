// ============================================================
// NEON STRIKE — Phase 2: F3 debug overlay (FPS / frame time / render)
// Overlay yopiq bo'lsa diagnostika umuman formatlanmaydi (0 xarajat).
// ============================================================
export class DebugOverlay {
  constructor (el) {
    this.el = el;
    this.visible = false;
    this.el.hidden = true;
  }

  toggle () { return this.setVisible(!this.visible); }

  setVisible (v) {
    this.visible = !!v;
    this.el.hidden = !this.visible;
    return this.visible;
  }

  update (d) {
    if (!this.visible || !d) return;
    const f = d.fps;
    const p = d.player;
    const c = d.camera;
    const r = d.render;
    this.el.textContent = [
      `NEON STRIKE · ${d.mode.toUpperCase()} · ${d.running ? 'RUNNING' : 'STOPPED'} · t=${d.elapsed.toFixed(1)}s`,
      `FPS      : ${f.fpsEma.toFixed(1)} (o'rt ${f.fpsAvg.toFixed(1)} · min ${f.fpsMin.toFixed(1)} · maks ${f.fpsMax.toFixed(1)})`,
      `FRAME    : o'rt ${f.frameMsAvg.toFixed(2)} ms · p95 ${f.frameMsP95.toFixed(2)} ms · maks ${f.frameMsMax.toFixed(2)} ms`,
      `CPU/GPU  : submit ${(d.cpuMs ?? 0).toFixed(2)} ms · draw calls ${r.calls} · uchburchak ${r.triangles}`,
      `PLAYER   : x=${p.x} y=${p.y} z=${p.z} yaw=${p.yaw} speed=${p.speed} m/s`,
      `KOLLIZIYA: hitX=${p.hitX} hitZ=${p.hitZ}`,
      `KAMERA   : yaw=${c.yaw} pitch=${c.pitch} dist=${c.distance}/${c.desiredDistance} blocked=${c.blocked} look=${c.lookEvents}`,
      `KIRITISH : pointerLock=${d.pointerLocked} keys=[${d.keys.join(' ')}] sprint=${p.sprint}`,
      `SAHNA    : ${d.scene.dummies} dummy + ${d.scene.rings} halqa · AABB ${d.scene.boxes} · ${r.width}×${r.height}@${r.pixelRatio} · shadowMap=${r.shadowMap}`,
      `MAPA     : ${d.scene.map} · AABB ${d.scene.mapStats ? d.scene.mapStats.colliders : '?'} · mesh ${d.scene.mapStats ? d.scene.mapStats.meshes : '?'}`,
      d.combat
        ? `COMBAT   : ${d.combat.weaponName} [${d.combat.slot}/4] mag=${d.combat.mag}/${d.combat.reserve} reload=${d.combat.reloading ? Math.round(d.combat.reloadProgress * 100) + '%' : '-'}${d.combat.switching ? ' SWITCH' : ''} · HP=${d.combat.hp}${d.combat.alive ? '' : ' DEAD'} · o\u2018q=${d.combat.shots} hit=${d.combat.hits} blocked=${d.combat.blocked} kill=${d.combat.kills} · self=${d.combat.selfDamage} · granata=${d.combat.grenadesActive} · nishon tirik=${d.combat.targetsAlive}`
        : `COMBAT   : (yuklanmagan)`
    ].join('\n');
  }
}