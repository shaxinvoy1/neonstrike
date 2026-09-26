// ============================================================
// NEON STRIKE — PHASE 11: LAN QA testlari (DETERMINISTIK qism)
//
// BU FAYL "IKKI QURILMA" DEB DA'VO QILMAYDI. Bu yerda faqat bitta hostda
// halol tekshiriladigan LAN mantiqi sinovdan o'tadi:
//   • LAN interfeys aniqlash (loopback/internal CHIQARILADI)
//   • Device B ochadigan manzil (hapqiqiy interfeysdan, hard-code YO'Q)
//   • klient WS manzili formulasi bilan mosligi (location.host → ws://host/ws)
//   • server 0.0.0.0 ga bind bo'lishi
//   • HAQIQIY LAN interfeys IP'si orqali HTTP + WS ulanish (loopback EMAS)
//   • peer tasnifi: 'loopback' | 'self' | 'remote' — ya'ni "bu mening o'zim"
//     bilan "bu boshqa qurilma" farqi. Verifikator aynan shu tasnifga tayanadi,
//     shuning uchun u TESTLANADI (soxta ikki-qurilma dalili mumkin bo'lmasin).
//
// Mock YO'Q: WS ulanishlar haqiqiy serverga, haqiqiy LAN interfeys orqali.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

import {
  normalizeIp, isLoopbackIp, lanInterfaces, lanUrls, wsUrlFor,
  classifyPeer, localIpv4Addresses
} from '../../server/net.js';
import { createNeonServer } from '../../server/app.js';
import { SERVER_DEFAULTS, MSG } from '../../shared/protocol-consts.js';

// ---------------- sof mantiq (deterministik) ----------------

test('net: IPv6-mapped/zone IPv4 manzillar normallashtiriladi', () => {
  assert.equal(normalizeIp('::ffff:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIp('::FFFF:10.0.0.5'), '10.0.0.5');
  assert.equal(normalizeIp('fe80::1%enp2s0'), 'fe80::1');
  assert.equal(normalizeIp('  10.0.0.7  '), '10.0.0.7');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(undefined), '');
});

test('net: loopback aniqlash (127.0.0.0/8 va ::1)', () => {
  for (const ip of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackIp(ip), true, `${ip} loopback bo'lishi kerak`);
  }
  for (const ip of ['10.201.177.74', '192.168.1.7', '::ffff:10.0.0.9', '']) {
    assert.equal(isLoopbackIp(ip), false, `${ip} loopback EMAS`);
  }
});

test('net: LAN interfeyslar — faqat haqiqiy IPv4 (internal/loopback chiqariladi)', () => {
  const fake = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true, netmask: '255.0.0.0' }],
    eth0: [
      { family: 'IPv6', address: 'fe80::1', internal: false, netmask: 'ffff::' },
      { family: 'IPv4', address: '10.201.177.74', internal: false, netmask: '255.255.255.0' },
      { family: 4, address: '192.168.5.9', internal: false, netmask: '255.255.255.0' }  // raqamli family
    ],
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false, netmask: '255.255.0.0' }],
    down: null
  };
  const list = lanInterfaces(fake);
  const addrs = list.map((i) => i.address).sort();
  assert.deepEqual(addrs, ['10.201.177.74', '172.17.0.1', '192.168.5.9']);
  assert.ok(!addrs.includes('127.0.0.1'), 'loopback CHIQARILISHI kerak');
  assert.equal(list.find((i) => i.address === '10.201.177.74').netmask, '255.255.255.0');
  assert.equal(lanInterfaces({}).length, 0);
});

test('net: Device B manzili haqiqiy interfeysdan olinadi; interfeys yo\u2018q bo\u2018lsa localhost fallback', () => {
  const fake = { eth0: [{ family: 'IPv4', address: '10.201.177.74', internal: false }] };
  assert.deepEqual(lanUrls(fake, 3000), ['http://10.201.177.74:3000']);
  // loopback-only host → halol fallback (soxta LAN manzil o'ylab topilmaydi)
  const onlyLo = { lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] };
  assert.deepEqual(lanUrls(onlyLo, 3000), ['http://localhost:3000']);
  assert.deepEqual(lanUrls({}, 3000), ['http://localhost:3000']);
});

