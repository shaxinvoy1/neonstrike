// WebAudio sintez ovozlari (fayl yuklanmaydi). Pozitsion: masofa + panorama.
import { settings, onSettings } from './settings.js';
let ac = null, master = null, noiseBuf = null;
const listener = { x: 0, y: 0, z: 0, yaw: 0 };

export function unlockAudio () {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC();
  master = ac.createGain();
  master.gain.value = settings.volume;
  const comp = ac.createDynamicsCompressor();
  master.connect(comp); comp.connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
onSettings((k, v) => { if (k === 'volume' && master) master.gain.value = v; });
export function setListener (x, y, z, yaw) { listener.x = x; listener.y = y; listener.z = z; listener.yaw = yaw; }

function out (pos, vol) {
  const g = ac.createGain();
  let v = vol;
  if (pos) {
    const dx = pos.x - listener.x, dz = pos.z - listener.z;
    const d = Math.hypot(dx, pos.y - listener.y, dz);
    v *= 1 / (1 + d * d * 0.012);
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      // ekran o'ngi = (-cos yaw, sin yaw)
      const rx = -Math.cos(listener.yaw), rz = Math.sin(listener.yaw);
      p.pan.value = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) : 0;
      g.connect(p); p.connect(master);
    } else g.connect(master);
  } else g.connect(master);
  g.gain.value = v;
  return g;
}
function noise ({ dur = 0.1, f = 1200, q = 1, type = 'bandpass', vol = 0.5, pos = null, decay = 2, t0 = 0, sweep = 0 }) {
  if (!ac || !settings.sfx) return;
  const t = ac.currentTime + t0;
  const s = ac.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
  if (sweep) fl.frequency.exponentialRampToValueAtTime(Math.max(40, f * sweep), t + dur);
  const g = ac.createGain(); g.gain.setValueAtTime(1, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(fl); fl.connect(g); g.connect(out(pos, vol));
  s.start(t, Math.random() * 0.5, dur + 0.05);
}
function tone ({ f = 440, dur = 0.1, type = 'sine', vol = 0.2, pos = null, slide = 0, t0 = 0 }) {
  if (!ac || !settings.sfx) return;
  const t = ac.currentTime + t0;
  const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, f * slide), t + dur);
  const g = ac.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(out(pos, vol)); o.start(t); o.stop(t + dur + 0.05);
}

export const sfx = {
  rifle (pos) { noise({ dur: 0.12, f: 1800, q: 0.7, vol: 0.55, pos, sweep: 0.3 }); tone({ f: 160, dur: 0.08, type: 'square', vol: 0.12, pos, slide: 0.5 }); tone({ f: 1400, dur: 0.05, type: 'sawtooth', vol: 0.05, pos, slide: 0.4 }); },
  pistol (pos) { noise({ dur: 0.1, f: 2400, q: 1.2, vol: 0.5, pos, sweep: 0.25 }); tone({ f: 900, dur: 0.12, type: 'triangle', vol: 0.15, pos, slide: 0.3 }); },
  shotgun (pos) { noise({ dur: 0.32, f: 900, q: 0.5, vol: 0.9, pos, sweep: 0.2, type: 'lowpass' }); tone({ f: 90, dur: 0.2, type: 'sine', vol: 0.4, pos, slide: 0.5 }); },
  knife (pos) { noise({ dur: 0.16, f: 3500, q: 2, vol: 0.25, pos, sweep: 0.4 }); },
  throw (pos) { noise({ dur: 0.18, f: 800, q: 1, vol: 0.18, pos, sweep: 2 }); },
  explosion (pos) { noise({ dur: 0.9, f: 500, q: 0.4, vol: 1.2, pos, sweep: 0.15, type: 'lowpass' }); tone({ f: 60, dur: 0.6, vol: 0.6, pos, slide: 0.4 }); },
  impact (pos) { noise({ dur: 0.05, f: 3000 + Math.random() * 1500, q: 3, vol: 0.15, pos }); },
  hit () { tone({ f: 1250, dur: 0.06, type: 'square', vol: 0.12 }); tone({ f: 1700, dur: 0.05, type: 'square', vol: 0.08, t0: 0.03 }); },
  headshot () { tone({ f: 2100, dur: 0.09, type: 'square', vol: 0.14 }); },
  kill () { tone({ f: 660, dur: 0.1, type: 'triangle', vol: 0.2 }); tone({ f: 990, dur: 0.16, type: 'triangle', vol: 0.2, t0: 0.08 }); },
  hurt () { tone({ f: 180, dur: 0.18, type: 'sawtooth', vol: 0.18, slide: 0.6 }); },
  death () { tone({ f: 300, dur: 0.6, type: 'sawtooth', vol: 0.22, slide: 0.25 }); },
  respawn () { tone({ f: 300, dur: 0.4, type: 'sine', vol: 0.18, slide: 3 }); },
  reload (pos) { noise({ dur: 0.05, f: 2500, q: 4, vol: 0.2, pos }); noise({ dur: 0.06, f: 1800, q: 4, vol: 0.22, pos, t0: 0.5 }); noise({ dur: 0.05, f: 3000, q: 5, vol: 0.25, pos, t0: 1.2 }); },
  switch (pos) { noise({ dur: 0.05, f: 2200, q: 5, vol: 0.2, pos }); noise({ dur: 0.04, f: 3200, q: 5, vol: 0.15, pos, t0: 0.12 }); },
  dry () { noise({ dur: 0.03, f: 4000, q: 6, vol: 0.15 }); },
  step (pos, k = 1) { noise({ dur: 0.05, f: 500 + Math.random() * 300, q: 1.2, vol: 0.07 * k, pos, type: 'lowpass' }); },
  land (pos) { noise({ dur: 0.1, f: 300, q: 0.8, vol: 0.18, pos, type: 'lowpass' }); },
  ui () { tone({ f: 880, dur: 0.05, type: 'sine', vol: 0.08 }); },
  roundStart () { [523, 659, 784].forEach((f, i) => tone({ f, dur: 0.18, type: 'triangle', vol: 0.15, t0: i * 0.12 })); },
  victory () { [523, 659, 784, 1047].forEach((f, i) => tone({ f, dur: 0.4, type: 'triangle', vol: 0.18, t0: i * 0.14 })); },
  defeat () { [392, 330, 262].forEach((f, i) => tone({ f, dur: 0.45, type: 'triangle', vol: 0.16, t0: i * 0.2 })); },
  chat () { tone({ f: 1320, dur: 0.05, vol: 0.06 }); }
};
