// O'lchov: har sifat presetida kadr vaqti, JS (update) vaqti, draw call, uchburchak,
// GPU resurslar; o'yinni 3 marta ochib-yopib resurs/xotira tozalanishi.
// DIQQAT: bu muhitda GPU yo'q — WebGL SwiftShader (CPU) orqali; FPS real qurilmadan past.
import { createRequire } from 'node:module';
import { createNeonServer } from '../../server/app.js';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }
const server = createNeonServer({ host: '127.0.0.1', port: 0, log: { info () {}, warn () {}, error () {} } });
await server.listen();
const URL_ = `http://127.0.0.1:${server.httpServer.address().port}/`;
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const out = { renderer: null, presets: {}, cleanup: null };
for (const q of ['low', 'medium', 'high']) {
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.addInitScript((q) => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: q, resolutionScale: 1 })), q);
  await p.goto(URL_);
  await p.waitForSelector('[data-a="training"]', { timeout: 90000 });
  await p.click('[data-a="training"]');
  await p.waitForFunction(() => window.__ns && window.__ns.state, null, { timeout: 60000 });
  const r = await p.evaluate(async () => {
    const g = window.__ns;
    g.qaTeleport(-11, -1.5, Math.PI / 2 + 0.25, -0.06);
    const orig = g.update.bind(g);
    const js = [];
    g.update = (...a) => { const t = performance.now(); orig(...a); js.push(performance.now() - t); };
    const fr = [];
    let last = performance.now();
    await new Promise((res) => { const t0 = performance.now(); const f = (t) => { fr.push(t - last); last = t; if (t - t0 < 6000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const sorted = [...fr].sort((x, y) => x - y);
    const gl = g.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      frames: fr.length, avgFrameMs: +avg(fr).toFixed(1), p95FrameMs: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), fps: +(1000 / avg(fr)).toFixed(1),
      jsUpdateMs: +avg(js).toFixed(2), drawCalls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
      geometries: g.renderer.info.memory.geometries, textures: g.renderer.info.memory.textures, pixelRatio: g.renderer.getPixelRatio(),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
    };
  });
  out.renderer = r.gpu;
  out.presets[q] = r;
  console.log(q, JSON.stringify(r));
  await p.close();
}
// resurs tozalanishi: menyu ↔ o'yin 3 marta
{
  const p = await b.newPage({ viewport: { width: 800, height: 450 } });
  await p.addInitScript(() => localStorage.setItem('neonstrike.settings.v1', JSON.stringify({ quality: 'low' })));
  await p.goto(URL_);
  await p.waitForSelector('[data-a="training"]', { timeout: 90000 });
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await p.click('[data-a="training"]');
    await p.waitForFunction(() => window.__ns && window.__ns.state, null, { timeout: 60000 });
    await p.waitForTimeout(1500);
    const inGame = await p.evaluate(() => ({ geo: window.__ns.renderer.info.memory.geometries, tex: window.__ns.renderer.info.memory.textures }));
    await p.evaluate(() => window.__app.go('pause'));
    await p.evaluate(() => document.querySelector('[data-a="quit"]').click());
    await p.waitForSelector('[data-a="training"]');
    await p.waitForTimeout(800);
    const heap = await p.evaluate(() => { if (window.gc) window.gc(); return performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null; });
    const leftover = await p.evaluate(() => ({ game: !!window.__ns, listeners: document.getElementById('hud').childElementCount + document.getElementById('touch').childElementCount }));
    samples.push({ cycle: i + 1, inGame, heapAfterQuitMB: heap, ...leftover });
  }
  out.cleanup = samples;
  console.log('cleanup', JSON.stringify(samples));
}
// server tick narxi (8 ta o'yinchi sessiyasi bilan emas — joriy holat)
out.serverTickMs = server.state.tickMs ?? null;
console.log('JSON', JSON.stringify(out));
await b.close(); await server.close();
process.exit(0);
