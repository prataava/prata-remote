// PRATA Remote — Store & logika transfer file (Command 008, Phase 3)
// Dua arah, keduanya lewat HTTP stream terautentikasi (BUKAN WebSocket —
// WS dibatasi payload 1 MB & rate-limit ketat, hanya untuk browsing/metadata).
//
//   Download (Agent -> Controller):
//     POST /api/transfers {deviceId, docId, fileName} (JWT)
//       -> transfer "waiting-upload" + WS file_download_request ke Agent
//     PUT  /api/transfers/:id/blob (Agent Token) -> "ready"
//     GET  /api/transfers/:id/blob (JWT) -> bytes, lalu "done" + blob dihapus.
//   Upload (Controller -> Agent):
//     POST /api/devices/:id/files/upload (JWT, body mentah + X-File-Name)
//       -> transfer "ready" (blob sudah tersimpan) + WS file_upload_ready
//     GET  /api/transfers/:id/blob (Agent Token) -> bytes (blob TETAP ada)
//     WS file_transfer_done {transferId, ok} dari Agent -> "done"/"failed"
//       + blob dihapus.
//
// Blob TIDAK PERNAH masuk database — hanya metadata (tabel file_transfers).
// Byte disimpan di BlobStore sementara (implementasi dev: memori; produksi
// wajib diganti disk/object storage). Blob sekali pakai: dihapus sesudah
// transfer selesai atau kedaluwarsa (TTL 10 menit). Batas ukuran 50 MB.
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./http-utils.ts";

/** SHA-256 hex dari byte blob (dicatat di file_transfers). */
export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
export const TRANSFER_TTL_MS = 10 * 60 * 1000;

export type TransferDirection = "download" | "upload";
export type TransferStatus = "waiting-upload" | "ready" | "done" | "failed" | "expired";

export interface TransferRecord {
  id: string;
  deviceId: string;
  ownerId: string;
  direction: TransferDirection;
  docId: string | null;
  fileName: string;
  mimeType: string | null;
  size: number | null;
  /** SHA-256 hex dari blob (diisi sesudah byte diterima server). */
  sha256Hash: string | null;
  status: TransferStatus;
  error?: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface TransferCreateInput {
  deviceId: string;
  ownerId: string;
  direction: TransferDirection;
  docId?: string | null;
  fileName: string;
  mimeType?: string | null;
  size?: number | null;
}

export interface TransferStore {
  create(input: TransferCreateInput): Promise<TransferRecord>;
  get(id: string): Promise<TransferRecord | null>;
  setStatus(id: string, status: TransferStatus, error?: string | null): Promise<TransferRecord | null>;
  setSha256(id: string, sha256: string): Promise<void>;
  /** Perbarui ukuran blob sesudah streaming selesai (dipakai upload streaming). */
  setSize(id: string, size: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface BlobStore {
  put(id: string, data: Buffer): void;
  get(id: string): Buffer | null;
  delete(id: string): void;
  /** Streaming (opsional, diimplementasikan DiskBlobStore): tulis tanpa menahan RAM. */
  createWriteStream?(id: string): NodeJS.WritableStream;
  /** Streaming (opsional, diimplementasikan DiskBlobStore): baca tanpa menahan RAM. */
  createReadStream?(id: string): NodeJS.ReadableStream | null;
  exists?(id: string): boolean;
  /** Ukuran byte blob yang tersimpan (null bila tidak ada) — dipakai
   * untuk memverifikasi tulis streaming benar-benar mendarat utuh. */
  size?(id: string): number | null;
}

export function newTransferId(): string {
  return `tr_${Date.now().toString(36)}_${randomBytes(9).toString("base64url")}`;
}

/** Nama file aman: tanpa pemisah path / karakter kontrol, maks 200 karakter. */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/<>:"|?*\x00-\x1f]/g, "_").trim().replace(/^\.+/, "");
  return cleaned.slice(0, 200) || "file";
}

export class MemoryTransferStore implements TransferStore {
  private readonly records = new Map<string, TransferRecord>();

