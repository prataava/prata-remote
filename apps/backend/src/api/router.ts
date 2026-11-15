// PRATA Remote — REST API (Command 002, Tugas 1)
// Router HTTP di atas node:http bawaan (tanpa framework tambahan —
// handler di sini adalah fungsi murni sehingga bisa dipindah ke Express
// nanti tanpa mengubah logika).
//
// Endpoint:
//   POST /api/auth/login               {email, password} -> {token, user}
//   POST /api/devices/pairing/init     (tanpa auth; Agent belum terdaftar)
//   POST /api/devices/pairing/poll     {pairingId, pairingCode} -> status/token
//   POST /api/devices/pairing/confirm  (JWT) {pairingId, pairingCode} -> device
//   GET  /api/devices                 (JWT) daftar perangkat milikmu
//   GET  /api/devices/:id             (JWT) detail satu perangkat
//   PATCH /api/devices/:id            (JWT) ubah nama/grup perangkat
//   DELETE /api/devices/:id           (JWT) hapus perangkat + cabut kunci
//   POST /api/devices/:id/revoke      (JWT) cabut akses perangkat (putus WS)
//   GET  /api/devices/:id/permissions (JWT) status izin fitur Agent
//   GET  /api/devices/:id/keys        (JWT) daftar kunci perangkat (hash saja)
//   POST /api/devices/:id/files/upload (JWT) unggah file ke Agent
//   POST /api/devices/:id/files/request-download (JWT) minta file dari Agent
//   POST /api/transfers               (JWT) minta file dari Agent (alias lama)
//   GET  /api/transfers/:id           (JWT) status transfer
//   PUT  /api/transfers/:id/blob      (Agent Token) unggah byte file
//   GET  /api/transfers/:id/blob      (JWT pemilik / Agent Token) unduh byte
//   GET  /api/rtc/ice-servers         (JWT) konfigurasi ICE untuk WebRTC
//   GET  /api/releases/apks           (JWT) daftar APK rilis di server
//   GET  /api/releases/apks/:file     (JWT) unduh satu APK rilis
//   GET  /api/releases/source-bundle  (JWT) unduh bundel sumber (tar.gz)
//   POST /api/sessions/terminate-all  (JWT) hentikan semua sesi milikmu
//   GET  /api/activity-logs           (JWT) riwayat aktivitas keamanan
//   GET  /api/notifications           (JWT) riwayat notifikasi (filter ?package= &kind=)
//   GET  /api/automation/rules        (JWT) daftar aturan otomatisasi
//   POST /api/automation/rules        (JWT) buat aturan
//   PATCH /api/automation/rules/:id   (JWT) ubah aturan
//   DELETE /api/automation/rules/:id  (JWT) hapus aturan
//
// Catatan keamanan:
// - Login gagal selalu 401 dengan pesan sama (email terdaftar/tidak).
// - Token agen TIDAK PERNAH dikembalikan ke controller — hanya ke agent
//   lewat poll sekali-baca.
// - pairing/init dibatasi 10/menit/IP agar kode tidak bisa di-spam.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { verifyControllerToken, mintControllerToken } from "../signaling/auth.ts";
import { verifyLoginPassword } from "./passwords.ts";
import { ApiError, sendJson, sendError, sendBytes, sendStream, streamRequestToStream, readJsonBody, readRawBody, requireString, optionalString, getBearerToken } from "./http-utils.ts";
import { initPairing, pollPairing, confirmPairing, parseQrPayload } from "./pairing-service.ts";
import {
  MAX_TRANSFER_BYTES,
  completeUpload,
  completeUploadStream,
  expireIfNeeded,
  finishDownloadStream,
  requireTransfer,
  sanitizeFileName,
  sha256Hex,
  takeBlobForAgent,
  takeBlobForDownload,
  takeBlobStreamForAgent,
  takeBlobStreamForDownload,
} from "./transfers.ts";
import type { BlobStore, TransferRecord, TransferStore } from "./transfers.ts";
import { hashToken } from "../signaling/auth.ts";
import type { ActivityLogStore } from "./activity-logs.ts";
import type { AutomationRuleStore } from "./automation.ts";
import { AUTOMATION_CONDITIONS } from "./automation.ts";
import type { DeviceKeyStore } from "./device-keys.ts";
import type { NotificationStore } from "./notifications.ts";
import type { PermissionStore } from "./permissions.ts";
import type { UserStore, UserRecord } from "./users.ts";
import type { PairingStore } from "./pairings.ts";
import type { DeviceStore } from "./devices.ts";
import type { IceServer } from "../signaling/types.ts";
import { buildIceServers } from "../signaling/ice-config.ts";

