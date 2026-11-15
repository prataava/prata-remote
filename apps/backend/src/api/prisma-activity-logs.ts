// PRATA Remote — Store activity log dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat ACTIVITY_LOG_STORE=prisma. Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type { ActivityAction, ActivityLogCreateInput, ActivityLogRecord, ActivityLogStore } from "./activity-logs.ts";

function toRecord(l: {
  id: string;
  userId: string;
  deviceId: string | null;
  action: string;
  detail: string | null;
  createdAt: Date;
}): ActivityLogRecord {
  return { id: l.id, userId: l.userId, deviceId: l.deviceId, action: l.action as ActivityAction, detail: l.detail, createdAt: l.createdAt };
}

export class PrismaActivityLogStore implements ActivityLogStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async append(input: ActivityLogCreateInput): Promise<ActivityLogRecord> {
    const l = await this.prisma.activityLog.create({
      data: { userId: input.userId, deviceId: input.deviceId ?? null, action: input.action, detail: input.detail ?? null },
    });
    return toRecord(l);
  }

  async listByOwner(userId: string, limit = 100): Promise<ActivityLogRecord[]> {
    const rows = await this.prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  }

  async listByDevice(deviceId: string, limit = 100): Promise<ActivityLogRecord[]> {
    const rows = await this.prisma.activityLog.findMany({
      where: { deviceId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  }
}
