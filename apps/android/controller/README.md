# Android Controller — PRATA Remote (SCAFFOLD, Phase 1)

Belum dibangun. Dibangun di command berikutnya (Phase 1: Foundation).

Rencana (sesuai Master Prompt):

- **Stack:** Kotlin, Jetpack Compose, MVVM, Coroutines.
  Package: `com.prata.remote.controller`.
- **Modul (terpisah, clean):**
  - `signaling/` — klien WebSocket (login JWT + watch presence +
    session-request + offer/answer/ICE).
  - `webrtc/` — Phase 2: tampilkan VideoTrack layar agen + kirim input
    (koordinat X,Y + keyboard) lewat DataChannel.
  - `pairing/` — buat QR pairing (memanggil Device Registry API).
  - `devices/` — daftar perangkat + status online/offline.
- **Auth:** JWT pengguna (sama seperti web dashboard).
