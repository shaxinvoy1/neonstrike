// ============================================================
// NEON STRIKE — PHASE 10: PERFORMANCE / STABILITY INSTRUMENTATSIYA
//
// SOF modul: three.js / DOM / socket YO'Q → Node'da bevosita test qilinadi
// (test/unit/stability.test.js).
//
// Bu modul HECH NARSA hisoblamaydi va o'yin holatini O'ZGARTIRMAYDI — u faqat
// o'lchaydi. Har bir raqam HAQIQIY ish bajarilganda yoziladi (mock EMAS).
//
// Nima o'lchanadi:
//   • tick davomiyligi: count/avg/min/max/p50/p95/p99 + byudjetdan oshishlar
//   • snapshot generatsiyasi: vaqt, o'yinchi soni, taxminiy bayt
//   • ops: input/chat/lobby qabul+rad, buzilgan xabarlar, eventlar
//   • resurs hayoti (lifecycle): yaratilgan − yo'q qilingan = HOZIRGI (leak)
//   • xotira: rss/heap namunalari + birinchi namunaga nisbatan delta
//   • leak probe: har bir tur uchun live/max (yaratilib, yo'q qilinmagan)
// ============================================================

/** Byudjetdan oshgan tick'lar soni `overruns` da; foiz `overrunPct` da. */
export const DEFAULT_BUDGET_MS = 1000 / 30;   // 30 Hz → 33.33 ms

/** Ring bufer o'lchami (oxirgi N tick davomiyligi saqlanadi) */
export const DEFAULT_WINDOW = 512;

/**
 * @param {{budgetMs?:number, windowSize?:number, memSampleMs?:number}} opts
 */
