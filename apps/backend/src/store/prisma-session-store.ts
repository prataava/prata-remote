// PRATA Remote — Penyimpanan sesi dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat SESSION_STORE=prisma. Butuh DATABASE_URL + prisma generate +
// migrate dev (sama seperti prisma-registry.ts). Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type { SessionRecord, SessionStatus, SessionStore } from "./session-store.ts";
import type { SessionType } from "../signaling/types.ts";

function toRecord(s: {
  id: string;
  deviceId: string;
  controllerId: string;
  type: string;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
}): SessionRecord {
  return {
    id: s.id,
    deviceId: s.deviceId,
    controllerId: s.controllerId,
    type: s.type === "CAMERA" ? "camera" : "screen",
    status: s.status.toLowerCase() as SessionStatus,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endedReason: s.endedReason,
  };
}

export class PrismaSessionStore implements SessionStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: { deviceId: string; controllerId: string; type: SessionType }): Promise<SessionRecord> {
    const s = await this.prisma.session.create({
      data: {
        deviceId: input.deviceId,
        controllerId: input.controllerId,
        // Enum DB hanya SCREEN/CAMERA: camera-front/back dicatat CAMERA
        // (sisi kamera yang tepat tetap ada di pesan session-request live).
        type: input.type === "screen" ? "SCREEN" : "CAMERA",
        status: "REQUESTED",
      },
    });
    return toRecord(s);
  }

  async setStatus(id: string, status: SessionStatus, reason?: string): Promise<SessionRecord | null> {
    const s = await this.prisma.session
      .update({
        where: { id },
        data: {
          status: status.toUpperCase() as "REQUESTED" | "ACTIVE" | "ENDED" | "REJECTED",
          endedAt: status === "ended" || status === "rejected" ? new Date() : undefined,
          endedReason: reason ?? undefined,
        },
      })
      .catch(() => null);
    return s ? toRecord(s) : null;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const s = await this.prisma.session.findUnique({ where: { id } });
    return s ? toRecord(s) : null;
  }

  async listActiveForDevice(deviceId: string): Promise<SessionRecord[]> {
    const rows = await this.prisma.session.findMany({
      where: { deviceId, status: "ACTIVE" },
    });
    return rows.map(toRecord);
  }
}
