// PRATA Remote — Store kunci perangkat dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat DEVICE_KEY_STORE=prisma. Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type { DeviceKeyCreateInput, DeviceKeyRecord, DeviceKeyStore } from "./device-keys.ts";

function toRecord(k: {
  id: string;
  deviceId: string;
  keyHash: string;
  label: string | null;
  revoked: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): DeviceKeyRecord {
  return { ...k };
}

export class PrismaDeviceKeyStore implements DeviceKeyStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: DeviceKeyCreateInput): Promise<DeviceKeyRecord> {
    const k = await this.prisma.deviceKey.create({
      data: { deviceId: input.deviceId, keyHash: input.keyHash, label: input.label ?? null },
    });
    return toRecord(k);
  }

  async getByHash(keyHash: string): Promise<DeviceKeyRecord | null> {
    const k = await this.prisma.deviceKey.findFirst({ where: { keyHash } });
    return k ? toRecord(k) : null;
  }

  async listByDevice(deviceId: string): Promise<DeviceKeyRecord[]> {
    const rows = await this.prisma.deviceKey.findMany({
      where: { deviceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async revoke(id: string): Promise<DeviceKeyRecord | null> {
    const k = await this.prisma.deviceKey
      .update({ where: { id }, data: { revoked: true, revokedAt: new Date() } })
      .catch(() => null);
    return k ? toRecord(k) : null;
  }

  async revokeAllForDevice(deviceId: string): Promise<number> {
    const res = await this.prisma.deviceKey.updateMany({
      where: { deviceId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
    return res.count;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.prisma.deviceKey.update({ where: { id }, data: { lastUsedAt: at } }).catch(() => null);
  }
}
