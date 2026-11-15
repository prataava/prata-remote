// PRATA Remote — Store notifikasi dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat NOTIFICATION_STORE=prisma. Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type { NotificationCreateInput, NotificationKind, NotificationRecord, NotificationStore } from "./notifications.ts";

function toRecord(n: {
  id: string;
  ownerId: string;
  deviceId: string | null;
  kind: string;
  packageName: string | null;
  appName: string | null;
  title: string | null;
  text: string | null;
  createdAt: Date;
}): NotificationRecord {
  return {
    id: n.id,
    ownerId: n.ownerId,
    deviceId: n.deviceId,
    kind: n.kind as NotificationKind,
    packageName: n.packageName,
    appName: n.appName,
    title: n.title,
    text: n.text,
    createdAt: n.createdAt,
  };
}

export class PrismaNotificationStore implements NotificationStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async append(input: NotificationCreateInput): Promise<NotificationRecord> {
    const n = await this.prisma.notification.create({
      data: {
        ownerId: input.ownerId,
        deviceId: input.deviceId ?? null,
        kind: input.kind,
        packageName: input.packageName ?? null,
        appName: input.appName ?? null,
        title: input.title ?? null,
        text: input.text ?? null,
      },
    });
    return toRecord(n);
  }

  async listByOwner(
    ownerId: string,
    opts?: { packageName?: string; kind?: NotificationKind; limit?: number },
  ): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        ownerId,
        ...(opts?.packageName ? { packageName: opts.packageName } : {}),
        ...(opts?.kind ? { kind: opts.kind } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts?.limit ?? 100,
    });
    return rows.map(toRecord);
  }

  async listByDevice(deviceId: string, limit = 100): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: { deviceId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(toRecord);
  }
}
