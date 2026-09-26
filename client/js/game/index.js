// ============================================================
// NEON STRIKE — Phase 2: o'yin orkestratori (3D sahna + loop)
// Renderer sozlamalari: shadowMap O'CHIQ (blob shadow ishlatiladi),
// post-processing YO'Q, DPR 1.75 bilan cheklangan, fog bor.
// Loop: requestAnimationFrame + dt clamp; statistika ring-buffer'da.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { MAP, PALETTE, SPAWNS, CAMERA_BOXES } from '/shared/map.js';
import { MOVE, clamp, CAMERA } from '/shared/collision.js';
import { createMapMesh } from '../mapview.js';
import { COLLIDERS } from '/shared/map.js';
import { createPlayer, updateBlobShadow, animateHumanoid } from './player.js';
import { InputManager } from './input.js';
import { Movement } from './movement.js';
import { CameraController } from './camera-controller.js';
import { Training } from './training.js';
import { CombatController } from './combat.js';
import { MultiplayerSync } from './multiplayer.js';
// PHASE 9: HUD ko'rinishi — FAQAT avtoritar server holatidan (sof adapter)
import { buildHudView, connectionState } from './hud-state.js';
import { WEAPON_ORDER } from '/shared/weapons.js';
import { DebugOverlay } from './debug-overlay.js';

const FRAME_WINDOW = 240; // ~4 s @60fps

