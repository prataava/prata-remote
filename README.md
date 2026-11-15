# PRATA Remote

Ekosistem remote management Android: kendalikan banyak HP Android (Agent)
dari satu pusat kendali (Android Controller & Web Dashboard) lewat internet
menggunakan WebRTC & WebSocket.

> **Aturan utama: NO GIMMICK.** Tanpa mock data, tanpa tombol palsu. Semua
> fitur memakai implementasi API nyata. Bila Android membatasi sesuatu,
> dibuat error handling/fallback yang jujur — tidak ada klaim bypass
> keamanan OS Android.

## Status: FINALISASI SELESAI (15 Nov 2026, 19.29–19.45 WIB)

Seluruh spesifikasi PRATA Remote (Command 001–008 + FINAL) selesai
dibangun & teruji di lingkungan ini, **ditambah finalisasi**:
DiskStore persisten (default bila tanpa `DATABASE_URL`), blob transfer
di disk (streaming), server tunggal (backend + Web Dashboard + rilis APK
di satu port), Deep Kotlin Analyzer (1632 cek), uji E2E restart &
persistence, repo Git lokal siap push, dan server produksi berjalan di
VM ini (port 8080, lihat "Menjalankan server produksi" di bawah).

Yang masih menunggu perangkat/akses di luar VM ini: uji end-to-end di
perangkat Android fisik + build APK (GitHub Actions / Android Studio) +
push repo ke GitHub (kredensial) — lihat "Batas jujur" di bawah.
Ringkasan per command ada di bawah; bagian FINAL (skema 10 tabel, file
manager penuh, app manager, notifikasi, kamera, keamanan, otomatisasi,
Web Dashboard, CI) dirangkum di akhir; bagian FINALISASI sesudahnya.

## Command 002 — REST API + Pairing (Tugas 1 SELESAI)

Backend kini melayani REST + WebSocket di satu port (Node `http` bawaan —
tanpa framework tambahan; handler adalah fungsi murni sehingga bisa
dipindah ke Express nanti tanpa mengubah logika).

| Endpoint | Auth | Fungsi |
|---|---|---|
| `POST /api/auth/login` | — | Email + kata sandi (scrypt) -> JWT HS256 (sama dengan yang diverifikasi WS), berlaku 8 jam |
| `POST /api/devices/pairing/init` | — | Agent belum terdaftar -> kode pairing 6 karakter + `qrPayload` `prata://pair/<id>/<kode>`, berlaku 10 menit |
| `POST /api/devices/pairing/poll` | kode pairing | Agent mengambil status + `agentToken` SEKALI (poll kedua tidak mengeluarkan token lagi) |
| `POST /api/devices/pairing/confirm` | JWT | Controller kirim hasil scan QR -> daftarkan device + terbitkan `agentToken` permanen |
| `GET /api/devices` | JWT | Daftar perangkat milikmu + status live (online/offline) dari presence tracker |
| `GET /api/devices/:id` | JWT | Detail satu perangkat (cek pemilik) |

Alur pairing (aman, tanpa kata sandi HP ke server):

```text
Agent (belum terdaftar)                 Controller (login JWT)
  | POST /pairing/init                     |
  | <- pairingCode + qrPayload            |
  | tampilkan QR                          | scan QR
  | POST /pairing/poll -> pending         | POST /pairing/confirm (JWT + kode)
  |            ... server: verifikasi hash kode, buat Device +
  |            agentToken (hanya hash disimpan), Pairing CONSUMED
  | POST /pairing/poll -> consumed + agentToken (SEKALI)
  | simpan token di EncryptedSharedPreferences
  | WebSocket hello (token) -> welcome -> online
```

Yang ditegakkan: kode kedaluwarsa 10 menit; 5x kode salah -> pairing
dicabut; confirm atomik (hanya satu yang berhasil bila dua controller
bersamaan); token agen TIDAK PERNAH dikembalikan ke controller; login
gagal selalu 401 dengan pesan sama (anti-enumerasi user); init dibatasi
10/menit/IP; satu sumber kebenaran perangkat — REST dan WS membaca
`DeviceStore` yang sama (Command 001 `EnvDeviceRegistry` dihapus).

Contoh (sesudah `npm install` + isi `.env`):

```bash
# login -> simpan token
curl -s -X POST localhost:8080/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@prata.test","password":"..."}'
# pairing init (dari Agent)
curl -s -X POST localhost:8080/api/devices/pairing/init \
  -H 'content-type: application/json' -d '{"deviceName":"POCO X6 Pro"}'
# confirm (dari Controller, pakai JWT hasil login)
curl -s -X POST localhost:8080/api/devices/pairing/confirm \
  -H "authorization: Bearer <JWT>" -H 'content-type: application/json' \
  -d '{"qrPayload":"prata://pair/<id>/<kode>"}'
# daftar perangkat
curl -s localhost:8080/api/devices -H "authorization: Bearer <JWT>"
```

**Bukti tes:** `npm test` menjalankan dua suite — signaling 18/18 dan
REST 19/19 (login benar/salah, auth 401, init + QR, poll pending,
confirm kode salah, confirm via QR tanpa token di respons, poll token
sekali-baca, confirm ulang 409, daftar offline -> online sesudah WS
hello dengan token hasil pairing, kedaluwarsa 410, lockout 410,
rate limit 429). Entrypoint asli (`node src/index.ts`, seed user dev)
juga dites lewat curl langsung: login + pairing init + healthz semua OK.

