// PRATA Remote — Store audit trail keamanan (FINAL, Bagian 1)
// Append-only: login, pairing, sesi mulai/akhir, transfer file, cabut
// perangkat, alert otomatisasi. Tidak ada endpoint hapus.
export type ActivityAction =
  | "login"
  | "pairing"
  | "session-start"
  | "session-end"
  | "file-transfer"
  | "device-revoke"
  | "device-delete"
  | "device-rename"
  | "automation-alert"
  | "terminate-all";

export interface ActivityLogRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  action: ActivityAction;
  detail: string | null;
  createdAt: Date;
}

export interface ActivityLogCreateInput {
  userId: string;
  deviceId?: string | null;
  action: ActivityAction;
  detail?: string | null;
}

export interface ActivityLogStore {
  append(input: ActivityLogCreateInput): Promise<ActivityLogRecord>;
  listByOwner(userId: string, limit?: number): Promise<ActivityLogRecord[]>;
  listByDevice(deviceId: string, limit?: number): Promise<ActivityLogRecord[]>;
}

let counter = 0;

export class MemoryActivityLogStore implements ActivityLogStore {
  private readonly records: ActivityLogRecord[] = [];

  async append(input: ActivityLogCreateInput): Promise<ActivityLogRecord> {
    const rec: ActivityLogRecord = {
      id: `log_${Date.now().toString(36)}_${(counter++).toString(36)}`,
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      action: input.action,
      detail: input.detail ?? null,
      createdAt: new Date(),
    };
    this.records.push(rec);
    return { ...rec };
  }

  async listByOwner(userId: string, limit = 100): Promise<ActivityLogRecord[]> {
    return this.records
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByDevice(deviceId: string, limit = 100): Promise<ActivityLogRecord[]> {
    return this.records
      .filter((r) => r.deviceId === deviceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}