export interface RestDeps {
  userStore: UserStore;
  pairingStore: PairingStore;
  deviceStore: DeviceStore;
  jwtSecret: string;
  loginTokenTtlSec?: number;
  /** Konfigurasi ICE (default: buildIceServers() dari env). */
  iceServers?: IceServer[];
  /** Status live dari presence tracker signaling (bila tidak ada -> "offline"). */
  getLiveStatus?: (deviceId: string) => "online" | "offline" | "connecting" | null;
  getLiveLastSeen?: (deviceId: string) => Date | null;
  /** Store transfer file (Command 008). Tanpa ini endpoint transfer 503. */
  transferStore?: TransferStore;
  blobStore?: BlobStore;
  /** Verifikasi token agen untuk satu device (dipakai PUT/GET blob). */
  verifyAgentToken?: (deviceId: string, token: string) => Promise<boolean>;
  /** Kirim pesan WS ke agen satu device (false bila agen tidak terhubung). */
  sendToAgent?: (deviceId: string, msg: Record<string, unknown>) => boolean;
  /** Putus paksa soket agen satu device (dipakai revoke perangkat). */
  disconnectDevice?: (deviceId: string, reason?: string) => void;
  /** Hentikan seluruh sesi aktif milik satu controller. */
  terminateAllSessions?: (controllerId: string, reason?: string) => Promise<number>;
  /** Store FINAL (Bagian 1/4/6). Bila tidak ada, endpoint terkait 503. */
  keyStore?: DeviceKeyStore;
  permissionStore?: PermissionStore;
  activityStore?: ActivityLogStore;
  ruleStore?: AutomationRuleStore;
  notificationStore?: NotificationStore;
  /** Folder APK rilis untuk diunduh (FINALISASI Langkah 2/4). */
  releasesDir?: string;
  /** Path arsip bundel sumber (prata-remote-full-release.tar.gz). */
  sourceBundlePath?: string;
}

export type RestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const INIT_RATE_LIMIT = 10;
const INIT_RATE_WINDOW_MS = 60_000;

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

