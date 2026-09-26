// ============================================================
// NEON STRIKE — Phase 1 unit/integration smoke testlari
// Ishga tushirish: node --test test/unit/   (yoki: npm test)
// Ephemeral port'da REAL server + REAL WebSocket ulanishlari.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createNeonServer } from '../../server/app.js';
import {
  MSG, SERVER_DEFAULTS, PROTOCOL_VERSION, SIM, TEAM, MATCH_PHASE, CHAT
} from '../../shared/protocol-consts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------- statik tekshiruvlar ----------
test('protocol-consts: kutilgan qiymatlar', () => {
  assert.equal(MSG.HELLO, 'hello');
  assert.equal(MSG.WELCOME, 'welcome');
  assert.equal(MSG.PONG, 'pong');
  assert.equal(SERVER_DEFAULTS.PORT, 3000);
  assert.equal(SERVER_DEFAULTS.WS_PATH, '/ws');
  // PHASE 5: avtoritativ xabarlar (additiv — Phase 1 turlari o'chirilmagan)
  assert.equal(MSG.INPUT, 'input');
  assert.equal(MSG.SESSION, 'session');
  assert.equal(MSG.STATE, 'state');
  assert.equal(MSG.EVENTS, 'events');
  assert.equal(MSG.INPUT_ACK, 'input-ack');
  assert.equal(MSG.RESET, 'reset');
  // PHASE 6: LAN lobby xabarlari (additiv — Phase 1–5 turlari o'chirilmagan)
  assert.equal(MSG.CREATE_SESSION, 'create-session');
  assert.equal(MSG.JOIN_SESSION, 'join-session');
  assert.equal(MSG.LEAVE_SESSION, 'leave-session');
  assert.equal(MSG.START_SESSION, 'start-session');
  assert.equal(MSG.LOBBY_STATE, 'lobby-state');
  assert.equal(SERVER_DEFAULTS.MAX_PLAYERS, 8);
  // PHASE 7: sinxronizatsiya xabari (additiv — Phase 1–6 turlari o'chirilmagan)
  assert.equal(MSG.SNAPSHOT, 'snapshot');
  // PHASE 8: match holati MAVJUD SNAPSHOT/LOBBY_STATE ichida (yangi xabar YO'Q)
  assert.equal(TEAM.A, 'A');
  assert.equal(TEAM.B, 'B');
  assert.equal(MATCH_PHASE.LIVE, 'live');
  assert.equal(MATCH_PHASE.MATCH_END, 'match_end');
  // PHASE 9: chat xabarlari (additiv — Phase 1–8 turlari o'chirilmagan)
  assert.equal(MSG.CHAT, 'chat');
  assert.equal(MSG.CHAT_MSG, 'chat-msg');
  assert.equal(CHAT.MAX_LEN, 160);
  assert.ok(CHAT.BURST >= 1 && CHAT.WINDOW_MS > 0);
  assert.equal(PROTOCOL_VERSION, 6);
  assert.equal(SIM.TICK_HZ, 30);
  assert.equal(SIM.SNAPSHOT_HZ, 20);
  assert.equal(SIM.INTERP_DELAY_MS, 100);
  assert.equal(SIM.MAX_SNAPSHOT_PLAYERS, 8);
  assert.equal(SIM.ROUNDS_TO_WIN, 5);
});

test('vendor: three.module.js mavjud, r160, butun fayl', () => {
  const p = path.join(ROOT, 'vendor', 'three.module.js');
  assert.ok(fs.existsSync(p), 'vendor/three.module.js yo‘q — tools/fetch-vendor.sh ishga tushiring');
  const src = fs.readFileSync(p, 'utf8');
  assert.match(src, /REVISION\s*=\s*'160'/, 'REVISION 160 emas');
  assert.ok(src.length > 500_000, `three.module.js juda kichik: ${src.length} bayt`);
});

test('ws paketi ESM import bo‘ladi', async () => {
  const ws = await import('ws');
  assert.equal(typeof ws.WebSocketServer, 'function');
});