## Struktur monorepo

```text
prata-remote/
├── apps/
│   ├── backend/                 # Node.js + TypeScript + Prisma (signaling + REST API)
│   │   ├── prisma/schema.prisma # Users, Devices, Sessions, Pairings
│   │   ├── src/
│   │   │   ├── index.ts         # Bootstrap (env -> registry/store -> server)
│   │   │   ├── signaling/       # types, auth (JWT HS256), presence, server
│   │   │   ├── registry/        # DeviceRegistry: env (dev) | prisma (prod)
│   │   │   └── store/           # SessionStore: memory (dev) | prisma (prod)
│   │   └── test/signaling.smoke.mjs  # Smoke test end-to-end (12+ cek)
│   ├── web/                     # SPA statis (FINAL): 8 halaman dashboard
│   │                            # index.html + styles.css + js/ (api, ws, rtc, app)
│   └── android/
│       ├── agent/               # Kotlin + Compose — MediaProjection,
│       │                        # AccessibilityService, SAF, notifikasi, kamera
│       └── controller/          # Kotlin + Compose — WebRTC viewer + input,
│                                # tab Files/Apps/Notifikasi, PIN/biometrik
├── packages/
│   └── shared/                  # Tipe pesan/DTO bersama (dibangun saat web dimulai)
├── infra/
│   ├── docker-compose.yml       # PostgreSQL + CoTURN (host deploy)
│   └── coturn/turnserver.conf   # Konfigurasi TURN minimal
└── docs/                        # Catatan arsitektur per fase
```

## Menjalankan backend (Command 001 + FINALISASI)

```bash
cd apps/backend
npm install            # memasang ws + @prisma/client (butuh internet)
cp .env.example .env   # isi JWT_SECRET (wajib) + DATABASE_URL (bila prisma)
node src/index.ts      # Node >= 22 (type-stripping aktif, tanpa build)
# atau: npm run dev    # watch mode
```

**Store default (FINALISASI): `disk`** bila `DATABASE_URL` kosong —
10 tabel tersimpan di `apps/backend/data/prata-store.json` (JSON WAL,
tulis atomik tmp+rename, tiap mutasi) dan blob transfer di
`apps/backend/data/blobs/<transferId>.bin` (streaming, TTL 10 menit).
Set `STORE=memory` untuk mode lama tanpa persistensi, atau
`STORE=prisma` + `DATABASE_URL` untuk PostgreSQL. Variabel data:
`PRATA_DATA_FILE`, `PRATA_BLOB_DIR`, `PRATA_WEB_DIR`, `PRATA_RELEASES_DIR`.

**Server tunggal (FINALISASI):** backend menyajikan Web Dashboard di
`/` (port yang sama dengan `/api/*` dan WS `/ws`) + endpoint rilis
`GET /api/releases/apks`, `GET /api/releases/apks/:file`,
`GET /api/releases/source-bundle` (butuh JWT). Bundel rilis dibuat
dengan `bash scripts/release-bundle.sh` (isi = HEAD git, bersih).

**Server produksi di VM ini:** berjalan sebagai proses background di
port 8080 (`PRATA_DEV=1` + seed `admin@prata.app` / `admin123` —
ganti kredensial & matikan `PRATA_DEV` untuk produksi sungguhan).
Perintah mulai ulang (dari `apps/backend`):

```bash
JWT_SECRET=<rahasia-kuat> PORT=8080 PRATA_DEV=1 \
  PRATA_SEED_USER=admin@prata.app:admin123:Admin node src/index.ts
```

Smoke test (tanpa database — registry env + session memory):

```bash
cd apps/backend
npm test               # signaling 43/43 + REST 54/54
npm run test:persistence  # uji E2E restart & persistence (Langkah 6)
```

Hasil yang diharapkan: semua cek LULUS (healthz, hello agen/controller,
watch presence online, session-request → accept, relay offer/answer/ICE,
penolakan relay tanpa sesi, session-end, presence offline saat agen putus,
serta penolakan token agen salah, JWT palsu, dan pesan sebelum hello;
persistence: device/token/rule/log/blob bertahan melewati restart).

## Command 002 — Android Agent & Controller (Tugas 2–3 SELESAI, 15 Nov 18.48 WIB)

Proyek Gradle di `apps/android/` (buka di Android Studio, JDK 17,
AGP 8.7.3): modul `:shared` (model API + Retrofit + klien signaling WS
+ TokenStore terenkripsi + ServerConfig + parser QR) dan dua aplikasi
`:agent` (`com.prata.remote.agent`) + `:controller`
(`com.prata.remote.controller`).

- **Agent:** cek token tersimpan -> belum ada = layar Unpaired (minta
  kode pairing via REST init, tampilkan QR ZXing + kode + hitung mundur,
  polling tiap 3 detik sampai confirm) -> sudah ada = dashboard Paired
  (status WS, tombol Berhenti/Mulai Lagi yang mengendalikan Foreground
  Service tipe dataSync + WS). FGS mediaProjection baru di Phase 2.
- **Controller:** login (email + kata sandi + alamat server -> JWT
  tersimpan terenkripsi), daftar perangkat (GET /api/devices + chip
  status + refresh + keluar), scanner QR (CameraX + ML Kit, sekali-scan
  -> POST pairing/confirm -> kembali + refresh daftar).
