// ============================================================
// KIRITISH: kompyuter (klaviatura + sichqoncha, pointer lock) va
// telefon (sensorli: chap joystik, o'ng qarash maydoni, tugmalar).
// Har kadr `poll()` bitta umumiy holat qaytaradi (o'yin manbadan bexabar).
// ============================================================
import { settings, touchEnabled } from '../settings.js';

const KEYMAP = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyC: 'crouch', ControlLeft: 'crouch', Space: 'jump', KeyR: 'reload',
  KeyG: 'grenade', KeyV: 'knife', KeyF: 'knife', Tab: 'score', Digit1: 's1', Digit2: 's2', Digit3: 's3', Digit4: 's4', Digit5: 's5', KeyQ: 'cycle'
};

export class Input {
  constructor (canvas, overlay) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.keys = new Set();
    this.edges = new Set();
    this.lookX = 0; this.lookY = 0;
    this.fire = false; this.aim = false; this.firePressed = false;
    this.wheel = 0;
    this.enabled = false;
    this.locked = false;
    this.touch = touchEnabled();
    this.joy = { id: null, x0: 0, y0: 0, x: 0, y: 0 };
    this.lookTouch = { id: null, x: 0, y: 0 };
    this.tbtn = new Map();      // pointerId → tugma nomi
    this.tstate = { fire: false, aim: false, crouch: false, sprint: false };
    this._bind();
    if (this.touch) this._buildTouch();
  }

  _bind () {
    this._kd = (e) => {
      if (!this.enabled) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const k = KEYMAP[e.code];
      if (k) { if (!this.keys.has(k)) this.edges.add(k); this.keys.add(k); e.preventDefault(); }
    };
    this._ku = (e) => { const k = KEYMAP[e.code]; if (k) this.keys.delete(k); };
    this._mm = (e) => { if (this.enabled && this.locked) { this.lookX += e.movementX || 0; this.lookY += e.movementY || 0; } };
    this._md = (e) => {
      if (!this.enabled || this.touch) return;
      if (!this.locked) { this.requestLock(); return; }
      if (e.button === 0) { this.fire = true; this.firePressed = true; }
      if (e.button === 2) this.aim = true;
    };
    this._mu = (e) => { if (e.button === 0) this.fire = false; if (e.button === 2) this.aim = false; };
    this._wh = (e) => { if (this.enabled && this.locked) this.wheel += Math.sign(e.deltaY); };
    this._pl = () => { this.locked = document.pointerLockElement === this.canvas; if (!this.locked) { this.fire = false; this.aim = false; this.keys.clear(); } };
    this._ctx = (e) => e.preventDefault();
    this._blur = () => { this.keys.clear(); this.fire = false; this.aim = false; };
    addEventListener('keydown', this._kd);
    addEventListener('keyup', this._ku);
    addEventListener('mousemove', this._mm);
    this.canvas.addEventListener('mousedown', this._md);
    addEventListener('mouseup', this._mu);
    addEventListener('wheel', this._wh, { passive: true });
    document.addEventListener('pointerlockchange', this._pl);
    this.canvas.addEventListener('contextmenu', this._ctx);
    addEventListener('blur', this._blur);
  }

  requestLock () {
    if (this.touch) return;
    try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch {}
  }
  releaseLock () { if (document.pointerLockElement) document.exitPointerLock(); }

  // ---------------- sensorli boshqaruv ----------------
  _buildTouch () {
    const o = this.overlay;
    o.classList.add('touch-on');
    o.innerHTML = `
      <div class="t-joy" id="tJoy"><div class="t-joy-base"><div class="t-joy-knob" id="tKnob"></div></div></div>
      <div class="t-look" id="tLook"></div>
      <button class="t-btn t-fire" data-b="fire" aria-label="Otish">◉</button>
      <button class="t-btn t-fire2" data-b="fire" aria-label="Otish">◉</button>
      <button class="t-btn t-aim" data-b="aim">AIM</button>
      <button class="t-btn t-reload" data-b="reload">R</button>
      <button class="t-btn t-jump" data-b="jump">⤒</button>
      <button class="t-btn t-crouch" data-b="crouch">⤓</button>
      <button class="t-btn t-sprint" data-b="sprint">»</button>
      <button class="t-btn t-swap" data-b="cycle">⇄</button>
      <button class="t-btn t-gren" data-b="grenade">●</button>
      <button class="t-btn t-knife" data-b="knife">⟋</button>`;
    const joy = o.querySelector('#tJoy'), knob = o.querySelector('#tKnob'), look = o.querySelector('#tLook');
    this.knob = knob;
    const opt = { passive: false };
    joy.addEventListener('pointerdown', (e) => { e.preventDefault(); if (this.joy.id !== null) return; this.joy.id = e.pointerId; this.joy.x0 = e.clientX; this.joy.y0 = e.clientY; this.joy.x = 0; this.joy.y = 0; joy.setPointerCapture(e.pointerId); joy.classList.add('on'); }, opt);
    joy.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.joy.id) return;
      const R = 56;
      let dx = e.clientX - this.joy.x0, dy = e.clientY - this.joy.y0;
      const l = Math.hypot(dx, dy);
      // joystikni chetga surish = sprint (yuqoriga 1.35R dan ortiq)
      this.joySprint = -dy > R * 1.35;
      if (l > R) { dx *= R / l; dy *= R / l; }
      this.joy.x = dx / R; this.joy.y = dy / R;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }, opt);
    const joyEnd = (e) => { if (e.pointerId !== this.joy.id) return; this.joy.id = null; this.joy.x = this.joy.y = 0; this.joySprint = false; knob.style.transform = ''; joy.classList.remove('on'); };
    joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd);
    look.addEventListener('pointerdown', (e) => { e.preventDefault(); if (this.lookTouch.id !== null) return; this.lookTouch.id = e.pointerId; this.lookTouch.x = e.clientX; this.lookTouch.y = e.clientY; look.setPointerCapture(e.pointerId); }, opt);
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookTouch.id) return;
      const k = 2.2 * settings.touchSensitivity;
      this.lookX += (e.clientX - this.lookTouch.x) * k; this.lookY += (e.clientY - this.lookTouch.y) * k;
      this.lookTouch.x = e.clientX; this.lookTouch.y = e.clientY;
    }, opt);
    const lookEnd = (e) => { if (e.pointerId === this.lookTouch.id) this.lookTouch.id = null; };
    look.addEventListener('pointerup', lookEnd); look.addEventListener('pointercancel', lookEnd);
    for (const b of o.querySelectorAll('.t-btn')) {
      const name = b.dataset.b;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        b.classList.add('on');
        b._last = { x: e.clientX, y: e.clientY };
        b._pid = e.pointerId;
        if (name === 'fire') { this.tstate.fire = true; this.firePressed = true; }
        else if (name === 'aim') this.tstate.aim = !this.tstate.aim;
        else if (name === 'crouch') this.tstate.crouch = !this.tstate.crouch;
        else if (name === 'sprint') this.tstate.sprint = !this.tstate.sprint;
        else this.edges.add(name);
        this._syncToggles();
      }, opt);
      // otish tugmasini ushlab turib sudrash = qarash (haqiqiy mobil shooterlar kabi)
      b.addEventListener('pointermove', (e) => {
        if (name !== 'fire' || e.pointerId !== b._pid || !b._last) return;
        const k = 2.2 * settings.touchSensitivity;
        this.lookX += (e.clientX - b._last.x) * k; this.lookY += (e.clientY - b._last.y) * k;
        b._last.x = e.clientX; b._last.y = e.clientY;
      }, opt);
      const up = () => { b.classList.remove('on'); b._last = null; b._pid = null; if (name === 'fire') this.tstate.fire = [...o.querySelectorAll('.t-btn.on')].some((x) => x.dataset.b === 'fire'); this._syncToggles(); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    }
    // brauzer imo-ishoralarini o'chirish (scroll, zoom, pull-to-refresh)
    o.addEventListener('touchmove', (e) => e.preventDefault(), opt);
    o.addEventListener('gesturestart', (e) => e.preventDefault(), opt);
  }
  _syncToggles () {
    for (const [cls, on] of [['.t-aim', this.tstate.aim], ['.t-crouch', this.tstate.crouch], ['.t-sprint', this.tstate.sprint]]) {
      const el = this.overlay.querySelector(cls); if (el) el.classList.toggle('latched', on);
    }
  }

  setEnabled (on) {
    this.enabled = on;
    this.overlay.classList.toggle('t-visible', on && this.touch);
    if (!on) { this.keys.clear(); this.fire = false; this.aim = false; this.tstate.fire = false; }
  }

  /** Bir kadrlik holat (edge'lar shu yerda iste'mol qilinadi) */
  poll () {
    const k = this.keys;
    let f = (k.has('fwd') ? 1 : 0) - (k.has('back') ? 1 : 0);
    let r = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
    if (this.touch && this.joy.id !== null) {
      const dz = 0.12;
      const jx = Math.abs(this.joy.x) < dz ? 0 : this.joy.x, jy = Math.abs(this.joy.y) < dz ? 0 : this.joy.y;
      f = -jy; r = jx;
    }
    const e = this.edges;
    let slot = null;
    for (let i = 1; i <= 5; i++) if (e.has('s' + i)) slot = i;
    const out = {
      forward: Math.max(-1, Math.min(1, f)), right: Math.max(-1, Math.min(1, r)),
      sprint: k.has('sprint') || this.tstate.sprint || !!this.joySprint,
      crouch: k.has('crouch') || this.tstate.crouch,
      jump: e.has('jump'), reload: e.has('reload'), grenade: e.has('grenade'), knife: e.has('knife'),
      cycle: e.has('cycle') ? 1 : this.wheel > 0 ? 1 : this.wheel < 0 ? -1 : 0,
      slot,
      fire: this.fire || this.tstate.fire, firePressed: this.firePressed,
      aim: this.aim || this.tstate.aim,
      score: k.has('score'),
      lookX: this.lookX * settings.sensitivity * (this.touch ? 1 : 1), lookY: this.lookY * settings.sensitivity * (settings.invertY ? -1 : 1)
    };
    this.lookX = 0; this.lookY = 0; this.wheel = 0;
    this.firePressed = false;
    e.clear();
    return out;
  }

  dispose () {
    removeEventListener('keydown', this._kd); removeEventListener('keyup', this._ku); removeEventListener('mousemove', this._mm);
    this.canvas.removeEventListener('mousedown', this._md); removeEventListener('mouseup', this._mu); removeEventListener('wheel', this._wh);
    document.removeEventListener('pointerlockchange', this._pl); this.canvas.removeEventListener('contextmenu', this._ctx); removeEventListener('blur', this._blur);
    this.overlay.innerHTML = ''; this.overlay.classList.remove('touch-on', 't-visible');
  }
}
