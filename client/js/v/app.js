// ============================================================
// NEON STRIKE — bootstrap: menyular, LAN xona (host/join), lobby + jamoa
// tanlash, sozlamalar, pauza, natijalar. Har bir tugma haqiqiy amal bajaradi.
// ============================================================
import * as THREE from '/vendor/three.module.js';
import { MSG } from '/shared/protocol-consts.js';
import { Net } from './net.js';
import { Game } from './game/game.js';
import { settings, resetSettings, QUALITY, touchEnabled } from './settings.js';
import { sfx, unlockAudio } from './audio.js';
import { createV773 } from './character/model.js';
import { Animator } from './character/animator.js';
import { createWeaponModel } from './weapons/models.js';
import { createNeonEnvironment } from './world/env.js';

const ui = document.getElementById('ui');
const canvas = document.getElementById('gl');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const net = new Net();
let session = null;     // SESSION xabari
let lobby = null;       // oxirgi LOBBY_STATE
let game = null;
let screen = 'boot';
let menuScene = null;
let lastError = '';
let pendingTraining = false;

// ---------------- menyu fon sahnasi (V-773 idle) ----------------
class MenuScene {
  constructor () {
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.r.toneMapping = THREE.ACESFilmicToneMapping;
    this.r.setPixelRatio(Math.min(2, devicePixelRatio));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b1c);
    this.env = createNeonEnvironment(this.r);
    this.scene.environment = this.env.texture;
    this.cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    this.scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x101030, 0.8));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(2, 4, 5); this.scene.add(key);
    const b = new THREE.PointLight(0x2f8cff, 16, 10); b.position.set(-2.5, 2, -1); this.scene.add(b);
    const v = new THREE.PointLight(0xb05cff, 12, 10); v.position.set(2.5, 2.2, -1.5); this.scene.add(v);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.MeshStandardMaterial({ color: 0x0f1840, roughness: 0.35, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2; this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x35c8ff).multiplyScalar(1.6) }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005; this.scene.add(ring);
    this.c = createV773({ quality: settings.quality === 'low' ? 'low' : 'high', team: 'A', envMap: this.env.texture });
    this.scene.add(this.c.root);
    this.a = new Animator(this.c);
    this.a.setWeapon(createWeaponModel('neon-rifle', { envMap: this.env.texture }), 'neon-rifle');
    this.c.root.rotation.y = -0.5;
    this.t = 0; this.last = performance.now(); this.on = true;
    this.resize = () => { const w = innerWidth, h = innerHeight; this.r.setSize(w, h, false); this.cam.aspect = w / h; const wide = w / h > 1.1; this.cam.position.set(wide ? -1.3 : 0, 1.25, 4.6); this.cam.lookAt(wide ? -1.3 : 0, 0.95, 0); this.cam.updateProjectionMatrix(); };
    addEventListener('resize', this.resize); this.resize();
    const loop = (t) => { if (!this.on) return; requestAnimationFrame(loop); const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t; this.t += dt; this.c.root.rotation.y = -0.45 + Math.sin(this.t * 0.3) * 0.25; this.a.in.aiming = Math.sin(this.t * 0.5) > 0.6; this.a.update(dt); this.r.render(this.scene, this.cam); };
    requestAnimationFrame(loop);
  }
  dispose () { this.on = false; removeEventListener('resize', this.resize); this.a.setWeapon(null); this.c.dispose(); this.env.dispose(); this.r.dispose(); }
}
function showMenuScene (on) {
  // LOW sifatda (kuchsiz qurilmalar) 3D menyu foni chizilmaydi — CSS fon
  if (on && !menuScene && settings.quality !== 'low') menuScene = new MenuScene();
  if (!on && menuScene) { menuScene.dispose(); menuScene = null; }
}