export function createMetrics ({
  budgetMs = DEFAULT_BUDGET_MS,
  windowSize = DEFAULT_WINDOW,
  memSampleMs = 1000
} = {}) {
  const size = Math.max(8, Math.floor(windowSize));
  const tick = {
    count: 0, sum: 0, min: Infinity, max: 0, overruns: 0,
    ring: new Float64Array(size), at: 0, filled: 0
  };
  const snap = { count: 0, sum: 0, max: 0, playersLast: 0, playersMax: 0 };
  const ops = {
    inputs: 0, inputsAccepted: 0, inputsRejected: 0,
    chatAccepted: 0, chatRejected: 0,
    lobbyActions: 0, lobbyRejected: 0,
    malformed: 0, shotsAccepted: 0, shotsRejected: 0, events: 0
  };
  // Resurs hayoti: +1 yaratilganda, −1 yo'q qilinganda → live = yaratilgan − yo'q qilingan
  const life = {
    connections: 0, connectionsClosed: 0,
    sessions: 0, sessionsClosed: 0,
    members: 0, membersRemoved: 0,
    chatEntries: 0, chatEntriesDropped: 0
  };
  const mem = {
    samples: 0, firstRss: 0, firstHeap: 0,
    lastRss: 0, lastHeap: 0, lastExternal: 0,
    maxRss: 0, maxHeap: 0, lastAt: 0
  };
  let lastMemAt = 0;

  /** Ring buferga davomiylik yozish (O(1), allokatsiyasiz) */
  function push (ms) {
    tick.ring[tick.at] = ms;
    tick.at = (tick.at + 1) % size;
    if (tick.filled < size) tick.filled += 1;
  }

  return {
    budgetMs,
    windowSize: size,

    /** Bitta simulyatsiya tick'i tugadi */
    recordTick (ms) {
      if (!Number.isFinite(ms) || ms < 0) return tick.count;
      tick.count += 1;
      tick.sum += ms;
      if (ms < tick.min) tick.min = ms;
      if (ms > tick.max) tick.max = ms;
      if (ms > budgetMs) tick.overruns += 1;
      push(ms);
      return tick.count;
    },

    /** Bitta snapshot yuborish qadami (barcha sessiyalar uchun bir marta) */
    recordSnapshot (ms, players = 0) {
      if (!Number.isFinite(ms) || ms < 0) return snap.count;
      snap.count += 1;
      snap.sum += ms;
      if (ms > snap.max) snap.max = ms;
      snap.playersLast = players;
      if (players > snap.playersMax) snap.playersMax = players;
      return snap.count;
    },

    /** Input natijasi (ok=true → qabul) */
    recordInput (ok) {
      ops.inputs += 1;
      if (ok) ops.inputsAccepted += 1; else ops.inputsRejected += 1;
    },

    /** Chat natijasi (ok=true → tarqatildi) */
    recordChat (ok) {
      if (ok) ops.chatAccepted += 1; else ops.chatRejected += 1;
    },

    /** Lobby amali natijasi */
    recordLobby (ok) {
      ops.lobbyActions += 1;
      if (!ok) ops.lobbyRejected += 1;
    },

    /** Buzilgan/begona xabar (bad_json, unknown_type, too_big, ruxsatsiz maydon) */
    recordMalformed (n = 1) { ops.malformed += n; },
    recordShots (accepted, rejected = 0) {
      ops.shotsAccepted += accepted; ops.shotsRejected += rejected;
    },
    recordEvents (n = 0) { ops.events += n; },

    /**
     * Resurs hayoti hisobi. `lifecycle('sessions', +1)` — sessiya yaratildi,
     * `lifecycle('sessionsClosed', +1)` — yo'q qilindi.
     */
    lifecycle (key, n = 1) {
      if (life[key] === undefined) life[key] = 0;
      life[key] += n;
      return life[key];
    },

    /**
     * Xotira namunasi. `now` tashqaridan (deterministik testlar uchun);
     * `force` bilan vaqt tekshiruvi chetlab o'tiladi.
     * @returns {boolean} namuna olindi mi
     */
    sampleMemory (now = Date.now(), force = false) {
      if (!force && now - lastMemAt < memSampleMs) return false;
      lastMemAt = now;
      const m = process.memoryUsage();
      if (!mem.samples) { mem.firstRss = m.rss; mem.firstHeap = m.heapUsed; }
      mem.samples += 1;
      mem.lastRss = m.rss;
      mem.lastHeap = m.heapUsed;
      mem.lastExternal = m.external;
      mem.lastAt = now;
      if (m.rss > mem.maxRss) mem.maxRss = m.rss;
      if (m.heapUsed > mem.maxHeap) mem.maxHeap = m.heapUsed;
      return true;
    },

    /** Hoziroviy (delta emas) qiymatlar — testlar shuni o'qiydi */
    raw () {
      return {
        tick: { count: tick.count, sum: tick.sum, min: tick.min, max: tick.max, overruns: tick.overruns, filled: tick.filled },
        snapshot: { ...snap },
        ops: { ...ops },
        life: { ...life },
        memory: { ...mem }
      };
    },

    /** JSON-xavfsiz to'liq hisobot (foizlar ring buferdan) */
    snapshot () {
      const n = tick.filled;
      const sorted = n ? Array.from(tick.ring.subarray(0, n)).sort((a, b) => a - b) : [];
      const pct = (p) => {
        if (!n) return 0;
        const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
        return round(sorted[idx]);
      };
      const live = {
        connections: life.connections - life.connectionsClosed,
        sessions: life.sessions - life.sessionsClosed,
        members: life.members - life.membersRemoved,
        chatEntries: life.chatEntries - life.chatEntriesDropped
      };
      return {
        budgetMs: round(budgetMs),
        tick: {
          count: tick.count,
          avgMs: tick.count ? round(tick.sum / tick.count) : 0,
          minMs: n || tick.count ? round(tick.min === Infinity ? 0 : tick.min) : 0,
          maxMs: round(tick.max),
          p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99),
          window: n,
          overruns: tick.overruns,
          overrunPct: tick.count ? round((tick.overruns / tick.count) * 100) : 0,
          utilPct: tick.count ? round(((tick.sum / tick.count) / budgetMs) * 100) : 0
        },
        snapshot: {
          count: snap.count,
          avgMs: snap.count ? round(snap.sum / snap.count) : 0,
          maxMs: round(snap.max),
          playersLast: snap.playersLast,
          playersMax: snap.playersMax
        },
        ops: { ...ops },
        life: { ...life, live },
        memory: {
          samples: mem.samples,
          rssMb: mb(mem.lastRss),
          heapMb: mb(mem.lastHeap),
          externalMb: mb(mem.lastExternal),
          rssDeltaMb: mb(mem.lastRss - mem.firstRss),
          heapDeltaMb: mb(mem.lastHeap - mem.firstHeap),
          maxHeapMb: mb(mem.maxHeap),
          maxRssMb: mb(mem.maxRss),
          lastAt: mem.lastAt
        }
      };
    },

    /**
     * O'LCHOV OYNASINI tozalash (tick/snapshot/ops/xotira).
     *
     * DIQQAT: `life` (resurs hayoti) ATAYIN tozalanmaydi — u monoton hisob:
     * `yaratilgan − yopilgan = hozirgi`. Uni noldan boshlash `opened - closed`
     * invariantini buzadi (test buni ushladi: −2 ≠ 0). Hayot hisobini ham
     * tozalash kerak bo'lsa — `resetAll()`.
     */
    reset () {
      tick.count = 0; tick.sum = 0; tick.min = Infinity; tick.max = 0; tick.overruns = 0;
      tick.ring.fill(0); tick.at = 0; tick.filled = 0;
      snap.count = 0; snap.sum = 0; snap.max = 0; snap.playersLast = 0; snap.playersMax = 0;
      for (const k of Object.keys(ops)) ops[k] = 0;
      mem.samples = 0; mem.firstRss = 0; mem.firstHeap = 0;
      mem.lastRss = 0; mem.lastHeap = 0; mem.lastExternal = 0;
      mem.maxRss = 0; mem.maxHeap = 0; mem.lastAt = 0;
      lastMemAt = 0;
    },

    /** HAMMA narsa (o'lchov + resurs hayoti) — faqat yangi server uchun */
    resetAll () {
      this.reset();
      for (const k of Object.keys(life)) life[k] = 0;
    }
  };
}

