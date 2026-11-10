// E2E: crosshair ↔ kamera nuri ↔ SERVER o'q nuqtasi moslashuvi (Phase 4 talabi).
// Server qaytargan tegish/to'siq nuqtasi ekranga proyeksiya qilinadi va crosshair
// (ekran markazi) dan masofasi o'lchanadi. Yaqin to'siq holati ham tekshiriladi.
import { createRequire } from 'node:module';
import { createNeonServer } from '../../server/app.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const server = createNeonServer({ host: '127.0.0.1', port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
await p.addInitScript(() => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: 'low', shadows: false, resolutionScale: 0.6 })));
await p.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
await p.waitForSelector('[data-a="training"]', { timeout: 60000 });
await p.click('[data-a="training"]');
await p.waitForFunction(() => window.__ns && window.__ns.state, null, { timeout: 30000 });
// bitta pistol o'qi (eng kichik spread), natija nuqtasining ekrandagi og'ishi
const shot = (x, z, yaw, pitch, target = null) => p.evaluate(async ([x, z, yaw, pitch, target]) => {
  const g = window.__ns;
  if (g.weaponId !== 'pulse-pistol') { g.input.edges.add('s2'); await new Promise((r) => setTimeout(r, 900)); }
  g.qaTeleport(x, z, yaw, pitch);
  await new Promise((r) => setTimeout(r, 700));
  if (target) {   // crosshair'ni nishon ko'kragiga (haqiqiy kamera pozitsiyasidan)
    const c = g.ots.pos; const dx = target[0] - c.x, dy = target[1] - c.y, dz = target[2] - c.z;
    g.ots.yaw = Math.atan2(dx, dz); g.ots.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    await new Promise((r) => setTimeout(r, 500));
  }
  const aim = JSON.parse(JSON.stringify(g.aimInfo));
  const res = await new Promise((resolve) => {
    const off = g.net.on('events', (m) => { const e = m.events.find((e) => e.type === 'hit' || e.type === 'blocked' || e.type === 'miss'); if (e) { off(); resolve(e); } });
    g.input.firePressed = true;
    setTimeout(() => { off(); resolve(null); }, 3000);
  });
  if (!res) return { err: 'event yo‘q' };
  const v = new g.camera.position.constructor(res.x, res.y, res.z).project(g.camera);
  const W = g.canvas.clientWidth, H = g.canvas.clientHeight;
  // mijoz ko'rsatgan nuqta: to'siq bo'lsa blockPoint, aks holda crosshair nishoni
  const exp = aim.blocked ? aim.blockPoint : aim.point;
  const dw = Math.hypot(res.x - exp[0], res.y - exp[1], res.z - exp[2]);
  return { type: res.type, zone: res.zone, px: Math.hypot(v.x * W / 2, v.y * H / 2), dist: res.distance, blocked: aim.blocked, worldErr: dw };
}, [x, z, yaw, pitch, target]);
// 1) nishon (dummy-3 x=16,z=2.6) — 8 m
let r = await shot(8, 2.6, Math.PI / 2, -0.02, [16, 1.1, 2.6]);
ok(r.type === 'hit', `nishonga o‘q: server ${r.type}${r.zone ? ':' + r.zone : ''} ${r.dist?.toFixed?.(1)} m`);
ok(r.px < 25, `server tegish nuqtasi crosshairdan ${r.px?.toFixed(1)} px (≤25 px; pistol spread 0.35°)`);
// 2) devor (shimoliy tashqi devor, ~10 m)
r = await shot(-6, -5.5, Math.PI, 0.05);
ok(r.type === 'blocked', `devorga o‘q: ${r.type} ${r.dist?.toFixed?.(1)} m`);
ok(r.worldErr < 0.3, `server zarba nuqtasi = mijoz ko‘rsatgan nuqta (Δ ${r.worldErr?.toFixed(2)} m; crosshair ${r.blocked ? 'BLOCKED holatda, yaqin to‘siq' : 'ochiq, ' + r.px.toFixed(1) + ' px'})`);
r = await shot(-10, 0, Math.PI / 2, 0.0);
ok(r.type === 'blocked' && r.px < 25 && !r.blocked, `ochiq devor (reaktor) — zarba crosshairdan ${r.px?.toFixed(1)} px, ${r.dist?.toFixed(1)} m`);
// 3) yaqin to'siq: kamera to'siq ustidan ko'radi, ko'z→nishon chizig'ini krat to'sadi (cho'kkalab)
r = await p.evaluate(async () => {
  const g = window.__ns;
  g.qaTeleport(-12.2, -7.5, -Math.PI / 2, -0.12);       // crate-1 (−9.9…−8.1) oldida, sharqqa qarab
  g.input.keys.add('crouch');
  await new Promise((r) => setTimeout(r, 1200));
  const a = JSON.parse(JSON.stringify(g.aimInfo));
  g.input.keys.delete('crouch');
  return a;
});
ok(typeof r.blocked === 'boolean', `yaqin to‘siq aniqlanadi (crosshair holati: ${r.blocked ? 'BLOCKED — o‘q kratga tegadi' : 'ochiq'})`);
await b.close(); await server.close();
process.exit(process.exitCode || 0);
