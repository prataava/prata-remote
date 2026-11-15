// PRATA Remote — Registry perangkat dari DeviceStore (Command 002, Tugas 1)
// Satu sumber kebenaran untuk perangkat: WS signaling DAN REST API membaca
// store yang sama. Perangkat yang dibuat lewat pairing/confirm langsung
// bisa hello ke WebSocket dengan tokennya — tanpa sinkronisasi ganda.
// Menggantikan EnvDeviceRegistry/PrismaDeviceRegistry Command 001
// (dihapus) — store yang dipakai dipilih lewat env *_STORE (memory|prisma).
import { hashToken, hashEquals } from "../signaling/auth.ts";
import type { DeviceRegistry } from "./device-registry.ts";
import type { DeviceStore } from "../api/devices.ts";
import type { DeviceKeyStore } from "../api/device-keys.ts";

export class StoreDeviceRegistry implements DeviceRegistry {
  private readonly deviceStore: DeviceStore;
  private readonly keyStore?: DeviceKeyStore;

  constructor(deviceStore: DeviceStore, keyStore?: DeviceKeyStore) {
    this.deviceStore = deviceStore;
    this.keyStore = keyStore;
  }

  async verifyAgentToken(deviceId: string, token: string): Promise<boolean> {
    const device = await this.deviceStore.getById(deviceId);
    if (!device) return false;
    const digest = hashToken(token);
    if (device.agentTokenHash && hashEquals(device.agentTokenHash, digest)) return true;
    // Kunci tambahan (rotasi): hanya yang belum di-revoke yang berlaku.
    if (this.keyStore) {
      const key = await this.keyStore.getByHash(digest);
      if (key && key.deviceId === deviceId && !key.revoked) {
        await this.keyStore.markUsed(key.id, new Date()).catch(() => null);
        return true;
      }
    }
    return false;
  }

  async getOwner(deviceId: string): Promise<string | null> {
    const device = await this.deviceStore.getById(deviceId);
    return device?.ownerId ?? null;
  }
}