// ---------- PHASE 3: map integratsiyasi (statik) ----------
test('client: game indeksi NEON FACILITY mapini ishlatadi (eski arena-mesh emas)', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'client', 'js', 'game', 'index.js'), 'utf8');
  assert.match(idx, /from '\/shared\/map\.js'/, 'index.js shared/map.js import qilmaydi');
  assert.match(idx, /createMapMesh/, 'index.js mapview ishlatmaydi');
  assert.ok(!/createArenaMesh|from '\.\/arena-mesh\.js'/.test(idx), 'eski arena-mesh kod havolasi qolgan');
  assert.ok(!/from '\/shared\/arena\.js'/.test(idx), 'eski shared/arena.js havolasi qolgan');

  const mapview = fs.readFileSync(path.join(ROOT, 'client', 'js', 'mapview.js'), 'utf8');
  assert.match(mapview, /from '\/shared\/map\.js'/, 'mapview shared/map.js o‘qimaydi');
  assert.match(mapview, /InstancedMesh/, 'mapview instanced render ishlatmaydi');
  assert.match(mapview, /\bCOLLIDERS\b/, 'mapview kollayderlardan qurmaydi');
});

test('client: statik sahna fayllari mavjud (PHASE 4 combat: index.html → main → combat HUD)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
  // Phase 4 combat qatlami hali ham e'lon qilingan (regressiya belgisi)
  assert.match(html, /PHASE 4 COMBAT/i, 'index.html Phase 4 combat belgisi yo‘q');
  // PHASE 9: joriy bosqich belgisi + chat paneli (yangi qatlam)
  assert.match(html, /PHASE 9/, 'index.html Phase 9 belgisi yo‘q');
  assert.match(html, /id="chatInput"/, 'chat kiritish maydoni yo‘q');
  assert.match(html, /id="roundBanner"/, 'raund banneri yo‘q');
  assert.match(html, /NEON FACILITY MAP/i, 'xarita nomi yo‘qoldi');
  assert.match(html, /js\/main\.js/);
  assert.match(html, /id="combatHud"/, 'combat HUD elementi yo‘q');
  assert.match(html, /id="chCrosshair"/, 'crosshair yo‘q');
  assert.match(html, /id="chReload"/, 'reload indikatori yo‘q');
  const main = fs.readFileSync(path.join(ROOT, 'client', 'js', 'main.js'), 'utf8');
  assert.match(main, /setMapVisible/, 'setMapVisible test hook yo‘q');
  assert.match(main, /version: 4/, 'client versiyasi 4 emas');
  assert.match(main, /combatQa/, 'combat QA hook yo‘q');
  assert.match(main, /aimAt/, 'aimAt QA hook yo‘q');
});

// ---------- real server (ephemeral port) ----------
const server = createNeonServer({ port: 0, log: { info () {}, warn () {} } });
await server.listen();
const PORT = server.httpServer.address().port;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

/**
 * Real WS ulanish. Kelgan xabarlar NAVBATGA yig'iladi — bu muhim: Phase 5 da
 * server hello'dan keyin ketma-ket WELCOME + SESSION + STATE yuboradi va ular
 * await orasida yo'qolib qolmasligi kerak.
 */
function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._queue = [];
    ws._waiters = [];
    const to = setTimeout(() => reject(new Error('connect timeout')), 3000);
    ws.onopen = () => { clearTimeout(to); resolve(ws); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('connect failed')); };
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      for (let i = 0; i < ws._waiters.length; i++) {
        const w = ws._waiters[i];
        if (!w.type || w.type === msg.type) {
          ws._waiters.splice(i, 1);
          clearTimeout(w.to);
          return w.resolve(msg);
        }
      }
      ws._queue.push(msg);
    });
  });
}
/**
 * Navbatdan (yoki kelishini kutib) xabar oladi. `wantType` berilsa — faqat shu
 * turdagi xabar (boshqalari navbatda qoladi).
 */
function nextMessage (ws, wantType = null) {
  for (let i = 0; i < ws._queue.length; i++) {
    if (!wantType || ws._queue[i].type === wantType) return Promise.resolve(ws._queue.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`msg timeout${wantType ? ' (' + wantType + ')' : ''}`)), 3000);
    ws._waiters.push({ type: wantType, resolve, to });
  });
}

