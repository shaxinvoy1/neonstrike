// ============================================================
// NEON STRIKE — PHASE 11: LAN manzil / peer mantiqi (SOF modul)
//
// Nega alohida fayl: ilgari "haqiqiy LAN interfeys" tsikli `server/app.js`
// va `server/index.js` da TAKRORLANARDI va uni unit-testda tekshirish
// mumkin emasdi. Endi bitta manba — deterministik testlanadi (test/unit/lan-qa.test.js).
//
// Bu modul hech narsani import qilmaydi (faqat node:os — standart kutubxona):
//   • DOM yo'q, Three.js yo'q, tarmoq I/O yo'q
//
// MUHIM (P11 halollik qoidasi): bu modul "qaysi peer HAQIQIY boshqa qurilma"
// degan savolga javob beradi. Verifikator shu javobsiz "ikki qurilma" deb
// da'vo qilmaydi.
// ============================================================
import os from 'node:os';

/** `::ffff:10.0.0.5` → `10.0.0.5` (dual-stack soketlarda IPv4 shunday keladi) */
export function normalizeIp (addr) {
  const a = String(addr ?? '').trim();
  if (!a) return '';
  // zone id (`fe80::1%enp2s0`) va IPv6-mapped IPv4 prefiksini olib tashlaymiz
  const noZone = a.split('%')[0];
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(noZone);
  return (m ? m[1] : noZone).toLowerCase();
}

export function isLoopbackIp (addr) {
  const a = normalizeIp(addr);
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

/**
 * Haqiqiy LAN interfeys manzillari (loopback/internal CHIQARILADI).
 * @returns {{name:string, address:string, netmask:string}[]}
 */
export function lanInterfaces (ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const ni of list || []) {
      // `family` ba'zi Node versiyalarida 'IPv4' string, ba'zilarida 4 raqami
      const family = typeof ni.family === 'string' ? ni.family : (ni.family === 4 ? 'IPv4' : String(ni.family));
      if (family !== 'IPv4') continue;
      if (ni.internal) continue;
      if (isLoopbackIp(ni.address)) continue;
      out.push({ name, address: normalizeIp(ni.address), netmask: ni.netmask || '' });
    }
  }
  return out;
}

/**
 * LAN o'yinchilar Device B'da ochadigan manzillar (real interfeysdan olinadi —
 * HARD-CODE YO'Q). Interfeys bo'lmasa — faqat localhost (halol fallback).
 */
export function lanUrls (ifaces = os.networkInterfaces(), port) {
  const list = lanInterfaces(ifaces).map((i) => `http://${i.address}:${port}`);
  return list.length ? list : [`http://localhost:${port}`];
}

/** Klient WS manzilini AYNAN shu formuladan yasaydi (client/js/main.js) */
export function wsUrlFor (hostHeader, secure = false) {
  return `${secure ? 'wss' : 'ws'}://${hostHeader}/ws`;
}

/**
 * Peer'ni tasniflaydi — "ikki qurilma" da'vosining YAGONA asosi.
 *
 *  'loopback' → 127.0.0.1 / ::1        (bir mashina, loopback: DALIL EMAS)
 *  'self'     → shu hostning LAN IP'si (bir mashina, LAN interfeysi: ikki
 *               qurilma dalili EMAS, lekin real tarmoq yo'li)
 *  'remote'   → boshqa manzil          (HAQIQIY ikkinchi qurilma)
 */
export function classifyPeer (remoteAddress, localAddresses = []) {
  const ip = normalizeIp(remoteAddress);
  if (!ip) return 'unknown';
  if (isLoopbackIp(ip)) return 'loopback';
  const locals = new Set(localAddresses.map(normalizeIp));
  if (locals.has(ip)) return 'self';
  return 'remote';
}

/** Shu hostning barcha IPv4 manzillari (loopback ham) — classifyPeer uchun */
export function localIpv4Addresses (ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const ni of list || []) {
      const family = typeof ni.family === 'string' ? ni.family : (ni.family === 4 ? 'IPv4' : String(ni.family));
      if (family === 'IPv4') out.push(normalizeIp(ni.address));
    }
  }
  return out;
}
