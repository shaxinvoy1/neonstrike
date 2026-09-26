// ============================================================
// NEON STRIKE — Phase 2: kiritish (WASD + Pointer Lock) boshqaruvi
// Klaviatura event.code bo'yicha (layout'ga bog'liq emas), sichqoncha
// harakati Pointer Lock ostida to'planadi (frame'da bir marta o'qiladi).
// ============================================================
export class InputManager {
  constructor (domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.pointerLocked = false;
    this.lockRequested = false;
    this.enabled = false;
    this.onLockChange = null;
    this.onKeyExtra = null;   // (code) => void  — masalan F3
    // --- PHASE 4: combat intents ---
    this.buttons = new Set();        // 'fire' (LMB), ushlab turish holati
    this.firePressedCount = 0;       // edge (yangi bosish) — semi-auto uchun
    this.reloadPressed = false;      // KeyR edge
    this.switchQueue = 0;            // Digit1..Digit4 → 1..4 (0 = yo'q)
    this._bound = false;
    this._boundHandlers = {};
  }

  /**
   * PHASE 9: matn maydoni (chat) fokusda bo'lsa — o'yin tugmalari ISHLAMAYDI.
   * Aks holda chatga yozish reload/qurol almashish/harakat sifatida qabul
   * qilinardi. Faqat HAQIQIY `input`/`textarea` fokusida ishlaydi.
   */
  typingInField () {
    const el = typeof document !== 'undefined' ? document.activeElement : null;
    if (!el || !el.tagName) return false;
    const t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || el.isContentEditable === true;
  }

  bind () {
    if (this._bound) return;
    const h = this._boundHandlers;
    h.keydown = (e) => {
      if (!this.enabled) return;
      if (this.typingInField()) return;   // PHASE 9: chat yozilmoqda
      this.keys.add(e.code);
      // --- PHASE 4: reload + qurol slotlari (edge'lar keydown'da) ---
      if (e.code === 'KeyR' && !e.repeat) this.reloadPressed = true;
      if (e.code === 'Digit1') this.switchQueue = 1;
      if (e.code === 'Digit2') this.switchQueue = 2;
      if (e.code === 'Digit3') this.switchQueue = 3;
      if (e.code === 'Digit4') this.switchQueue = 4;
      if (this.onKeyExtra) this.onKeyExtra(e.code, e);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    };
    h.keyup = (e) => { this.keys.delete(e.code); };
    h.mousedown = (e) => {
      // FAQAT Pointer Lock ostida otish (Phase 2/3 harness clicklarini buzmaslik)
      if (!this.enabled || !this.pointerLocked) return;
      if (this.typingInField()) return;   // PHASE 9: chat yozilayotganda o'q uzilmaydi
      if (e.button === 0) {
        this.buttons.add('fire');
        this.firePressedCount += 1;
      }
    };
    h.mouseup = (e) => {
      if (e.button === 0) this.buttons.delete('fire');
    };
    h.mousemove = (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };
    h.lockchange = () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
      if (!this.pointerLocked) this.buttons.clear();  // lock yo'q → trigger bo'shashadi
      if (this.onLockChange) this.onLockChange(this.pointerLocked);
    };
    h.click = () => { if (this.enabled && !this.pointerLocked) this.requestLock(); };
    h.blur = () => { this.keys.clear(); this.buttons.clear(); this.firePressedCount = 0; this.reloadPressed = false; this.switchQueue = 0; };

    window.addEventListener('keydown', h.keydown);
    window.addEventListener('keyup', h.keyup);
    window.addEventListener('blur', h.blur);
    document.addEventListener('mousemove', h.mousemove);
    document.addEventListener('mousedown', h.mousedown);
    document.addEventListener('mouseup', h.mouseup);
    document.addEventListener('pointerlockchange', h.lockchange);
    this.dom.addEventListener('click', h.click);
    this._bound = true;
  }

  unbind () {
    if (!this._bound) return;
    const h = this._boundHandlers;
    window.removeEventListener('keydown', h.keydown);
    window.removeEventListener('keyup', h.keyup);
    window.removeEventListener('blur', h.blur);
    document.removeEventListener('mousemove', h.mousemove);
    document.removeEventListener('mousedown', h.mousedown);
    document.removeEventListener('mouseup', h.mouseup);
    document.removeEventListener('pointerlockchange', h.lockchange);
    this.dom.removeEventListener('click', h.click);
    this._bound = false;
  }

  /** Pointer Lock so'rovi — foydalanuvchi jesti (click) ichida chaqirilishi shart */
  requestLock () {
    if (document.pointerLockElement === this.dom) return true;
    try {
      const p = this.dom.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(() => { /* jest yo'q — klik kutamiz */ });
      return true;
    } catch { return false; }
  }

  exitLock () {
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }

  has (code) { return this.keys.has(code); }

  /** -1..1 ko'rinishidagi harakat o'qlari (WASD + strelkalar) */
  get axes () {
    const f = (this.has('KeyW') || this.has('ArrowUp') ? 1 : 0) - (this.has('KeyS') || this.has('ArrowDown') ? 1 : 0);
    const r = (this.has('KeyD') || this.has('ArrowRight') ? 1 : 0) - (this.has('KeyA') || this.has('ArrowLeft') ? 1 : 0);
    return { forward: f, right: r };
  }

  get sprint () { return this.has('ShiftLeft') || this.has('ShiftRight'); }

  /** PHASE 4: ushlab turilgan trigger (auto qurollar uchun) */
  get firing () { return this.buttons.has('fire'); }

  /**
   * Combat intent'larini o'qish (frame'da bir marta). Edge'lar (yangi bosish)
   * o'qilgandan keyin tozalanadi — ushlab turish fire:true'da qoladi.
   * PHASE 5: shu obyekt serverga "combat request" bo'ladi.
   */
  consumeIntents () {
    const intents = {
      fire: this.firing,
      firePressed: this.firePressedCount > 0,
      reload: this.reloadPressed,
      switchSlot: this.switchQueue
    };
    this.firePressedCount = 0;
    this.reloadPressed = false;
    this.switchQueue = 0;
    return intents;
  }

  /** To'plangan sichqoncha harakati (frame'da bir marta) */
  consumeMouse () {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
