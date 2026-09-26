// ============================================================
// NEON STRIKE — PHASE 4: combat HUD (crosshair / qurol / o'q-dori / HP /
// reload / o'lim / kill-feed / zarar flash)
// Faqat DOM matni va CSS o'zgaruvchilarini yangilaydi — 3D kod yo'q.
// QIMMAT yozuvlarni kamaytirish uchun har bir qiymat keshlanadi (o'zgarmasa
// DOM tegilmaydi). Mavjud "frozen" HUD timer formati (index.js) TEGILMAYDI.
// ============================================================
import { WEAPON_ORDER, WEAPONS } from '/shared/weapons.js';
import { HEALTH } from '/shared/health.js';

const FEED_TTL_MS = 2200;
const MARKER_TTL_MS = 200;
const DAMAGE_TTL_MS = 420;

export class CombatHud {
  /** @param {object} refs — index.html dagi elementlar (main.js beradi) */
  constructor (refs = {}) {
    this.r = refs;
    this._c = {};
    this.errorText = '';
    this.hitT = 0;
    this.damageT = 0;
    this.dmgNumT = 0;
    this.dmgDirT = 0;
    this.feedT = 0;
    this.feed = '';
    this.visible = false;
    this._slotEls = null;
    // PHASE 9: oxirgi qiymat manbasi — 'server' (avtoritar) yoki 'predict'
    this.source = 'predict';
    // PHASE 10: HAQIQIY DOM yozuv hisobi — "HUD har kadr DOM ni qayta
    // qurmaydi" da'vosini o'lchovga aylantiradi (domWrites kichik, domSkips
    // katta bo'lishi kerak).
    this.domWrites = 0;
    this.domSkips = 0;
  }

  /** HUD blokini ko'rsatish/yashirish (menyuga qaytganda) */
  setVisible (v) {
    this.visible = !!v;
    if (this.r.root) this.r.root.hidden = !this.visible;
    return this.visible;
  }

  /** Sha'ba (setter) — matn keshini buzmaslik uchun */
  _text (el, key, value) {
    if (!el) return;
    if (this._c[key] === value) { this.domSkips += 1; return; }
    this._c[key] = value;
    this.domWrites += 1;                       // PHASE 10 o'lchov
    el.textContent = value;
  }

  /** CSS xossa (custom property bo'lsa setProperty — aks holda jimgina yo'qoladi) */
  _style (el, key, prop, value) {
    if (!el) return;
    const k = key + ':' + prop;
    if (this._c[k] === value) { this.domSkips += 1; return; }
    this._c[k] = value;
    this.domWrites += 1;                       // PHASE 10 o'lchov
    if (prop.startsWith('--')) el.style.setProperty(prop, value);
    else el.style[prop] = value;
  }