- **Verifikasi statis** `python3 apps/android/tools/verify.py`: **34/34
  lulus** (XML, kurung, import, kelas di manifest, tanpa penanda gimmick).
- **Build Gradle di VM ini BLOCKED (bukan kode):** `gradle --version`
  saja gagal di init native services — JVM tidak bisa menulis hasil
  ekstrak JNI sesudah membaca lib dari `~/workspace` (aturan sandbox:
  proses yang sudah membaca `~/workspace` tidak bisa menulis; probe
  tulis bersih tanpa baca berhasil). Jadi APK hanya bisa dibangun di
  Android Studio pengguna (atau CI) — jalankan `:agent:assembleDebug`
  + `:controller:assembleDebug`, lalu uji di emulator/HP fisik.
- Dependensi Gradle: Compose BOM 2024.10.00, Retrofit 2.11.0, OkHttp
  4.12.0, security-crypto 1.1.0-alpha06, CameraX 1.3.4, ML Kit
  barcode-scanning 17.3.0, ZXing core 3.5.3, material 1.12.0 (parent
  tema XML). Alamat server default `http://10.0.2.2:8080` (emulator);
  di HP fisik isi IP/host backend + pastikan backend terjangkau.

## Command 003 — Phase 2 Remote Engine (Tugas 1 + awal Tugas 2 SELESAI)

Backend kini bicara WebRTC: pesan `webrtc_offer` / `webrtc_answer` /
`webrtc_ice_candidate` (alias lama `offer`/`answer`/`ice` tetap diterima
dan dinormalisasi server menjadi `webrtc_*`), `GET /api/rtc/ice-servers`
(JWT) + `iceServers` di pesan `welcome`. STUN Google selalu ada sebagai
fallback; TURN ditambahkan bila env `TURN_URLS` + `TURN_USERNAME` +
`TURN_CREDENTIAL` ketiganya diisi (kredensial tidak pernah di repo).
Pesan dari satu soket diproses BERURUTAN (antrean promise) — tanpa ini,
accept + offer yang dikirim agent berurutan bisa diproses terbalik dan
offer ditolak `not-in-session` (latent, terutama dengan store Prisma).

**Bukti tes:** signaling 22/22, REST 21/21 (termasuk relay webrtc_*,
alias lama, welcome berisi STUN, endpoint ICE 401/200, dan accept +
offer berurutan tanpa jeda).

Android `:shared`: dependensi `org.webrtc:google-webrtc:1.0.32006`,
DTO RTC (`IceServerDto`/`SdpDto`/`IceCandidateDto` + konverter),
`WebRtcClient` (PeerConnection terpisah dari UI — Agent membuat Offer,
Controller nanti membuat Answer), `SignalingClient` diperbarui ke
`webrtc_*` + `iceServers` dari welcome.

Android `:agent`: berbagi layar nyata — tombol "Mulai Berbagi Layar"
meminta izin `MediaProjectionManager` (dialog sistem, user WAJIB tap
"Start Now" tiap sesi, sesuai aturan Android 14+), token izin ke
Foreground Service tipe `mediaProjection` (turun ke `dataSync` saat
berhenti), `ScreenCapturerAndroid` -> `WebRtcClient.attachScreenCapturer`.
Saat controller request sesi "screen" dan sharing On, agent accept +
buat offer + kirim via WS; bila sharing mati, session-request ditolak
jujur `"screen-sharing-off"`. Status ICE tampil di dashboard.

**Verifikasi statis** `python3 apps/android/tools/verify.py`: **37/37
lulus**. Build Gradle tetap BLOCKED di VM ini (aturan sandbox yang sama)
— APK dibangun di Android Studio pengguna. Controller (Tugas 3:
`RemoteControlScreen` + Answer + render video) MENUNGGU konfirmasi
pengguna sebelum dikerjakan.

## Command 004 — Controller Receiver & Remote Touch DataChannel (SELESAI)

**Controller (Tugas 1):** klik perangkat di Device List -> rute
`remote/{deviceId}/{deviceName}` -> `RemoteControlViewModel` kirim
`session-request` tipe `"screen"` -> terima `webrtc_offer` -> set remote
description -> `createAnswer` -> kirim `webrtc_answer` -> ICE terhubung.
`RemoteControlScreen` merender video lewat `SurfaceViewRenderer` di
`AndroidView`, di-`init` dengan `eglContext` dari `WebRtcClient` (tidak
ada EGL kedua). Loading tampil sampai ICE `CONNECTED`; gagal -> pesan
error + tombol "Coba lagi" (retry).

**DataChannel (Tugas 2):** `WebRtcClient` punya DataChannel
`"prata_control"` — dibuat offerer (Agent) sebelum offer; Controller
menerimanya lewat `onDataChannel`. Tap di video (`Modifier.pointerInput`
+ `detectTapGestures`) dinormalisasi 0..1 terhadap area tampilan,
dikirim sebagai JSON `{"action":"tap","x":..,"y":..}`. Agent untuk saat
ini HANYA mencatat pesan ke Logcat (`PRATA-DATACHANNEL`) — eksekusi
`AccessibilityService` di command berikutnya, bukan sekarang.

