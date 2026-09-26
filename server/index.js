// ============================================================
// NEON STRIKE — server kirish nuqtasi
// Ishga tushirish: node server/index.js   (yoki: npm start)
// ============================================================
import { createNeonServer } from './app.js';
import { lanUrls } from './net.js';   // PHASE 11: LAN manzillar (bir manba)
import { initLogFile, createLogger } from './logger.js';
import { SERVER_DEFAULTS, SIM, PROTOCOL_VERSION } from '../shared/protocol-consts.js';

const PORT = Number(process.env.PORT || SERVER_DEFAULTS.PORT);
const HOST = process.env.HOST || SERVER_DEFAULTS.HOST;

initLogFile();
const log = createLogger();
const server = createNeonServer({ host: HOST, port: PORT, log });

try {
  await server.listen();
} catch (err) {
  log.error(`[fatal] ${HOST}:${PORT} bind QILINMADI: ${err.message}`);
  log.error(`        Port band yoki ruxsat yo'q. Sinang: PORT=3100 node server/index.js`);
  process.exit(1);
}

log.info('==================================================');
log.info(`  NEON STRIKE — Phase 5 avtoritativ server (protokol v${PROTOCOL_VERSION})`);
log.info(`  Sim   : ${SIM.TICK_HZ} Hz tick · ${SIM.SNAPSHOT_HZ} Hz snapshot`);
log.info(`  Local : http://localhost:${PORT}`);
// PHASE 11: Device B shu manzillarni ochadi (real interfeys, hard-code YO'Q)
for (const url of lanUrls(undefined, PORT)) log.info(`  LAN   : ${url}`);
log.info(`  WS    : ws://<host>:${PORT}${SERVER_DEFAULTS.WS_PATH}`);
log.info('==================================================');
