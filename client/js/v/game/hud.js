// ============================================================
// HUD (Reference B): yuqorida jamoa hisobi + taymer + raund, chap-yuqorida
// minimap, o'ng-yuqorida kill-feed, markazda crosshair/hitmarker, chap-pastda
// avatar + HP + qalqon + chat, o'ng-pastda qurol + o'q-dori + qurollar ro'yxati.
// HUD faqat SERVER holatini ko'rsatadi.
// ============================================================
import { COLLIDERS, MAP, SITES } from '/shared/map.js';
import { WEAPONS, WEAPON_ORDER } from '/shared/weapons.js';
import { WEAPON_ICON } from '../weapons/models.js';
import { TEAM_COLOR } from './players.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SHORT = { 'neon-rifle': 'Neon Rifle', 'pulse-pistol': 'Pulse Pistol', 'scatter-shot': 'Scatter Shot', 'energy-grenade': 'Grenade', 'combat-knife': 'Knife' };
const PERSON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="7" r="5"/><path d="M4 23c0-6 3.5-9 8-9s8 3 8 9z"/></svg>';

export class Hud {
  constructor (root) {
    this.root = root;
    root.innerHTML = `
      <div class="h-top">
        <div class="h-team h-blue"><span class="h-tname">BLUE TEAM</span><span class="h-alive" id="hAliveA"></span><b id="hScoreA">0</b></div>
        <div class="h-clock"><b id="hTime">--:--</b><small id="hRound">ROUND -/10</small></div>
        <div class="h-team h-red"><b id="hScoreB">0</b><span class="h-alive" id="hAliveB"></span><span class="h-tname">RED TEAM</span></div>
      </div>
      <div class="h-map"><canvas id="hMap" width="340" height="250"></canvas></div>
      <div class="h-feed" id="hFeed"></div>
      <div class="h-cross" id="hCross"><i></i><i></i><i></i><i></i><b></b></div>
      <div class="h-hit" id="hHit"><i></i><i></i><i></i><i></i></div>
      <div class="h-dmgdir" id="hDmg"></div>
      <div class="h-vignette" id="hVig"></div>
      <div class="h-chat" id="hChat"><div class="h-chat-log" id="hChatLog"></div><input id="hChatIn" maxlength="160" placeholder="Xabar yozing… (Enter)" autocomplete="off"></div>
      <div class="h-me">
        <div class="h-avatar" id="hAvatar">${PERSON}</div>
        <div class="h-bars">
          <div class="h-row"><span class="h-ic">✚</span><b id="hHp">100</b></div>
          <div class="h-bar"><i id="hHpBar"></i></div>
          <div class="h-row h-shield"><span class="h-ic">⛉</span><b id="hShield">0</b></div>
        </div>
      </div>
      <div class="h-slots" id="hSlots"></div>
      <div class="h-weapon">
        <div class="h-wmain"><div class="h-wicon" id="hWIcon"></div><div class="h-ammo"><b id="hMag">30</b><span>/</span><i id="hRes">90</i></div><small id="hWName">Neon Rifle</small><div class="h-reload" id="hReload"><i></i></div></div>
        <div class="h-wcard" id="hCardPistol"><div class="h-wicon sm"></div><small>2</small></div>
        <div class="h-wcard" id="hCardGren"><div class="h-wicon sm"></div><small id="hGren">2</small></div>
      </div>
      <div class="h-banner" id="hBanner"><h2></h2><p></p></div>
      <div class="h-dead" id="hDead"><h3>ELIMINATED</h3><p></p></div>
      <div class="h-score" id="hScore"></div>
      <div class="h-fps" id="hFps"></div>
      <div class="h-net" id="hNet"></div>`;
    const $ = (id) => root.querySelector('#' + id);
    this.el = {};
    for (const id of ['hAliveA', 'hAliveB', 'hScoreA', 'hScoreB', 'hTime', 'hRound', 'hMap', 'hFeed', 'hCross', 'hHit', 'hDmg', 'hVig', 'hChat', 'hChatLog', 'hChatIn', 'hHp', 'hHpBar', 'hShield', 'hSlots', 'hWIcon', 'hMag', 'hRes', 'hWName', 'hReload', 'hCardPistol', 'hCardGren', 'hGren', 'hBanner', 'hDead', 'hScore', 'hFps', 'hNet', 'hAvatar']) this.el[id] = $(id);
    this.el.hCardPistol.querySelector('.h-wicon').innerHTML = WEAPON_ICON['pulse-pistol'];
    this.el.hCardGren.querySelector('.h-wicon').innerHTML = WEAPON_ICON['energy-grenade'];
    this.el.hSlots.innerHTML = WEAPON_ORDER.map((id, i) => `<div class="h-slot" data-id="${id}"><span>${i + 1}</span><div class="h-wicon xs">${WEAPON_ICON[id]}</div><em>${SHORT[id]}</em></div>`).join('');
    this.mapCtx = this.el.hMap.getContext('2d');
    this._mapBase = this._drawMapBase();
    this.cache = {};
    this.chatOpen = false;
    this.bannerT = 0;
    this.hitT = 0;
  }

