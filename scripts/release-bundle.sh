#!/usr/bin/env bash
# PRATA Remote — buat arsip rilis bersih (source bundle).
# Isi = HEAD git (sudah bersih: .gitignore mengecualikan data/, node_modules,
# .env, artefak build, APK). Output: apps/backend/public/releases/prata-remote-full-release.tar.gz
# Jalankan dari root repo:  bash scripts/release-bundle.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/backend/public/releases/prata-remote-full-release.tar.gz"
mkdir -p "$(dirname "$OUT")"
# git archive membaca dari object store; gzip yang menulis berkas output
# (proses penulis tidak membaca ~/workspace — penting di VM sandbox ini).
git -C "$ROOT" archive --format=tar --prefix=prata-remote/ HEAD | gzip -9 > "$OUT"
echo "bundle: $OUT"
ls -l "$OUT"