test('net: klientning WS formulasi bilan mos (location.host → ws://host/ws)', () => {
  assert.equal(wsUrlFor('10.201.177.74:3000'), 'ws://10.201.177.74:3000/ws');
  assert.equal(wsUrlFor('10.201.177.74:3000', true), 'wss://10.201.177.74:3000/ws');
  assert.equal(wsUrlFor('localhost:3000'), 'ws://localhost:3000/ws');
  assert.equal(SERVER_DEFAULTS.WS_PATH, '/ws');

  // MUHIM: real klient manzilni `location.host` dan yasashi SHART — shu sabab
  // Device B faqat http://<DEVICE_A_LAN_IP>:3000 ni ochishi kifoya (qo'lda IP
  // kiritish shart emas, va manzil hard-code qilinmagan).
  const src = fs.readFileSync(path.resolve('client/js/main.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('wsUrl'));
  assert.ok(line, 'client/js/main.js da wsUrl topilmadi');
  assert.match(line, /location\.protocol === 'https:' \? 'wss:\/\/' : 'ws:\/\//);
  assert.match(line, /location\.host/);
  assert.match(line, /'\/ws'/);
});

test('net: peer tasnifi — loopback/self/remote (ikki-qurilma dalilining asosi)', () => {
  const locals = ['127.0.0.1', '10.201.177.74', '172.17.0.1'];
  assert.equal(classifyPeer('127.0.0.1', locals), 'loopback');
  assert.equal(classifyPeer('::1', locals), 'loopback');
  assert.equal(classifyPeer('::ffff:127.0.0.1', locals), 'loopback');
  assert.equal(classifyPeer('10.201.177.74', locals), 'self');
  assert.equal(classifyPeer('::ffff:10.201.177.74', locals), 'self');
  assert.equal(classifyPeer('10.201.177.110', locals), 'remote');
  assert.equal(classifyPeer('192.168.1.50', locals), 'remote');
  assert.equal(classifyPeer('', locals), 'unknown');
});

test('net: localIpv4Addresses shu hostni to\u2018liq sanaydi (loopback ham)', () => {
  const fake = {
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 'IPv4', address: '10.201.177.74', internal: false }]
  };
  const locals = localIpv4Addresses(fake);
  assert.ok(locals.includes('127.0.0.1'));
  assert.ok(locals.includes('10.201.177.74'));
  // haqiqiy muhitda: o'z manzillarimiz hech qachon 'remote' bo'lmaydi
  for (const ip of locals) {
    assert.notEqual(classifyPeer(ip, locals), 'remote', `${ip} o'zimizni 'remote' deb ko'rsatmasin`);
  }
});

// ---------------- haqiqiy server (bitta host, LAN interfeys orqali) ----------------

const silent = { info () {}, warn () {}, error () {} };
const server = createNeonServer({ port: 0, log: silent });   // host sukut bo'yicha 0.0.0.0
await server.listen();
const bound = server.httpServer.address();
const PORT = bound.port;
const LOCAL_IPS = localIpv4Addresses();
const LAN = lanInterfaces();
const LAN_IP = LAN.length ? LAN[0].address : null;

const connect = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws._q = []; ws._w = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString('utf8'));
    const i = ws._w.findIndex((w) => w.type === m.type);
    if (i >= 0) ws._w.splice(i, 1)[0].resolve(m);
    else ws._q.push(m);
  });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
const next = (ws, type, ms = 2000) => new Promise((resolve, reject) => {
  const hit = ws._q.findIndex((m) => m.type === type);
  if (hit >= 0) return resolve(ws._q.splice(hit, 1)[0]);
  const t = setTimeout(() => reject(new Error(`timeout: ${type}`)), ms);
  ws._w.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
});
/** Server xotirasidagi holat o'zgarishini kutish (xabar turiga bog'lanmaslik uchun) */
const waitFor = (fn, timeout = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    let ok = false;
    try { ok = !!fn(); } catch { ok = false; }
    if (ok) return resolve(true);
    if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
    setTimeout(tick, 25);
  };
  tick();
});
const lobbyPlayers = () => server.state.lobby.session?.players ?? [];

test('server: sukut bo\u2018yicha 0.0.0.0 ga bind bo\u2018ladi (LAN uchun ochiq)', () => {
  assert.equal(SERVER_DEFAULTS.HOST, '0.0.0.0');
  assert.equal(typeof bound, 'object');
  assert.equal(bound.address, '0.0.0.0', `bind=${bound.address}`);
  assert.ok(bound.port > 0);
  assert.equal(server.httpServer.listening, true);
});

