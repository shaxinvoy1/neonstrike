// ============================================================
// NEON STRIKE — PHASE 7: KLIENT ko'p o'yinchili sinxronizatsiya
//
// AVTORITET ZANJIRI (o'zgarmaydi):
//   klient input niyati → SERVER simulyatsiyasi → SNAPSHOT (20 Hz) → shu modul
//
// Bu modul FAQAT taqdim etish (presentation) bilan shug'ullanadi:
//   • masofaviy o'yinchilar — SERVER snapshot'idan (klient ularni "o'ylab
//     topmaydi"; serverdagi ro'yxatda yo'q bo'lsa — mesh YO'QOLADI)
//   • interpolatsiya — snapshot orasida silliq harakat (teleport EMAS)
//   • lokal rekonsiliatsiya — server holati USTUN; bashorat xatosi
//     tuzatiladi (klient hech qachon serverga o'z holatini "qabul qildirmaydi")
//
// Combat/hit/HP/zarar mantig'i BU YERDA YO'Q — u shared/combat.js da.
// ============================================================
import { MAP } from '/shared/map.js';
import { MOVE } from '/shared/collision.js';
import { SIM } from '/shared/protocol-consts.js';
import { createPlayer, animateHumanoid, updateBlobShadow, makeHumanoidMaterials } from './player.js';
import { PALETTE } from '/shared/map.js';
// PHASE 7: interpolatsiya/rekonsiliatsiya MATEMATIKASI — sof modul
// (Node'da ham test qilinadi: test/unit/multiplayer.test.js)
import {
  sampleBuffer, computeReconcile, applyCorrection,
  SNAP_THRESHOLD, SMOOTH_RATE
} from './sync-math.js';

/** Masofaviy o'yinchi uchun maksimal bufer (snapshot soni) */
const MAX_BUFFER = 24;
/** Tasdiqlanmagan bashorat navbati chegarasi */
const MAX_PENDING_INPUTS = 300;

/**
 * Bitta masofaviy o'yinchi: server snapshot buferi + mesh.
 * Mesh SERVER holatidan boshqariladi; bufer interpolatsiya uchun.
 */
class RemotePlayer {
  constructor (id, mats, teamId = null) {
    this.id = id;
    // PHASE 8: avtoritar jamoa (SERVER snapshot'idan) — faqat vizual belgi
    this.teamId = teamId;
    this.buffer = [];          // [{t, x,y,z, yaw, faceYaw, speed, alive}]
    // PHASE 10: bufer HECH QACHON chegaradan oshmaganini isbotlovchi o'lchov
    this.bufferMax = 0;
    this.alive = true;
    this.visible = true;
    this.sampleCount = 0;
    this.interpSamples = 0;
    this.extrapolated = false;
    this.render = { x: 0, y: 0, z: 0, yaw: 0, faceYaw: 0 };

    const p = createPlayer(mats);
    this.group = p.group;
    this.group.name = `remote-${id}`;
    this.model = p.model;
    this.shadow = p.shadow;
    this.shadow.visible = false;
    this.group.visible = false;
  }

  /** Yangi avtoritar holat qo'shish (arrivalTime — mahalliy performance.now()) */
  push (t, s) {
    const b = this.buffer;
    b.push({
      t,
      x: s.x, y: s.y, z: s.z,
      yaw: s.yaw, faceYaw: s.faceYaw === undefined ? s.yaw : s.faceYaw,
      speed: s.speed || 0,
      alive: s.alive !== false
    });
    if (b.length > MAX_BUFFER) b.splice(0, b.length - MAX_BUFFER);
    if (b.length > this.bufferMax) this.bufferMax = b.length;   // PHASE 10 o'lchov
    this.alive = s.alive !== false;
  }

  /**
   * renderT uchun interpolatsiya qilingan holat (sof `sampleBuffer` orqali).
   * `interpSamples` — interpolatsiya HAQIQATAN ishlaganini isbotlovchi
   * telemetriya (mock EMAS).
   */
  sample (renderT) {
    const r = sampleBuffer(this.buffer, renderT);
    if (!r) return null;
    this.sampleCount++;
    if (r.interpolated) this.interpSamples++;
    this.extrapolated = r.extrapolated;
    return r.state;
  }

