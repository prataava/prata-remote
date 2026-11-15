// PRATA Remote — Store perangkat (Command 002, Tugas 1)
// Kontrak CRUD tabel devices untuk REST API. Status live (online/offline)
// TIDAK disimpan di sini — sumbernya presence tracker signaling server,
// digabung di handler GET /api/devices.
// Implementasi:
// - "memory" -> MemoryDeviceStore (pengembangan + smoke test)
// - "prisma" -> PrismaDeviceStore (produksi; file terpisah, dynamic import)
export interface DeviceRecord {
  id: string;
  ownerId: string;
  name: string;
  group: string | null;
  model: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  agentTokenHash: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface DeviceCreateInput {
  /** Bila diisi, dipakai sebagai id (dipakai seed perangkat dev dari env). */
  id?: string;
  ownerId: string;
  name: string;
  group?: string | null;
  model?: string;
  manufacturer?: string;
  androidVersion?: string;
  agentVersion?: string;
  agentTokenHash: string;
}

export interface DeviceUpdateInput {
  name?: string;
  group?: string | null;
  /** Set null untuk mencabut kunci utama perangkat (revoke). */
  agentTokenHash?: string | null;
}

export interface DeviceStore {
  create(input: DeviceCreateInput): Promise<DeviceRecord>;
  getById(id: string): Promise<DeviceRecord | null>;
  listByOwner(ownerId: string): Promise<DeviceRecord[]>;
  touchLastSeen(id: string, at: Date): Promise<void>;
  update(id: string, patch: DeviceUpdateInput): Promise<DeviceRecord | null>;
  delete(id: string): Promise<boolean>;
}

export class MemoryDeviceStore implements DeviceStore {
  private devices = new Map<string, DeviceRecord>();
  private counter = 0;

  async create(input: DeviceCreateInput): Promise<DeviceRecord> {
    const rec: DeviceRecord = {
      id: input.id ?? `dev_${Date.now().toString(36)}_${(this.counter++).toString(36)}`,
      ownerId: input.ownerId,
      name: input.name,
      group: input.group ?? null,
      model: input.model ?? null,
      manufacturer: input.manufacturer ?? null,
      androidVersion: input.androidVersion ?? null,
      agentVersion: input.agentVersion ?? null,
      agentTokenHash: input.agentTokenHash,
      lastSeenAt: null,
      createdAt: new Date(),
    };
    this.devices.set(rec.id, rec);
    return rec;
  }

  async getById(id: string): Promise<DeviceRecord | null> {
    return this.devices.get(id) ?? null;
  }

  async update(id: string, patch: DeviceUpdateInput): Promise<DeviceRecord | null> {
    const rec = this.devices.get(id);
    if (!rec) return null;
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.group !== undefined) rec.group = patch.group;
    if (patch.agentTokenHash !== undefined) rec.agentTokenHash = patch.agentTokenHash ?? "";
    return { ...rec };
  }

  async delete(id: string): Promise<boolean> {
    return this.devices.delete(id);
  }

  async listByOwner(ownerId: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((d) => d.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    const rec = this.devices.get(id);
    if (rec) rec.lastSeenAt = at;
  }
}