test('WS: hello -> welcome (id + protokol versiyasi) + Phase 5 sessiya', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: MSG.HELLO, name: 'unit' }));
  const welcome = await nextMessage(ws, MSG.WELCOME);
  assert.equal(welcome.type, MSG.WELCOME);
  assert.equal(typeof welcome.id, 'number');
  assert.equal(welcome.protocol, PROTOCOL_VERSION);
  // PHASE 5: server darhol o'z sessiyasini e'lon qiladi (holat EGAsi server)
  const session = await nextMessage(ws, MSG.SESSION);
  assert.equal(session.type, MSG.SESSION);
  assert.equal(typeof session.sessionId, 'number');
  assert.equal(typeof session.playerId, 'string');
  assert.equal(session.tickHz, 30);
  assert.equal(session.snapshotHz, 20);
  assert.equal(session.map.name, 'NEON FACILITY');
  assert.equal(session.targets.length, 8, 'training nishonlari (5 dummy + 3 halqa)');
  ws.close();
});

test('WS: ping -> pong — aynan shu t bilan', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: MSG.HELLO, name: 'unit' }));
  await nextMessage(ws, MSG.WELCOME);
  ws.send(JSON.stringify({ type: MSG.PING, t: 12345.6 }));
  const pong = await nextMessage(ws, MSG.PONG);
  assert.equal(pong.type, MSG.PONG);
  assert.equal(pong.t, 12345.6);
  assert.equal(typeof pong.serverTime, 'number');
  ws.close();
});

test('WS: buzilgan JSON -> error, ulanish tirik qoladi', async () => {
  const ws = await connect();
  ws.send('{{{ bu json emas');
  const err = await nextMessage(ws, MSG.ERROR);
  assert.equal(err.type, MSG.ERROR);
  assert.equal(err.code, 'bad_json');
  ws.send(JSON.stringify({ type: MSG.PING, t: 1 }));
  const pong = await nextMessage(ws, MSG.PONG);
  assert.equal(pong.type, MSG.PONG);
  ws.close();
});

test('WS: noma‘lum xabar turi -> error (server crash qilmaydi)', async () => {
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'cheat_give_damage', dmg: 9999 }));
  const err = await nextMessage(ws, MSG.ERROR);
  assert.equal(err.type, MSG.ERROR);
  assert.equal(err.code, 'unknown_type');
  ws.close();
});

test('HTTP: / -> index.html 200, NEON STRIKE', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /NEON STRIKE/);
  assert.match(html, /js\/main\.js/);
});

test('HTTP: /vendor/three.module.js xizmat qiladi (js MIME)', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/vendor/three.module.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

test('HTTP: server manba fayllari oqlanmaydi', async () => {
  // fetch URL'ni normalizatsiya qiladi — raw so'rov ham tekshiramiz
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/../server/app.js', method: 'GET' },
      (res) => { res.resume(); resolve(res.statusCode); }
    );
    req.on('error', reject);
    req.end();
  });
  assert.ok([403, 404].includes(raw), `raw traversal status: ${raw}`);
  const enc = await fetch(`http://127.0.0.1:${PORT}/%2e%2e/server/app.js`);
  assert.ok([403, 404].includes(enc.status), `encoded traversal status: ${enc.status}`);
});

test('HTTP: noma‘lum yo‘laka 404', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/secret.txt`);
  assert.equal(res.status, 404);
});

// ---------- PHASE 3 regressiya: takroriy 'close' — bir marta log ----------
function waitFor (fn, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('WS: uzilish hodisasi ikki marta kelsa ham server bir marta log qiladi', async () => {
  const logs = [];
  const srv = createNeonServer({ port: 0, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  await srv.listen();
  const port = srv.httpServer.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('connect timeout')), 3000);
    ws.onopen = () => { clearTimeout(to); resolve(); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('connect failed')); };
  });
  const welcome = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('welcome timeout')), 3000);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === MSG.WELCOME) { clearTimeout(to); resolve(m); }
    });
  });
  ws.send(JSON.stringify({ type: MSG.HELLO, name: 'dup-close' }));
  await welcome;
  assert.equal(srv.state.connections.size, 1, 'ulanish ro‘yxatga olinmadi');

  const socket = [...srv.state.connections][0];
  ws.close();
  await waitFor(() => srv.state.connections.size === 0);
  // ws kutubxonasi 'close'ni takroran chaqirishi mumkin — guard shuni yutadi
  socket.emit('close');
  socket.emit('close');
  await new Promise((r) => setTimeout(r, 30));

  const dc = logs.filter((m) => String(m).includes('disconnected'));
  assert.equal(dc.length, 1, `disconnect log ${dc.length} marta yozildi: ${dc.join(' | ')}`);
  assert.equal(srv.state.connections.size, 0, 'ulanish ro‘yxatdan o‘chmadi');
  await srv.close();
});

test.after(() => server.close());