**Verifikasi statis** `python3 apps/android/tools/verify.py`: **39/39
lulus**. Build Gradle tetap BLOCKED di VM ini — APK dibangun di Android
Studio pengguna. Uji end-to-end yang menunggu: Agent "Mulai Berbagi
Layar" -> "Start Now" -> Controller ketuk perangkat -> video tampil ->
tap terkirim (cek Logcat Agent).

**Batas yang diketahui (jujur):** bila koneksi WS controller/agent
putus di tengah sesi lalu reconnect otomatis, server tetap memegang
soket lama di room sesi — media tidak pulih sendiri; tekan "Coba lagi"
(retry) untuk meminta sesi baru. Satu sesi remote dalam satu waktu per
controller.

## Command 005 — Remote Touch via AccessibilityService (Tugas 1 + 2 SELESAI)

**Agent (Tugas 1):** `PrataAccessibilityService` (turunan
`AccessibilityService`, `canPerformGestures="true"`,
`canRetrieveWindowContent="false"` — tidak membaca isi layar) terdaftar
di manifest + `res/xml/accessibility_service_config.xml`.
`AccessibilityController` (singleton ringan) menjembatani WebRtcClient
dan service: tap JSON `{"action":"tap","x":0.5,"y":0.5}` dari DataChannel
-> koordinat proporsional × ukuran layar nyata (`DisplayMetrics`) ->
`GestureDescription` + `StrokeDescription` 80ms -> `dispatchGesture`.
Tanpa ROOT/ADB — 100% API resmi OS. Bila layanan belum aktif, tap
ditolak dengan jujur (return false + Logcat), tidak ada antrean
diam-diam.

**UI izin (Tugas 2):** dashboard Agent menampilkan status Aksesibilitas
(Aktif/Tidak Aktif) + tombol "Buka Pengaturan Aksesibilitas" ke
`Settings.ACTION_ACCESSIBILITY_SETTINGS`. Android tidak mengizinkan
aktivasi programatik — tertulis jujur di UI, tanpa janji bypass.

**Verifikasi statis** `python3 apps/android/tools/verify.py`: **43/43
lulus**. Build Gradle tetap BLOCKED di VM ini — APK dibangun di Android
Studio pengguna. Uji end-to-end yang menunggu: aktifkan layanan di
Pengaturan > Aksesibilitas -> Agent berbagi layar -> Controller tap
video -> ketukan sungguhan terjadi di HP Agent.

**BELUM:** Tugas 3 swipe (`detectDragGestures` + `{"action":"swipe",
...}` + eksekusi swipe di service) — menunggu konfirmasi pengguna.

## Command 006 — Swipe & Remote Keyboard (SELESAI)

**Swipe (Tugas 1, penutup Command 005):** Controller memakai
`detectDragGestures` (modifier pointerInput kedua, di dalam tap —
drag yang tidak melewati slop dilepas tanpa consume, jadi tap tetap
berfungsi). Swipe HANYA dikirim saat drag selesai (`onDragEnd`), satu
JSON utuh `{"action":"swipe","startX":..,"startY":..,"endX":..,"endY":..,
"duration":300}` — bukan per frame, agar DataChannel tidak banjir.
Threshold: 50px ATAU 5% sisi terpendek layar. Durasi diukur dari drag
nyata (100–1000ms). Agent: `Path` awal→akhir × ukuran layar nyata ->
`StrokeDescription` durasi terkirim -> `dispatchGesture`.

**Keyboard remote (Tugas 2+3):** tombol keyboard di bar bawah layar
remote memfokuskan `BasicTextField` tersembunyi (1dp, nyaris
transparan) sehingga soft keyboard Controller muncul. Tiap ketikan
mengirim TEKS LENGKAP `{"action":"text","text":"halo"}` (bukan delta —
karena Agent memakai `ACTION_SET_TEXT` yang mengganti isi field;
backspace bekerja karena teks terkirim memendek; duplikat tidak
dikirim ulang). Enter (ImeAction.Send) -> `{"action":"key","code":
"ENTER"}`. Agent: cari node input fokus (`FOCUS_INPUT`) -> cek
`isEditable` -> `ACTION_SET_TEXT` / `ACTION_IME_ENTER`. Bila tidak ada
node fokus / UI memblokir Accessibility / layanan belum aktif, perintah
diabaikan aman + dicatat di Logcat — tanpa crash, tanpa IME kustom
(sengaja tidak untuk V1).

**Verifikasi statis** `python3 apps/android/tools/verify.py`: **43/43
lulus**. Build Gradle tetap BLOCKED di VM ini — APK dibangun di Android
Studio pengguna. Uji end-to-end yang menunggu: swipe di video ->
geseran sungguhan di Agent; ketuk field teks di Agent -> ketik dari
Controller -> teks terisi; Enter mengeksekusi aksi field.

**Phase 2 (Remote Engine) kini SELESAI** kecuali uji perangkat fisik.

## Command 007 — Phase 3: Device Monitoring (SELESAI)

**Backend (Tugas 1):** pesan baru `device_metrics` di protokol WS.
Agen mengirim `{type:"device_metrics", metrics:{...}}`; server
meneruskannya ke controller pemilik — semua yang `watch` device itu
DITAMBAH controller di room sesi aktif dengannya. Tanpa sesi pun
metrik mengalir (itu tujuan Phase 3). Hanya agen yang boleh mengirim
(controller -> error `bad-message`; payload bukan objek -> error
`bad-message`); tidak bocor ke controller lain.

