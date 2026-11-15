// PRATA Remote — Store pairing dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat PAIRING_STORE=prisma. Butuh DATABASE_URL + prisma generate +
// migrate dev. Hanya dimuat saat dipilih (dynamic import di index.ts).
import { PrismaClient } from "@prisma/client";
import type { PairingCreateInput, PairingRecord, PairingStatus, PairingStore } from "./pairings.ts";

function toRecord(p: {
  id: string;
  deviceId: string | null;
  codeHash: string;
  attempts: number;
  status: string;
  deviceName: string | null;
  deviceModel: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  issuedToken: string | null;
  createdById: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}): PairingRecord {
  return {
    id: p.id,
    deviceId: p.deviceId,
    codeHash: p.codeHash,
    attempts: p.attempts,
    status: p.status.toLowerCase() as PairingStatus,
    deviceName: p.deviceName,
    deviceModel: p.deviceModel,
    manufacturer: p.manufacturer,
    androidVersion: p.androidVersion,
    agentVersion: p.agentVersion,
    issuedToken: p.issuedToken,
    createdById: p.createdById,
    expiresAt: p.expiresAt,
    consumedAt: p.consumedAt,
    createdAt: p.createdAt,
  };
}

export class PrismaPairingStore implements PairingStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: PairingCreateInput): Promise<PairingRecord> {
    const p = await this.prisma.pairing.create({
      data: {
        codeHash: input.codeHash,
        deviceName: input.deviceName ?? null,
        deviceModel: input.deviceModel ?? null,
        manufacturer: input.manufacturer ?? null,
        androidVersion: input.androidVersion ?? null,
        agentVersion: input.agentVersion ?? null,
        expiresAt: new Date(Date.now() + (input.expiresInMs ?? 10 * 60 * 1000)),
      },
    });
    return toRecord(p);
  }

  async getById(id: string): Promise<PairingRecord | null> {
    const p = await this.prisma.pairing.findUnique({ where: { id } });
    return p ? toRecord(p) : null;
  }

  async incrementAttempts(id: string): Promise<PairingRecord | null> {
    const p = await this.prisma.pairing
      .update({ where: { id }, data: { attempts: { increment: 1 } } })
      .catch(() => null);
    return p ? toRecord(p) : null;
  }

  async consume(
    id: string,
    input: { deviceId: string; createdById: string; issuedToken: string },
  ): Promise<PairingRecord | null> {
    // Atomik di database: updateMany dengan guard status PENDING — bila
    // 0 baris terpengaruh, pairing sudah direbut proses lain -> null.
    const res = await this.prisma.pairing.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "CONSUMED",
        deviceId: input.deviceId,
        createdById: input.createdById,
        issuedToken: input.issuedToken,
        consumedAt: new Date(),
      },
    });
    if (res.count === 0) return null;
    const p = await this.prisma.pairing.findUnique({ where: { id } });
    return p ? toRecord(p) : null;
  }

  async markExpired(id: string): Promise<PairingRecord | null> {
    const p = await this.prisma.pairing.update({ where: { id }, data: { status: "EXPIRED" } }).catch(() => null);
    return p ? toRecord(p) : null;
  }

  async markRevoked(id: string): Promise<PairingRecord | null> {
    const p = await this.prisma.pairing.update({ where: { id }, data: { status: "REVOKED" } }).catch(() => null);
    return p ? toRecord(p) : null;
  }

  async takeIssuedToken(id: string): Promise<string | null> {
    // Baca + hapus dalam satu transaksi agar token benar-benar sekali-baca.
    const token = await this.prisma.$transaction(async (tx) => {
      const p = await tx.pairing.findUnique({ where: { id }, select: { issuedToken: true } });
      if (!p?.issuedToken) return null;
      await tx.pairing.update({ where: { id }, data: { issuedToken: null } });
      return p.issuedToken;
    });
    return token;
  }
}
