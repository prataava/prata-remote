# Android Agent — PRATA Remote (SCAFFOLD, Phase 1)

Belum dibangun. Dibangun di command berikutnya (Phase 1: Foundation).

Rencana (sesuai Master Prompt — API resmi saja, tanpa bypass):

- **Stack:** Kotlin, Jetpack Compose, MVVM, Coroutines.
  Package: `com.prata.remote.agent`.
- **Modul (terpisah, clean):**
  - `signaling/` — klien WebSocket (hello agen + heartbeat + terima
    session-request/offer/answer/ICE).
  - `webrtc/` — Phase 2: MediaProjection → WebRTC VideoTrack.
  - `input/` — Phase 2: AccessibilityService `dispatchGesture`
    (touch/keyboard dari DataChannel).
  - `files/` — Phase 3: Storage Access Framework (SAF).
  - `service/` — Foreground Service (notifikasi persistent) +
    WorkManager untuk task berkala.
  - `notifications/` — NotificationListenerService.
- **Aturan Android 14+ yang wajib dipatuhi:** persetujuan user tiap sesi
  MediaProjection + deklarasi foreground service type `mediaProjection`.
- **Auth:** token perangkat (dari QR pairing) — TIDAK ADA kata sandi HP
  yang dikirim ke server.