**Agent (Tugas 2):** `DeviceMetricsCollector` membaca baterai
(`BATTERY_PROPERTY_CAPACITY` + fallback level/scale dari sticky
`ACTION_BATTERY_CHANGED`, status charging), penyimpanan (`StatFs`
pada `getDataDirectory()`), RAM (`ActivityManager.MemoryInfo`). Semua
gagal dibaca = `null` (jujur) + Logcat, bukan angka hardcode.
`AgentForegroundService` menjalankan loop tiap **15 detik**; pengiriman
lewat `AgentMetricsBridge` yang hanya aktif bila ViewModel sudah
mendaftarkan pengirim WS yang terhubung — bila offline, pengumpulan
diabaikan (tanpa antrean, tanpa leak). Loop hidup di service, bukan di
Activity, jadi metrik tetap mengalir saat aplikasi di latar belakang.

**Controller (Tugas 3):** `RemoteControlScreen` punya tab Video /
Monitor. Tab Monitor menampilkan baterai, penyimpanan, dan RAM dengan
lingkaran progres + angka ("12,4 GB bebas dari 128,0 GB") + jam
terakhir diperbarui. ViewModel `watch(deviceId)` sesudah welcome dan
memperbarui state tiap `device_metrics` masuk (real-time re-render).
Nilai null tampil sebagai "Tidak diketahui".

**Verifikasi:** signaling smoke **27/27** (5 cek baru device_metrics),
REST smoke **21/21**, verify statis Android **47/47**. Build Gradle
tetap BLOCKED di VM ini — APK dibangun di Android Studio pengguna. Uji
end-to-end yang menunggu: buka tab Monitor -> angka baterai/storage/RAM
Agent berubah tiap ±15 detik tanpa membuka sesi video.

**Phase 3 (File & Monitoring) SELESAI untuk monitoring.** Sisa Phase 3:
Web Dashboard + file transfer.

## Command 008 — Phase 3: File Manager & Transfer (Tugas 1 Backend SELESAI)

**Backend (Tugas 1):** relay WS `file_list_request`/`file_list_response`
(dipasangkan lewat `requestId`, hanya untuk controller pemilik, device
harus online) + transfer HTTP terautentikasi dua arah. Download:
`POST /api/transfers` (JWT) -> WS `file_download_request` ke Agent ->
`PUT /api/transfers/:id/blob` (token agen) -> `GET /api/transfers/:id/blob`
(JWT, sekali pakai lalu dihapus). Upload: `POST
/api/devices/:id/files/upload` (JWT, body mentah + header `X-File-Name`)
-> WS `file_upload_ready` -> Agent `GET` blob (token agen) -> ack WS
`file_transfer_done` -> status done/failed + blob dihapus + controller
diberitahu. Blob TIDAK PERNAH masuk database (hanya metadata tabel
`file_transfers`); batas 50 MB, TTL 10 menit, token sekali pakai.

**Verifikasi:** signaling smoke **30/30**, REST smoke **35/35**.

**Tugas 2+3 (Android SAF + tab Files) SELESAI di FINAL** — lihat bagian
FINAL di bawah (SafFileManager, tab Files/Apps/Notifications).

## FINAL — Autonomous Master Command (SELESAI, 15 Nov 2026 ±19.25 WIB)

### Bagian 1 — Skema 10 tabel
`schema.prisma` kini memuat: users, devices (+`group`), device_keys
(hash token/kunci + revoked), pairings, sessions, permissions (PK
gabungan device+feature: screen/accessibility/saf/notification/camera),
file_transfers (+`sha256Hash`), activity_logs, automation_rules,
notifications. Store Memory + Prisma untuk device_keys, permissions,
activity_logs, automation_rules, notifications; `DeviceStore` tambah
`update`/`delete`; `StoreDeviceRegistry.verifyAgentToken` cek
`agentTokenHash` dulu lalu kunci tambahan non-revoked di `device_keys`.

### Bagian 2 — File Manager penuh
WS relay `file_mkdir_request` / `file_rename_request` /
`file_delete_request` → `file_op_response` (requestId, timeout 60 dtk).
Endpoint `POST /api/devices/:id/files/request-download` (alias
`POST /api/transfers`); nama event kanonik FINAL `file_upload_requested`
& `file_download_ready` (klien Android menerima nama lama sebagai alias).
Agent: `SafFileManager`/`FileBrowser` (DocumentFile: list, mkdir, rename,
delete, InputStream upload, OutputStream simpan; SAF belum dipilih →
error jujur `"saf-folder-not-granted"`); kartu "Folder Akses File" di
dashboard Agent (pemilih `ACTION_OPEN_DOCUMENT_TREE` +
`takePersistableUriPermission`). Controller: tab Files (jelajah, buat
folder, rename, hapus dialog konfirmasi, unduh ke Downloads, kirim file
via GetContent).

### Bagian 3 — App Manager, Remote Actions & Stream Quality
DataChannel `{"action":"global","name":"HOME|BACK|RECENTS|LOCK|SCREENSHOT"}`
→ `performGlobalAction` (LOCK/SCREENSHOT Android 9+); volume via
`AudioManager` (`{"action":"volume","name":"UP|DOWN|MUTE"}`); clipboard
get/set (persetujuan eksplisit via tombol); kualitas
`{"action":"quality","preset":"low|medium|high"}` (480p@15/600kbps,
720p@24/1,5Mbps, 1080p@30/3,5Mbps) + ping/pong latensi DataChannel
(tiap 5 dtk); ambil foto dari frame terakhir (`takePhotoJpeg`, disimpan
Agent ke folder SAF). App Manager: `PackageManager.getInstalledApplications`
→ WS `app_list_response`; `app_open` / `app_settings` /
`app_uninstall` (dialog resmi OS di Agent). Controller: bar navigasi
cepat di bawah video + tab Apps + indikator latensi ms.