export class Game {
  constructor ({ canvas, debugEl, hud }) {
    this.canvas = canvas;
    this.hud = hud || {};
    this.debug = new DebugOverlay(debugEl);
    this.mode = 'training';
    this.running = false;
    // PHASE 5: server intent adapteri (main.js o'rnatadi). Klient FAQAT
    // intent yuboradi — zarar/HP/o'q-dori natijasini EMAS.
    this.net = null;
    this.netSeq = 0;
    this.elapsed = 0;
    this.size = { w: 1, h: 1 };
    this.frameTimes = new Float64Array(FRAME_WINDOW);
    this.frameIndex = 0;
    this.frameTotal = 0;
    this.fpsEma = 0;
    this.cpuMs = 0;
    this.loopErrors = [];
    // PHASE 10: kadr ichidagi ish hisoblagichlari (diagnostics().perf)
    this.perf = { frames: 0, hudViews: 0 };
    this._last = 0;
    this._raf = 0;
    this._hudAcc = 0;
    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);
  }

  init () {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = false;            // real-time shadow yo'q
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(PALETTE.BG, 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PALETTE.BG);
    scene.fog = new THREE.Fog(PALETTE.FOG, 26, 82);
    this.scene = scene;

    scene.add(new THREE.HemisphereLight(0x41529e, 0x0a0e20, 1.15));
    const keyLight = new THREE.DirectionalLight(0xa9dcff, 0.9);
    keyLight.position.set(9, 16, 7);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0x8f6fff, 0.45);
    fillLight.position.set(-11, 9, -8);
    scene.add(fillLight);

    // Phase 3: arena-mesh o'rniga NEON FACILITY (shared/map.js geometriyasi)
    this.mapview = createMapMesh();
    scene.add(this.mapview.group);

    this.camera = new THREE.PerspectiveCamera(74, 1, 0.1, 200);
    this.cameraController = new CameraController(this.camera);

    this.player = createPlayer();
    this.player.group.position.set(SPAWNS.A.x, SPAWNS.A.y, SPAWNS.A.z);
    scene.add(this.player.group);
    scene.add(this.player.shadow);

    this.movement = new Movement();
    // PHASE 7: server sinxronizatsiyasi (masofaviy o'yinchilar + rekonsiliatsiya)
    this.multiplayer = new MultiplayerSync({ scene });
    this.lobbyState = null;
    this.input = new InputManager(this.canvas);
    this.input.onKeyExtra = (code) => {
      if (code === 'F3') this.toggleDebug();
      if (code === 'KeyP') this.resetSession();       // PHASE 4: P = sessiya qayta boshlash (R endi = reload)
    };
    this.training = new Training(scene);
    // PHASE 4: lokal combat (shared qoidalar + vizual adapter)
    this.combat = new CombatController({
      scene, player: this.player, movement: this.movement,
      cameraController: this.cameraController, training: this.training, hud: this.hud
    });

    this.resize();
    this.cameraController.update(1 / 60, this.movement.pos, MAP.FLOOR_Y);
    this.renderer.render(this.scene, this.camera);   // birinchi kadr (kanvas bo'sh turmasin)
    return this;
  }
  // ---------------- lifecycle ----------------
  start () {
    if (this.running) return this;
    this.running = true;
    this.input.enabled = true;
    this.input.bind();
    this.training.reset();
    this.combat.reset();
    this.requestLock();
    window.addEventListener('resize', this.resize);
    this.resize();
    this._last = performance.now();
    this._raf = requestAnimationFrame(this.tick);
    return this;
  }

  stop () {
    this.running = false;
    this.input.enabled = false;
    this.input.exitLock();
    window.removeEventListener('resize', this.resize);
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    return this;
  }

  /** Pointer Lock so'rovi (foydalanuvchi jesti ichida chaqirilishi kerak) */
  requestLock () { return this.input.requestLock(); }

  resetSession () {
    this.movement.reset();
    this.training.reset();
    this.combat.reset();
    this.cameraController.first = true;
    this.frameTimes.fill(0);
    this.frameIndex = 0;
    this.frameTotal = 0;
    this.fpsEma = 0;
    this.elapsed = 0;
    return this;
  }

  toggleDebug () { return this.debug.setVisible(this.debug.toggle()); }

  toggleDebugVisible (v) { return this.debug.setVisible(!!v); }

  resize () {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------- loop ----------------
  tick (now) {
    if (!this.running) return;
    const dt = Math.min(0.05, Math.max(0.0005, (now - this._last) / 1000));
    this._last = now;

    const t0 = performance.now();
    try {
      this.update(dt, now);
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      this.loopErrors.push(String(err && err.stack ? err.stack : err));
      this.stop();
      console.error('[game] loop xatosi:', err);
      return;
    }
    this.cpuMs = performance.now() - t0;
    this.recordFrame(dt);

    this._hudAcc += dt;
    if (this._hudAcc >= 0.2) { this._hudAcc = 0; this.updateHud(); }
    if (this.debug.visible) this.debug.update(this.diagnostics());

    this._raf = requestAnimationFrame(this.tick);
  }

  update (dt, now = performance.now()) {
    // 1) sichqoncha (Pointer Lock) → kamera yaw/pitch
    const look = this.input.consumeMouse();
    this.cameraController.look(look.dx, look.dy);

    // 2) WASD → silliq mahalliy harakat + AABB kolliziya
    const axis = this.input.axes;
    this.movement.step(dt, axis, this.cameraController.yaw, this.input.sprint);

    // 3) model vizuali
    const p = this.movement.pos;
    this.player.group.position.set(p.x, p.y, p.z);
    this.player.group.rotation.y = this.movement.faceYaw;
    animateHumanoid(this.player.model, dt, this.movement.speed,
      this.input.sprint ? MOVE.SPRINT : MOVE.WALK);
    updateBlobShadow(this.player.shadow, p.x, MAP.FLOOR_Y, p.z, p.y - MAP.FLOOR_Y);

    // 4) kamera: pivot → sweep (kolliziya) → silliqlash → lookAt
    this.cameraController.update(dt, p, MAP.FLOOR_Y);

    // 4b) PHASE 7: masofaviy o'yinchilarni interpolatsiya qilib yangilash
    this.multiplayer.update(dt, now);
    // 4c) PHASE 1: crosshair nuri masofaviy o'yinchilarni ham "ko'radi"
    //     (server tomonidagi `_shotTargets` bilan bir xil semantika).
    this.combat.setPeerTargets(this.multiplayer.aimTargets());
    this.combat.setPlayerId(this.multiplayer.playerId);
    // 4d) PHASE 1: lokal o'yinchi AVTORITAR tiriklik holatini oladi (server
    //     snapshot'i). Dushman o'ldirsa — lokal o'q otish/reload to'xtaydi;
    //     raund boshida server qayta tiriltiradi → holat tiklanadi.
    this.combat.syncAuthoritativeAlive(this.multiplayer.selfAlive());

    // 5) training sessiyasi
    this.training.update(dt);
    this.elapsed = this.training.elapsed;

    // 6) PHASE 4: combat (intents → shared qoidalar → effektlar/HUD)
    const intents = this.input.consumeIntents();
    this.combat.update(dt * 1000, now, intents);
    this.combatNow = now;

    // 6b) PHASE 9: HUD uchun AVTORITAR ko'rinish (server STATE/SNAPSHOT/lobby).
    //     Avtoritar sessiya bo'lmasa — null (HUD lokal bashoratni ko'rsatadi).
    this.combat.setHudView(this.hudView());
    // PHASE 10: kadr ichidagi ish o'lchanadi (o'lchandi: ≈0.31 µs/chaqiruv —
    // byudjetning ~0.003%, shu sabab optimallashtirish TALAB QILINMADI).
    this.perf.frames += 1;
    this.perf.hudViews += 1;

    // 7) PHASE 5: intentlarni avtoritativ serverga yuborish.
    //    Yuboriladigan maydonlar FAQAT intent: seq/pose/aim/intents.
    //    Server raqami (damage/hp/ammo) bu yerda YO'Q.
    if (this.net) {
      // PHASE 1: serverga CROSSHAIR konvergensiyasidan chiqqan yo'nalish
      // yuboriladi — shu sababli server o'qi ham crosshair ostidan o'tadi.
      const dir = this.combat.shotDir();
      const seq = ++this.netSeq;
      // PHASE 7: bashoratni yozib boramiz (rekonsiliatsiya uchun) — server
      // tasdiqlagan ketma-ketlikdagi bashorat bilan solishtiriladi.
      this.multiplayer.recordLocalInput(seq, p);
      this.net.sendInput({
        seq,
        pose: {
          x: p.x, y: p.y, z: p.z,
          yaw: this.cameraController.yaw, pitch: this.cameraController.pitch
        },
        aim: { dir: [dir[0], dir[1], dir[2]] },
        // PHASE 7: harakat niyati (pozitsiya EMAS). in_game bo'lsa server
        // shu o'qdan o'zi simulyatsiya qiladi va server holati ustun bo'ladi.
        move: {
          forward: axis.forward, right: axis.right, sprint: this.input.sprint
        },
        intents: {
          fire: !!intents.fire,
          firePressed: !!intents.firePressed,
          reload: !!intents.reload,
          switchTo: intents.switchSlot >= 1 && intents.switchSlot <= WEAPON_ORDER.length
            ? WEAPON_ORDER[intents.switchSlot - 1] : null,
          moving: this.combat.moving
        }
      });
    }

    // 8) PHASE 7: REKONSILIATSIYA — server holati ustun. Server tasdiqlagan
    //    ketma-ketlikdan keyin xato bo'lsa lokal holat tuzatiladi.
    this.multiplayer.applyTo(this.movement);
  }

  /**
   * PHASE 6/7: server AVTORITAR lobby holati (faqat in_game → sinxronizatsiya
   * yoqiladi). Qaror SERVERDA — klient faqat aks ettiradi.
   */
  onLobbyState (msg) {
    this.lobbyState = msg || null;
    const inGame = !!msg && msg.state === 'in_game' && !!msg.inSession;
    this.multiplayer.setAuthoritative(inGame, msg ? msg.you : null);
    return inGame;
  }

  /** PHASE 7: server SNAPSHOT xabari (20 Hz) */
  onSnapshot (msg) { return this.multiplayer.onSnapshot(msg); }

  /**
   * PHASE 1: AVTORITAR combat hodisalari (server EVENTS) → PvP feedback.
   * Klient bu hodisalarni faqat KO'RSATADI: hit marker, zarar raqami,
   * zarar yo'nalishi, kill feed. HP/o'lim/o'q-dori AVTORITETI serverda.
   */
  onCombatEvents (events) {
    if (!this.combat) return 0;
    return this.combat.applyAuthoritativeEvents(events);
  }

  /**
   * PHASE 9: HAQIQIY ulanish uzildi (WS close). Sinxronizatsiyani to'xtatamiz va
   * masofaviy o'yinchilarni olib tashlaymiz — ekranda "hali ham sinxron" degan
   * yolg'on holat qolmasin. Lokal sessiya (bashorat) to'xtamaydi.
   */
  onNetClosed () {
    this.netClosed = true;
    this.multiplayer.setAuthoritative(false, this.multiplayer.playerId);
    return true;
  }

  /**
   * PHASE 9: HUD ko'rinishi — FAQAT server xabarlaridan (STATE, SNAPSHOT,
   * LOBBY_STATE). Klient bu qiymatlarni hisoblamaydi va o'zgartirmaydi;
   * `hud-state.js` sof adapteri ularni HUD uchun normallashtiradi.
   * Avtoritar sessiya yo'q bo'lsa (`source: 'predict'`) — offline TRAINING.
   */
  hudView () {
    const net = this.net || null;
    const local = this.combat ? this.combat.snapshot() : null;
    return buildHudView({
      authoritative: net && net.authoritative ? net.authoritative : null,
      snapshot: net && net.snapshot ? net.snapshot : null,
      lobby: net && net.lobby ? net.lobby : null,
      local,
      connection: connectionState({
        connected: !!(net && net.connected),
        readyState: net && net.socket ? net.socket.readyState : 3
      }),
      you: net && net.lobby ? net.lobby.you
        : (net && net.session ? net.session.playerId : null)
    });
  }

  /**
   * PHASE 8: AVTORITAR match holati (faqat server snapshot'idan o'qiladi).
   * Klient bu yerda HECH NARSA hisoblamaydi — jamoa/raund/ball serverdan.
   */
  matchQa () {
    const qa = this.multiplayer.qa();
    return {
      match: qa.match,
      selfTeam: qa.self ? qa.self.teamId : null,
      playerId: qa.playerId,
      remotes: qa.remotes.map((r) => ({ id: r.id, teamId: r.teamId, alive: r.alive }))
    };
  }

  /** PHASE 7: multiplayer QA ko'rinishi (mock EMAS) */
  multiplayerQa () {
    const qa = this.multiplayer.qa();
    // lokal holat ham qo'shiladi (rekonsiliatsiya dalili)
    return {
      ...qa,
      local: {
        x: +this.movement.pos.x.toFixed(3),
        y: +this.movement.pos.y.toFixed(3),
        z: +this.movement.pos.z.toFixed(3),
        speed: +this.movement.speed.toFixed(3),
        seq: this.netSeq,
        lobbyState: this.lobbyState ? this.lobbyState.state : null
      }
    };
  }

  recordFrame (dt) {
    this.frameTimes[this.frameIndex] = dt * 1000;
    this.frameIndex = (this.frameIndex + 1) % FRAME_WINDOW;
    this.frameTotal++;
    const inst = dt > 0 ? 1 / dt : 0;
    this.fpsEma = this.fpsEma ? this.fpsEma + (inst - this.fpsEma) * 0.1 : inst;
  }

  frameStats () {
    const n = Math.min(this.frameTotal, FRAME_WINDOW);
    if (n === 0) {
      return { frames: 0, windowFrames: 0, fpsEma: 0, fpsAvg: 0, fpsMin: 0, fpsMax: 0, frameMsAvg: 0, frameMsP95: 0, frameMsMax: 0 };
    }
    const arr = Array.from(this.frameTimes.slice(0, n)).sort((a, b) => a - b);
    const sum = arr.reduce((s, v) => s + v, 0);
    const avg = sum / n;
    const p95 = arr[Math.min(n - 1, Math.floor(n * 0.95))];
    const max = arr[n - 1];
    const min = arr[0];
    return {
      frames: this.frameTotal,
      windowFrames: n,
      windowSeconds: +(sum / 1000).toFixed(1),
      frameMsAvg: +avg.toFixed(3),
      frameMsP95: +p95.toFixed(3),
      frameMsMax: +max.toFixed(3),
      fpsEma: +this.fpsEma.toFixed(2),
      fpsAvg: +(1000 / avg).toFixed(2),
      fpsMin: +(1000 / max).toFixed(2),
      fpsMax: +(1000 / min).toFixed(2)
    };
  }

  // ---------------- HUD ----------------
  updateHud () {
    const h = this.hud;
    const p = this.movement.pos;
    if (h.timer) h.timer.textContent = this.training.elapsed.toFixed(1) + ' s';
    if (h.position) h.position.textContent = `${p.x.toFixed(1)} / ${p.z.toFixed(1)}`;
    if (h.speed) h.speed.textContent = this.movement.speed.toFixed(2) + ' m/s' + (this.movement.sprinting ? ' (SPRINT)' : '');
    if (h.targets) h.targets.textContent = String(this.training.targetCount);
    if (h.fps) h.fps.textContent = this.fpsEma.toFixed(0) + ' FPS';
    if (h.pointer) h.pointer.textContent = this.input.pointerLocked ? 'POINTER LOCK: ON' : 'POINTER LOCK: OFF';

    // ---- PHASE 9: HUD = AVTORITAR holatning KO'RINISHI -------------------
    // Barcha qiymatlar `hudView()` dan (server STATE/SNAPSHOT/LOBBY_STATE).
    const v = this.hudView();

    // match satri (jamoa · raund · ball) — P8 matn formati saqlanadi
    if (h.matchLine || h.matchTeam || h.matchRound || h.matchScore) {
      if (h.matchLine) h.matchLine.hidden = !v.inMatch;
      if (v.inMatch) {
        if (h.matchTeam) h.matchTeam.textContent = v.teamText;
        if (h.matchRound) h.matchRound.textContent = v.roundText;
        if (h.matchScore) h.matchScore.textContent = v.scoreText;
      }
    }

    // PHASE 9: ulanish holati (HAQIQIY WS holatidan — taxmin emas)
    if (h.conn) {
      h.conn.textContent = v.connection.text;
      const cls = 'hud-chip conn ' + v.connection.cls;
      if (h.conn.className !== cls) h.conn.className = cls;
    }

    // PHASE 9: o'z jamoasi + o'z ID si (server bergan)
    if (h.team) h.team.textContent = v.inMatch ? v.teamText : 'JAMOA —';
    if (h.me) h.me.textContent = 'ID ' + (v.playerId || '—');

    // PHASE 9: raund/match tugash banneri — AVTORITAR g'olib/ball
    if (h.banner) {
      h.banner.hidden = !v.banner.show;
      if (v.banner.show) {
        if (h.bannerTitle) h.bannerTitle.textContent = v.banner.title;
        if (h.bannerSub) h.bannerSub.textContent = v.banner.sub;
        h.banner.dataset.kind = v.matchState === 'match_end' ? 'match' : (v.roundState === 'round_end' ? 'round' : 'ready');
      }
    }
  }

  // ---------------- diagnostika (F3 + avtomatik verifikatsiya) ----------------
  diagnostics () {
    const p = this.movement.pos;
    const c = this.cameraController;
    const info = this.renderer.info.render;
    return {
      mode: this.mode,
      running: this.running,
      elapsed: +this.training.elapsed.toFixed(2),
      cpuMs: +this.cpuMs.toFixed(3),
      pointerLocked: this.input.pointerLocked,
      player: {
        x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
        yaw: +this.movement.faceYaw.toFixed(3),
        speed: +this.movement.speed.toFixed(3),
        sprint: this.movement.sprinting,
        hitX: this.movement.hitX, hitZ: this.movement.hitZ,
        collisions: this.movement.collisions,
        travelled: +this.movement.travelled.toFixed(3)
      },
      camera: {
        x: +c.pos.x.toFixed(3), y: +c.pos.y.toFixed(3), z: +c.pos.z.toFixed(3),
        yaw: +c.yaw.toFixed(3), pitch: +c.pitch.toFixed(3),
        distance: +c.last.distance.toFixed(3),
        desiredDistance: c.last.desiredDistance,
        blocked: c.last.blocked,
        lookEvents: c.lookEvents,
        lookAccum: { dx: c.accumDX, dy: c.accumDY }
      },
      render: {
        calls: info.calls, triangles: info.triangles,
        width: this.size.w, height: this.size.h,
        pixelRatio: this.renderer.getPixelRatio(),
        shadowMap: this.renderer.shadowMap.enabled
      },
      fps: this.frameStats(),
      // PHASE 10: HAQIQIY kadr/hud/DOM hisoblari (o'lchov, mock EMAS)
      perf: {
        frames: this.perf.frames,
        hudViews: this.perf.hudViews,
        hudDomWrites: this.combat && this.combat.hud ? this.combat.hud.domWrites : 0,
        hudDomSkips: this.combat && this.combat.hud ? this.combat.hud.domSkips : 0
      },
      scene: {
        dummies: this.training.dummies.length,
        rings: this.training.rings.length,
        targets: this.training.targetCount,
        boxes: CAMERA_BOXES.length,
        props: COLLIDERS.length,
        arena: MAP.NAME,
        map: MAP.NAME,
        mapStats: this.mapview.counts,
        mapVisible: this.mapview.group.visible,
        blobShadow: !!this.player.shadow.parent,
        blobOpacity: +(this.player.shadow.material.opacity).toFixed(3),
        fog: !!this.scene.fog,
        lights: this.scene.children.filter((c) => c.isLight).length,
        playerParts: this.player.group.children.length,
        playerVisible: this.player.group.visible,
        trainingVisible: this.training.group.visible,
        trainingGroup: !!this.scene.getObjectByName('training')
      },
      keys: [...this.input.keys],
      loopErrors: this.loopErrors.length,
      combat: this.combat ? (() => {
        const c = this.combat.qa();
        return {
          version: 4,
          weaponId: c.weapon.weaponId,
          weaponName: c.weapon.weaponName,
          slot: c.weapon.slot,
          mag: c.weapon.mag,
          reserve: c.weapon.reserve,
          reloading: c.weapon.reloading,
          reloadProgress: c.weapon.reloadProgress,
          switching: c.weapon.switching,
          hp: c.hp,
          alive: c.alive,
          deaths: c.deaths,
          respawnIn: c.respawnIn,
          shots: c.stats.shots,
          hits: c.stats.hits,
          blocked: c.stats.blocked,
          kills: c.stats.kills,
          damageDealt: c.stats.damageDealt,
          damageTaken: c.stats.damageTaken,
          selfDamage: c.stats.selfDamage,
          grenadeThrows: c.stats.grenadeThrows,
          grenadeExplosions: c.stats.grenadeExplosions,
          grenadesActive: c.grenadesActive,
          targetsAlive: c.targets.filter((t) => t.alive).length,
          targetDeaths: c.targets.reduce((s, t) => s + (t.deaths || 0), 0),
          effectsActive: c.effectsActive,
          weapon: this.combat.weaponProbe()
        };
      })() : null
    };
  }

  /**
   * Kadrni to'g'ridan-to'g'ri WebGL drawing buffer'idan oladi (verifikatsiya
   * uchun): avval sinxron render, so'ng canvas.toDataURL — shu sababli
   * olingan rasm ekrandagi kadr bilan AYNAN bir xil (skrinshot quvuri emas).
   */
  captureFrame () {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  /** Sichqoncha harakati orqali kamerani burish (verifikatsiya uchun —
   *  aynan Pointer Lock eventlari ishlatadigan `CameraController.look` yo'li) */
  lookBy (dx, dy) {
    this.cameraController.look(dx, dy);
    this.cameraController.update(1 / 60, this.movement.pos, MAP.FLOOR_Y);
    return this.diagnostics();
  }

  /** Diagnostika/verifikatsiya: map guruhini ko'rsatish/yashirish.
   * Anti-fake dalil: mapa o'chirilganda kadr piksellari o'zgaradi. */
  setMapVisible (v) {
    this.mapview.group.visible = !!v;
    this.renderer.render(this.scene, this.camera);
    return this.mapview.group.visible;
  }

  /** Diagnostika/verifikatsiya: player guruhini (soya bilan) ko'rsatish/yashirish.
   * Anti-fake piksel dalili uchun: model yashirilganda ekrandan yo'qoladi. */
  setPlayerVisible (v) {
    this.player.group.visible = !!v;
    this.player.shadow.visible = !!v;
    this.renderer.render(this.scene, this.camera);
    return this.player.group.visible;
  }

  /** Training nishonlarini ko'rsatish/yashirish — piksel dalili uchun */
  setTrainingVisible (v) {
    this.training.group.visible = !!v;
    this.renderer.render(this.scene, this.camera);
    return this.training.group.visible;
  }

  /**
   * Player modeli ekranda ko'rinadimi — obyektiv o'lchov (anti-fake):
   * model markazini NDC'ga proyeksiya qiladi va ekran balandligidagi ulushini hisoblaydi.
   */
  probePlayer () {
    const THREE_Vec3 = this.camera.position.constructor;
    const top = new THREE_Vec3();
    const bottom = new THREE_Vec3();
    this.player.model.head.getWorldPosition(top);
    this.player.group.getWorldPosition(bottom);
    const camDist = this.camera.position.distanceTo(bottom);
    const camDir = new THREE_Vec3();
    this.camera.getWorldDirection(camDir);
    const toPlayer = bottom.clone().sub(this.camera.position).normalize();
    const inFront = camDir.dot(toPlayer) > 0;

    top.project(this.camera);
    bottom.project(this.camera);
    const ndcHeight = Math.abs(top.y - bottom.y);
    const onScreen = Math.abs(bottom.x) < 1 && Math.abs(bottom.y) < 1 &&
      top.z > -1 && top.z < 1 && top.z <= this.camera.far;

    return {
      visible: this.player.group.visible,
      inFront,
      onScreen,
      ndc: { x: +bottom.x.toFixed(3), y: +bottom.y.toFixed(3), z: +bottom.z.toFixed(3) },
      ndcHeight: +ndcHeight.toFixed(4),
      distance: +camDist.toFixed(3)
    };
  }

  /**
   * Sahna obyektlarini "nishonga olish" diagnostikasi (verifikatsiya uchun):
   * har bir nishonning jahon pozitsiyasi, kamera oldida ekanligi, NDC proyeksiyasi
   * va material rangi (hex). Nishon haqiqatan kadrda bormi — shu bilan isbotlanadi.
   */
  probeScene () {
    const Vec3 = this.camera.position.constructor;
    const out = [];
    const dir = new Vec3();
    this.camera.getWorldDirection(dir);
    for (const [kind, group, list] of [
      ['dummy', this.training.group, this.training.dummies.map((d) => d.model.rig)],
      ['ring', this.training.group, this.training.rings.map((r) => r.mesh)]
    ]) {
      list.forEach((obj, idx) => {
        const wp = new Vec3();
        obj.getWorldPosition(wp);
        const toObj = wp.clone().sub(this.camera.position);
        const dist = toObj.length();
        const inFront = dir.dot(toObj.normalize()) > 0;
        const p = wp.clone().project(this.camera);
        const colors = [];
        obj.traverse((o) => {
          if (o.isMesh && o.material && o.material.color) {
            colors.push('#' + o.material.color.getHexString());
          }
        });
        out.push({
          kind, idx, name: obj.name || `${kind}-${idx}`,
          pos: { x: +wp.x.toFixed(2), y: +wp.y.toFixed(2), z: +wp.z.toFixed(2) },
          distance: +dist.toFixed(2),
          inFront,
          ndc: { x: +p.x.toFixed(3), y: +p.y.toFixed(3) },
          onScreen: inFront && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1,
          visible: obj.visible && group.visible,
          colors: colors.slice(0, 6)
        });
      });
    }
    return { groupVisible: this.training.group.visible, objects: out };
  }

  /**
   * Nishon NDC proyeksiyasidan ekran piksel koordinatasi (1280x661 viewport uchun
   * emas — haqiqiy canvas o'lchami bo'yicha) va o'sha piksel atrofini o'qish.
   */
  probePixel (px, py) {
    // Kadrni hozir chizamiz va shu task ichida o'qiymiz — aks holda brauzer
    // drawing buffer'ni allaqachon almashgan bo'lishi mumkin
    this.renderer.render(this.scene, this.camera);
    const gl = this.renderer.getContext();
    const buf = new Uint8Array(4);
    const x = Math.max(0, Math.min(this.size.w - 1, Math.round(px)));
    const y = Math.max(0, Math.min(this.size.h - 1, this.size.h - Math.round(py) - 1));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { x, y, r: buf[0], g: buf[1], b: buf[2], a: buf[3] };
  }

  /** NDC → ekran piksel koordinatasi */
  ndcToPixel (nx, ny) {
    return {
      x: Math.round((nx + 1) / 2 * this.size.w),
      y: Math.round((1 - ny) / 2 * this.size.h)
    };
  }

  /**
   * JAHON koordinatasidagi nuqtani ekranga proyeksiya qilib, o'sha pikselning
   * rangini o'qiydi. Nishon (dummy/halqa) aynan shu yerda chindan chizilyaptimi —
   * shu bilan obyektiv isbotlanadi (rang qiymati bilan).
   */
  probeWorld (x, y, z) {
    const Vec3 = this.camera.position.constructor;
    const p = new Vec3(x, y, z);
    const inFront = p.clone().sub(this.camera.position).normalize()
      .dot(this.camera.getWorldDirection(new Vec3())) > 0;
    p.project(this.camera);
    const px = this.ndcToPixel(p.x, p.y);
    const onScreen = inFront && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
    const rgb = onScreen ? this.probePixel(px.x, px.y) : null;
    return { ndc: { x: +p.x.toFixed(3), y: +p.y.toFixed(3) }, pixel: px, inFront, onScreen, rgb };
  }

  // ---------------- verifikatsiya vositasi (test hook) ----------------
  /** O'yinchini ko'chirish va kamerani burish — faqat tekshiruv uchun */
  teleport (x, z, yaw, pitch, y) {
    this.movement.teleport(x, z, typeof yaw === 'number' ? yaw : undefined, typeof y === 'number' ? y : undefined);
    if (typeof yaw === 'number') this.cameraController.yaw = yaw;
    if (typeof pitch === 'number') {
      this.cameraController.pitch = clamp(pitch, CAMERA.PITCH_MIN, CAMERA.PITCH_MAX);
    }
    this.cameraController.first = true;
    const p = this.movement.pos;
    this.player.group.position.set(p.x, p.y, p.z);
    this.cameraController.update(1 / 60, p, MAP.FLOOR_Y);
    return this.diagnostics();
  }
}

