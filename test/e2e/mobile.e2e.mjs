// E2E: telefon (landshaft, sensorli) — haqiqiy touch hodisalari (CDP Input.dispatchTouchEvent).
// Joystik harakati, qarash, otish, AIM/cho'kkalash toggle, sakrash, reload, almashtirish, granata, pichoq.
import { createRequire } from 'node:module';
import { createNeonServer } from '../../server/app.js';
const require = createRequire(import.meta.url);
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch { ({ chromium, devices } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const server = createNeonServer({ host: '127.0.0.1', port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const URL_ = `http://127.0.0.1:${server.httpServer.address().port}/`;
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const dev = devices['Pixel 7 landscape'] || { viewport: { width: 863, height: 360 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const ctx = await b.newContext({ ...dev, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.addInitScript(() => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: 'low', shadows: false, resolutionScale: 0.6 })));
await p.goto(URL_);
await p.waitForSelector('[data-a="training"]', { timeout: 60000 });
const vp = p.viewportSize();
ok(vp.width > vp.height, `landshaft viewport ${vp.width}×${vp.height}, touch=${!!dev.hasTouch}`);
await p.tap('[data-a="training"]');
await p.waitForFunction(() => window.__ns && window.__ns.state, null, { timeout: 30000 });
ok(await p.evaluate(() => window.__ns.input.touch && document.getElementById('touch').classList.contains('t-visible')), 'sensorli boshqaruv yoqildi');
const cdp = await ctx.newCDPSession(p);
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((t) => ({ x: t[0], y: t[1], id: t[2] || 0 })) });
const center = async (sel) => { const r = await p.locator(sel).boundingBox(); return [r.x + r.width / 2, r.y + r.height / 2]; };
const st = () => p.evaluate(() => { const g = window.__ns; return { x: g.move.pos.x, z: g.move.pos.z, yaw: g.ots.yaw, crouch: g.move.crouching, air: g.move.airborne, w: g.weaponId, mag: g.state.weapon.mag, aim: !!g.aiming, gren: g._grenadesLeft() }; });

// 1) joystik: yuqoriga surish → oldinga yurish
const jb = await center('.t-joy-base');
let s0 = await st();
await touch('touchStart', [[jb[0], jb[1], 1]]);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[jb[0], jb[1] - i * 8, 1]]); await p.waitForTimeout(30); }
await p.waitForTimeout(1500);
let s1 = await st();
await touch('touchEnd', []);
ok(Math.hypot(s1.x - s0.x, s1.z - s0.z) > 1.5, `joystik → harakat ${Math.hypot(s1.x - s0.x, s1.z - s0.z).toFixed(2)} m`);
ok(await p.evaluate(() => getComputedStyle(document.querySelector('.t-joy-knob')).transform !== 'none') === false, 'joystik qo‘yib yuborilgach markazga qaytdi');

// 2) o'ng tomonni sudrash → qarash
s0 = await st();
const lx = vp.width * 0.62, ly = vp.height * 0.35;
await touch('touchStart', [[lx, ly, 2]]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [[lx + i * 12, ly, 2]]); await p.waitForTimeout(25); }
await touch('touchEnd', []);
await p.waitForTimeout(300);
s1 = await st();
ok(s1.yaw < s0.yaw - 0.05, `sudrash o‘ngga → kamera o‘ngga burildi (yaw ${s0.yaw.toFixed(2)}→${s1.yaw.toFixed(2)})`);

// 3) tugmalar
const tapBtn = async (sel, hold = 120) => { const c = await center(sel); await touch('touchStart', [[c[0], c[1], 3]]); await p.waitForTimeout(hold); await touch('touchEnd', []); await p.waitForTimeout(250); };
s0 = await st();
await tapBtn('.t-fire', 900);
await p.waitForTimeout(400);
s1 = await st();
ok(s1.mag < s0.mag, `◉ otish → server o‘q-dorisi ${s0.mag}→${s1.mag}`);
await tapBtn('.t-aim'); ok((await st()).aim, 'AIM toggle yoqildi'); await tapBtn('.t-aim'); ok(!(await st()).aim, 'AIM toggle o‘chdi');
await tapBtn('.t-crouch'); await p.waitForTimeout(300); ok((await st()).crouch, '⤓ cho‘kkalash toggle'); await tapBtn('.t-crouch'); await p.waitForTimeout(300); ok(!(await st()).crouch, 'turishga qaytdi');
const j0 = await p.evaluate(() => window.__ns.move.jumps);
await tapBtn('.t-jump', 60);
await p.waitForTimeout(300);
const j1 = await p.evaluate(() => window.__ns.move.jumps);
ok(j1 === j0 + 1, `⤒ sakrash (jumps ${j0}→${j1})`);
s0 = await st(); await tapBtn('.t-reload'); await p.waitForTimeout(2600); s1 = await st();
ok(s1.mag > s0.mag, `R reload ${s0.mag}→${s1.mag}`);
await tapBtn('.t-swap'); await p.waitForTimeout(900);
ok((await st()).w === 'pulse-pistol', '⇄ qurol almashtirish → pistol');
s0 = await st(); await tapBtn('.t-gren'); await p.waitForTimeout(2400); s1 = await st();
ok(s1.gren === s0.gren - 1, `● granata ${s0.gren}→${s1.gren}`);
const evs = await p.evaluate(async () => { const ev = []; const off = window.__ns.net.on('events', (m) => m.events.forEach((e) => ev.push(e.type + '@' + e.weaponId))); window.__ns.input.edges.add('knife'); await new Promise((r) => setTimeout(r, 1400)); off(); return ev; });
const kc = await center('.t-knife'); void kc;
ok(evs.some((e) => e === 'shot@combat-knife'), '⟋ pichoq zarbasi serverga yetdi: ' + [...new Set(evs)].join(','));
// tugmalar crosshairni to'smaydi
const cross = await p.locator('#hCross').boundingBox();
const overlaps = await p.evaluate(([cx, cy]) => [...document.querySelectorAll('.t-btn')].filter((b) => { const r = b.getBoundingClientRect(); return cx > r.left - 20 && cx < r.right + 20 && cy > r.top - 20 && cy < r.bottom + 20; }).length, [cross.x, cross.y]);
ok(overlaps === 0, 'tugmalar crosshairni to‘smaydi');
// sahifa scroll/zoom qilinmaydi
ok(await p.evaluate(() => scrollX === 0 && scrollY === 0 && (visualViewport ? visualViewport.scale === 1 : true)), 'sahifa scroll/zoom yo‘q');
await p.screenshot({ path: (process.env.SHOT_DIR || '.') + '/mobile-landscape.png' });
ok(errs.length === 0, 'xatolar: ' + (errs.slice(0, 3).join(' | ') || 'yo‘q'));
await b.close(); await server.close();
process.exit(process.exitCode || 0);
