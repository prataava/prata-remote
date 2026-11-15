#!/bin/sh
# PRATA Remote — nyalakan server di Codespace.
# Dipanggil otomatis oleh devcontainer (postStartCommand) setiap kali
# Codespace dibuat/dibangun-ulang/dinyalakan. Idempotent: bila server
# sudah menjawab /healthz, tidak dinyalakan lagi.
set -e
cd "$(dirname "$0")/../apps/backend"

if node -e "fetch('http://127.0.0.1:8080/healthz').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "prata-server: sudah jalan di :8080"
  exit 0
fi

mkdir -p data
if [ ! -f data/.jwt-secret ]; then
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > data/.jwt-secret
  chmod 600 data/.jwt-secret
fi

export PORT=8080
export PRATA_DEV=1
export PRATA_SEED_USER="admin@prata.app:admin123:Admin"
export JWT_SECRET="$(cat data/.jwt-secret)"

nohup node src/index.ts > /tmp/prata-server.log 2>&1 &
echo "prata-server: dimulai (pid $!) di :8080, log /tmp/prata-server.log"
