// PRATA Remote — Store riwayat notifikasi (FINAL, Bagian 1 & 4)
// kind "device" = notifikasi perangkat yang diteruskan Agent;
// kind "automation" = peringatan sistem/otomatisasi.
import { randomBytes } from "node:crypto";

export type NotificationKind = "device" | "automation";

export interface NotificationRecord {
  id: string;
  ownerId: string;
  deviceId: string | null;
  kind: NotificationKind;
  packageName: string | null;
  appName: string | null;
  title: string | null;
  text: string | null;
  createdAt: Date;
}

export interface NotificationCreateInput {
  ownerId: string;
  deviceId?: string | null;
  kind: NotificationKind;
  packageName?: string | null;
  appName?: string | null;
  title?: string | null;
  text?: string | null;
}

export interface NotificationStore {
  append(input: NotificationCreateInput): Promise<NotificationRecord>;
  listByOwner(ownerId: string, opts?: { packageName?: string; kind?: NotificationKind; limit?: number }): Promise<NotificationRecord[]>;
  listByDevice(deviceId: string, limit?: number): Promise<NotificationRecord[]>;
}

export function newNotificationId(): string {
  return `ntf_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

export class MemoryNotificationStore implements NotificationStore {
  private readonly records: NotificationRecord[] = [];

  async append(input: NotificationCreateInput): Promise<NotificationRecord> {
    const rec: NotificationRecord = {
      id: newNotificationId(),
      ownerId: input.ownerId,
      deviceId: input.deviceId ?? null,
      kind: input.kind,
      packageName: input.packageName ?? null,
      appName: input.appName ?? null,
      title: input.title ?? null,
      text: input.text ?? null,
      createdAt: new Date(),
    };
    this.records.push(rec);
    return { ...rec };
  }

  async listByOwner(
    ownerId: string,
    opts?: { packageName?: string; kind?: NotificationKind; limit?: number },
  ): Promise<NotificationRecord[]> {
    const limit = opts?.limit ?? 100;
    return this.records
      .filter((r) => r.ownerId === ownerId)
      .filter((r) => !opts?.packageName || r.packageName === opts.packageName)
      .filter((r) => !opts?.kind || r.kind === opts.kind)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByDevice(deviceId: string, limit = 100): Promise<NotificationRecord[]> {
    return this.records
      .filter((r) => r.deviceId === deviceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
