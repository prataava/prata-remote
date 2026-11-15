// PRATA Remote — Protokol pesan signaling (Command 001, Phase 1)
// Semua pesan adalah JSON dengan satu field "type". Tidak ada kredensial
// yang pernah dikirim di dalam payload offer/answer/ice — autentikasi
// hanya terjadi sekali di pesan "hello" awal koneksi.

export type Role = "agent" | "controller";
export type DeviceStatus = "online" | "offline" | "connecting";
/** "camera" = kamera belakang (alias lama); "camera-front"/"camera-back"
 *  membedakan sisi kamera secara eksplisit (FINAL, Bagian 5). */
export type SessionType = "screen" | "camera" | "camera-front" | "camera-back";

/** Satu entri konfigurasi ICE untuk RTCPeerConnection. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Satu aplikasi terpasang di Agent (FINAL, Bagian 3 — App Manager). */
export interface AppInfo {
  packageName: string;
  label: string;
  versionName: string | null;
  isSystemApp: boolean;
}

/** Satu laporan izin fitur dari Agent (FINAL, Bagian 1). */
export interface PermissionReportItem {
  feature: string;
  granted: boolean;
}

/** Satu notifikasi perangkat yang diteruskan Agent (FINAL, Bagian 4).
 *  Notifikasi dengan visibilitas SECRET tidak pernah dikirim Agent. */
export interface DeviceNotification {
  packageName: string;
  appName: string;
  title: string | null;
  text: string | null;
  at: string;
}

/** Satu item file/folder dari Agent (Command 008). docId = document ID
 *  SAF (DocumentsContract.getDocumentId); root = docId null di request. */
export interface FileItem {
  name: string;
  isDirectory: boolean;
  size: number | null;
  mimeType: string | null;
  lastModified: number | null;
  docId: string;
}

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { type: "hello"; role: "agent"; deviceId: string; token: string }
  | { type: "hello"; role: "controller"; token: string }
  | { type: "heartbeat" }
  | { type: "watch"; deviceId: string }
  | { type: "unwatch"; deviceId: string }
  | { type: "session-request"; deviceId: string; sessionType: SessionType }
  | { type: "session-accept"; sessionId: string }
  | { type: "session-reject"; sessionId: string; reason?: string }
  // WebRTC SDP/ICE (Command 003, Phase 2). Nama kanonik: webrtc_*.
  // Nama lama offer/answer/ice tetap diterima sebagai alias dan
  // dinormalisasi server menjadi webrtc_* saat diteruskan.
  | { type: "webrtc_offer"; sessionId: string; payload: unknown }
  | { type: "webrtc_answer"; sessionId: string; payload: unknown }
  | { type: "webrtc_ice_candidate"; sessionId: string; payload: unknown }
  | { type: "offer"; sessionId: string; payload: unknown }
  | { type: "answer"; sessionId: string; payload: unknown }
  | { type: "ice"; sessionId: string; payload: unknown }
  // Metrik perangkat (Command 007, Phase 3): Agen mengirim berkala,
  // server meneruskan ke controller pemilik (watcher / room sesi).
  | { type: "device_metrics"; metrics: DeviceMetrics }
  // File browsing & transfer (Command 008, Phase 3). file_list_request
  // di-relay controller -> agen; file_list_response di-relay kembali ke
  // controller peminta (dipasangkan lewat requestId). file_transfer_done
  // adalah ack agen sesudah menyimpan file kiriman controller.
  | { type: "file_list_request"; requestId: string; deviceId: string; docId?: string | null }
  | { type: "file_list_response"; requestId: string; items?: FileItem[]; error?: string }
  | { type: "file_transfer_done"; transferId: string; ok: boolean; error?: string }
  // Operasi direktori (FINAL, Bagian 2): mkdir/rename/delete di-relay
  // seperti file_list (dipasangkan lewat requestId, dijawab file_op_response).
  | { type: "file_mkdir_request"; requestId: string; deviceId: string; parentDocId?: string | null; name: string }
  | { type: "file_rename_request"; requestId: string; deviceId: string; docId: string; newName: string }
  | { type: "file_delete_request"; requestId: string; deviceId: string; docId: string }
  | { type: "file_op_response"; requestId: string; ok: boolean; error?: string }
  // App Manager (FINAL, Bagian 3): daftar aplikasi + perintah buka/
  // pengaturan/hapus (uninstall memunculkan dialog resmi OS di Agent).
  | { type: "app_list_request"; requestId: string; deviceId: string }
  | { type: "app_list_response"; requestId: string; apps?: AppInfo[]; error?: string }
  | { type: "app_command"; requestId: string; deviceId: string; command: "open" | "settings" | "uninstall"; packageName: string }
  | { type: "app_command_response"; requestId: string; ok: boolean; error?: string }
  // Notifikasi perangkat (FINAL, Bagian 4): Agent -> server (disimpan +
  // diteruskan ke controller pemilik). SECRET tidak pernah dikirim.
  | { type: "device_notification"; deviceId: string; packageName: string; appName: string; title?: string | null; text?: string | null; at?: string }
  // Laporan izin fitur Agent (FINAL, Bagian 1): screen, accessibility,
  // saf, notification, camera.
  | { type: "permission_report"; permissions: PermissionReportItem[] }
  | { type: "session-end"; sessionId: string; reason?: string }
  | { type: "bye" };

