// PRATA Remote — Penyimpanan sesi (Command 001, Phase 1)
// Kontrak pencatatan sesi untuk audit (tabel sessions di schema.prisma).
// - "memory" -> MemorySessionStore (pengembangan + smoke test)
// - "prisma" -> PrismaSessionStore (produksi; file terpisah, dynamic import)
import type { SessionType } from "../signaling/types.ts";

export type SessionStatus = "requested" | "active" | "ended" | "rejected";

export interface SessionRecord {
  id: string;
  deviceId: string;
  controllerId: string;
  type: SessionType;
  status: SessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
}

export interface SessionStore {
  create(input: { deviceId: string; controllerId: string; type: SessionType }): Promise<SessionRecord>;
  setStatus(id: string, status: SessionStatus, reason?: string): Promise<SessionRecord | null>;
  get(id: string): Promise<SessionRecord | null>;
  listActiveForDevice(deviceId: string): Promise<SessionRecord[]>;
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionRecord>();
  private counter = 0;

  async create(input: { deviceId: string; controllerId: string; type: SessionType }): Promise<SessionRecord> {
    const id = `ses_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
    const rec: SessionRecord = {
      id,
      deviceId: input.deviceId,
      controllerId: input.controllerId,
      type: input.type,
      status: "requested",
      startedAt: new Date(),
      endedAt: null,
      endedReason: null,
    };
    this.sessions.set(id, rec);
    return rec;
  }

  async setStatus(id: string, status: SessionStatus, reason?: string): Promise<SessionRecord | null> {
    const rec = this.sessions.get(id);
    if (!rec) return null;
    rec.status = status;
    if (status === "ended" || status === "rejected") {
      rec.endedAt = new Date();
      rec.endedReason = reason ?? null;
    }
    return rec;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async listActiveForDevice(deviceId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()].filter((s) => s.deviceId === deviceId && s.status === "active");
  }
}
