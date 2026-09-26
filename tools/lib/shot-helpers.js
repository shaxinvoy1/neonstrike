// ============================================================
// NEON STRIKE — verifikatsiya yordamchilari (in-page)
// tools/verify-phase2.mjs CDP orqali shu kodni sahifaga in'ektsiya qiladi.
// ============================================================
window.__v = {
  diag: () => window.__neon.diagnostics(),
  rect: (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height)
    };
  },
  badge: (id) => { const el = document.getElementById(id); return el ? el.textContent : null; },
  hidden: (id) => document.getElementById(id).hidden,
  debugText: () => document.getElementById('debugOverlay').textContent,
  playerNdc: () => window.__neon.probePlayer(),

  // ---- Pointer Lock / sichqoncha tekshiruvlari (haqiqiy DOM eventlari) ----
  /** Sahifaga real yetib kelgan mousemove eventlarini yozib boradi */
  installMouseProbe: () => {
    window.__mouseProbe = [];
    document.addEventListener('mousemove', (e) => {
      window.__mouseProbe.push({ movementX: e.movementX, movementY: e.movementY, clientX: e.clientX, isTrusted: e.isTrusted });
    }, true);
    window.__kbProbe = { keydown: [], keyup: [], blur: 0, focus: 0 };
    window.addEventListener('keydown', (e) => {
      window.__kbProbe.keydown.push({ code: e.code, isTrusted: e.isTrusted });
      if (window.__kbProbe.keydown.length > 40) window.__kbProbe.keydown.shift();
    }, true);
    window.addEventListener('keyup', (e) => {
      window.__kbProbe.keyup.push({ code: e.code });
      if (window.__kbProbe.keyup.length > 40) window.__kbProbe.keyup.shift();
    }, true);
    window.addEventListener('blur', () => { window.__kbProbe.blur++; });
    window.addEventListener('focus', () => { window.__kbProbe.focus++; });
    return true;
  },
  readMouseProbe: () => window.__mouseProbe || [],
  /**
   * Pointer Lock ostida sichqoncha harakatini simulyatsiya qiladi: brauzer
   * yaratadigan MouseEvent'ning aynan o'zi (movementX/movementY bilan) → ishlab
   * chiqarish kodidagi HAQIQIY handler (document mousemove) ishlaydi.
   */
  mouseMoveWithDelta: (dx, dy) => {
    document.dispatchEvent(new MouseEvent('mousemove', {
      movementX: dx, movementY: dy, bubbles: true, cancelable: false
    }));
    return true;
  },
  exitLock: () => { if (document.pointerLockElement) document.exitPointerLock(); return !!document.pointerLockElement; },
  lockState: () => ({ locked: document.pointerLockElement === document.getElementById('gl'), el: (document.pointerLockElement || {}).id || null }),
  /** RESUME tugmasini haqiqiy DOM click bilan bosish (ishlab chiqarish yo'li) */
  resumeClick: () => {
    const b = document.getElementById('btnResume');
    if (!b) return false;
    b.click();
    return true;
  },
  /**
   * Rasmni (drawing buffer'dan) skanerlaydi: sahnaning ANIQ neon ranglari
   * bo'yicha piksel soni va bounding box'ini qaytaradi. Anti-fake dalil:
   * "model/nishon ekranda bor" degan da'vo rang + joy bilan tasdiqlanadi.
   */
  sceneScan: async (dataUrl, tol = 26) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const targets = {
      ringOrange: [255, 138, 77],    // PALETTE.TARGET_ACCENT (halqa + dummy visor)
      dummyPink: [255, 77, 94],      // PALETTE.TARGET (dummy aksenti)
      playerCyan: [53, 200, 255],    // PALETTE.PLAYER_ACCENT (o'yinchi neon)
      violet: [123, 92, 255],        // PALETTE.TRIM_ALT / PLAYER_CORE
      floorBlue: [13, 19, 48]        // PALETTE.FLOOR
    };
    const out = {};
    for (const k of Object.keys(targets)) out[k] = { count: 0, box: null };
    let lumSum = 0, lumMin = 255, lumMax = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumSum += lum; n++;
      if (lum < lumMin) lumMin = lum;
      if (lum > lumMax) lumMax = lum;
      const px = (i / 4) % c.width;
      const py = Math.floor((i / 4) / c.width);
      for (const k of Object.keys(targets)) {
        const t = targets[k];
        if (Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol) {
          const o = out[k];
          o.count++;
          if (!o.box) o.box = [px, py, px, py];
          else {
            if (px < o.box[0]) o.box[0] = px;
            if (py < o.box[1]) o.box[1] = py;
            if (px > o.box[2]) o.box[2] = px;
            if (py > o.box[3]) o.box[3] = py;
          }
        }
      }
    }
    return {
      size: [c.width, c.height],
      lum: { avg: +(lumSum / n).toFixed(2), min: lumMin, max: lumMax },
      colors: out
    };
  },
  /** data URL skrinshotni luminance/rang statistikasiga aylantiradi */
  // ---- model/miqyos tekshiruvlari (piksel dalili) ----
  playerVisible: (v) => window.__neon.setPlayerVisible(v),
  trainingVisible: (v) => window.__neon.setTrainingVisible(v),
  diff: async (dataUrlA, dataUrlB) => {
    const load = async (u) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = u; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    };
    const a = await load(dataUrlA), b = await load(dataUrlB);
    const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
    const db = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
    let changed = 0, maxDelta = 0, sumDelta = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > 12) changed++;
      if (d > maxDelta) maxDelta = d;
      sumDelta += d;
    }
    const px = da.length / 4;
    return {
      changedPixels: changed,
      changedRatio: +(changed / px).toFixed(5),
      maxDelta,
      avgDelta: +(sumDelta / px).toFixed(3)
    };
  },
  /** Kamera oldidagi nishon (dummy) piksellarini o'lchash uchun: ekran tahlili */
  analyze: async (dataUrl, stride = 5) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, min = 255, max = 0, cyan = 0, red = 0, violet = 0, dark = 0, n = 0;
    const buckets = new Set();
    for (let i = 0; i < d.length; i += 4 * stride) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; n++;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      if (lum < 26) dark++;
      if (b > 140 && g > 105 && r < 165 && (b - r) > 40) cyan++;
      // nishon aksenti (PALETTE.TARGET 0xff4d5e / TARGET_ACCENT 0xff8a4d) —
      // "iliq" qizil-to'q sariq yo'nalish; cyan/violet'dan aniq ajraladi
      if (r > 100 && (r - g) > 40 && (r - b) > 30) red++;
      if (b > 105 && r > 65 && (b - g) > 40) violet++;
      buckets.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
    }
    return {
      width: c.width, height: c.height, samples: n,
      lumAvg: +(sum / n).toFixed(2), lumMin: min, lumMax: max,
      darkRatio: +(dark / n).toFixed(4), cyanRatio: +(cyan / n).toFixed(4),
      redRatio: +(red / n).toFixed(4), violetRatio: +(violet / n).toFixed(4),
      colorBuckets: buckets.size
    };
  }
};
'helpers-ready';