/** Metrik perangkat dari Agent (Command 007). Semua field boleh null —
 *  null = tidak bisa dibaca di perangkat itu (jujur, bukan hardcode). */
export interface DeviceMetrics {
  batteryPct?: number | null;
  charging?: boolean | null;
  storageTotalBytes?: number | null;
  storageFreeBytes?: number | null;
  ramTotalBytes?: number | null;
  ramAvailBytes?: number | null;
}

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------
export type ServerMessage =
  | { type: "welcome"; peerId: string; role: Role; serverTime: string; iceServers: IceServer[] }
  | { type: "presence"; deviceId: string; status: DeviceStatus; lastSeenAt: string | null }
  | { type: "session-request"; sessionId: string; from: string; sessionType: SessionType }
  | { type: "session-accepted"; sessionId: string; deviceId: string }
  | { type: "session-rejected"; sessionId: string; deviceId: string; reason?: string }
  | { type: "session-ended"; sessionId: string; reason?: string }
  | { type: "webrtc_offer"; sessionId: string; from: string; payload: unknown }
  | { type: "webrtc_answer"; sessionId: string; from: string; payload: unknown }
  | { type: "webrtc_ice_candidate"; sessionId: string; from: string; payload: unknown }
  | { type: "offer"; sessionId: string; from: string; payload: unknown }
  | { type: "answer"; sessionId: string; from: string; payload: unknown }
  | { type: "ice"; sessionId: string; from: string; payload: unknown }
  // Metrik perangkat yang diteruskan server ke controller pemilik.
  | { type: "device_metrics"; deviceId: string; metrics: DeviceMetrics; at: string }
  // File browsing & transfer (Command 008). file_list_request &
  // file_download_request & file_upload_ready dikirim server -> agen;
  // file_list_response & file_transfer_done diteruskan server -> controller.
  // FINAL: nama kanonik baru file_upload_requested (alias
  // file_download_request) & file_download_ready (alias file_upload_ready)
  // — server mengirim nama BARU; klien lama tetap menerima nama lama
  // lewat alias di parsernya masing-masing.
  | { type: "file_list_request"; requestId: string; docId?: string | null }
  | { type: "file_list_response"; requestId: string; items?: FileItem[]; error?: string }
  | { type: "file_download_request"; transferId: string; docId: string; fileName: string }
  | { type: "file_upload_requested"; transferId: string; docId: string; fileName: string }
  | { type: "file_upload_ready"; transferId: string; fileName: string; size: number; mimeType: string | null; docId?: string | null }
  | { type: "file_download_ready"; transferId: string; fileName: string; size: number; mimeType: string | null; docId?: string | null }
  | { type: "file_transfer_done"; transferId: string; ok: boolean; error?: string }
  // Operasi direktori (FINAL, Bagian 2): server -> agen.
  | { type: "file_mkdir_request"; requestId: string; parentDocId?: string | null; name: string }
  | { type: "file_rename_request"; requestId: string; docId: string; newName: string }
  | { type: "file_delete_request"; requestId: string; docId: string }
  // Jawaban operasi direktori + app manager (FINAL): server -> controller.
  | { type: "file_op_response"; requestId: string; ok: boolean; error?: string }
  | { type: "app_list_response"; requestId: string; apps?: AppInfo[]; error?: string }
  | { type: "app_command_response"; requestId: string; ok: boolean; error?: string }
  // Permintaan app manager (FINAL): server -> agen.
  | { type: "app_list_request"; requestId: string }
  | { type: "app_command"; requestId: string; command: "open" | "settings" | "uninstall"; packageName: string }
  // Notifikasi perangkat (FINAL, Bagian 4) + alert otomatisasi (Bagian 6).
  | { type: "device_notification"; deviceId: string; packageName: string; appName: string; title: string | null; text: string | null; at: string }
  | { type: "automation_alert"; ruleId: string; ruleName: string; deviceId: string; message: string; at: string }
  | { type: "error"; code: string; message: string };

export type ErrorCode =
  | "auth-required"
  | "auth-failed"
  | "bad-message"
  | "device-offline"
  | "not-owner"
  | "not-in-session"
  | "unknown-session"
  | "rate-limited";