  update (dt, renderT) {
    const s = this.sample(renderT);
    if (!s) return null;
    this.render.x = s.x; this.render.y = s.y; this.render.z = s.z;
    this.render.yaw = s.yaw; this.render.faceYaw = s.faceYaw;
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = s.faceYaw;
    this.group.visible = this.visible && s.alive;
    this.shadow.visible = this.group.visible;
    if (this.group.visible) {
      animateHumanoid(this.model, dt, s.speed, MOVE.SPRINT);
      updateBlobShadow(this.shadow, s.x, MAP.FLOOR_Y, s.z, s.y - MAP.FLOOR_Y);
    }
    return s;
  }

  dispose (scene) {
    scene.remove(this.group);
    scene.remove(this.shadow);
    this.buffer.length = 0;
  }
}

/**
 * Sessiyadagi hamma o'yinchining sinxronizatsiya holati (klient tomoni).
 * Server SNAPSHOT xabarini qabul qiladi; lokal bashoratni tuzatadi.
 */
export class MultiplayerSync {
  constructor ({ scene } = {}) {
    this.scene = scene;
    this.enabled = false;          // faqat in_game (server qaror qilgan)
    this.playerId = null;
    this.serverTick = 0;
    this.ackSeq = -1;
    this.lastSnapshotAt = 0;
    this.snapshots = 0;
    this.remotes = new Map();      // playerId -> RemotePlayer
    this.added = 0;
    this.removed = 0;
    this.duplicateIgnored = 0;

    // lokal rekonsiliatsiya
    this.pending = [];             // [{seq, x, y, z}] — tasdiqlanmagan bashorat
    this.pendingMax = 0;           // PHASE 10: navbat chegarasi dalili
    this.pendingCorrection = null;
    this.recon = { corrections: 0, smoothings: 0, lastError: 0, maxError: 0, samples: 0 };
    this.lastSelf = null;
    this.lastApplied = null;

    // PHASE 8: AVTORITAR match holati (faqat SERVER snapshot'idan). Klient uni
    // hisoblamaydi — faqat ko'rsatadi. Rasmiylashtirilgan minimal ko'rinish.
    this.match = null;
    this.matchMessages = 0;

    // PHASE 8: jamoa ranglari — mavjud palitradan (yangi asset YO'Q)
    this._matsByTeam = {
      A: makeHumanoidMaterials({ accent: PALETTE.PLAYER_ACCENT, core: PALETTE.PLAYER_CORE }),
      B: makeHumanoidMaterials({ accent: PALETTE.VIOLET, core: PALETTE.TARGET_ACCENT })
    };
    this._mats = this._matsByTeam.A;   // jamoasi noma'lum bo'lsa — A uslubi
  }

  /** in_game rejimi (server qaror qiladi — klient yoqmaydi) */
  setAuthoritative (on, playerId = null) {
    const next = !!on;
    if (next === this.enabled) {
      if (playerId) this.playerId = playerId;
      return this.enabled;
    }
    this.enabled = next;
    if (playerId) this.playerId = playerId;
    if (!next) {
      // o'yin tugadi → masofaviylarni tozalaymiz (stale state qolmasin)
      this.clearRemotes();
      this.pending.length = 0;
      this.pendingCorrection = null;
    }
    return this.enabled;
  }

  clearRemotes () {
    // PHASE 10: yo'q qilingan mesh'lar HAM hisoblanadi — aks holda
    // `yaratilgan − yo'q qilingan = hozirgi` invarianti buziladi (leak dalil
    // yaroqsiz bo'lardi).
    for (const r of this.remotes.values()) { r.dispose(this.scene); this.removed += 1; }
    this.remotes.clear();
  }

