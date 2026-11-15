// PRATA Remote — Store transfer file dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat TRANSFER_STORE=prisma. Hanya metadata yang disimpan di DB —
// blob byte TIDAK PERNAH masuk database (lihat BlobStore di transfers.ts).
// Hanya dimuat saat dipilih (dynamic import di index.ts).
import { PrismaClient } from "@prisma/client";
import { newTransferId, TRANSFER_TTL_MS } from "./transfers.ts";
import type { TransferCreateInput, TransferRecord, TransferStatus, TransferStore } from "./transfers.ts";

function toRecord(t: {
  id: string;
  deviceId: string;
  ownerId: string;
  direction: string;
  docId: string | null;
  fileName: string;
  mimeType: string | null;
  size: bigint | null;
  sha256Hash: string | null;
  status: string;
  error: string | null;
  createdAt: Date;
  expiresAt: Date;
}): TransferRecord {
  return {
    id: t.id,
    deviceId: t.deviceId,
    ownerId: t.ownerId,
    direction: t.direction as TransferRecord["direction"],
    docId: t.docId,
    fileName: t.fileName,
    mimeType: t.mimeType,
    size: t.size === null ? null : Number(t.size),
    sha256Hash: t.sha256Hash,
    status: t.status as TransferStatus,
    error: t.error,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
  };
}

export class PrismaTransferStore implements TransferStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: TransferCreateInput): Promise<TransferRecord> {
    const now = new Date();
    const t = await this.prisma.fileTransfer.create({
      data: {
        id: newTransferId(),
        deviceId: input.deviceId,
        ownerId: input.ownerId,
        direction: input.direction,
        docId: input.docId ?? null,
        fileName: input.fileName,
        mimeType: input.mimeType ?? null,
        size: input.size ?? null,
        status: input.direction === "download" ? "waiting-upload" : "ready",
        createdAt: now,
        expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS),
      },
    });
    return toRecord(t);
  }

  async get(id: string): Promise<TransferRecord | null> {
    const t = await this.prisma.fileTransfer.findUnique({ where: { id } });
    return t ? toRecord(t) : null;
  }

  async setStatus(id: string, status: TransferStatus, error?: string | null): Promise<TransferRecord | null> {
    const t = await this.prisma.fileTransfer
      .update({ where: { id }, data: { status, ...(error !== undefined ? { error } : {}) } })
      .catch(() => null);
    return t ? toRecord(t) : null;
  }

  async setSha256(id: string, sha256: string): Promise<void> {
    await this.prisma.fileTransfer.update({ where: { id }, data: { sha256Hash: sha256 } }).catch(() => null);
  }

  async setSize(id: string, size: number): Promise<void> {
    await this.prisma.fileTransfer.update({ where: { id }, data: { size } }).catch(() => null);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.fileTransfer.delete({ where: { id } }).catch(() => null);
  }
}