  async create(input: TransferCreateInput): Promise<TransferRecord> {
    const now = new Date();
    const rec: TransferRecord = {
      id: newTransferId(),
      deviceId: input.deviceId,
      ownerId: input.ownerId,
      direction: input.direction,
      docId: input.docId ?? null,
      fileName: sanitizeFileName(input.fileName),
      mimeType: input.mimeType ?? null,
      size: input.size ?? null,
      sha256Hash: null,
      status: input.direction === "download" ? "waiting-upload" : "ready",
      createdAt: now,
      expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS),
    };
    this.records.set(rec.id, rec);
    return { ...rec };
  }

  async get(id: string): Promise<TransferRecord | null> {
    const rec = this.records.get(id);
    return rec ? { ...rec } : null;
  }

  async setStatus(id: string, status: TransferStatus, error?: string | null): Promise<TransferRecord | null> {
    const rec = this.records.get(id);
    if (!rec) return null;
    rec.status = status;
    if (error !== undefined) rec.error = error;
    return { ...rec };
  }

  async setSha256(id: string, sha256: string): Promise<void> {
    const rec = this.records.get(id);
    if (rec) rec.sha256Hash = sha256;
  }

  async setSize(id: string, size: number): Promise<void> {
    const rec = this.records.get(id);
    if (rec) rec.size = size;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  put(id: string, data: Buffer): void {
    this.blobs.set(id, data);
  }

  get(id: string): Buffer | null {
    return this.blobs.get(id) ?? null;
  }

  delete(id: string): void {
    this.blobs.delete(id);
  }

  size(id: string): number | null {
    const buf = this.blobs.get(id);
    return buf === undefined ? null : buf.length;
  }
}

function isTerminal(status: TransferStatus): boolean {
  return status === "done" || status === "failed" || status === "expired";
}

/** Tandai kedaluwarsa bila TTL lewat (status terminal + blob dibersihkan). */
export async function expireIfNeeded(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<TransferRecord> {
  if (!isTerminal(rec.status) && Date.now() > rec.expiresAt.getTime()) {
    blobs.delete(rec.id);
    const updated = await store.setStatus(rec.id, "expired");
    return updated ?? { ...rec, status: "expired" as TransferStatus };
  }
  return rec;
}

/** Ambil transfer atau lempar 404. */
export async function requireTransfer(store: TransferStore, id: string): Promise<TransferRecord> {
  const rec = await store.get(id);
  if (!rec) throw new ApiError(404, "transfer-not-found", "Transfer tidak ditemukan.");
  return rec;
}

/** Agen mengunggah blob untuk transfer download. */
export async function completeUpload(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
  data: Buffer,
): Promise<TransferRecord> {
  if (rec.direction !== "download") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan unduhan dari Agent.");
  }
  if (rec.status !== "waiting-upload") {
    throw new ApiError(409, "wrong-status", `Transfer sudah berstatus ${rec.status}.`);
  }
  blobs.put(rec.id, data);
  const updated = await store.setStatus(rec.id, "ready");
  return updated ?? rec;
}

/** Varian streaming dari completeUpload: blob SUDAH ditulis ke disk oleh
 *  pemanggil (via createWriteStream); di sini hanya ubah status -> ready. */
export async function completeUploadStream(
  store: TransferStore,
  rec: TransferRecord,
): Promise<TransferRecord> {
  if (rec.direction !== "download") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan unduhan dari Agent.");
  }
  if (rec.status !== "waiting-upload") {
    throw new ApiError(409, "wrong-status", `Transfer sudah berstatus ${rec.status}.`);
  }
  const updated = await store.setStatus(rec.id, "ready");
  return updated ?? rec;
}

/** Varian streaming dari takeBlobForDownload: kembalikan stream baca;
 *  blob TIDAK dihapus di sini — pemanggil wajib memanggil
 *  finishDownloadStream sesudah stream selesai terkirim. */
export async function takeBlobStreamForDownload(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<{ record: TransferRecord; stream: NodeJS.ReadableStream }> {
  if (rec.direction !== "download") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan unduhan dari Agent.");
  }
  if (rec.status !== "ready") {
    throw new ApiError(409, "wrong-status", `Blob belum siap (status ${rec.status}).`);
  }
  const stream = blobs.createReadStream?.(rec.id);
  if (!stream) throw new ApiError(404, "blob-not-found", "Blob transfer sudah tidak tersedia.");
  // Jangan alirkan blob hantu: bila berkas di disk tidak ada (mis. tulis
  // gagal), jawab 404 bersih — bukan putuskan soket di tengah respons.
  if (typeof blobs.exists === "function" && !blobs.exists(rec.id)) {
    throw new ApiError(404, "blob-not-found", "Berkas blob transfer tidak ditemukan di disk.");
  }
  return { record: rec, stream };
}

/** Varian streaming dari takeBlobForAgent: kembalikan stream baca. */
export async function takeBlobStreamForAgent(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<{ record: TransferRecord; stream: NodeJS.ReadableStream }> {
  if (rec.direction !== "upload") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan kiriman ke Agent.");
  }
  if (rec.status !== "ready") {
    throw new ApiError(409, "wrong-status", `Blob belum siap (status ${rec.status}).`);
  }
  const stream = blobs.createReadStream?.(rec.id);
  if (!stream) throw new ApiError(404, "blob-not-found", "Blob transfer sudah tidak tersedia.");
  // Jangan alirkan blob hantu: bila berkas di disk tidak ada (mis. tulis
  // gagal), jawab 404 bersih — bukan putuskan soket di tengah respons.
  if (typeof blobs.exists === "function" && !blobs.exists(rec.id)) {
    throw new ApiError(404, "blob-not-found", "Berkas blob transfer tidak ditemukan di disk.");
  }
  return { record: rec, stream };
}

/** Penutup unduhan streaming: hapus blob + tandai done. */
export async function finishDownloadStream(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<TransferRecord> {
  blobs.delete(rec.id);
  const updated = await store.setStatus(rec.id, "done");
  return updated ?? rec;
}

/** Controller mengunduh blob: kembalikan bytes, lalu tandai done + hapus blob. */
export async function takeBlobForDownload(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<{ record: TransferRecord; data: Buffer }> {
  if (rec.direction !== "download") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan unduhan dari Agent.");
  }
  if (rec.status !== "ready") {
    throw new ApiError(409, "wrong-status", `Blob belum siap (status ${rec.status}).`);
  }
  const data = blobs.get(rec.id);
  if (!data) throw new ApiError(404, "blob-not-found", "Blob transfer sudah tidak tersedia.");
  blobs.delete(rec.id);
  const updated = await store.setStatus(rec.id, "done");
  return { record: updated ?? rec, data };
}

/** Agent mengunduh blob kiriman controller: blob TETAP ada sampai ack done. */
export async function takeBlobForAgent(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
): Promise<{ record: TransferRecord; data: Buffer }> {
  if (rec.direction !== "upload") {
    throw new ApiError(409, "wrong-direction", "Transfer ini bukan kiriman ke Agent.");
  }
  if (rec.status !== "ready") {
    throw new ApiError(409, "wrong-status", `Blob belum siap (status ${rec.status}).`);
  }
  const data = blobs.get(rec.id);
  if (!data) throw new ApiError(404, "blob-not-found", "Blob transfer sudah tidak tersedia.");
  return { record: rec, data };
}

/** Ack Agent sesudah menyimpan file kiriman: done/failed + blob dihapus. */
export async function finishTransfer(
  store: TransferStore,
  blobs: BlobStore,
  rec: TransferRecord,
  ok: boolean,
  error?: string | null,
): Promise<TransferRecord> {
  if (rec.direction !== "upload") return rec;
  if (isTerminal(rec.status)) return rec;
  blobs.delete(rec.id);
  const updated = await store.setStatus(rec.id, ok ? "done" : "failed", error ?? null);
  return updated ?? rec;
}
