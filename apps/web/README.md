# PRATA Remote — Web Dashboard (FINAL, Bagian 7)

SPA statis (tanpa build step) yang terhubung langsung ke REST API &
WebSocket backend PRATA Remote. Desain: Hybrid Premium Glass —
Midnight Navy `#080D18`, surface `#111B2B`, Electric Cyan `#50D8F5`,
Mint `#72E6B4`, Violet `#9B8CFF`, teks `#F2F6FC`, font Inter/Manrope,
radius 14–22px, transisi 180–350ms, glassmorphism hanya pada kartu
utama & header navigasi.

## Menjalankan

```bash
# 1. Backend (dari apps/backend):
PRATA_DEV=1 JWT_SECRET=dev-secret PRATA_SEED_USER=admin@prata.app:admin123:Admin \
  node src/index.ts        # default PORT=8080

# 2. Dashboard (dari apps/web) — origin apa pun, mis. port 8000:
python3 -m http.server 8000
# buka http://localhost:8000 — isi alamat server backend di form login
# (default http://localhost:8080).
```

Backend mengirim header CORS (`Access-Control-Allow-Origin`, default
`*` untuk dev; atur env `CORS_ORIGIN` di produksi) sehingga fetch dari
origin lain berfungsi. WebSocket tidak memakai CORS.

## Struktur

- `index.html` — shell: header kaca, nav 8 halaman, form login.
- `styles.css` — token desain + komponen.
- `js/api.js` — klien REST (JWT di localStorage `prata_web_jwt`).
- `js/ws.js` — klien signaling (hello controller, watch, relay
  file/app lewat requestId + timeout 60 dtk, reconnect backoff).
- `js/rtc.js` — penerima WebRTC browser (RTCPeerConnection +
  DataChannel `prata_control`).
- `js/app.js` — router + 8 halaman + aksi.

## 8 halaman (semua tombol terhubung ke API nyata)

1. **Overview** — total perangkat, online, sesi aktif (dari
   `/healthz`), aturan aktif, alert otomatisasi terbaru, ringkasan
   metrik tiap perangkat.
2. **Device Center** — cari + filter grup, ubah nama/grup (PATCH),
   lihat izin fitur (GET permissions), Revoke (POST revoke),
   Hapus (DELETE), form pairing (`prata://pair/...` atau ID + kode).
3. **Live Control** — pilih perangkat → sesi layar/kamera depan/
   belakang (RTCPeerConnection di browser, `<video>` live), klik &
   drag mouse di video → tap/swipe ternormalisasi 0..1 ke
   DataChannel, input keyboard (teks lengkap + ENTER), tombol
   Back/Home/Recents/Lock/Screenshot, Volume, pemilih kualitas
   Low/Med/High, latensi ping/pong (ms), Ambil Foto, Clipboard.
4. **File Transfer** — explorer SAF Agent (WS `file_list_request`),
   buat folder, rename, hapus (konfirmasi), unduh (transfer relay
   → blob → unduhan browser), unggah file dari komputer (POST
   `/api/devices/:id/files/upload`).
5. **Monitoring** — gauge Baterai (status charging), Penyimpanan,
   RAM (dari `device_metrics` WS tiap 15 dtk) + riwayat status
   koneksi (presence).
6. **Automation** — buat/aktifkan/nonaktifkan/hapus aturan
   (`battery_below`, `storage_above`, `device_offline`,
   `session_started`, `session_ended`).
7. **Security & Activity Logs** — tabel audit (GET
   `/api/activity-logs`), notifikasi terbaru, tombol
   **Terminate All Sessions** (POST `/api/sessions/terminate-all`).
8. **Settings** — info akun, alamat server backend, status server
   ICE (GET `/api/rtc/ice-servers`), logout jarak jauh (terminate
   semua sesi + hapus JWT).

## Batas jujur

- Dashboard memakai JWT yang sama dengan Controller Android; tidak
  ada pendaftaran akun dari dashboard.
- Stream video butuh Agent online + izin MediaProjection di Agent
  (dialog "Start Now" di HP Agent) — sama seperti Controller Android.
- Foto hasil `takePhotoJpeg` disimpan Agent ke folder SAF-nya
  (bukan diunduh otomatis ke browser).
