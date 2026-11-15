// PRATA Remote — Store kunci perangkat (FINAL, Bagian 1)
// Satu device bisa punya banyak kunci sepanjang riwayat; masing-masing
// bisa dicabut. Token mentah TIDAK PERNAH disimpan — hanya SHA-256.
import { randomBytes } from "node:crypto";

export interface DeviceKeyRecord {
  id: string;
  deviceId: string;
  keyHash: string;
  label: string | null;
  revoked: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface DeviceKeyCreateInput {
  deviceId: string;
  keyHash: string;
  label?: string | null;
}

export interface DeviceKeyStore {
  create(input: DeviceKeyCreateInput): Promise<DeviceKeyRecord>;
  getByHash(keyHash: string): Promise<DeviceKeyRecord | null>;
  listByDevice(deviceId: string): Promise<DeviceKeyRecord[]>;
  revoke(id: string): Promise<DeviceKeyRecord | null>;
  revokeAllForDevice(deviceId: string): Promise<number>;
  markUsed(id: string, at: Date): Promise<void>;
}

export function newDeviceKeyId(): string {
  return `key_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly records = new Map<string, DeviceKeyRecord>();

  async create(input: DeviceKeyCreateInput): Promise<DeviceKeyRecord> {
    const rec: DeviceKeyRecord = {
      id: newDeviceKeyId(),
      deviceId: input.deviceId,
      keyHash: input.keyHash,
      label: input.label ?? null,
      revoked: false,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    };
    this.records.set(rec.id, rec);
    return { ...rec };
  }

  async getByHash(keyHash: string): Promise<DeviceKeyRecord | null> {
    for (const rec of this.records.values()) {
      if (rec.keyHash === keyHash) return { ...rec };
    }
    return null;
  }

  async listByDevice(deviceId: string): Promise<DeviceKeyRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.deviceId === deviceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async revoke(id: string): Promise<DeviceKeyRecord | null> {
    const rec = this.records.get(id);
    if (!rec) return null;
    rec.revoked = true;
    rec.revokedAt = new Date();
    return { ...rec };
  }

  async revokeAllForDevice(deviceId: string): Promise<number> {
    let n = 0;
    for (const rec of this.records.values()) {
      if (rec.deviceId === deviceId && !rec.revoked) {
        rec.revoked = true;
        rec.revokedAt = new Date();
        n++;
      }
    }
    return n;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    const rec = this.records.get(id);
    if (rec) rec.lastUsedAt = at;
  }
}