  /**
   * SERVER snapshot'i. Yagona haqiqat manbasi — masofaviylar FAQAT shu
   * ro'yxatdan yaratiladi/o'chiriladi va lokal holat shu yerdan tuzatiladi.
   */
  onSnapshot (msg, now = performance.now()) {
    if (!msg || msg.type !== undefined && msg.type !== 'snapshot') return null;
    this.snapshots++;
    this.serverTick = Number.isFinite(msg.serverTick) ? msg.serverTick : this.serverTick;
    this.lastSnapshotAt = now;
    // PHASE 8: AVTORITAR match holati (jamoa/raund/ball) — server yuboradi
    if (msg.match) { this.match = msg.match; this.matchMessages += 1; }
    const players = Array.isArray(msg.players) ? msg.players : [];

    // 1) lokal o'yinchi: ack + tuzatish uchun server pozitsiyasi
    if (this.playerId) {
      for (const p of players) {
        if (p && p.id === this.playerId) { this.lastSelf = p; break; }
      }
    }
    if (Number.isFinite(msg.ackSeq)) this.ackSeq = Math.max(this.ackSeq, msg.ackSeq);

    // 2) masofaviy o'yinchilar (server ro'yxatidan)
    const seen = new Set();
    for (const p of players) {
      if (!p || !p.id) continue;
      if (p.id === this.playerId) continue;              // o'zim — lokal model bor
      seen.add(p.id);
      let r = this.remotes.get(p.id);
      if (!r) {
        // PHASE 8: jamoa rangi SERVER bergan teamId bo'yicha (vizual belgi)
        const mats = this._matsByTeam[p.teamId] || this._matsByTeam.A;
        r = new RemotePlayer(p.id, mats, p.teamId || null);
        r.alive = p.alive !== false;
        r.visible = r.alive;
        this.remotes.set(p.id, r);
        this.scene.add(r.group);
        this.scene.add(r.shadow);
        this.added++;
      }
      r.teamId = p.teamId || r.teamId;
      r.push(now, p);
    }
    // serverda yo'q → mesh YO'QOLADI (disconnect/chiqish; stale remote yo'q)
    for (const [id, r] of this.remotes) {
      if (seen.has(id)) continue;
      r.dispose(this.scene);
      this.remotes.delete(id);
      this.removed++;
    }

    // 3) lokal rekonsiliatsiya navbati
    if (this.enabled && this.lastSelf) this._queueCorrection(now);
    return { remotes: this.remotes.size, self: this.lastSelf };
  }

  /**
   * PHASE 1: lokal o'yinchining AVTORITAR tiriklik holati (server snapshot'i).
   * `null` — hali noma'lum (sessiya faol emas / snapshot yo'q). Klient bu
   * qiymatni FAQAT cheklov/taqdimot uchun ishlatadi — HP/zarar avtoriteti
   * serverda qoladi (klient o'z HP sini "qabul qildirmaydi").
   * @returns {boolean|null}
   */
  selfAlive () {
    if (!this.enabled || !this.lastSelf) return null;
    return this.lastSelf.alive !== false;
  }

  /** Lokal bashoratni yozib borish (yuborilgan input ketma-ketligi bo'yicha) */
  recordLocalInput (seq, pos) {
    this.pending.push({ seq, x: pos.x, y: pos.y, z: pos.z });
    if (this.pending.length > MAX_PENDING_INPUTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
    }
    if (this.pending.length > this.pendingMax) this.pendingMax = this.pending.length;   // PHASE 10
  }

  /**
   * REKONSILIATSIYA: server tasdiqlagan ketma-ketlik (ackSeq) uchun bashorat
   * qilingan pozitsiyani SERVER pozitsiyasi bilan solishtiradi. Server
   * holati USTUN: xato katta bo'lsa — to'g'ridan-to'g'ri tuzatish (snap),
   * aks holda yumshoq tortish. Bu yerda faqat QAROR qilinadi; qo'llash
   * index.js da (u harakat holatiga ega).
   */
  _queueCorrection (now) {
    const self = this.lastSelf;
    const c = computeReconcile(this.pending, this.ackSeq, self, SNAP_THRESHOLD);
    if (!c) return;
    if (c.keepFrom > 0) this.pending.splice(0, c.keepFrom);
    this.recon.samples++;
    this.recon.lastError = +c.error.toFixed(4);
    if (c.error > this.recon.maxError) this.recon.maxError = +c.error.toFixed(4);
    this.pendingCorrection = { ...c, at: now };
  }

  /** Qo'llanishi kerak bo'lgan tuzatishni oladi (bir marta) */
  takeCorrection () {
    const c = this.pendingCorrection;
    this.pendingCorrection = null;
    return c;
  }

  /** Tuzatish qo'llangani — telemetriya */
  noteCorrection (c) {
    if (c.kind === 'snap') this.recon.corrections++;
    else this.recon.smoothings++;
  }