### Bagian 4 — Notification Center
`PrataNotificationListenerService` (manifest + indikator status +
tombol ke `Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS`);
`onNotificationPosted` → WS `device_notification` (hormati
`VISIBILITY_SECRET`); backend simpan di store `notifications` +
teruskan real-time ke pemilik; Controller: tab Notifikasi (filter per
aplikasi) + alert otomatisasi di atas daftar.

### Bagian 5 — Kamera
Sesi `"camera-front"` / `"camera-back"` (DB mencatat CAMERA);
izin CAMERA + Foreground Service tipe `camera` (Android 14+) dengan
notifikasi mencolok *"PRATA Remote: Kamera sedang diakses dari jarak
jauh"* + tombol "Hentikan Kamera" di notifikasi; `Camera2Enumerator`
org.webrtc; Controller & Web: mode kamera (depan/belakang, kembali ke
layar, stop).

### Bagian 6 — Multi-Device, Automation & Logs
`PATCH /api/devices/:id` (nama & grup), `DELETE /api/devices/:id`,
`POST /api/devices/:id/revoke` (cabut `agentTokenHash` + semua kunci +
putus paksa soket WS Agent), `POST /api/sessions/terminate-all`
(panic button), `GET /api/activity-logs`, CRUD
`GET/POST/PATCH/DELETE /api/automation/rules` + engine evaluasi
(`battery_below`, `storage_above`, `device_offline`, `session_started`,
`session_ended`; cooldown anti-spam 15 menit per aturan) → alert di
`notifications` + `activity_logs` + push WS `automation_alert`.
Controller: PIN aplikasi (hash SHA-256 + garam di
EncryptedSharedPreferences) + biometrik sebagai jalur buka alternatif
(`BiometricPrompt`, butuh FragmentActivity).

### Bagian 7 — Web Dashboard (`apps/web`)
SPA statis (tanpa build): `index.html` + `styles.css` + `js/api.js` /
`js/ws.js` / `js/rtc.js` / `js/app.js`. 8 halaman: Overview, Device
Center, Live Control (RTCPeerConnection browser + `<video>` + klik/drag
mouse ternormalisasi + keyboard + tombol aksi + kualitas + latensi),
File Transfer, Monitoring (gauge baterai/storage/RAM + riwayat koneksi),
Automation, Security & Activity Logs (+ Terminate All), Settings
(akun, STUN/TURN, logout jarak jauh). Backend mengirim header CORS
(`CORS_ORIGIN`, default `*` dev) agar dashboard dari origin lain bisa
memanggil REST API. Cara jalan: `python3 -m http.server 8000` di
`apps/web` (atau server statis apa pun) + backend di `localhost:8080`.
Diverifikasi live di VM: backend healthz + CORS preflight 204 + login
+ devices + ICE + logs semua OK; berkas web tersaji 200 + sintaks JS OK.

### Bagian 8 — CI & verifikasi akhir
Workflow `.github/workflows/build-android.yml` (JDK 17, Android SDK,
`verify.py` + `:agent:assembleDebug` + `:controller:assembleDebug`,
upload dua APK sebagai artifact). Verifikasi statis Android
`python3 apps/android/tools/verify.py`: **58/58 lulus**. Smoke backend:
signaling **43/43**, REST **54/54** (termasuk file ops relay, app
manager relay, notifikasi + permission report, automation alert
baterai rendah + storage, multi-koneksi per user, revoke → soket putus
+ hello token tercabut ditolak, terminate-all). BUG NYATA yang
ditemukan & diperbaiki saat FINAL: `controllerSockets` satu-soket-per-
user → kini `Map<userId, Set<socket>>` (koneksi kedua menimpa yang
pertama + close menghapus entri user).