test('server: LAN interfeys manzillari (lanAddresses) real va loopbacksiz', () => {
  const urls = server.telemetry().addresses;
  assert.ok(Array.isArray(urls) && urls.length >= 1);
  for (const u of urls) {
    if (u.includes('localhost')) continue;   // interfeyssiz muhit uchun halol fallback
    assert.match(u, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
    assert.ok(!u.includes('127.0.0.1'), 'loopback LAN manzil sifatida ko\'rsatilmasin');
  }
  if (LAN_IP) assert.ok(urls.some((u) => u.startsWith(`http://${LAN_IP}:`)), `LAN IP ${LAN_IP} ro'yxatda`);
});

test('server: HAQIQIY LAN IP orqali HTTP javob beradi (loopback EMAS)', async (t) => {
  if (!LAN_IP) return t.skip('haqiqiy LAN interfeysi yo\u2018q');
  const res = await fetch(`http://${LAN_IP}:${PORT}/`, { signal: AbortSignal.timeout(4000) });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<canvas/i);
  assert.match(html, /neon/i);
});

test('server: HAQIQIY LAN IP orqali WS ulanadi va peer "self" deb tasniflanadi', async (t) => {
  if (!LAN_IP) return t.skip('haqiqiy LAN interfeysi yo\u2018q');
  const ws = await connect(`ws://${LAN_IP}:${PORT}/ws`);
  try {
    const socket = [...server.state.connections].at(-1);
    const peer = socket._socket.remoteAddress;
    assert.equal(normalizeIp(peer), LAN_IP, `server ko'rgan peer=${peer}`);
    // MUHIM halollik qoidasi: o'zimizga LAN IP orqali ulanish 'self' —
    // bu IKKI QURILMA dalili EMAS, faqat real tarmoq yo'lining isboti.
    assert.equal(classifyPeer(peer, LOCAL_IPS), 'self');

    ws.send(JSON.stringify({ type: MSG.HELLO, name: 'lan-self' }));
    const welcome = await next(ws, MSG.WELCOME);
    const sess = await next(ws, MSG.SESSION);
    assert.ok(welcome.id > 0);
    assert.match(sess.playerId, /^p\d+$/);
    assert.ok(sess.sessionId >= 1);
  } finally { ws.close(); }
});

test('server: bir sessiyada LAN interfeys orqali ikki klient — ID farqli (bir host)', async (t) => {
  if (!LAN_IP) return t.skip('haqiqiy LAN interfeysi yo\u2018q');
  const a = await connect(`ws://${LAN_IP}:${PORT}/ws`);
  const b = await connect(`ws://${LAN_IP}:${PORT}/ws`);
  try {
    a.send(JSON.stringify({ type: MSG.HELLO, name: 'lan-a' }));
    const sa = await next(a, MSG.SESSION);
    b.send(JSON.stringify({ type: MSG.HELLO, name: 'lan-b' }));
    const sb = await next(b, MSG.SESSION);
    assert.notEqual(sa.playerId, sb.playerId);
    a._q.length = 0; b._q.length = 0;   // HELLO'dan keyingi dastlabki holat xabarlarini tashlaymiz
    a.send(JSON.stringify({ type: MSG.CREATE_SESSION }));
    const lobby = await next(a, MSG.LOBBY_STATE);
    assert.equal(lobby.players.length, 1);
    assert.equal(lobby.hostId, sa.playerId);          // host server tomonidan tayinlangan
    assert.equal(lobby.isHost, true);
    assert.deepEqual(lobby.addresses, server.telemetry().addresses);   // LAN manzillar (real, hard-code emas)
    b.send(JSON.stringify({ type: MSG.JOIN_SESSION }));
    await waitFor(() => lobbyPlayers().length === 2);
    assert.deepEqual(lobbyPlayers().map((p) => p.id).sort(), [sa.playerId, sb.playerId].sort());
    // a'zolik server xotirasida (DOM/klient da'vosi emas)
    assert.equal(server.state.lobby.session.players.length, 2);
    // hammani "self" deb tasniflaymiz — ya'ni bu test IKKI QURILMA EMAS
    const peers = [...server.state.connections].map((s) => classifyPeer(s._socket.remoteAddress, LOCAL_IPS));
    assert.deepEqual([...new Set(peers)], ['self'], `peer tasniflari=${JSON.stringify([...new Set(peers)])}`);
  } finally { a.close(); b.close(); }
});

test('server: ulanish yopilgach LAN QA holati tozalanadi (ghost yo\u2018q)', async () => {
  await waitFor(() => server.state.connections.size === 0 && server.state.sessions.size === 0);
  const tel = server.telemetry();
  assert.equal(tel.online, 0, 'barcha ulanish yopilgan');
  assert.equal(tel.sessions, 0, 'sessiyalar bo\u2018sh');
  assert.equal(server.state.lobby.session?.players?.length ?? 0, 0, 'lobby a\u2019zosi qolmadi');
  assert.equal(tel.tickErrors, 0);
  await server.close();
  assert.equal(server.httpServer.listening, false, 'server to\u2018liq yopildi');
});
