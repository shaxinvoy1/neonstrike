// Haqiqiy brauzer mijozlari bilan LAN multiplayer E2E (N o'yinchi)
// E2E: haqiqiy brauzer mijozlari (har biri alohida Chromium jarayoni) ↔ jarayon ichidagi server.
// Server faqat o'yinchilarni joylashtirish uchun (test garnituri) chaqiriladi; harakat, otish,
// zarar, o'lim, raund, kill-feed, chat — hammasi mijozlar orqali.
// Ishga tushirish: node test/e2e/multiplayer.e2e.mjs [N=2]
import { createRequire } from 'node:module';
import { createNeonServer } from '../../server/app.js';
import { placePlayerAt } from '../../server/session.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }
const N = +(process.argv[2] || 2);
// protokol mijozlari (xuddi shu WS protokoli; GPU brauzer xotirasi cheklangan muhitda 4 o'yinchi uchun)
const BOTS = +(process.argv[3] || 0);
import WS from 'ws';
const server = createNeonServer({ host: '0.0.0.0', port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const URL_ = `http://127.0.0.1:${server.httpServer.address().port}/`;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const browsers = [];
  const pages = [];
  const errs = [];
  for (let i = 0; i < N; i++) {
    // LAN IP to'g'ridan-to'g'ri (agent proksisiz) — haqiqiy Wi-Fi tarmog'idagi kabi
    const env = { ...process.env }; for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
    const bi = await chromium.launch({ env, args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-proxy-server', '--proxy-bypass-list=*'] });
    browsers.push(bi);
    // MOBILE=1: ikkinchi o'yinchi — telefon (landshaft, sensorli) va serverga LAN IP orqali ulanadi
    const mobile = process.env.MOBILE === '1' && i === 1;
    const ctx = await bi.newContext(mobile ? { viewport: { width: 640, height: 300 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' } : { viewport: { width: 480, height: 270 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(`[p${i}] ${e.message}`));
    p.on('console', (m) => m.type() === 'error' && errs.push(`[p${i}] ${m.text()}`));
    await p.addInitScript(() => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: 'low', shadows: false, resolutionScale: 0.5 })));
    const lan = server.state ? (await import('node:os')).networkInterfaces() : {};
    const lanIp = Object.values(lan).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    const target = mobile && lanIp ? URL_.replace('127.0.0.1', lanIp.address) : URL_;
    if (mobile) console.log('INFO mobil mijoz URL:', target);
    await p.goto(target);
    await p.waitForFunction(() => window.__app && window.__app.net.open, null, { timeout: 20000 });
    await p.waitForSelector('#nameIn', { timeout: 90000 }); await p.fill('#nameIn', ['Shaxin', 'Zoro', 'aybek', 'bekzod'][i]);
    pages.push(p);
    if (mobile) ok(await p.evaluate(() => window.__app && document.body.classList.contains('is-touch')), 'mobil mijoz: sensorli rejim');
  }
  const [host] = pages;
  await host.click('[data-a="mp"]');
  await host.click('[data-a="create"]');
  await host.waitForSelector('.screen-lobby', { timeout: 10000 });
  ok(true, 'host CREATE ROOM → lobby');
  for (let i = 1; i < N; i++) {
    const p = pages[i];
    await p.click('[data-a="mp"]');
    await p.waitForSelector('[data-a="join"]', { timeout: 10000 });
    await p.click('[data-a="join"]');
    await p.waitForSelector('.screen-lobby', { timeout: 10000 });
  }
  ok(true, `${N - 1} ta mijoz JOIN ROOM`);
  const bots = [];
  for (let i = 0; i < BOTS; i++) {
    const ws = new WS(URL_.replace('http', 'ws') + 'ws');
    await new Promise((r) => ws.once('open', r));
    const bot = { ws, q: [], seq: 0, send: (o) => ws.send(JSON.stringify(o)) };
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'session') bot.id = m.playerId; if (m.type === 'snapshot') bot.snap = m; });
    bot.send({ type: 'hello', name: 'bot' + (i + 1) });
    await new Promise((r) => setTimeout(r, 200));
    bot.send({ type: 'join-session', name: 'bot' + (i + 1) });
    await new Promise((r) => setTimeout(r, 200));
    bot.send({ type: 'set-team', prefer: (N + i) % 2 ? 'B' : 'A' });
    bot.timer = setInterval(() => {   // jonli kirish oqimi (30 Hz): aylanib yuradi
      bot.seq += 1;
      const t = bot.seq / 30;
      bot.send({ type: 'input', seq: bot.seq, pose: { x: 0, y: 0, z: 0, yaw: t, pitch: 0 }, aim: { dir: [Math.sin(t), 0, Math.cos(t)] }, intents: {}, move: { forward: 0.6, right: 0, sprint: false } });
    }, 33);
    bots.push(bot);
  }
  if (BOTS) ok(true, `${BOTS} ta protokol mijozi qo‘shildi → jami ${N + BOTS} o‘yinchi`);
  const TOTAL = N + BOTS;
  // jamoa tanlash: juft — BLUE, toq — RED
  for (let i = 0; i < N; i++) await pages[i].click(`[data-a="team"][data-t="${i % 2 ? 'B' : 'A'}"]`);
  await host.waitForFunction((n) => window.__app.lobby.players.filter((p) => p.prefer).length === n, TOTAL, { timeout: 10000 });
  const lob = await host.evaluate(() => window.__app.lobby.players.map((p) => `${p.name}:${p.prefer}`));
  ok(lob.length === TOTAL, 'lobbyda jamoa tanlovi ko‘rinadi: ' + lob.join(', '));
  await host.click('[data-a="start"]');
  for (const p of pages) await p.waitForFunction(() => window.__ns && window.__ns.match && window.__ns.match.roundState === 'live', null, { timeout: 25000 });
  ok(true, 'host START → hamma o‘yinda, raund LIVE');
  const teams = await Promise.all(pages.map((p) => p.evaluate(() => window.__ns.team)));
  ok(teams.every((t, i) => t === (i % 2 ? 'B' : 'A')), 'jamoalar server tomonidan tanlovga ko‘ra: ' + teams.join(','));
  // remote o'yinchilar ko'rinadi
  for (const p of pages) await p.waitForFunction((n) => window.__ns.remotes.size === n - 1, TOTAL, { timeout: 15000 });
  ok(true, `har brauzer mijozida ${TOTAL - 1} ta remote V-773`);
  if (BOTS) {
    const snapN = bots[0].snap ? bots[0].snap.players.length : 0;
    ok(snapN === TOTAL, `snapshot ${TOTAL} o‘yinchini olib keladi (bot ko‘rgan: ${snapN})`);
    const botId = bots[0].id;
    const p0 = await host.evaluate((id) => { const r = window.__ns.remotes.get(id); return r && [r.pos.x, r.pos.z]; }, botId);
    await host.waitForTimeout(1500);
    const p1 = await host.evaluate((id) => { const r = window.__ns.remotes.get(id); return r && [r.pos.x, r.pos.z, r.av.anim.state]; }, botId);
    ok(p0 && p1 && Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 0.5, `bot harakati brauzerda ko‘rinadi: ${JSON.stringify(p0)} → ${JSON.stringify(p1)}`);
  }
  // harakat sinxronizatsiyasi: p1 oldinga yuradi — p0 da uning pozitsiyasi o'zgaradi
  const p1id = await pages[1].evaluate(() => window.__app.net.playerId);
  const before = await host.evaluate((id) => { const r = window.__ns.remotes.get(id); return { x: r.pos.x, z: r.pos.z }; }, p1id);
  await pages[1].evaluate(() => { const i = window.__ns.input; i.keys.add('fwd'); });
  await pages[1].waitForTimeout(1500);
  await pages[1].evaluate(() => window.__ns.input.keys.delete('fwd'));
  await host.waitForFunction(([id, bx]) => { const r = window.__ns.remotes.get(id); return r && Math.abs(r.pos.x - bx) > 1.5; }, [p1id, before.x], { timeout: 15000 }).catch(() => {});
  await host.waitForTimeout(800);
  const after = await host.evaluate((id) => { const r = window.__ns.remotes.get(id); return { x: r.pos.x, z: r.pos.z, st: r.av.anim.state }; }, p1id);
  const srv = await pages[1].evaluate(() => ({ x: window.__ns.move.pos.x, z: window.__ns.move.pos.z, err: window.__ns.lastErr }));
  ok(Math.hypot(after.x - before.x, after.z - before.z) > 1.5, `harakat sinxron: ${before.x.toFixed(2)}→${after.x.toFixed(2)} (p1 lokal ${srv.x.toFixed(2)}, rekonsiliatsiya xatosi ${(srv.err || 0).toFixed(3)} m)`);
  ok(Math.hypot(after.x - srv.x, after.z - srv.z) < 1.0, `hostdagi ko‘rinish ≈ p1 bashorati (Δ=${Math.hypot(after.x - srv.x, after.z - srv.z).toFixed(2)} m; 100 ms interpolatsiya + ~10 FPS dasturiy render)`);
  // test garnituri: ochiq chiziqqa joylashtirish (z=-2.8: reaktor platformasi ustidan ko'rinish bor)
  const idOf = (p) => p.evaluate(() => window.__app.net.playerId);
  const sessByPid = (pid) => [...server.state.sessions.values()].find((s) => s.playerId === pid);
  // reaktor platformasi ustida (y=1.2), 7 m oraliq, yadro chizig'idan tashqarida
  for (const [p, x, yaw] of [[host, -3.5, Math.PI / 2], [pages[1], 3.5, -Math.PI / 2]]) {
    const s = sessByPid(await idOf(p));
    placePlayerAt(s, { x, y: 1.2, z: -2.8, yaw }, Date.now()); s.movement.pos = s.state.position;
  }
  await host.waitForFunction(() => Math.abs(window.__ns.move.pos.x + 3.5) < 0.6, null, { timeout: 10000 });
  ok(true, 'garnitur joylashtirdi; mijoz bashorati server pozitsiyasiga snap qildi');
  // jang: p0 (A) va p1 (B) ni yonma-yon qo'yib (server test API emas — haqiqiy harakat): p1 ni p0 tomonga burab otamiz
  const shooterId = await host.evaluate(() => window.__app.net.playerId);
  const res = await pages[1].evaluate(async (target) => {
    const g = window.__ns;
    const ev = [];
    const off = g.net.on('events', (m) => { for (const e of m.events) ev.push(e.type); });
    const t0 = performance.now();
    const r = () => g.remotes.get(target);
    g.input.fire = true;
    while (performance.now() - t0 < 9000) {
      const R = r(); if (!R || !R.alive) break;
      // crosshair'ni nishon ko'kragiga: haqiqiy kamera pozitsiyasidan (o'yinchi qanday ko'rsa)
      const c = g.ots.pos;
      const dx = R.pos.x - c.x, dz = R.pos.z - c.z, dy = R.pos.y + 1.0 - c.y;
      g.ots.yaw = Math.atan2(dx, dz) - g.ots.recoilY; g.ots.pitch = Math.atan2(dy, Math.hypot(dx, dz)) - g.ots.recoilP;
      await new Promise((r) => setTimeout(r, 80));
    }
    g.input.fire = false; off();
    return { ev: [...new Set(ev)], kills: g.state.stats.kills, hits: g.state.stats.hits, targetAlive: r() ? r().alive : null };
  }, shooterId);
  ok(res.hits > 0, `PvP zarar server orqali: hits=${res.hits} kills=${res.kills} events=${res.ev.join(',')}`);
  // jabrlanuvchi tomoni: server o'lim hisobi + host mijozidagi kill-feed + remote o'lim animatsiyasi
  const hostSess = sessByPid(shooterId);
  ok(hostSess.state.stats.deaths >= 1 || !hostSess.state.health.alive, `jabrlanuvchi (host) serverda o‘lgan: deaths=${hostSess.state.stats.deaths}`);
  await host.waitForFunction(() => (window.__ns.match.feed || []).length > 0, null, { timeout: 8000 }).catch(() => {});
  const feed = await host.evaluate(() => (window.__ns.match.feed || []).slice(-1)[0]);
  ok(feed && feed.victim === shooterId && feed.weapon, 'kill-feed host mijozida: ' + JSON.stringify(feed));
  const hud = await host.evaluate(() => document.querySelector('#hFeed').textContent);
  ok(hud.includes('Zoro') && hud.includes('Shaxin'), 'kill-feed HUD da ismlar bilan: ' + hud.trim());
  if (TOTAL === 2) {
    await host.waitForFunction(() => window.__ns.match.scores.B >= 1, null, { timeout: 10000 });
    ok(true, 'raund natijasi: B jamoasiga ball');
    await host.waitForFunction(() => window.__ns.match.roundNumber >= 2 && window.__ns.match.roundState === 'live' && window.__ns.alive, null, { timeout: 15000 });
    ok(true, 'keyingi raund: host respawn bo‘ldi, ROUND 2/10 LIVE');
  }
  // scoreboard (Tab)
  await host.evaluate(() => { window.__ns.scoreHeld = true; window.__ns.input.keys.add('score'); });
  await host.waitForTimeout(400);
  const sb = await host.evaluate(() => document.querySelectorAll('#hScore tr').length);
  ok(sb >= TOTAL + 2, 'scoreboard jadvali: ' + sb + ' qator');
  await host.evaluate(() => window.__ns.input.keys.delete('score'));
  // chat
  await pages[1].evaluate(() => window.__app.net.send({ type: 'chat', text: 'A da 2 ta bor' }));
  await host.waitForFunction(() => document.querySelector('#hChatLog') && document.querySelector('#hChatLog').textContent.includes('A da 2 ta bor'), null, { timeout: 8000 });
  ok(true, 'chat boshqa mijozda ko‘rinadi');
  await host.screenshot({ path: (process.env.SHOT_DIR || '.') + `/mp${TOTAL}-host.png` });
  await pages[1].screenshot({ path: (process.env.SHOT_DIR || '.') + `/mp${TOTAL}-p1.png` });
  // uzilish: oxirgi mijoz yopiladi → boshqalarda remote yo'qoladi
  await browsers[N - 1].close();
  await host.waitForFunction((n) => window.__ns && window.__ns.remotes.size === n - 2, TOTAL, { timeout: 12000 });
  for (const bt of bots) { clearInterval(bt.timer); bt.ws.close(); }
  ok(true, 'uzilgan o‘yinchi boshqa mijozlardan olib tashlandi');
  ok(errs.length === 0, 'konsol/sahifa xatolari: ' + (errs.slice(0, 4).join(' | ') || 'yo‘q'));
  for (const bi of browsers) await bi.close();
  await server.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.log('FAIL exception', e.message); process.exit(1); });