export function createRestRouter(deps: RestDeps): RestHandler {
  const loginTtlSec = deps.loginTokenTtlSec ?? 8 * 3600;
  const iceServers = deps.iceServers ?? buildIceServers();
  const initHits = new Map<string, { count: number; resetAt: number }>();

  async function authenticate(req: IncomingMessage): Promise<UserRecord> {
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "unauthorized", "Token JWT wajib dikirim (Authorization: Bearer <token>).");
    let sub: string;
    try {
      sub = verifyControllerToken(token, deps.jwtSecret).sub;
    } catch {
      throw new ApiError(401, "unauthorized", "Token tidak valid atau kedaluwarsa.");
    }
    const user = await deps.userStore.findById(sub);
    if (!user) throw new ApiError(401, "unauthorized", "Pengguna token ini tidak ditemukan.");
    return user;
  }

  function checkInitRateLimit(req: IncomingMessage): void {
    const ip = clientIp(req);
    const now = Date.now();
    const entry = initHits.get(ip);
    if (!entry || now >= entry.resetAt) {
      initHits.set(ip, { count: 1, resetAt: now + INIT_RATE_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > INIT_RATE_LIMIT) {
      throw new ApiError(429, "rate-limited", "Terlalu banyak permintaan kode pairing. Coba lagi semenit lagi.");
    }
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const email = requireString(body, "email", { maxLen: 254 }).toLowerCase();
    const password = requireString(body, "password", { maxLen: 512 });
    const user = await deps.userStore.findByEmail(email);
    // Pesan sama untuk email tak dikenal & kata sandi salah (anti-enumerasi).
    if (!verifyLoginPassword(password, user?.passwordHash ?? null)) {
      throw new ApiError(401, "invalid-credentials", "Email atau kata sandi salah.");
    }
    // verifyLoginPassword sudah memastikan user tidak null bila true.
    const found = user as UserRecord;
    const token = mintControllerToken({ sub: found.id, role: found.role, expiresInSec: loginTtlSec }, deps.jwtSecret);
    await deps.activityStore?.append({ userId: found.id, action: "login", detail: found.email }).catch(() => null);
    sendJson(res, 200, {
      token,
      expiresInSec: loginTtlSec,
      user: { id: found.id, email: found.email, name: found.name, role: found.role },
    });
  }

  async function handlePairingInit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    checkInitRateLimit(req);
    const body = await readJsonBody(req);
    const result = await initPairing(deps.pairingStore, {
      deviceName: optionalString(body, "deviceName"),
      deviceModel: optionalString(body, "deviceModel"),
      manufacturer: optionalString(body, "manufacturer"),
      androidVersion: optionalString(body, "androidVersion", 50),
      agentVersion: optionalString(body, "agentVersion", 50),
    });
    sendJson(res, 201, {
      pairingId: result.pairing.id,
      pairingCode: result.code,
      qrPayload: result.qrPayload,
      expiresAt: result.pairing.expiresAt.toISOString(),
      expiresInSec: Math.floor((result.pairing.expiresAt.getTime() - Date.now()) / 1000),
    });
  }

  async function handlePairingPoll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const pairingId = requireString(body, "pairingId", { maxLen: 100 });
    const pairingCode = requireString(body, "pairingCode", { maxLen: 20 });
    const result = await pollPairing(deps.pairingStore, { pairingId, pairingCode });
    sendJson(res, 200, {
      status: result.status,
      deviceId: result.deviceId,
      deviceName: result.deviceName,
      // agentToken hanya ada pada poll pertama sesudah confirm.
      agentToken: result.agentToken,
      tokenAlreadyCollected: result.tokenAlreadyCollected,
    });
  }

  async function handlePairingConfirm(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const body = await readJsonBody(req);
    // Terima dua bentuk: field terpisah ATAU qrPayload hasil scan.
    let pairingId: string;
    let pairingCode: string;
    if (typeof body.qrPayload === "string") {
      const parsed = parseQrPayload(body.qrPayload);
      if (!parsed) throw new ApiError(400, "bad-request", "Format QR tidak dikenal (harapkan prata://pair/<id>/<kode>).");
      pairingId = parsed.pairingId;
      pairingCode = parsed.code;
    } else {
      pairingId = requireString(body, "pairingId", { maxLen: 100 });
      pairingCode = requireString(body, "pairingCode", { maxLen: 20 });
    }
    const deviceName = optionalString(body, "deviceName");
    const { device } = await confirmPairing(
      { pairingStore: deps.pairingStore, deviceStore: deps.deviceStore },
      { pairingId, pairingCode, controllerId: user.id, deviceName },
    );
    // Catat kunci utama perangkat di device_keys (hash saja, bukan token).
    if (deps.keyStore) {
      const pairing = await deps.pairingStore.getById(pairingId);
      if (pairing?.issuedToken) {
        await deps.keyStore
          .create({ deviceId: device.id, keyHash: hashToken(pairing.issuedToken), label: "kunci-utama" })
          .catch(() => null);
      }
    }
    await deps.activityStore
      ?.append({ userId: user.id, deviceId: device.id, action: "pairing", detail: `Perangkat ${device.name} dipasangkan.` })
      .catch(() => null);
    // SENGAJA: agentToken TIDAK dikembalikan ke controller.
    sendJson(res, 201, {
      deviceId: device.id,
      deviceName: device.name,
      status: "paired",
      message: "Perangkat terdaftar. Agent akan menerima tokennya lewat polling.",
    });
  }

  function deviceView(device: { id: string; name: string; group: string | null; model: string | null; manufacturer: string | null; androidVersion: string | null; agentVersion: string | null; lastSeenAt: Date | null; createdAt: Date }): Record<string, unknown> {
    const liveStatus = deps.getLiveStatus?.(device.id) ?? null;
    const liveSeen = deps.getLiveLastSeen?.(device.id) ?? null;
    return {
      id: device.id,
      name: device.name,
      group: device.group,
      model: device.model,
      manufacturer: device.manufacturer,
      androidVersion: device.androidVersion,
      agentVersion: device.agentVersion,
      status: liveStatus ?? "offline",
      lastSeenAt: (liveSeen ?? device.lastSeenAt)?.toISOString() ?? null,
      createdAt: device.createdAt.toISOString(),
    };
  }

  async function handleListDevices(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const devices = await deps.deviceStore.listByOwner(user.id);
    sendJson(res, 200, { devices: devices.map(deviceView) });
  }

  async function handleGetDevice(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const device = await deps.deviceStore.getById(id);
    if (!device) throw new ApiError(404, "device-not-found", "Perangkat tidak ditemukan.");
    if (device.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Perangkat ini bukan milikmu.");
    }
    sendJson(res, 200, { device: deviceView(device) });
  }

  async function handleIceServers(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await authenticate(req);
    // STUN publik + TURN (bila env TURN_* diisi). Kredensial TURN hanya
    // diberikan ke controller yang sudah login — tidak pernah publik.
    sendJson(res, 200, { iceServers });
  }

  // --- Transfer file (Command 008) ---

  function requireTransferStores(): { transferStore: TransferStore; blobStore: BlobStore } {
    if (!deps.transferStore || !deps.blobStore) {
      throw new ApiError(503, "transfer-unavailable", "Layanan transfer file belum dikonfigurasi di server ini.");
    }
    return { transferStore: deps.transferStore, blobStore: deps.blobStore };
  }

  function transferView(rec: TransferRecord): Record<string, unknown> {
    return {
      transferId: rec.id,
      deviceId: rec.deviceId,
      direction: rec.direction,
      docId: rec.docId,
      fileName: rec.fileName,
      mimeType: rec.mimeType,
      size: rec.size,
      sha256Hash: rec.sha256Hash,
      status: rec.status,
      error: rec.error ?? null,
      createdAt: rec.createdAt.toISOString(),
      expiresAt: rec.expiresAt.toISOString(),
    };
  }

  async function handleCreateTransfer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const { transferStore } = requireTransferStores();
    const body = await readJsonBody(req);
    const deviceId = requireString(body, "deviceId", { maxLen: 100 });
    const docId = requireString(body, "docId", { maxLen: 2000 });
    const fileName = requireString(body, "fileName", { maxLen: 200 });
    const size = typeof body.size === "number" && Number.isFinite(body.size) ? Math.floor(body.size) : null;
    const mimeType = optionalString(body, "mimeType");
    const device = await deps.deviceStore.getById(deviceId);
    if (!device) throw new ApiError(404, "device-not-found", "Perangkat tidak ditemukan.");
    if (device.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Perangkat ini bukan milikmu.");
    }
    if ((deps.getLiveStatus?.(deviceId) ?? "offline") !== "online") {
      throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
    }
    const rec = await transferStore.create({
      deviceId,
      ownerId: user.id,
      direction: "download",
      docId,
      fileName,
      mimeType,
      size,
    });
    const notified = deps.sendToAgent?.(deviceId, {
      type: "file_upload_requested",
      transferId: rec.id,
      docId,
      fileName: rec.fileName,
    }) ?? false;
    if (!notified) {
      await transferStore.setStatus(rec.id, "failed", "Agent tidak terhubung saat transfer dibuat.");
      throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
    }
    await deps.activityStore
      ?.append({ userId: user.id, deviceId, action: "file-transfer", detail: `Minta unduh ${rec.fileName} (${rec.id}).` })
      .catch(() => null);
    sendJson(res, 201, { transferId: rec.id, fileName: rec.fileName, status: "waiting-upload" });
  }

  async function handleGetTransfer(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const { transferStore, blobStore } = requireTransferStores();
    const rec = await expireIfNeeded(
      transferStore,
      blobStore,
      await requireTransfer(transferStore, id),
    );
    if (rec.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Transfer ini bukan milikmu.");
    }
    sendJson(res, 200, { transfer: transferView(rec) });
  }

  async function handlePutBlob(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const { transferStore, blobStore } = requireTransferStores();
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "unauthorized", "Token agen wajib dikirim (Authorization: Bearer <token>).");
    const rec = await expireIfNeeded(transferStore, blobStore, await requireTransfer(transferStore, id));
    const ok = deps.verifyAgentToken ? await deps.verifyAgentToken(rec.deviceId, token) : false;
    if (!ok) throw new ApiError(401, "unauthorized", "Token agen tidak valid untuk perangkat ini.");
    if (rec.status === "expired") throw new ApiError(410, "transfer-expired", "Transfer sudah kedaluwarsa.");
    // Streaming bila blob store mendukung (DiskBlobStore): byte mengalir
    // request -> disk tanpa menahan RAM. Fallback: baca penuh (MemoryBlobStore).
    if (typeof blobStore.createWriteStream === "function") {
      const ws = blobStore.createWriteStream(rec.id);
      let result: { size: number; sha256Hex: string };
      try {
        result = await streamRequestToStream(req, ws, MAX_TRANSFER_BYTES);
      } catch (err) {
        await blobStore.delete(rec.id);
        throw err;
      }
      // Verifikasi tulis mendarat utuh: tulis streaming yang gagal
      // diam-diam (0 byte di disk tanpa error) tidak boleh jadi 200.
      if (typeof blobStore.size === "function" && (await blobStore.size(rec.id)) !== result.size) {
        await blobStore.delete(rec.id);
        throw new ApiError(500, "blob-write-failed", `Byte blob tidak mendarat utuh di disk (harap ${result.size} byte).`);
      }
      const updated = await completeUploadStream(transferStore, rec);
      await transferStore.setSha256(rec.id, result.sha256Hex);
      await transferStore.setSize(rec.id, result.size);
      sendJson(res, 200, { transferId: updated.id, status: updated.status, size: result.size });
      return;
    }
    const data = await readRawBody(req, MAX_TRANSFER_BYTES);
    const updated = await completeUpload(transferStore, blobStore, rec, data);
    await transferStore.setSha256(rec.id, sha256Hex(data));
    sendJson(res, 200, { transferId: updated.id, status: updated.status, size: data.length });
  }

  async function handleGetBlob(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const { transferStore, blobStore } = requireTransferStores();
    const token = getBearerToken(req);
    if (!token) throw new ApiError(401, "unauthorized", "Token wajib dikirim (Authorization: Bearer <token>).");
    const rec = await expireIfNeeded(transferStore, blobStore, await requireTransfer(transferStore, id));
    if (rec.status === "expired") throw new ApiError(410, "transfer-expired", "Transfer sudah kedaluwarsa.");
    // Dua jalur auth: JWT controller (pemilik) ATAU token agen (perangkat itu).
    let asController = false;
    let asAgent = false;
    try {
      const claims = verifyControllerToken(token, deps.jwtSecret);
      const user = await deps.userStore.findById(claims.sub);
      asController = !!user && (rec.ownerId === user.id || user.role === "admin");
    } catch {
      asController = false;
    }
    if (!asController && deps.verifyAgentToken) {
      asAgent = await deps.verifyAgentToken(rec.deviceId, token);
    }
    if (!asController && !asAgent) {
      throw new ApiError(401, "unauthorized", "Token tidak valid untuk transfer ini.");
    }
    if (asController && rec.direction !== "download") {
      throw new ApiError(403, "wrong-direction", "Controller hanya boleh mengunduh blob arah download.");
    }
    if (asAgent && rec.direction !== "upload") {
      throw new ApiError(403, "wrong-direction", "Agent hanya boleh mengunduh blob arah upload.");
    }
    // Streaming bila blob store mendukung (DiskBlobStore): byte mengalir
    // disk -> respons tanpa menahan RAM. Fallback: baca penuh (MemoryBlobStore).
    if (typeof blobStore.createReadStream === "function") {
      const { stream } = asController
        ? await takeBlobStreamForDownload(transferStore, blobStore, rec)
        : await takeBlobStreamForAgent(transferStore, blobStore, rec);
      const size = typeof rec.size === "number" ? rec.size : null;
      if (asController) {
        res.on("finish", () => {
          void finishDownloadStream(transferStore, blobStore, rec).catch(() => null);
          void deps.activityStore
            ?.append({ userId: rec.ownerId, deviceId: rec.deviceId, action: "file-transfer", detail: `Unduh selesai ${rec.fileName} (${rec.id}).` })
            .catch(() => null);
        });
      }
      stream.on("error", () => {
        // Bila header belum terkirim, jawab 500 bersih; hanya putuskan
        // soket bila respons sudah mengalir (tidak ada jalan kembali).
        if (!res.headersSent && !res.writableEnded) {
          try { sendError(res, new ApiError(500, "blob-read-failed", "Blob transfer gagal dibaca dari disk.")); } catch { res.destroy(); }
        } else if (!res.writableEnded) {
          res.destroy();
        }
      });
      sendStream(res, stream, size, rec.mimeType ?? "application/octet-stream", rec.fileName);
      return;
    }
    const { data } = asController
      ? await takeBlobForDownload(transferStore, blobStore, rec)
      : await takeBlobForAgent(transferStore, blobStore, rec);
    if (asController) {
      await deps.activityStore
        ?.append({ userId: rec.ownerId, deviceId: rec.deviceId, action: "file-transfer", detail: `Unduh selesai ${rec.fileName} (${rec.id}).` })
        .catch(() => null);
    }
    sendBytes(res, data, rec.mimeType ?? "application/octet-stream", rec.fileName);
  }

  async function handleUploadFile(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const user = await authenticate(req);
    const { transferStore, blobStore } = requireTransferStores();
    const rawName = req.headers["x-file-name"];
    if (typeof rawName !== "string" || rawName.trim().length === 0) {
      throw new ApiError(400, "bad-request", "Header X-File-Name wajib diisi.");
    }
    const fileName = sanitizeFileName(rawName);
    const mimeType = typeof req.headers["x-file-mime"] === "string" ? req.headers["x-file-mime"] : null;
    const docId = typeof req.headers["x-folder-docid"] === "string" ? req.headers["x-folder-docid"] : null;
    const device = await deps.deviceStore.getById(deviceId);
    if (!device) throw new ApiError(404, "device-not-found", "Perangkat tidak ditemukan.");
    if (device.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Perangkat ini bukan milikmu.");
    }
    // Streaming bila blob store mendukung (DiskBlobStore): buat rekaman
    // dulu (id dipakai sebagai nama file blob), lalu alirkan body ke disk.
    if (typeof blobStore.createWriteStream === "function") {
      const rec = await transferStore.create({
        deviceId,
        ownerId: user.id,
        direction: "upload",
        docId,
        fileName,
        mimeType,
        size: null,
      });
      const ws = blobStore.createWriteStream(rec.id);
      let result: { size: number; sha256Hex: string };
      try {
        result = await streamRequestToStream(req, ws, MAX_TRANSFER_BYTES);
      } catch (err) {
        await blobStore.delete(rec.id);
        await transferStore.setStatus(rec.id, "failed", "Unggahan gagal di tengah jalan.");
        throw err;
      }
      // Verifikasi tulis mendarat utuh: tulis streaming yang gagal
      // diam-diam (0 byte di disk tanpa error) tidak boleh jadi 201.
      if (typeof blobStore.size === "function" && (await blobStore.size(rec.id)) !== result.size) {
        await blobStore.delete(rec.id);
        await transferStore.setStatus(rec.id, "failed", "Byte blob tidak mendarat utuh di disk.");
        throw new ApiError(500, "blob-write-failed", `Byte blob tidak mendarat utuh di disk (harap ${result.size} byte).`);
      }
      await transferStore.setSha256(rec.id, result.sha256Hex);
      await transferStore.setSize(rec.id, result.size);
      const notified = deps.sendToAgent?.(deviceId, {
        type: "file_download_ready",
        transferId: rec.id,
        fileName: rec.fileName,
        size: result.size,
        mimeType: rec.mimeType,
        docId,
      }) ?? false;
      if (!notified) {
        await transferStore.setStatus(rec.id, "failed", "Agent tidak terhubung saat file diunggah.");
        await blobStore.delete(rec.id);
        throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
      }
      await deps.activityStore
        ?.append({ userId: user.id, deviceId, action: "file-transfer", detail: `Unggah ${rec.fileName} (${result.size} byte) ke Agent.` })
        .catch(() => null);
      sendJson(res, 201, { transferId: rec.id, fileName: rec.fileName, size: result.size, status: "ready" });
      return;
    }
    const data = await readRawBody(req, MAX_TRANSFER_BYTES);
    const rec = await transferStore.create({
      deviceId,
      ownerId: user.id,
      direction: "upload",
      docId,
      fileName,
      mimeType,
      size: data.length,
    });
    await blobStore.put(rec.id, data);
    await transferStore.setSha256(rec.id, sha256Hex(data));
    const notified = deps.sendToAgent?.(deviceId, {
      type: "file_download_ready",
      transferId: rec.id,
      fileName: rec.fileName,
      size: data.length,
      mimeType: rec.mimeType,
      docId,
    }) ?? false;
    if (!notified) {
      await transferStore.setStatus(rec.id, "failed", "Agent tidak terhubung saat file diunggah.");
      await blobStore.delete(rec.id);
      throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
    }
    await deps.activityStore
      ?.append({ userId: user.id, deviceId, action: "file-transfer", detail: `Unggah ${rec.fileName} (${data.length} byte) ke Agent.` })
      .catch(() => null);
    sendJson(res, 201, { transferId: rec.id, fileName: rec.fileName, size: data.length, status: "ready" });
  }

  // --- Manajemen perangkat & keamanan (FINAL, Bagian 6) ---

  async function requireOwnedDevice(user: { id: string; role: string }, deviceId: string) {
    const device = await deps.deviceStore.getById(deviceId);
    if (!device) throw new ApiError(404, "device-not-found", "Perangkat tidak ditemukan.");
    if (device.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Perangkat ini bukan milikmu.");
    }
    return device;
  }

  async function handleUpdateDevice(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const device = await requireOwnedDevice(user, id);
    const body = await readJsonBody(req);
    const name = optionalString(body, "name", 100);
    const group = body.group === null ? null : optionalString(body, "group", 50);
    if (name === undefined && group === undefined) {
      throw new ApiError(400, "bad-request", "Tidak ada field yang diubah (name/group).");
    }
    const updated = await deps.deviceStore.update(id, {
      ...(name !== undefined ? { name } : {}),
      ...(group !== undefined ? { group } : {}),
    });
    await deps.activityStore
      ?.append({ userId: user.id, deviceId: id, action: "device-rename", detail: `Perangkat "${device.name}" diubah.` })
      .catch(() => null);
    sendJson(res, 200, { device: updated ? deviceView(updated) : null });
  }

  async function handleDeleteDevice(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const device = await requireOwnedDevice(user, id);
    deps.disconnectDevice?.(id, "device-deleted");
    await deps.keyStore?.revokeAllForDevice(id).catch(() => null);
    await deps.deviceStore.delete(id);
    await deps.activityStore
      ?.append({ userId: user.id, deviceId: id, action: "device-delete", detail: `Perangkat "${device.name}" dihapus.` })
      .catch(() => null);
    sendJson(res, 200, { deleted: true, deviceId: id });
  }

  async function handleRevokeDevice(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const device = await requireOwnedDevice(user, id);
    await deps.deviceStore.update(id, { agentTokenHash: null });
    const revokedKeys = await deps.keyStore?.revokeAllForDevice(id).catch(() => 0);
    deps.disconnectDevice?.(id, "device-revoked");
    await deps.activityStore
      ?.append({ userId: user.id, deviceId: id, action: "device-revoke", detail: `Akses perangkat "${device.name}" dicabut (${revokedKeys ?? 0} kunci).` })
      .catch(() => null);
    sendJson(res, 200, { revoked: true, deviceId: id, revokedKeys: revokedKeys ?? 0 });
  }

  async function handleTerminateAll(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const count = (await deps.terminateAllSessions?.(user.id, "terminated-by-user")) ?? 0;
    await deps.activityStore
      ?.append({ userId: user.id, action: "terminate-all", detail: `${count} sesi dihentikan sekaligus.` })
      .catch(() => null);
    sendJson(res, 200, { terminated: count });
  }

  async function handleActivityLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    if (!deps.activityStore) throw new ApiError(503, "activity-unavailable", "Layanan activity log belum dikonfigurasi.");
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const deviceId = url.searchParams.get("deviceId");
    const logs = deviceId
      ? await deps.activityStore.listByDevice(deviceId, limit)
      : await deps.activityStore.listByOwner(user.id, limit);
    sendJson(res, 200, {
      logs: logs.map((l) => ({
        id: l.id,
        userId: l.userId,
        deviceId: l.deviceId,
        action: l.action,
        detail: l.detail,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  }

  async function handleNotifications(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    if (!deps.notificationStore) throw new ApiError(503, "notifications-unavailable", "Layanan notifikasi belum dikonfigurasi.");
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const packageName = url.searchParams.get("package") ?? undefined;
    const kind = url.searchParams.get("kind");
    const rows = await deps.notificationStore.listByOwner(user.id, {
      packageName,
      kind: kind === "device" || kind === "automation" ? kind : undefined,
      limit,
    });
    sendJson(res, 200, {
      notifications: rows.map((n) => ({
        id: n.id,
        deviceId: n.deviceId,
        kind: n.kind,
        packageName: n.packageName,
        appName: n.appName,
        title: n.title,
        text: n.text,
        createdAt: n.createdAt.toISOString(),
      })),
    });
  }

  async function handleListPermissions(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const user = await authenticate(req);
    await requireOwnedDevice(user, deviceId);
    if (!deps.permissionStore) throw new ApiError(503, "permissions-unavailable", "Layanan permission belum dikonfigurasi.");
    const rows = await deps.permissionStore.listByDevice(deviceId);
    sendJson(res, 200, {
      deviceId,
      permissions: rows.map((p) => ({ feature: p.feature, granted: p.granted, updatedAt: p.updatedAt.toISOString() })),
    });
  }

  async function handleListKeys(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const user = await authenticate(req);
    await requireOwnedDevice(user, deviceId);
    if (!deps.keyStore) throw new ApiError(503, "keys-unavailable", "Layanan device keys belum dikonfigurasi.");
    const rows = await deps.keyStore.listByDevice(deviceId);
    sendJson(res, 200, {
      deviceId,
      keys: rows.map((k) => ({
        id: k.id,
        label: k.label,
        keyHashPrefix: k.keyHash.slice(0, 12),
        revoked: k.revoked,
        revokedAt: k.revokedAt?.toISOString() ?? null,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdAt: k.createdAt.toISOString(),
      })),
    });
  }

  // --- Automation Center (FINAL, Bagian 6) ---

  function ruleView(r: { id: string; ownerId: string; deviceId: string | null; name: string; conditionType: string; threshold: number | null; enabled: boolean; createdAt: Date; updatedAt: Date }): Record<string, unknown> {
    return {
      id: r.id,
      deviceId: r.deviceId,
      name: r.name,
      conditionType: r.conditionType,
      threshold: r.threshold,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async function requireRuleStore() {
    if (!deps.ruleStore) throw new ApiError(503, "automation-unavailable", "Layanan otomatisasi belum dikonfigurasi.");
    return deps.ruleStore;
  }

  async function handleListRules(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const store = await requireRuleStore();
    const rows = await store.listByOwner(user.id);
    sendJson(res, 200, { rules: rows.map(ruleView) });
  }

  async function handleCreateRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = await authenticate(req);
    const store = await requireRuleStore();
    const body = await readJsonBody(req);
    const name = requireString(body, "name", { maxLen: 100 });
    const conditionType = requireString(body, "conditionType", { maxLen: 50 });
    if (!(AUTOMATION_CONDITIONS as readonly string[]).includes(conditionType)) {
      throw new ApiError(400, "bad-request", `conditionType tidak dikenal: ${conditionType}`);
    }
    const threshold = typeof body.threshold === "number" ? Math.floor(body.threshold) : null;
    if (threshold !== null && (threshold < 0 || threshold > 100)) {
      throw new ApiError(400, "bad-request", "threshold harus 0..100.");
    }
    const deviceId = optionalString(body, "deviceId", 100);
    if (deviceId) await requireOwnedDevice(user, deviceId);
    const rec = await store.create({
      ownerId: user.id,
      deviceId: deviceId ?? null,
      name,
      conditionType: conditionType as (typeof AUTOMATION_CONDITIONS)[number],
      threshold,
    });
    sendJson(res, 201, { rule: ruleView(rec) });
  }

  async function handleUpdateRule(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const store = await requireRuleStore();
    const existing = await store.get(id);
    if (!existing) throw new ApiError(404, "rule-not-found", "Aturan tidak ditemukan.");
    if (existing.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Aturan ini bukan milikmu.");
    }
    const body = await readJsonBody(req);
    const patch: {
      name?: string;
      deviceId?: string | null;
      conditionType?: (typeof AUTOMATION_CONDITIONS)[number];
      threshold?: number | null;
      enabled?: boolean;
    } = {};
    if (body.name !== undefined) patch.name = requireString(body, "name", { maxLen: 100 });
    if (body.deviceId !== undefined) {
      patch.deviceId = body.deviceId === null ? null : optionalString(body, "deviceId", 100) ?? null;
      if (patch.deviceId) await requireOwnedDevice(user, patch.deviceId);
    }
    if (body.conditionType !== undefined) {
      const ct = requireString(body, "conditionType", { maxLen: 50 });
      if (!(AUTOMATION_CONDITIONS as readonly string[]).includes(ct)) {
        throw new ApiError(400, "bad-request", `conditionType tidak dikenal: ${ct}`);
      }
      patch.conditionType = ct as (typeof AUTOMATION_CONDITIONS)[number];
    }
    if (body.threshold !== undefined) {
      patch.threshold = body.threshold === null ? null : Math.floor(Number(body.threshold));
      if (patch.threshold !== null && (patch.threshold < 0 || patch.threshold > 100)) {
        throw new ApiError(400, "bad-request", "threshold harus 0..100.");
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") throw new ApiError(400, "bad-request", "enabled harus boolean.");
      patch.enabled = body.enabled;
    }
    const updated = await store.update(id, patch);
    sendJson(res, 200, { rule: updated ? ruleView(updated) : null });
  }

  async function handleDeleteRule(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = await authenticate(req);
    const store = await requireRuleStore();
    const existing = await store.get(id);
    if (!existing) throw new ApiError(404, "rule-not-found", "Aturan tidak ditemukan.");
    if (existing.ownerId !== user.id && user.role !== "admin") {
      throw new ApiError(403, "not-owner", "Aturan ini bukan milikmu.");
    }
    await store.delete(id);
    sendJson(res, 200, { deleted: true, ruleId: id });
  }

  // Alias FINAL (Bagian 2): POST /api/devices/:id/files/request-download
  // sama dengan POST /api/transfers (deviceId dari path).
  async function handleRequestDownload(req: IncomingMessage, res: ServerResponse, deviceId: string): Promise<void> {
    const user = await authenticate(req);
    const { transferStore } = requireTransferStores();
    const body = await readJsonBody(req);
    const docId = requireString(body, "docId", { maxLen: 2000 });
    const fileName = requireString(body, "fileName", { maxLen: 200 });
    const size = typeof body.size === "number" && Number.isFinite(body.size) ? Math.floor(body.size) : null;
    const mimeType = optionalString(body, "mimeType");
    await requireOwnedDevice(user, deviceId);
    if ((deps.getLiveStatus?.(deviceId) ?? "offline") !== "online") {
      throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
    }
    const rec = await transferStore.create({
      deviceId,
      ownerId: user.id,
      direction: "download",
      docId,
      fileName,
      mimeType,
      size,
    });
    const notified = deps.sendToAgent?.(deviceId, {
      type: "file_upload_requested",
      transferId: rec.id,
      docId,
      fileName: rec.fileName,
    }) ?? false;
    if (!notified) {
      await transferStore.setStatus(rec.id, "failed", "Agent tidak terhubung saat transfer dibuat.");
      throw new ApiError(409, "device-offline", `Perangkat offline: ${deviceId}`);
    }
    await deps.activityStore
      ?.append({ userId: user.id, deviceId, action: "file-transfer", detail: `Minta unduh ${rec.fileName} (${rec.id}).` })
      .catch(() => null);
    sendJson(res, 201, { transferId: rec.id, fileName: rec.fileName, status: "waiting-upload" });
  }

  // --- Rilis & APK (FINALISASI Langkah 2/4) ---

  function listReleaseFiles(): { name: string; size: number; modifiedAt: string; downloadUrl: string }[] {
    const dir = deps.releasesDir;
    if (!dir || !existsSync(dir)) return [];
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => /\.(apk|aab)$/i.test(f));
    } catch {
      return [];
    }
    return names
      .map((name) => {
        try {
          const st = statSync(join(dir, name));
          return { name, size: st.size, modifiedAt: st.mtime.toISOString(), downloadUrl: `/api/releases/apks/${encodeURIComponent(name)}` };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; size: number; modifiedAt: string; downloadUrl: string } => x !== null)
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async function handleListApks(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await authenticate(req);
    const apks = listReleaseFiles();
    const bundle = deps.sourceBundlePath && existsSync(deps.sourceBundlePath)
      ? (() => {
          const st = statSync(deps.sourceBundlePath as string);
          return { name: basename(deps.sourceBundlePath as string), size: st.size, modifiedAt: st.mtime.toISOString(), downloadUrl: "/api/releases/source-bundle" };
        })()
      : null;
    sendJson(res, 200, { apks, sourceBundle: bundle });
  }

  async function handleDownloadApk(req: IncomingMessage, res: ServerResponse, file: string): Promise<void> {
    await authenticate(req);
    const dir = deps.releasesDir;
    const safe = basename(file);
    if (!dir || !/\.(apk|aab)$/i.test(safe) || safe !== file) {
      throw new ApiError(404, "apk-not-found", "APK tidak ditemukan.");
    }
    const full = join(dir, safe);
    if (!existsSync(full)) throw new ApiError(404, "apk-not-found", "APK tidak ditemukan di server.");
    const size = statSync(full).size;
    sendStream(res, createReadStream(full), size, "application/vnd.android.package-archive", safe);
  }

  async function handleDownloadSourceBundle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await authenticate(req);
    const bundle = deps.sourceBundlePath;
    if (!bundle || !existsSync(bundle)) {
      throw new ApiError(404, "bundle-not-found", "Bundel sumber belum dibuat di server ini. Jalankan scripts/release-bundle.sh di repo.");
    }
    const size = statSync(bundle).size;
    sendStream(res, createReadStream(bundle), size, "application/gzip", basename(bundle));
  }

  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "POST" && path === "/api/auth/login") {
        await handleLogin(req, res);
        return true;
      }
      if (method === "POST" && path === "/api/devices/pairing/init") {
        await handlePairingInit(req, res);
        return true;
      }
      if (method === "POST" && path === "/api/devices/pairing/poll") {
        await handlePairingPoll(req, res);
        return true;
      }
      if (method === "POST" && path === "/api/devices/pairing/confirm") {
        await handlePairingConfirm(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/devices") {
        await handleListDevices(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/rtc/ice-servers") {
        await handleIceServers(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/releases/apks") {
        await handleListApks(req, res);
        return true;
      }
      const apkDetail = /^\/api\/releases\/apks\/([^/]+)$/.exec(path);
      if (method === "GET" && apkDetail) {
        await handleDownloadApk(req, res, decodeURIComponent(apkDetail[1]));
        return true;
      }
      if (method === "GET" && path === "/api/releases/source-bundle") {
        await handleDownloadSourceBundle(req, res);
        return true;
      }
      if (method === "POST" && path === "/api/transfers") {
        await handleCreateTransfer(req, res);
        return true;
      }
      const transferDetail = /^\/api\/transfers\/([A-Za-z0-9_-]+)$/.exec(path);
      if (method === "GET" && transferDetail) {
        await handleGetTransfer(req, res, transferDetail[1]);
        return true;
      }
      const blobDetail = /^\/api\/transfers\/([A-Za-z0-9_-]+)\/blob$/.exec(path);
      if (method === "PUT" && blobDetail) {
        await handlePutBlob(req, res, blobDetail[1]);
        return true;
      }
      if (method === "GET" && blobDetail) {
        await handleGetBlob(req, res, blobDetail[1]);
        return true;
      }
      const uploadDetail = /^\/api\/devices\/([A-Za-z0-9_-]+)\/files\/upload$/.exec(path);
      if (method === "POST" && uploadDetail) {
        await handleUploadFile(req, res, uploadDetail[1]);
        return true;
      }
      const requestDownloadDetail = /^\/api\/devices\/([A-Za-z0-9_-]+)\/files\/request-download$/.exec(path);
      if (method === "POST" && requestDownloadDetail) {
        await handleRequestDownload(req, res, requestDownloadDetail[1]);
        return true;
      }
      if (method === "POST" && path === "/api/sessions/terminate-all") {
        await handleTerminateAll(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/activity-logs") {
        await handleActivityLogs(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/notifications") {
        await handleNotifications(req, res);
        return true;
      }
      if (method === "GET" && path === "/api/automation/rules") {
        await handleListRules(req, res);
        return true;
      }
      if (method === "POST" && path === "/api/automation/rules") {
        await handleCreateRule(req, res);
        return true;
      }
      const ruleDetail = /^\/api\/automation\/rules\/([A-Za-z0-9_-]+)$/.exec(path);
      if (method === "PATCH" && ruleDetail) {
        await handleUpdateRule(req, res, ruleDetail[1]);
        return true;
      }
      if (method === "DELETE" && ruleDetail) {
        await handleDeleteRule(req, res, ruleDetail[1]);
        return true;
      }
      const revokeDetail = /^\/api\/devices\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
      if (method === "POST" && revokeDetail) {
        await handleRevokeDevice(req, res, revokeDetail[1]);
        return true;
      }
      const permDetail = /^\/api\/devices\/([A-Za-z0-9_-]+)\/permissions$/.exec(path);
      if (method === "GET" && permDetail) {
        await handleListPermissions(req, res, permDetail[1]);
        return true;
      }
      const keysDetail = /^\/api\/devices\/([A-Za-z0-9_-]+)\/keys$/.exec(path);
      if (method === "GET" && keysDetail) {
        await handleListKeys(req, res, keysDetail[1]);
        return true;
      }
      const detail = /^\/api\/devices\/([A-Za-z0-9_-]+)$/.exec(path);
      if (method === "GET" && detail) {
        await handleGetDevice(req, res, detail[1]);
        return true;
      }
      if (method === "PATCH" && detail) {
        await handleUpdateDevice(req, res, detail[1]);
        return true;
      }
      if (method === "DELETE" && detail) {
        await handleDeleteDevice(req, res, detail[1]);
        return true;
      }
      return false;
    } catch (err) {
      if (!res.writableEnded) sendError(res, err);
      return true;
    }
  };
}