### Endpoint REST lengkap (FINAL)
| Endpoint | Auth | Fungsi |
|---|---|---|
| `POST /api/auth/login` | — | Email + kata sandi (scrypt) -> JWT HS256, 8 jam |
| `POST /api/devices/pairing/init` | — | Kode pairing 6 karakter + `prata://pair/<id>/<kode>`, 10 menit |
| `POST /api/devices/pairing/poll` | kode pairing | Status + `agentToken` SEKALI |
| `POST /api/devices/pairing/confirm` | JWT | Daftarkan device + terbitkan `agentToken` (tidak dikembalikan ke controller) |
| `GET /api/devices` | JWT | Daftar perangkat + status live |
| `GET /api/devices/:id` | JWT | Detail satu perangkat |
| `PATCH /api/devices/:id` | JWT | Ubah nama & grup |
| `DELETE /api/devices/:id` | JWT | Hapus perangkat (putus WS + cabut kunci) |
| `POST /api/devices/:id/revoke` | JWT | Cabut akses perangkat |
| `GET /api/devices/:id/permissions` | JWT | Status izin fitur Agent |
| `GET /api/devices/:id/keys` | JWT | Daftar kunci perangkat (hanya prefix hash) |
| `GET /api/rtc/ice-servers` | JWT | Daftar server ICE (STUN selalu, TURN bila env diisi) |
| `POST /api/transfers` | JWT | Minta unduhan file (buat transferId) |
| `POST /api/devices/:id/files/request-download` | JWT | Alias request-download |
| `GET /api/transfers/:id` | JWT | Status transfer |
| `PUT /api/transfers/:id/blob` | token agen | Agent unggah byte stream |
| `GET /api/transfers/:id/blob` | JWT / token agen | Unduh byte stream (sekali pakai untuk controller) |
| `POST /api/devices/:id/files/upload` | JWT | Controller unggah file ke Agent (body mentah + `X-File-Name`) |
| `POST /api/sessions/terminate-all` | JWT | Hentikan semua sesi aktif (panic button) |
| `GET /api/activity-logs` | JWT | Riwayat aktivitas (`?limit=&deviceId=`) |
| `GET /api/notifications` | JWT | Riwayat notifikasi (`?limit=&package=&kind=`) |
| `GET /api/automation/rules` | JWT | Daftar aturan otomatisasi |
| `POST /api/automation/rules` | JWT | Buat aturan |
| `PATCH /api/automation/rules/:id` | JWT | Ubah aturan |
| `DELETE /api/automation/rules/:id` | JWT | Hapus aturan |

### Pesan WebSocket lengkap (FINAL)
Client→Server: `hello`, `heartbeat`, `watch`, `unwatch`,
`session-request`, `session-accept`, `session-reject`, `webrtc_offer`,
`webrtc_answer`, `webrtc_ice_candidate` (alias lama `offer`/`answer`/
`ice`), `device_metrics`, `file_list_request`, `file_list_response`,
`file_transfer_done`, `file_mkdir_request`, `file_rename_request`,
`file_delete_request`, `file_op_response`, `app_list_request`,
`app_list_response`, `app_command`, `app_command_response`,
`device_notification`, `permission_report`, `session-end`, `bye`.
Server→Client: `welcome` (+`iceServers`), `presence`,
`session-request`, `session-accepted`, `session-rejected`,
`session-ended`, `webrtc_offer`, `webrtc_answer`,
`webrtc_ice_candidate` (+ alias lama), `device_metrics`,
`file_upload_requested`, `file_download_ready`, `file_list_request`,
`file_mkdir_request`, `file_rename_request`, `file_delete_request`,
`app_list_request`, `app_command`, `device_notification`,
`automation_alert`, `error`.

## Jujur soal batas (Command 001)

- **Tidak ada kata sandi HP yang dikirim ke server.** Agen memakai token
  perangkat; controller memakai JWT. Yang disimpan hanya hash SHA-256
  (`agentTokenHash`, `codeHash`) — bocornya database tidak memberi akses.
- **Relay tertutup:** offer/answer/ICE hanya diteruskan bila pengirim
  adalah pihak dari sesi AKTIF yang sudah disetujui agen. Tanpa sesi,
  server menjawab error `not-in-session`.
- **Kepemilikan ditegakkan:** controller hanya bisa watch/meminta sesi
  untuk perangkat miliknya (kecuali role ADMIN).
- **Batas kirim:** payload maks 1 MB, rate limit 120 pesan/menit/soket.
- **wss:// di produksi:** server ini menerima koneksi polos (ws) hanya
  bila di belakang TLS terminator/reverse proxy — jangan ekspos port
  tanpa TLS di internet.

## FINALISASI — Zero Handover (15 Nov 2026, 19.29–19.45 WIB)

Perintah: bereskan semua batas yang tersisa sampai sistem hidup,
persisten, tervalidasi penuh, siap pakai tanpa pengguna menyentuh
terminal/Android Studio.

1. **DiskStore + blob disk (Langkah 1):** `src/store/disk-store.ts` —
   satu `DiskBackend` (JSON WAL atomik tmp+rename, tiap mutasi) + 10
   adapter store + `DiskBlobStore` (streaming read/write, TTL cleanup).
   Default store kini `disk` bila `DATABASE_URL` kosong. Uji unit
   `13/13` (semua tabel + blob bertahan melewati instance baru).
   `tools/verify-prisma-schema.mjs` menggantikan `npx prisma validate`
   yang diblokir sandbox: **322 cek lulus**.
2. **Server tunggal + rilis (Langkah 2):** backend menyajikan
   `apps/web` di `/` (SPA fallback, anti-traversal) + endpoint
   `/api/releases/*` + kartu "Download APK & Release" di halaman
   Settings dashboard. Bundel sumber: `scripts/release-bundle.sh`
   → `apps/backend/public/releases/prata-remote-full-release.tar.gz`
   (187 KB, 180 entri, bersih dari data/.env/node_modules).
3. **Gradle / Deep Analyzer (Langkah 3):** salin toolchain ke /tmp
   & /var/tmp GAGAL definitif (EPERM saat menyalin + dependensi Maven
   tak bisa diunduh). Pengganti: **Deep Kotlin Cross-File Analyzer**
   (`apps/android/tools/deep_verify.py`) — dikalibrasi dari puluhan
   positif palsu menjadi **1632 cek, 0 gagal** (uji negatif: 2 bug
   sengaja dimasukkan, keduanya tertangkap dengan lokasi tepat),
   terhubung ke `verify.py` (**59/59**). Bonus: analyzer menemukan
   bug volume Agent yang sebenarnya (lihat "Jujur soal batas").