  /**
   * Server tuzatishini lokal harakat holatiga QO'LLASH. SERVER holati USTUN:
   * katta xatoda pozitsiya to'g'ridan-to'g'ri serverdan olinadi (bashorat
   * tashlanadi), kichik xatoda yumshoq tortish (ko'rinadigan sakrash yo'q).
   * @param {{pos:object, vel:object, vy:number}} movement lokal harakat holati
   */
  /**
   * PHASE 1: crosshair nuri uchun masofaviy o'yinchilar ro'yxati.
   * Pozitsiya — INTERPOLATSIYA qilingan TAQDIMOT pozasi (`render`), ya'ni
   * ekranda ko'rinib turgan joy; server esa o'z avtoritar pozasidan otadi.
   * Massiv qayta ishlatiladi (har kadr allokatsiya yo'q).
   */
  aimTargets (out = this._aimTargets || (this._aimTargets = [])) {
    const arr = out;
    let n = 0;
    for (const r of this.remotes.values()) {
      if (!r.alive) continue;
      let e = arr[n];
      if (!e) e = arr[n] = { id: '', alive: true, x: 0, y: 0, z: 0 };
      e.id = r.id;
      e.alive = true;
      e.x = r.render.x;
      e.y = r.render.y;
      e.z = r.render.z;
      n += 1;
    }
    arr.length = n;
    return arr;
  }

  applyTo (movement) {
    const c = this.pendingCorrection;
    if (!c || !movement) return null;
    this.pendingCorrection = null;
    this.lastApplied = applyCorrection(movement, c, SMOOTH_RATE);
    this.noteCorrection(c);
    return c;
  }

  update (dt, now = performance.now()) {
    if (!this.enabled) return 0;
    const renderT = now - SIM.INTERP_DELAY_MS;
    let n = 0;
    for (const r of this.remotes.values()) { r.update(dt, renderT); n++; }
    return n;
  }

  /** QA/verifikatsiya uchun o'qish (mock EMAS — haqiqiy holat) */
  qa () {
    const remotes = [];
    for (const r of this.remotes.values()) {
      remotes.push({
        id: r.id,
        teamId: r.teamId,
        alive: r.alive,
        visible: !!(r.group.visible),
        x: r.render.x, y: r.render.y, z: r.render.z,
        faceYaw: +r.render.faceYaw.toFixed(4),
        buffer: r.buffer.length,
        bufferMax: r.bufferMax,
        samples: r.sampleCount,
        interpSamples: r.interpSamples,
        lastServer: r.buffer.length ? {
          x: r.buffer[r.buffer.length - 1].x,
          y: r.buffer[r.buffer.length - 1].y,
          z: r.buffer[r.buffer.length - 1].z
        } : null
      });
    }
    return {
      enabled: this.enabled,
      playerId: this.playerId,
      serverTick: this.serverTick,
      ackSeq: this.ackSeq,
      snapshots: this.snapshots,
      lastSnapshotAgo: this.lastSnapshotAt ? +(performance.now() - this.lastSnapshotAt).toFixed(1) : -1,
      remoteCount: this.remotes.size,
      remoteIds: remotes.map((r) => r.id),
      added: this.added,
      removed: this.removed,
      pendingInputs: this.pending.length,
      // PHASE 10: kuzatilgan maksimallar (chegara buzilmagani dalili)
      bounds: {
        pendingMax: this.pendingMax,
        bufferMaxOverall: remotes.reduce((m, r) => Math.max(m, r.bufferMax), 0),
        limits: { pending: MAX_PENDING_INPUTS, buffer: MAX_BUFFER }
      },
      // PHASE 8: server yuborgan AVTORITAR match holati (klient hisoblamaydi)
      match: this.match ? {
        state: this.match.matchState,
        roundState: this.match.roundState,
        roundNumber: this.match.roundNumber,
        roundWinner: this.match.roundWinner,
        matchWinner: this.match.matchWinner,
        scores: this.match.scores,
        teams: this.match.teams,
        lives: this.match.lives,
        roundsToWin: this.match.roundsToWin,
        messages: this.matchMessages
      } : null,
      self: this.lastSelf
        ? { x: this.lastSelf.x, y: this.lastSelf.y, z: this.lastSelf.z, alive: this.lastSelf.alive, teamId: this.lastSelf.teamId || null }
        : null,
      remotes,
      interpolation: {
        delayMs: SIM.INTERP_DELAY_MS,
        samples: remotes.reduce((s, r) => s + r.interpSamples, 0),
        active: remotes.some((r) => r.interpSamples > 0)
      },
      reconciliation: { ...this.recon, threshold: SNAP_THRESHOLD, lastApplied: this.lastApplied || null }
    };
  }
}
