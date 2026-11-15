// PRATA Remote — Store perangkat dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat DEVICE_STORE=prisma. Butuh DATABASE_URL + prisma generate +
// migrate dev. Hanya dimuat saat dipilih (dynamic import di index.ts).
import { PrismaClient } from "@prisma/client";
import type { DeviceCreateInput, DeviceRecord, DeviceStore, DeviceUpdateInput } from "./devices.ts";

function toRecord(d: {
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
}): DeviceRecord {
  return { ...d };
}

export class PrismaDeviceStore implements DeviceStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: DeviceCreateInput): Promise<DeviceRecord> {
    const d = await this.prisma.device.create({
      data: {
        ...(input.id ? { id: input.id } : {}),
        ownerId: input.ownerId,
        name: input.name,
        group: input.group ?? null,
        model: input.model ?? null,
        manufacturer: input.manufacturer ?? null,
        androidVersion: input.androidVersion ?? null,
        agentVersion: input.agentVersion ?? null,
        agentTokenHash: input.agentTokenHash,
      },
    });
    return toRecord(d);
  }

  async getById(id: string): Promise<DeviceRecord | null> {
    const d = await this.prisma.device.findUnique({ where: { id } });
    return d ? toRecord(d) : null;
  }

  async listByOwner(ownerId: string): Promise<DeviceRecord[]> {
    const rows = await this.prisma.device.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    await this.prisma.device.update({ where: { id }, data: { lastSeenAt: at } }).catch(() => null);
  }

  async update(id: string, patch: DeviceUpdateInput): Promise<DeviceRecord | null> {
    const d = await this.prisma.device
      .update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.group !== undefined ? { group: patch.group } : {}),
          ...(patch.agentTokenHash !== undefined ? { agentTokenHash: patch.agentTokenHash ?? "" } : {}),
        },
      })
      .catch(() => null);
    return d ? toRecord(d) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.prisma.device.delete({ where: { id } }).then(
      () => true,
      () => false,
    );
  }
}
