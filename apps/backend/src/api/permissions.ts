// PRATA Remote — Store status persetujuan fitur Agent (FINAL, Bagian 1)
// Satu baris per (device, feature); feature ∈ screen, accessibility, saf,
// notification, camera. Diperbarui Agent lewat WS permission_report.
export type PermissionFeature = "screen" | "accessibility" | "saf" | "notification" | "camera";

export const PERMISSION_FEATURES: readonly PermissionFeature[] = [
  "screen",
  "accessibility",
  "saf",
  "notification",
  "camera",
];

export interface PermissionRecord {
  deviceId: string;
  feature: PermissionFeature;
  granted: boolean;
  updatedAt: Date;
}

export interface PermissionStore {
  upsert(deviceId: string, feature: PermissionFeature, granted: boolean): Promise<PermissionRecord>;
  listByDevice(deviceId: string): Promise<PermissionRecord[]>;
  get(deviceId: string, feature: PermissionFeature): Promise<PermissionRecord | null>;
}

export class MemoryPermissionStore implements PermissionStore {
  private readonly records = new Map<string, PermissionRecord>();

  private key(deviceId: string, feature: string): string {
    return `${deviceId}:${feature}`;
  }

  async upsert(deviceId: string, feature: PermissionFeature, granted: boolean): Promise<PermissionRecord> {
    const rec: PermissionRecord = { deviceId, feature, granted, updatedAt: new Date() };
    this.records.set(this.key(deviceId, feature), rec);
    return { ...rec };
  }

  async listByDevice(deviceId: string): Promise<PermissionRecord[]> {
    return [...this.records.values()].filter((r) => r.deviceId === deviceId).map((r) => ({ ...r }));
  }

  async get(deviceId: string, feature: PermissionFeature): Promise<PermissionRecord | null> {
    const rec = this.records.get(this.key(deviceId, feature));
    return rec ? { ...rec } : null;
  }
}