  /** Faol qurol slotlarini bir marta qurish (1..4 indikator) */
  _buildSlots () {
    if (this._slotEls || !this.r.slots) return;
    this._slotEls = [];
    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const el = document.createElement('span');
      el.className = 'ch-slot-chip';
      el.dataset.slot = String(i + 1);
      el.textContent = String(i + 1);
      this.r.slots.appendChild(el);
      this._slotEls.push(el);
    }
  }

  /** O'q uzilganda hit-markeri (crosshair) miltillashi */
  hitMarker () { this.hitT = MARKER_TTL_MS; }

  /** Zarar flash (o'z granatasi / o'lim / server hodisasi) */
  damageFlash (amount) {
    this.damageT = DAMAGE_TTL_MS;
    this._damageAmount = amount;
  }

  /**
   * PHASE 1: AVTORITAR zarar raqami (server EVENTS → hit/damage-taken).
   * Bu qiymat HECH QACHON klient hisobidan olinmaydi.
   */
  damageNumber (amount) {
    if (!this.r.dmgNum || !Number.isFinite(amount) || amount <= 0) return;
    this.dmgNumT = DAMAGE_TTL_MS;
    this._text(this.r.dmgNum, 'dmgNum', String(Math.round(amount)));
    if (this.r.dmgNum) this.r.dmgNum.classList.add('on');
  }

  /**
   * PHASE 1: zarar YO'NALISHI indikatori. `from` — hujumchi jahon pozasi
   * (server hodisasidan), `pos` — o'z pozasi, `yaw` — kamera yaw.
   * Sof TAQDIMOT: 0° = old tomondan, soat yo'nalishida aylanadi.
   */
  damageDirection (from, pos, yaw) {
    if (!this.r.dmgDir || !Array.isArray(from) || from.length < 3 || !pos) return;
    const dx = from[0] - pos.x;
    const dz = from[2] - pos.z;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    // Kamera bazisi (shared/aim.js): forward = (sin yaw, cos yaw),
    // screen-right = (-cos yaw, sin yaw). CSS 0deg = yuqori (old).
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);
    const f = dx * sy + dz * cy;         // old (+) / orqa (−)
    const r = -dx * cy + dz * sy;        // o'ng (+) / chap (−)
    const deg = Math.atan2(r, f) * 180 / Math.PI;
    this.dmgDirT = DAMAGE_TTL_MS;
    this._style(this.r.dmgDir, 'dmgDir', '--dmg-rot', deg.toFixed(1) + 'deg');
    this.r.dmgDir.hidden = false;
  }

  /** Kill-feed yozuvi */
  pushFeed (text) {
    this.feed = text;
    this.feedT = FEED_TTL_MS;
    this._text(this.r.feed, 'feed', text);
    if (this.r.feed) this.r.feed.classList.add('on');
  }

  /**
   * Har kadr yangilanish.
   *
   * PHASE 9: HUD AVTORITAR holatni afzal ko'radi. Agar `auth` berilgan va u
   * server rejimida bo'lsa (authoritative=true) — HP/o'q-dori/reload qiymatlari
   * SERVERDAN olinadi; aks holda (offline TRAINING) lokal bashorat ko'rsatiladi.
   * Bu yerda hech narsa HISOBLANMAYDI — faqat ko'rsatiladi.
   *
   * @param {number} dtMs
   * @param {object} snap — shared/combat.js combatSnapshot natijasi (bashorat)
   * @param {object|null} auth — PHASE 9 HUD ko'rinishi (client/js/game/hud-state.js)
   */
  update (dtMs, snap, auth = null) {
    if (!this.visible || !snap) return;
    this._buildSlots();
    const useAuth = !!(auth && auth.authoritative === true);
    this.source = useAuth ? 'server' : 'predict';
    const w = useAuth ? auth.weapon : snap.weapon;

    // ---- crosshair: spread bo'yicha ochilish (base/moving) ----
    if (this.r.crosshair) {
      const wc = WEAPONS[w.weaponId];
      const spread = wc ? (snap.moving ? wc.spreadDeg.moving : wc.spreadDeg.base) : 0;
      const gap = 3 + Math.min(14, spread * 2.6);
      this._style(this.r.crosshair, 'crosshair', '--gap', gap.toFixed(2) + 'px');
    }

    // ---- qurol nomi + slot ----
    // (avtoritar manbada faqat weaponId bo'ladi — nom WEAPONS'dan olinadi)
    const wcfg = WEAPONS[w.weaponId];
    this._text(this.r.weaponName, 'wname', w.weaponName || (wcfg ? wcfg.name : '—'));
    this._text(this.r.weaponSlot, 'wslot', `${w.slot}/${WEAPON_ORDER.length}`);
    if (this._slotEls) {
      for (let i = 0; i < this._slotEls.length; i++) {
        const on = i === w.slot - 1;
        if (this._slotEls[i].classList.contains('on') !== on) this._slotEls[i].classList.toggle('on', on);
      }
    }

    // ---- o'q-dori ----
    this._text(this.r.mag, 'mag', String(w.mag));
    this._text(this.r.reserve, 'reserve', String(w.reserve));
    if (this.r.ammoBlock) {
      const low = w.mag === 0;
      if (low !== this._c.lowAmmo) {
        this._c.lowAmmo = low;
        this.r.ammoBlock.classList.toggle('empty', low);
      }
    }

    // ---- reload holati ----
    const showReload = w.reloading;
    if (showReload !== this._c.showReload) {
      this._c.showReload = showReload;
      if (this.r.reload) this.r.reload.hidden = !showReload;
      if (this.r.crosshair) this.r.crosshair.classList.toggle('reloading', showReload);
    }
    if (showReload) {
      const pct = Math.round(Math.max(0, Math.min(1, w.reloadProgress || 0)) * 100);
      this._style(this.r.reloadFill, 'reloadFill', 'width', pct + '%');
      this._text(this.r.reloadText, 'reloadText', `RELOADING ${pct}%`);
    }

    // ---- switching holati ----
    if (this.r.crosshair) {
      const sw = w.switching;
      if (sw !== this._c.switching) {
        this._c.switching = sw;
        this.r.crosshair.classList.toggle('switching', !!sw);
      }
    }

    // ---- HP (avtoritar rejimda — SERVER qiymati) ----
    const srcHp = useAuth ? auth.hp : snap.hp;
    const srcMaxHp = useAuth ? auth.maxHp : snap.maxHp;
    const hp = Math.max(0, Math.round(srcHp));
    const pctHp = Math.max(0, Math.min(1, hp / Math.max(1, srcMaxHp)));
    this._text(this.r.hp, 'hp', String(hp));
    this._style(this.r.healthFill, 'healthFill', 'width', (pctHp * 100).toFixed(1) + '%');
    if (this.r.healthBar) {
      const band = pctHp > 0.6 ? 'ok' : pctHp > 0.3 ? 'warn' : 'bad';
      if (band !== this._c.hpBand) {
        this._c.hpBand = band;
        this.r.healthBar.dataset.band = band;
      }
    }

    // ---- hisob ----
    this._text(this.r.kills, 'kills', String(snap.stats ? snap.stats.kills : 0));
    this._text(this.r.deaths, 'deaths', String(snap.deaths || 0));

    // ---- o'lim ekrani + respawn sanoq ----
    const dead = useAuth ? auth.dead : !snap.alive;
    if (dead !== this._c.dead) {
      this._c.dead = dead;
      if (this.r.dead) this.r.dead.hidden = !dead;
      if (this.r.root) this.r.root.classList.toggle('is-dead', dead);
    }
    if (dead) {
      // Raund rejimida `respawnIn < 0` → avtomatik respawn YO'Q (keyingi raund)
      const respawnIn = useAuth ? auth.respawnIn : snap.respawnIn;
      const waitsRound = !Number.isFinite(respawnIn) || respawnIn < 0;
      this._text(this.r.deadTitle, 'deadTitle', waitsRound ? 'ELIMINATED' : 'DOWNED');
      if (this.r.deadRespawn) this.r.deadRespawn.hidden = waitsRound;
      if (this.r.deadWait) this.r.deadWait.hidden = !waitsRound;
      if (!waitsRound) this._text(this.r.respawnIn, 'respawnIn', respawnIn.toFixed(1));
    }

    // ---- hit marker / zarar flash so'nishi ----
    this.hitT = Math.max(0, this.hitT - dtMs);
    this._style(this.r.hitmarker, 'hitmarker', 'opacity', (this.hitT / MARKER_TTL_MS).toFixed(3));
    this.damageT = Math.max(0, this.damageT - dtMs);
    this._style(this.r.damage, 'damage', 'opacity', (this.damageT / DAMAGE_TTL_MS * 0.7).toFixed(3));

    // ---- PHASE 1: avtoritar zarar raqami + yo'nalish indikatori so'nishi ----
    if (this.dmgNumT > 0) {
      this.dmgNumT = Math.max(0, this.dmgNumT - dtMs);
      this._style(this.r.dmgNum, 'dmgNum', 'opacity', (this.dmgNumT / DAMAGE_TTL_MS).toFixed(3));
      if (this.dmgNumT === 0 && this.r.dmgNum) this.r.dmgNum.classList.remove('on');
    }
    if (this.dmgDirT > 0) {
      this.dmgDirT = Math.max(0, this.dmgDirT - dtMs);
      if (this.dmgDirT === 0 && this.r.dmgDir) this.r.dmgDir.hidden = true;
    }

    // ---- kill-feed so'nishi ----
    if (this.feedT > 0) {
      this.feedT = Math.max(0, this.feedT - dtMs);
      if (this.feedT === 0 && this.r.feed) {
        this.r.feed.classList.remove('on');
        this._text(this.r.feed, 'feed', '');
      }
    }
  }

  /** QA/debug: HUD holati (verifikatsiya uchun o'qish) */
  state (snap) {
    const w = snap && snap.weapon ? snap.weapon : null;
    return {
      /** PHASE 9: qiymatlar qayerdan — 'server' (avtoritar) yoki 'predict' */
      source: this.source,
      visible: this.visible,
      weapon: this.r.weaponName ? this.r.weaponName.textContent : null,
      mag: this.r.mag ? this.r.mag.textContent : null,
      reserve: this.r.reserve ? this.r.reserve.textContent : null,
      hp: this.r.hp ? this.r.hp.textContent : null,
      reloading: !!(this.r.reload && !this.r.reload.hidden),
      reloadText: this.r.reloadText ? this.r.reloadText.textContent : null,
      dead: !!(this.r.dead && !this.r.dead.hidden),
      respawnIn: this.r.respawnIn ? this.r.respawnIn.textContent : null,
      kills: this.r.kills ? this.r.kills.textContent : null,
      deaths: this.r.deaths ? this.r.deaths.textContent : null,
      crosshairPresent: !!(this.r.crosshair && this.r.crosshair.isConnected),
      crosshairClass: this.r.crosshair ? this.r.crosshair.className : null,
      feed: this.r.feed ? this.r.feed.textContent : null,
      // PHASE 1: avtoritar feedback ko'rinishi (dalil)
      dmgNum: this.r.dmgNum ? this.r.dmgNum.textContent : null,
      dmgNumVisible: !!(this.r.dmgNum && this.r.dmgNum.classList.contains('on')),
      dmgDirVisible: !!(this.r.dmgDir && !this.r.dmgDir.hidden),
      dmgDirRot: this.r.dmgDir ? this.r.dmgDir.style.getPropertyValue('--dmg-rot') : null,
      maxHp: HEALTH.PLAYER_MAX,
      weaponId: w ? w.weaponId : null
    };
  }
}