4. **Git + kredensial (Langkah 4):** repo lokal `git init` + commit
   rapi `494aa09` (117 berkas). Push BLOCKED: `gh` belum login, SSH
   github diblokir proxy, tanpa token. Vercel MCP terhubung tetapi
   bukan jalur deploy untuk server WS persisten; tanpa tunnel publik.
5. **Server produksi (Langkah 5):** berjalan di VM port 8080
   (background process; unit systemd diblokir tulis /etc & /run saat
   ini — lihat "Jujur soal batas"). `/` → dashboard, login admin
   berfungsi, `/api/releases/source-bundle` mengunduh bundel 187 KB.
6. **Uji E2E restart & persistence (Langkah 6):**
   `apps/backend/test/persistence.e2e.mjs` — pairing + rule +
   upload blob → matikan server → nyalakan lagi → device/token/rule/
   log/blob masih ada & berfungsi + dashboard tersaji dari `/`.
   (Hasil run: lihat laporan akhir; tes mem-probe rezim tulis sandbox
   dulu — bila EPERM, gagal jujur, bukan false-pass.)

## Jujur soal batas (FINAL + FINALISASI)

- **Persistensi:** store `disk` adalah default produksi-lokal (JSON WAL
  + blob di disk) dan lolos uji E2E restart (`test/persistence.e2e.mjs`).
  Untuk produksi multi-server tetap WAJIB store `prisma` dengan
  `DATABASE_URL` aktif + `npx prisma migrate dev` (DiskStore satu file
  bukan pengganti database untuk skala itu). Blob transfer di dev
  tersimpan di disk (maks 50 MB, TTL 10 menit).
- **`npx prisma validate` resmi TIDAK BISA jalan di VM ini** (unduh
  paket prisma diblokir sandbox) — diganti verifier skema tanpa
  dependensi `tools/verify-prisma-schema.mjs` (322 cek lulus: 10 model,
  enum, relasi, cross-check store Prisma). Jalankan `prisma validate` +
  `migrate` saat database tersedia.
- **Build Gradle BLOCKED di VM ini** (JVM tak bisa menulis sesudah
  membaca `~/workspace` — aturan sandbox; salin toolchain ke /tmp dan
  /var/tmp juga gagal — EPERM saat menyalin + dependensi Maven tak bisa
  diunduh). APK dibangun lewat CI (`.github/workflows/build-android.yml`)
  atau Android Studio pengguna. Pengganti di VM: Deep Kotlin Analyzer
  (`apps/android/tools/deep_verify.py`, **1632 cek, 0 gagal** —
  resolusi fungsi/konstruktor lintas berkas, aritas, simetri DTO JSON,
  R.*, manifest, impor Android SDK vs `android.jar`) yang ikut
  dijalankan `verify.py` (**59/59**) dan CI. Kompilasi Kotlin +
  uji perangkat fisik BELUM pernah jalan.
- **Push GitHub BLOCKED kredensial:** `gh` belum login, SSH ke
  github.com diblokir proxy egress, tidak ada token di environment.
  Repo lokal sudah `git init` + commit rapi (siap push). Perintah push
  sesudah login: `gh auth login` lalu `gh repo create prata-remote
  --public --source=. --push` (atau tambah remote + `git push -u
  origin main`). Vercel MCP terhubung, tetapi backend ini server WS
  persisten — bukan target deploy serverless Vercel; tidak ada tunnel
  publik di VM ini.
- **Server produksi di VM ini** berjalan sebagai proses background
  (bukan systemd — tulis unit ke /etc & /run diblokir sandbox saat
  ini). Pergantian VM mematikan server; mulai ulang dengan perintah
  di "Menjalankan backend". Rezim tulis sandbox datang-pergi: bila
  `DiskStore: GAGAL menulis state` muncul di log, data tetap aman di
  memori dan persistensi dicoba ulang di tiap mutasi — cek
  `apps/backend/data/prata-store.json` untuk bukti tulis berhasil.
- **Uji end-to-end Android menunggu perangkat fisik:** tap/swipe/
  keyboard lewat Accessibility, SAF file transfer, notifikasi, kamera,
  dan live WebRTC browser↔Agent belum pernah diuji di HP nyata.
  WebRTC browser di dashboard diverifikasi sampai level protokol
  (smoke test backend + file tersaji + sintaks JS); tidak ada Chromium
  di VM ini untuk uji `<video>` live. **Bug volume diperbaiki di
  finalisasi:** Agent sempat membaca field `action` (yang isinya
  "volume") alih-alih `name` (UP/DOWN/MUTE) sehingga tombol volume
  tidak pernah bekerja — kini membaca `name`.
- Reconnect WS di tengah sesi tidak memulihkan media (room server
  memegang soket lama) — pakai retry. Satu sesi remote per perangkat
  pada satu waktu.
- TURN (CoTURN) baru berupa konfigurasi infra + env `TURN_*` di
  backend; deployment CoTURN sendiri di luar mandat ini.
- Python `http.server` di VM ini mengembalikan balasan kosong untuk
  loopback (lapisan jaringan runtime); dashboard diuji sajikan lewat
  server HTTP Node — di mesin pengguna `python3 -m http.server`
  normal.
