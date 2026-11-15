#!/usr/bin/env bash
# PRATA Remote — push ke GitHub via HTTPS (bypass blokir SSH port 22 di VM).
#
# Pakai (token TIDAK PERNAH dicetak/dicatat, dan TIDAK disimpan di .git/config):
#   GITHUB_TOKEN=ghp_... GITHUB_USER=prataava GITHUB_REPO=prata-remote bash push-github.sh
#   (token boleh juga dilewatkan sebagai argumen pertama)
#
# Yang dilakukan script:
#   1. push branch main ke https://github.com/<USER>/<REPO>.git via HTTPS
#   2. poll GitHub Actions (workflow build-android.yml) sampai selesai
#   3. unduh artifact APK (agent + controller) ke apps/backend/public/releases/
#
# Butuh: git, curl, python3 (parse JSON), unzip (opsional, bila ada).
# Keluar bukan-nol bila push gagal, workflow gagal, atau artifact tak ditemukan.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
TOKEN="${GITHUB_TOKEN:-${1:-}}"
USER="${GITHUB_USER:-prataava}"
REPO="${GITHUB_REPO:-prata-remote}"
BRANCH="${GITHUB_BRANCH:-main}"
WORKFLOW="${GITHUB_WORKFLOW:-build-android.yml}"
RELEASES_DIR="$ROOT/apps/backend/public/releases"

if [ -z "$TOKEN" ]; then
  echo "GITHUB_TOKEN belum diset. Jalankan: GITHUB_TOKEN=ghp_... bash push-github.sh" >&2
  exit 1
fi
for cmd in git curl python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "butuh $cmd di PATH" >&2; exit 1; }
done

API="https://api.github.com/repos/$USER/$REPO"
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json")

echo "push $BRANCH -> https://github.com/$USER/$REPO.git ..."
git -C "$ROOT" push "https://${TOKEN}@github.com/${USER}/${REPO}.git" "$BRANCH"
echo "push OK."

# Cari run workflow terbaru untuk commit HEAD.
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
echo "menunggu run workflow $WORKFLOW untuk $HEAD_SHA ..."
RUN_ID=""
for _ in $(seq 1 40); do
  RUN_JSON="$(curl -s "${AUTH[@]}" "$API/actions/workflows/$WORKFLOW/runs?per_page=5")"
  RUN_ID="$(printf '%s' "$RUN_JSON" | python3 -c "
import json,sys
runs=json.load(sys.stdin).get('workflow_runs',[])
for r in runs:
    if r.get('head_sha')=='$HEAD_SHA':
        print(r['id']); break
" 2>/dev/null || true)"
  [ -n "$RUN_ID" ] && break
  sleep 15
done
[ -n "$RUN_ID" ] || { echo "run workflow untuk HEAD tidak ditemukan (cek Actions di GitHub)" >&2; exit 1; }
echo "run id: $RUN_ID — memantau sampai selesai (maks ±20 mnt) ..."

CONCLUSION=""
for _ in $(seq 1 40); do
  RUN_JSON="$(curl -s "${AUTH[@]}" "$API/actions/runs/$RUN_ID")"
  STATUS="$(printf '%s' "$RUN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)"
  CONCLUSION="$(printf '%s' "$RUN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('conclusion') or '')" 2>/dev/null || true)"
  echo "  status: $STATUS${CONCLUSION:+ / $CONCLUSION}"
  [ "$STATUS" = "completed" ] && break
  sleep 30
done
[ "$CONCLUSION" = "success" ] || { echo "workflow selesai dengan conclusion: ${CONCLUSION:-tidak diketahui}" >&2; exit 1; }

echo "workflow sukses — mengunduh artifact APK ..."
mkdir -p "$RELEASES_DIR"
ART_JSON="$(curl -s "${AUTH[@]}" "$API/actions/runs/$RUN_ID/artifacts")"
printf '%s' "$ART_JSON" | python3 -c "
import json,sys
for a in json.load(sys.stdin).get('artifacts',[]):
    print(a['id'], a['name'])
" | while read -r ART_ID ART_NAME; do
  [ -n "$ART_ID" ] || continue
  OUT="$RELEASES_DIR/${ART_NAME}.zip"
  echo "  $ART_NAME -> $OUT"
  curl -sL "${AUTH[@]}" "$API/actions/artifacts/$ART_ID/zip" -o "$OUT"
  if command -v unzip >/dev/null 2>&1; then
    unzip -o -q "$OUT" -d "$RELEASES_DIR/$ART_NAME" && echo "  diekstrak ke $RELEASES_DIR/$ART_NAME"
  fi
done
echo "selesai. APK di $RELEASES_DIR"
ls -l "$RELEASES_DIR"
