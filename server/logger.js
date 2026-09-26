// ============================================================
// NEON STRIKE — server logger
// Muhit xususiyati: snap node'da console.log'nin REDIRECT qilingan
// faylga yozuvi yo'qoladi/stall bo'ladi. Shuning uchun logging
// raw syscall (fs.writeSync) + loyiha ichidagi log faylga sync append.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
let logFile = null;

export function initLogFile () {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logFile = path.join(LOG_DIR, 'server.log');
    fs.appendFileSync(logFile, `\n=== NEON STRIKE server start: ${new Date().toISOString()} ===\n`);
  } catch {
    logFile = null; // log fayl ishlmasa ham server ishlashi shart
  }
  return logFile;
}

function emit (level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${ts}] [${level}] ${msg}`;
  // Faqat fd 1 (stdout). stderr yozsak 2>&1 pipeline'da satrlar takrorlanadi.
  try { fs.writeSync(1, line + '\n'); } catch { /* fd yopilgan bo'lishi mumkin */ }
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch (e) {
      try { fs.writeSync(1, `[logger] LOG FILE YOZUV XATOSI: ${e.message}\n`); } catch {}
    }
  }
}

export function createLogger () {
  return {
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a)
  };
}