// ---------------- ekranlar ----------------
function render () {
  const name = settings.name || '';
  const inSess = lobby && lobby.inSession;
  ui.className = 'ui on screen-' + screen;
  switch (screen) {
    case 'boot':
      ui.innerHTML = `<div class="panel center"><h1 class="logo">NEON <b>STRIKE</b></h1><p class="muted">Serverga ulanmoqda…</p>${lastError ? `<p class="err">${esc(lastError)}</p><button class="btn" data-a="retry">QAYTA ULANISH</button>` : ''}</div>`;
      break;
    case 'menu':
      ui.innerHTML = `
        <div class="menu-col">
          <h1 class="logo">NEON <b>STRIKE</b></h1>
          <p class="tag">LAN MULTIPLAYER · NEON FACILITY</p>
          <label class="field"><span>ISMINGIZ</span><input id="nameIn" maxlength="16" value="${esc(name)}" placeholder="Player"></label>
          <button class="btn primary" data-a="mp">MULTIPLAYER (LAN)</button>
          <button class="btn" data-a="training">TRAINING</button>
          <button class="btn" data-a="settings">SETTINGS</button>
          <button class="btn" data-a="help">HOW TO PLAY</button>
          <p class="muted small">Server: ${esc(location.host)} · ${net.open ? `<span class="ok">ulangan</span>` : '<span class="err">ulanmagan</span>'}</p>
        </div>`;
      break;
    case 'mp': {
      const exists = lobby && lobby.sessionId && lobby.count > 0;
      const started = lobby && lobby.state === 'in_game';
      ui.innerHTML = `
        <div class="panel">
          <h2>MULTIPLAYER · LAN</h2>
          <p class="muted">Bir Wi-Fi tarmog‘idagi qurilmalar shu server manzilini ochib bir xonaga qo‘shiladi.</p>
          <div class="addr">${(lobby && lobby.addresses && lobby.addresses.length ? lobby.addresses : [location.host]).map((a) => `<code>http://${esc(String(a).replace(/^https?:\/\//, ''))}</code>`).join('')}</div>
          ${exists ? `<div class="room"><b>XONA #${lobby.sessionId}</b><span>${lobby.count}/${lobby.capacity} o‘yinchi · ${started ? 'o‘yin ketmoqda' : 'kutilmoqda'}</span></div>
            <button class="btn primary" data-a="join">JOIN ROOM${started ? ' (o‘yinga qo‘shilish)' : ''}</button>`
            : `<p class="muted">Hozircha xona yo‘q.</p><button class="btn primary" data-a="create">CREATE ROOM (HOST)</button>`}
          ${lastError ? `<p class="err">${esc(lastError)}</p>` : ''}
          <button class="btn ghost" data-a="menu">ORQAGA</button>
        </div>`;
      break;
    }
    case 'lobby': {
      const L = lobby || { players: [] };
      const col = (t, title, cls) => `<div class="tcol ${cls}"><h3>${title}</h3>${L.players.filter((p) => (p.prefer || null) === t).map((p) => `<div class="pl${p.id === L.you ? ' me' : ''}">${p.host ? '★ ' : ''}${esc(p.name || p.id)}</div>`).join('') || '<div class="pl empty">—</div>'}
        <button class="btn sm" data-a="team" data-t="${t}">${t === 'A' ? 'BLUE' : 'RED'} JAMOAGA</button></div>`;
      const auto = L.players.filter((p) => !p.prefer);
      ui.innerHTML = `
        <div class="panel wide">
          <h2>LOBBY · XONA #${esc(L.sessionId)}</h2>
          <p class="muted">Boshqa qurilmalar: ${(L.addresses || []).map((a) => `<code>${esc(String(a))}</code>`).join(' ') || `<code>${esc(location.host)}</code>`}</p>
          <div class="teams">${col('A', 'BLUE TEAM', 'blue')}${col('B', 'RED TEAM', 'red')}</div>
          ${auto.length ? `<p class="muted small">Avtomatik taqsimlanadi: ${auto.map((p) => esc(p.name || p.id)).join(', ')}</p>` : ''}
          <p class="muted small">${L.count}/${L.capacity} o‘yinchi · 10 raund · birinchi 6 g‘alaba · raund ${100} s</p>
          <div class="row">
            ${L.isHost ? `<button class="btn primary" data-a="start" ${L.count < 1 ? 'disabled' : ''}>START MATCH</button>` : '<p class="muted">Host o‘yinni boshlashini kuting…</p>'}
            <button class="btn ghost" data-a="leave">XONADAN CHIQISH</button>
          </div>
          ${lastError ? `<p class="err">${esc(lastError)}</p>` : ''}
        </div>`;
      break;
    }
    case 'settings':
      ui.innerHTML = `
        <div class="panel wide">
          <h2>SETTINGS</h2>
          <div class="grid2">
            <label class="field"><span>Sichqoncha sezgirligi <b id="vSens">${settings.sensitivity.toFixed(2)}</b></span><input type="range" min="0.2" max="3" step="0.05" data-s="sensitivity" value="${settings.sensitivity}"></label>
            <label class="field"><span>Sensor sezgirligi <b id="vTSens">${settings.touchSensitivity.toFixed(2)}</b></span><input type="range" min="0.3" max="3" step="0.05" data-s="touchSensitivity" value="${settings.touchSensitivity}"></label>
            <label class="field"><span>FOV <b id="vFov">${settings.fov}</b></span><input type="range" min="60" max="95" step="1" data-s="fov" value="${settings.fov}"></label>
            <label class="field"><span>Ovoz balandligi <b id="vVol">${Math.round(settings.volume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" data-s="volume" value="${settings.volume}"></label>
            <label class="field"><span>Grafika sifati</span><select data-s="quality">${Object.keys(QUALITY).map((q) => `<option value="${q}" ${q === settings.quality ? 'selected' : ''}>${q.toUpperCase()}</option>`).join('')}</select></label>
            <label class="field"><span>Ruxsat masshtabi <b id="vRes">${Math.round(settings.resolutionScale * 100)}%</b></span><input type="range" min="0.5" max="1.25" step="0.05" data-s="resolutionScale" value="${settings.resolutionScale}"></label>
            <label class="check"><input type="checkbox" data-s="shadows" ${settings.shadows ? 'checked' : ''}> Soyalar</label>
            <label class="check"><input type="checkbox" data-s="invertY" ${settings.invertY ? 'checked' : ''}> Y o‘qini teskari</label>
            <label class="check"><input type="checkbox" data-s="sfx" ${settings.sfx ? 'checked' : ''}> Ovoz effektlari</label>
            <label class="check"><input type="checkbox" data-s="showFps" ${settings.showFps ? 'checked' : ''}> FPS ko‘rsatish</label>
            <label class="field"><span>Sensorli boshqaruv</span><select data-s="touchControls">${['auto', 'on', 'off'].map((q) => `<option value="${q}" ${q === settings.touchControls ? 'selected' : ''}>${q.toUpperCase()}</option>`).join('')}</select></label>
          </div>
          <p class="muted small">Grafika sifati / soyalar / sensor rejimi keyingi o‘yinga kirganda qo‘llanadi.</p>
          <div class="row"><button class="btn ghost" data-a="reset-settings">STANDART</button><button class="btn primary" data-a="back">TAYYOR</button></div>
        </div>`;
      break;
    case 'help':
      ui.innerHTML = `
        <div class="panel wide">
          <h2>HOW TO PLAY</h2>
          <div class="grid2 help">
            <div><h3>Kompyuter</h3><p><kbd>W A S D</kbd> yurish · <kbd>Shift</kbd> sprint · <kbd>C</kbd>/<kbd>Ctrl</kbd> cho‘kkalash · <kbd>Space</kbd> sakrash</p>
              <p><kbd>Sichqoncha</kbd> qarash · <kbd>LMB</kbd> otish · <kbd>RMB</kbd> nishonga olish · <kbd>R</kbd> qayta o‘qlash</p>
              <p><kbd>1–5</kbd> qurollar · <kbd>Q</kbd>/g‘ildirak almashtirish · <kbd>G</kbd> granata · <kbd>V</kbd> pichoq</p>
              <p><kbd>Tab</kbd> hisob jadvali · <kbd>T</kbd>/<kbd>Enter</kbd> chat · <kbd>Esc</kbd> pauza</p></div>
            <div><h3>Telefon (yotiq holat)</h3><p>Chap joystik — yurish (yuqoriga oxirigacha surish — sprint). O‘ng tomonni sudrash — qarash.</p>
              <p>◉ otish (ushlab sudrasa — nishonni ham buradi) · AIM · R · ⤒ sakrash · ⤓ cho‘kkalash · » sprint · ⇄ qurol · ● granata · ⟋ pichoq</p>
              <h3>Qoidalar</h3><p>2 jamoa · 10 raund · birinchi 6 g‘alaba qozongan jamoa yutadi. Raund ichida o‘lgan o‘yinchi keyingi raundda qaytadi. Raund vaqti 100 s — tugasa tirik a’zolari ko‘p jamoa yutadi.</p></div>
          </div>
          <button class="btn primary" data-a="menu">ORQAGA</button>
        </div>`;
      break;
    case 'pause':
      ui.innerHTML = `<div class="panel center"><h2>PAUSE</h2>
        <button class="btn primary" data-a="resume">DAVOM ETISH</button>
        <button class="btn" data-a="settings">SETTINGS</button>
        <button class="btn" data-a="help">BOSHQARUV</button>
        <button class="btn ghost" data-a="quit">${game && game.mode === 'lan' ? 'MATCHDAN CHIQISH' : 'MENYUGA QAYTISH'}</button></div>`;
      break;
    case 'results': {
      const R = game && game.results();
      const m = R && R.match || { scores: { A: 0, B: 0 } };
      const w = m.matchWinner;
      const title = w === 'draw' ? 'DURANG' : w === R?.myTeam ? 'VICTORY' : 'DEFEAT';
      const rows = (t) => (R ? R.rows : []).filter((p) => p.team === t).sort((a, b) => b.kills - a.kills).map((p) => `<tr class="${p.id === R.myId ? 'me' : ''}"><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td></tr>`).join('');
      ui.innerHTML = `<div class="panel wide results ${title.toLowerCase()}">
        <h1>${title}</h1><p class="score"><span class="b">BLUE ${m.scores.A}</span> : <span class="r">${m.scores.B} RED</span></p>
        <div class="teams"><table class="sb b"><tr><th>BLUE</th><th>K</th><th>D</th></tr>${rows('A')}</table><table class="sb r"><tr><th>RED</th><th>K</th><th>D</th></tr>${rows('B')}</table></div>
        <div class="row">${lobby && lobby.isHost ? '<button class="btn primary" data-a="restart">QAYTA O‘YNASH (LOBBY)</button>' : '<p class="muted">Host qayta boshlashini kutish mumkin</p>'}<button class="btn ghost" data-a="quit">MENYU</button></div></div>`;
      break;
    }
    case 'game':
      ui.innerHTML = '';
      ui.className = 'ui';
      break;
  }
  bindSettings();
}

function bindSettings () {
  for (const el of ui.querySelectorAll('[data-s]')) {
    el.addEventListener('input', () => {
      const k = el.dataset.s;
      const v = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : Number(el.value);
      settings[k] = v;
      const lab = { sensitivity: 'vSens', touchSensitivity: 'vTSens', fov: 'vFov', volume: 'vVol', resolutionScale: 'vRes' }[k];
      if (lab) ui.querySelector('#' + lab).textContent = k === 'volume' || k === 'resolutionScale' ? Math.round(v * 100) + '%' : k === 'fov' ? v : v.toFixed(2);
      if (game && k === 'fov') game.ots.baseFov = v;
      if (game && k === 'resolutionScale') game.resize();
    });
  }
  const n = ui.querySelector('#nameIn');
  if (n) n.addEventListener('change', () => { settings.name = n.value.trim().slice(0, 16); });
}

function go (s) { screen = s; lastError = ''; render(); }
let backTo = 'menu';

ui.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  unlockAudio(); sfx.ui();
  const a = b.dataset.a;
  const nameIn = ui.querySelector('#nameIn');
  if (nameIn) settings.name = nameIn.value.trim().slice(0, 16);
  const myName = settings.name || 'Player';
  switch (a) {
    case 'retry': boot(); break;
    case 'menu': go('menu'); break;
    case 'mp': go('mp'); break;
    case 'help': backTo = screen === 'pause' ? 'pause' : 'menu'; go('help'); if (backTo === 'pause') ui.querySelector('[data-a="menu"]').dataset.a = 'back'; break;
    case 'settings': backTo = screen === 'pause' ? 'pause' : 'menu'; go('settings'); break;
    case 'back': go(backTo); break;
    case 'reset-settings': resetSettings(); render(); break;
    case 'create': net.send({ type: MSG.CREATE_SESSION, name: myName }); break;
    case 'join': net.send({ type: MSG.JOIN_SESSION, name: myName }); break;
    case 'leave': net.send({ type: MSG.LEAVE_SESSION }); go('mp'); break;
    case 'team': net.send({ type: MSG.SET_TEAM, prefer: b.dataset.t }); break;
    case 'start': net.send({ type: MSG.START_SESSION }); break;
    case 'training': startTraining(myName); break;
    case 'resume': go('game'); game && game.pause(false); break;
    case 'quit': quitGame(); break;
    case 'restart': net.send({ type: MSG.RETURN_LOBBY }); break;
  }
});

function startGame (mode) {
  if (game) return;
  showMenuScene(false);
  game = new Game({
    canvas, hudRoot: document.getElementById('hud'), touchRoot: document.getElementById('touch'),
    net, mode, session, playerName: settings.name || 'Player',
    onPause: () => { if (screen === 'game') { game.pause(true); go('pause'); } },
    onMatchEnd: () => { if (game) { game.pause(true); go('results'); } },
    onExit: () => quitGame(true)
  });
  document.body.classList.add('playing');
  go('game');
  game.start();
}
function quitGame (silent) {
  if (game) {
    const mode = game.mode;
    game.dispose(); game = null;
    if (mode === 'lan') net.send({ type: MSG.LEAVE_SESSION });
  }
  document.body.classList.remove('playing');
  showMenuScene(true);
  go(net.open ? 'menu' : 'boot');
}
function startTraining (name) {
  // mashq: lobbysiz (standalone) avtoritativ sessiya — server nishonlari bilan
  if (lobby && lobby.inSession) { net.send({ type: MSG.LEAVE_SESSION }); }
  startGame('training');
}

net.on(MSG.LOBBY_STATE, (m) => {
  const was = lobby;
  lobby = m;
  if (m.inSession && m.state === 'in_game' && !game) { startGame('lan'); return; }
  if (game && game.mode === 'lan' && m.inSession && m.state === 'lobby') { game.dispose(); game = null; document.body.classList.remove('playing'); showMenuScene(true); go('lobby'); return; }
  if (screen === 'mp' && m.inSession) { go('lobby'); return; }
  if (screen === 'lobby' && !m.inSession) { go('mp'); return; }
  if (screen === 'mp' || screen === 'lobby') render();
  void was;
});
net.on(MSG.SESSION, (m) => { session = m; });
net.on(MSG.STATE, (m) => { if (session) session.state = m; });
net.on(MSG.ERROR, (m) => { lastError = m.message || m.code; if (['mp', 'lobby', 'results'].includes(screen)) render(); });
net.on('close', () => { if (!game) { lastError = 'Server bilan aloqa uzildi'; screen = 'boot'; render(); } });

async function boot () {
  screen = 'boot'; render();
  try {
    lastError = '';
    await net.connect(settings.name || 'Player');
    go('menu');
  } catch (e) {
    lastError = e.message || String(e);
    render();
  }
}
// HUD masshtabi (CSS'da uzunlikni uzunlikka bo'lib bo'lmaydi — shu yerda)
function hudScale () { const k = Math.max(0.55, Math.min(1.25, Math.min(innerWidth / 1280, innerHeight / 760))); document.documentElement.style.setProperty('--s', k.toFixed(3)); }
addEventListener('resize', hudScale); hudScale();
// telefon: o'yin paytida orientatsiya ogohlantirishi (CSS bilan), gesture'larni bloklash
document.addEventListener('gesturestart', (e) => e.preventDefault());
if (touchEnabled()) document.body.classList.add('is-touch');
showMenuScene(true);
boot();
window.__app = { net, get game () { return game; }, get lobby () { return lobby; }, go, startTraining };
