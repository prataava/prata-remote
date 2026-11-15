// PRATA Remote — Store permission Agent dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat PERMISSION_STORE=prisma. Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type { PermissionFeature, PermissionRecord, PermissionStore } from "./permissions.ts";

function toRecord(p: { deviceId: string; feature: string; granted: boolean; updatedAt: Date }): PermissionRecord {
  return { deviceId: p.deviceId, feature: p.feature as PermissionFeature, granted: p.granted, updatedAt: p.updatedAt };
}

export class PrismaPermissionStore implements PermissionStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async upsert(deviceId: string, feature: PermissionFeature, granted: boolean): Promise<PermissionRecord> {
    const p = await this.prisma.permission.upsert({
      where: { deviceId_feature: { deviceId, feature } },
      update: { granted },
      create: { deviceId, feature, granted },
    });
    return toRecord(p);
  }

  async listByDevice(deviceId: string): Promise<PermissionRecord[]> {
    const rows = await this.prisma.permission.findMany({ where: { deviceId } });
    return rows.map(toRecord);
  }

  async get(deviceId: string, feature: PermissionFeature): Promise<PermissionRecord | null> {
    const p = await this.prisma.permission.findUnique({ where: { deviceId_feature: { deviceId, feature } } });
    return p ? toRecord(p) : null;
  }
}
