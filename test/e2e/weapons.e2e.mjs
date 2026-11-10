// E2E: haqiqiy brauzer mijozi (TRAINING) — 5 qurol, reload, almashtirish, granata, pichoq.
// Zarar/o'q-dori — SERVER natijasi (EVENTS/STATE). Ishga tushirish: node test/e2e/weapons.e2e.mjs
import { createRequire } from 'node:module';
import { createNeonServer } from '../../server/app.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

const server = createNeonServer({ host: '127.0.0.1', port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const URL_ = `http://127.0.0.1:${server.httpServer.address().port}/`;
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.addInitScript(() => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: 'low', shadows: false, resolutionScale: 0.6 })));
await p.goto(URL_);
await p.waitForSelector('[data-a="training"]', { timeout: 60000 });
await p.click('[data-a="training"]');
await p.waitForFunction(() => window.__ns && window.__ns.state, null, { timeout: 30000 });
ok(true, 'TRAINING: server sessiyasi + nishonlar');

// nishon dummy-1 (-16,-2.6); o'yinchini uning oldiga qo'yamiz (server pozani validatsiya qiladi)
const setup = (dist) => p.evaluate(async (dist) => {
  const g = window.__ns;
  const d = g.dummies.get('dummy-1');
  g.qaTeleport(d.x + dist, d.z, -Math.PI / 2);   // nishonning OLDIDA (xarita ichida)
  await new Promise((r) => setTimeout(r, 700));
  // nishon tirik bo'lguncha (oldingi testda o'ldirilgan bo'lishi mumkin — server respawn)
  const t0 = performance.now();
  while (performance.now() - t0 < 8000 && !g.state.targets.find((t) => t.id === 'dummy-1').alive) await new Promise((r) => setTimeout(r, 100));
}, dist);
const fireAt = (weapon, ms, opt = {}) => p.evaluate(async ([weapon, ms, opt]) => {
  const g = window.__ns;
  const ev = [];
  const off = g.net.on('events', (m) => { for (const e of m.events) ev.push(e); });
  const d = g.dummies.get('dummy-1');
  const aim = () => { const c = g.ots.pos; const dx = d.x - c.x, dz = d.z - c.z, dy = (d.y + (opt.low ? 0.6 : 1.0)) - c.y; g.ots.yaw = Math.atan2(dx, dz) - g.ots.recoilY; g.ots.pitch = Math.atan2(dy, Math.hypot(dx, dz)) - g.ots.recoilP; };
  if (weapon && g.weaponId !== weapon) { g.input.edges.add('s' + (['neon-rifle', 'pulse-pistol', 'scatter-shot', 'energy-grenade', 'combat-knife'].indexOf(weapon) + 1)); }
  const t0 = performance.now();
  while (performance.now() - t0 < 1500 && weapon && g.weaponId !== weapon) { aim(); await new Promise((r) => setTimeout(r, 50)); }
  await new Promise((r) => setTimeout(r, 450));
  const s0 = JSON.parse(JSON.stringify(g.state));
  const t1 = performance.now();
  while (performance.now() - t1 < ms) {
    aim();
    if (opt.key) { g.input.edges.add(opt.key); opt.key = null; } else if (opt.tap) { g.input.firePressed = true; } else g.input.fire = true;
    await new Promise((r) => setTimeout(r, opt.tap ? 260 : 60));
  }
  g.input.fire = false;
  await new Promise((r) => setTimeout(r, opt.wait || 500));
  off();
  return { weapon: g.weaponId, before: s0, after: g.state, ev: ev.map((e) => e.type + (e.weaponId ? '@' + e.weaponId : '')), anim: g.me.anim.state };
}, [weapon, ms, opt]);
const count = (r, t) => r.ev.filter((e) => e.startsWith(t)).length;

await setup(9);
let r = await fireAt('pulse-pistol', 1500, { tap: true });
ok(r.weapon === 'pulse-pistol', 'almashtirish (2) → PULSE PISTOL (server state)');
ok(count(r, 'hit@pulse-pistol') >= 2, `pistol: yarim-avtomat, server tegishlari=${count(r, 'hit@pulse-pistol')}`);
ok(r.after.weapon.mag < r.before.weapon.mag, `pistol o‘q-dori ${r.before.weapon.mag}→${r.after.weapon.mag}`);

await setup(6);
r = await fireAt('scatter-shot', 900, { tap: true });
ok(count(r, 'hit@scatter-shot') >= 3, `shotgun: pelletlar tarqalishi, bir otishda ko‘p tegish=${count(r, 'hit@scatter-shot')}`);

await setup(9);
r = await fireAt('neon-rifle', 1200);
const hitsRifle = count(r, 'hit@neon-rifle');
ok(hitsRifle >= 4, `rifle: avtomat, tegishlar=${hitsRifle}`);
// reload
r = await p.evaluate(async () => {
  const g = window.__ns;
  const m0 = g.state.weapon.mag;
  g.input.edges.add('reload');
  await new Promise((r) => setTimeout(r, 600));
  const anim = g.me.anim.state;
  await new Promise((r) => setTimeout(r, 2600));
  return { m0, m1: g.state.weapon.mag, mag: g.state.weapon.magSize, res: g.state.weapon.reserve, anim };
});
ok(r.m1 === r.mag && r.m0 < r.mag, `reload: ${r.m0}→${r.m1}/${r.mag}, zaxira=${r.res}, animatsiya=${r.anim}`);

// pichoq: 1.5 m (V — tezkor zarba)
await setup(1.5);
r = await fireAt(null, 600, { key: 'knife', low: true, wait: 900 });
ok(count(r, 'hit@combat-knife') >= 1, `pichoq (V): server tegishi=${count(r, 'hit@combat-knife')} events=${[...new Set(r.ev)].join(',')}`);
// uzoqdan pichoq tegmaydi
await setup(6);
r = await fireAt('combat-knife', 800, { tap: true });
ok(count(r, 'hit@combat-knife') === 0, 'pichoq 6 m da tegmaydi (server masofa cheklovi)');

// granata (G): uloqtirish → portlash → zarar, inventar kamayadi
await setup(7);
const g0 = await p.evaluate(() => window.__ns._grenadesLeft());
const prevWeapon = await p.evaluate(() => window.__ns.weaponId);
r = await fireAt(null, 400, { key: 'grenade', wait: 2600 });
const g1 = await p.evaluate(() => window.__ns._grenadesLeft());
ok(r.ev.some((e) => e.startsWith('grenade-throw')), 'granata uloqtirildi (server grenade-throw)');
ok(r.ev.some((e) => e.startsWith('grenade-explode')), 'granata portladi (fuse + fizika)');
ok(r.ev.some((e) => e.startsWith('blast-hit') || e.startsWith('kill')), `portlash zarari: ${[...new Set(r.ev)].join(',')}`);
ok(g1 === g0 - 1, `granata inventari ${g0}→${g1}`);
ok(r.weapon === prevWeapon, `tezkor granatadan keyin oldingi qurolga qaytdi (${prevWeapon})`);

await p.screenshot({ path: (process.env.SHOT_DIR || '.') + '/weapons-training.png' });
ok(errs.length === 0, 'konsol xatolari: ' + (errs.slice(0, 3).join(' | ') || 'yo‘q'));
await b.close();
await server.close();
process.exit(process.exitCode || 0);
