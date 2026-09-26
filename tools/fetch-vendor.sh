#!/usr/bin/env bash
# ============================================================
# NEON STRIKE — fallback vendor fetcher
# npm ishlamasa (snap cheklovi), paketlarni to'g'ridan-to'g'ri
# registry'dan curl bilan yuklab, qo'lda joylaydi.
#   vendor/three.module.js   <- unpkg (pinned r160)
#   node_modules/ws          <- registry tarball (pure JS, zero-deps)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p vendor node_modules

echo "[1/3] three.module.js (r160) yuklanmoqda…"
curl -fsSL https://unpkg.com/three@0.160.0/build/three.module.js -o vendor/three.module.js
grep -q "REVISION = '160'" vendor/three.module.js || { echo "XATO: REVISION 160 topilmadi"; exit 1; }

echo "[2/3] ws@8.21.3 tarball yuklanmoqda…"
curl -fsSL https://registry.npmjs.org/ws/-/ws-8.21.3.tgz -o /tmp/ws-8.21.3.tgz

echo "[3/3] node_modules/ws ichiga joylanmoqda…"
rm -rf /tmp/ws-pkg node_modules/ws
mkdir -p /tmp/ws-pkg
tar -xzf /tmp/ws-8.21.3.tgz -C /tmp/ws-pkg
mv /tmp/ws-pkg/package node_modules/ws

node --input-type=module -e "const m=await import('ws'); console.log('ws OK:', typeof m.WebSocketServer)"
node --input-type=module -e "const m=await import('./vendor/three.module.js'); console.log('three OK, r'+m.REVISION)"
echo "DONE — vendor tayyor"