function round (v) { return Math.round(v * 1000) / 1000; }
function mb (bytes) { return Math.round((bytes / 1048576) * 100) / 100; }

/**
 * LEAK PROBE: har bir tur uchun "yaratildi − yo'q qilindi" hisobi.
 * Tur nomlari erkin (masalan 'remoteMesh', 'chatNode', 'interpBuffer').
 * `expectZero()` — yopilgandan keyin 0 bo'lishi shart bo'lgan turlar ro'yxati.
 */
export function createLeakProbe () {
  const kinds = new Map();
  const kind = (k) => {
    let v = kinds.get(k);
    if (!v) { v = { created: 0, destroyed: 0, max: 0 }; kinds.set(k, v); }
    return v;
  };
  return {
    create (k, n = 1) {
      const v = kind(k);
      v.created += n;
      if (v.created - v.destroyed > v.max) v.max = v.created - v.destroyed;
      return v.created - v.destroyed;
    },
    destroy (k, n = 1) {
      const v = kind(k);
      v.destroyed += n;
      return v.created - v.destroyed;
    },
    live (k) { const v = kinds.get(k); return v ? v.created - v.destroyed : 0; },
    /** @returns {Record<string, {created:number,destroyed:number,live:number,max:number}>} */
    report () {
      const out = {};
      for (const [k, v] of kinds) {
        out[k] = { created: v.created, destroyed: v.destroyed, live: v.created - v.destroyed, max: v.max };
      }
      return out;
    },
    /** Ko'rsatilgan turlar bo'yicha qoldiq (leak) bormi */
    leaks (...names) {
      const rep = this.report();
      const out = {};
      for (const n of (names.length ? names : Object.keys(rep))) out[n] = rep[n] ? rep[n].live : 0;
      return out;
    },
    clear () { kinds.clear(); }
  };
}

/**
 * Node aktiv resurslari (handle/timer) — "runaway timer" va soket qoldiqlari
 * dalili. Node 20+ `process.getActiveResourcesInfo()` bo'lmasa — null.
 * @returns {{total:number, byType:Record<string,number>}|null}
 */
export function activeResources () {
  if (typeof process.getActiveResourcesInfo !== 'function') return null;
  const list = process.getActiveResourcesInfo();
  const byType = {};
  for (const t of list) byType[t] = (byType[t] || 0) + 1;
  return { total: list.length, byType };
}