  _set (key, el, val, prop = 'textContent') { if (this.cache[key] !== val) { this.cache[key] = val; el[prop] = val; } }

  match (m, myTeam) {
    if (!m) return;
    this._set('sA', this.el.hScoreA, String(m.scores ? m.scores.A : 0));
    this._set('sB', this.el.hScoreB, String(m.scores ? m.scores.B : 0));
    const pip = (n, t) => `${PERSON.replace('<svg', `<svg class="pip ${t}"`)}<span>${n}</span>`;
    this._set('aA', this.el.hAliveA, pip(m.lives ? m.lives.A : 0, 'a'), 'innerHTML');
    this._set('aB', this.el.hAliveB, pip(m.lives ? m.lives.B : 0, 'b'), 'innerHTML');
    const t = m.roundState === 'live' ? m.roundTimeLeft : m.roundState === 'round_end' ? m.roundEndsIn : 0;
    const mm = Math.floor(t / 60), ss = Math.floor(t % 60);
    this._set('time', this.el.hTime, m.matchState === 'none' ? 'TRAINING' : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
    this._set('round', this.el.hRound, m.matchState === 'none' ? 'NEON FACILITY' : `ROUND ${Math.max(1, m.roundNumber || 1)}/${m.maxRounds || 10}`);
    this.root.classList.toggle('mine-a', myTeam === 'A');
    this.root.classList.toggle('mine-b', myTeam === 'B');
  }

  vitals (hp, maxHp = 100, alive = true) {
    const v = Math.max(0, Math.round(hp));
    this._set('hp', this.el.hHp, String(v));
    const pct = Math.max(0, Math.min(100, (v / maxHp) * 100));
    this._set('hpw', this.el.hHpBar.style, pct + '%', 'width');
    this.el.hVig.style.opacity = alive ? Math.max(0, (40 - v) / 60).toFixed(2) : '0';
    this.root.classList.toggle('low-hp', alive && v <= 30);
  }

  weapon (w, loadout) {
    if (!w) return;
    const id = w.weaponId;
    if (this.cache.wid !== id) { this.cache.wid = id; this.el.hWIcon.innerHTML = WEAPON_ICON[id] || ''; this.el.hWName.textContent = SHORT[id] || id; }
    const melee = WEAPONS[id] && WEAPONS[id].mode === 'melee';
    this._set('mag', this.el.hMag, melee ? '∞' : String(w.mag));
    this._set('res', this.el.hRes, melee ? '' : String(w.reserve));
    this.el.hMag.classList.toggle('empty', !melee && w.mag === 0);
    this.el.hReload.style.opacity = w.reloading ? '1' : '0';
    this.el.hReload.firstElementChild.style.width = (w.reloading ? w.reloadProgress * 100 : 0) + '%';
    if (loadout) {
      const gren = loadout.find((x) => x.id === 'energy-grenade');
      if (gren) this._set('gren', this.el.hGren, String(gren.mag + gren.reserve));
      const key = loadout.map((x) => x.id + (x.active ? '*' : '')).join(',');
      if (this.cache.slots !== key) {
        this.cache.slots = key;
        for (const el of this.el.hSlots.children) el.classList.toggle('on', el.dataset.id === id);
        this.el.hCardPistol.classList.toggle('on', id === 'pulse-pistol');
        this.el.hCardGren.classList.toggle('on', id === 'energy-grenade');
      }
    }
  }

  crosshair (spread, blocked, onEnemy) {
    const g = Math.round(6 + spread * 9);
    this._set('gap', this.el.hCross.style, `${g}px`, '--gap');
    if (this.cache.gapv !== g) { this.cache.gapv = g; this.el.hCross.style.setProperty('--gap', g + 'px'); }
    this.el.hCross.classList.toggle('blocked', !!blocked);
    this.el.hCross.classList.toggle('enemy', !!onEnemy);
  }
  hit (kind) {
    const el = this.el.hHit;
    el.className = 'h-hit on ' + (kind || '');
    clearTimeout(this._hitTo);
    this._hitTo = setTimeout(() => { el.className = 'h-hit'; }, kind === 'kill' ? 380 : 160);
  }
  damageFrom (angle) {
    const el = this.el.hDmg;
    el.style.transform = `translate(-50%,-50%) rotate(${angle}rad)`;
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }
  feed (items, nameOf) {
    const key = items.map((x) => x.seq).join(',');
    if (this.cache.feed === key) return;
    this.cache.feed = key;
    const now = Date.now();
    this.el.hFeed.innerHTML = items.slice(-5).reverse().map((f) => {
      const k = nameOf(f.killer), v = nameOf(f.victim);
      return `<div class="f-row${now - f.at > 6000 ? ' old' : ''}"><span style="color:${TEAM_COLOR[k.team] || '#cfe6ff'}">${esc(k.name)}</span><i class="h-wicon xs">${WEAPON_ICON[f.weapon] || ''}</i>${f.zone === 'head' ? '<em class="hs">◎</em>' : ''}<span class="x">✕</span><span style="color:${TEAM_COLOR[v.team] || '#cfe6ff'}">${esc(v.name)}</span></div>`;
    }).join('');
  }
  chat (entries, myId) {
    const key = entries.length ? entries[entries.length - 1].seq : 0;
    if (this.cache.chat === key) return;
    this.cache.chat = key;
    this.el.hChatLog.innerHTML = entries.slice(-6).map((e) => `<div><span class="${e.team === 'B' ? 'cr' : 'cb'}">[${e.team === 'A' ? 'Blue' : e.team === 'B' ? 'Red' : 'All'}] ${esc(e.name)}:</span> ${esc(e.text)}</div>`).join('');
  }
  banner (title, sub = '', ms = 2200, cls = '') {
    const b = this.el.hBanner;
    b.querySelector('h2').textContent = title;
    b.querySelector('p').textContent = sub;
    b.className = 'h-banner on ' + cls;
    clearTimeout(this._bto);
    this._bto = setTimeout(() => { b.className = 'h-banner'; }, ms);
  }
  dead (on, text = '') {
    this.el.hDead.classList.toggle('on', on);
    if (on) this.el.hDead.querySelector('p').textContent = text;
  }
  scoreboard (show, players, match, myId) {
    const el = this.el.hScore;
    el.classList.toggle('on', !!show);
    if (!show) return;
    const rows = (t) => players.filter((p) => p.team === t).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
      .map((p) => `<tr class="${p.id === myId ? 'me' : ''}${p.alive ? '' : ' deadrow'}"><td>${esc(p.name)}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.alive ? Math.max(0, p.hp) : '✕'}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">—</td></tr>';
    el.innerHTML = `<div class="sb-head"><span class="b">BLUE ${match?.scores?.A ?? 0}</span><span>ROUND ${match?.roundNumber || 1}/${match?.maxRounds || 10}</span><span class="r">${match?.scores?.B ?? 0} RED</span></div>
      <div class="sb-cols"><table class="sb b"><tr><th>BLUE TEAM</th><th>K</th><th>D</th><th>HP</th></tr>${rows('A')}</table><table class="sb r"><tr><th>RED TEAM</th><th>K</th><th>D</th><th>HP</th></tr>${rows('B')}</table></div>`;
  }
  fps (txt) { this._set('fps', this.el.hFps, txt); }
  net (txt) { this._set('net', this.el.hNet, txt); }

  // ---------------- minimap ----------------
  _drawMapBase () {
    const c = document.createElement('canvas'); c.width = 340; c.height = 250;
    const g = c.getContext('2d');
    const sx = (x) => (x + MAP.HALF_X) / (MAP.HALF_X * 2) * (c.width - 20) + 10;
    const sz = (z) => (z + MAP.HALF_Z) / (MAP.HALF_Z * 2) * (c.height - 20) + 10;
    this._sx = sx; this._sz = sz;
    g.fillStyle = 'rgba(16,26,64,.92)'; g.fillRect(sx(-MAP.HALF_X), sz(-MAP.HALF_Z), sx(MAP.HALF_X) - sx(-MAP.HALF_X), sz(MAP.HALF_Z) - sz(-MAP.HALF_Z));
    const S = SITES.A;
    g.fillStyle = 'rgba(60,150,255,.12)'; g.fillRect(sx(S.min[0]), sz(S.min[2]), sx(S.max[0]) - sx(S.min[0]), sz(S.max[2]) - sz(S.min[2]));
    for (const col of COLLIDERS) {
      const b = col.box;
      g.fillStyle = col.kind === 'wall' ? '#4a64c8' : col.kind === 'catwalk' ? 'rgba(90,130,255,.45)' : col.kind === 'stair' ? 'rgba(120,160,255,.35)' : '#2f4396';
      g.fillRect(sx(b.min[0]), sz(b.min[2]), Math.max(1.5, sx(b.max[0]) - sx(b.min[0])), Math.max(1.5, sz(b.max[2]) - sz(b.min[2])));
    }
    g.strokeStyle = '#6fd0ff'; g.lineWidth = 2; g.strokeRect(sx(-MAP.HALF_X), sz(-MAP.HALF_Z), sx(MAP.HALF_X) - sx(-MAP.HALF_X), sz(MAP.HALF_Z) - sz(-MAP.HALF_Z));
    g.fillStyle = '#9fd8ff'; g.font = '700 22px system-ui'; g.fillText('A', sx(SITES.A.sign.x) - 7, sz(-MAP.HALF_Z) + 28);
    return c;
  }
  minimap (self, mates, enemies) {
    const g = this.mapCtx;
    g.clearRect(0, 0, 340, 250);
    g.drawImage(this._mapBase, 0, 0);
    const dot = (x, z, col, r = 6) => { g.fillStyle = col; g.beginPath(); g.arc(this._sx(x), this._sz(z), r, 0, 7); g.fill(); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1.5; g.stroke(); };
    for (const m of mates) if (m.alive) dot(m.x, m.z, '#3d9bff');
    for (const e of enemies) if (e.alive) dot(e.x, e.z, '#ff4466');
    if (self) {
      const x = this._sx(self.x), y = this._sz(self.z);
      g.save(); g.translate(x, y); g.rotate(-self.yaw + Math.PI);
      g.fillStyle = '#e8f6ff'; g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 8); g.lineTo(0, 4); g.lineTo(-8, 8); g.closePath(); g.fill();
      g.restore();
    }
  }
}
