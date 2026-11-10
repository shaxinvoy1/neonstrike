// Sozlamalar (localStorage) — sezgirlik, grafika sifati, ruxsat masshtabi, soyalar, effektlar, ovoz
const KEY = 'neonstrike.settings.v1';
export const QUALITY = Object.freeze({
  low: { pixelRatio: 0.75, shadows: false, material: 'low', fx: 0.5, antialias: false },
  medium: { pixelRatio: 1, shadows: true, material: 'medium', fx: 0.8, antialias: true },
  high: { pixelRatio: 1.5, shadows: true, material: 'high', fx: 1, antialias: true }
});
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
export const DEFAULTS = Object.freeze({
  name: '', sensitivity: 1.0, touchSensitivity: 1.0, invertY: false, fov: 72,
  quality: coarse ? 'medium' : 'high', resolutionScale: 1.0, shadows: true, effects: 1.0,
  volume: 0.8, sfx: true, showFps: false, touchControls: 'auto'
});
let cur = { ...DEFAULTS };
try { cur = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
const subs = new Set();
export const settings = new Proxy(cur, {
  set (o, k, v) { o[k] = v; try { localStorage.setItem(KEY, JSON.stringify(o)); } catch {} subs.forEach((f) => f(k, v)); return true; }
});
export function onSettings (fn) { subs.add(fn); return () => subs.delete(fn); }
export function resetSettings () { for (const k in DEFAULTS) settings[k] = DEFAULTS[k]; }
export function touchEnabled () {
  if (settings.touchControls === 'on') return true;
  if (settings.touchControls === 'off') return false;
  return coarse || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
}
