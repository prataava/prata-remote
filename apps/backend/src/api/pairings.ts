// PRATA Remote — Store pairing (Command 002, Tugas 1)
// Kontrak CRUD rekaman Pairing. Logika alur (validasi kode, kedaluwarsa,
// pembuatan device + token) tinggal di PairingService — store ini dumb.
// Implementasi:
// - "memory" -> MemoryPairingStore (pengembangan + smoke test)
// - "prisma" -> PrismaPairingStore (produksi; file terpisah, dynamic import)
export type PairingStatus = "pending" | "consumed" | "expired" | "revoked";

export interface PairingRecord {
  id: string;
  deviceId: string | null;
  codeHash: string;
  attempts: number;
  status: PairingStatus;
  deviceName: string | null;
  deviceModel: string | null;
  manufacturer: string | null;
  androidVersion: string | null;
  agentVersion: string | null;
  /** Token agen yang diterbitkan saat confirm; dibaca SEKALI via poll lalu di-null-kan. */
  issuedToken: string | null;
  createdById: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface PairingCreateInput {
  codeHash: string;
  deviceName?: string;
  deviceModel?: string;
  manufacturer?: string;
  androidVersion?: string;
  agentVersion?: string;
  /** Override masa berlaku (dipakai smoke test untuk membuat pairing kedaluwarsa). */
  expiresInMs?: number;
}

export interface PairingStore {
  create(input: PairingCreateInput): Promise<PairingRecord>;
  getById(id: string): Promise<PairingRecord | null>;
  incrementAttempts(id: string): Promise<PairingRecord | null>;
  consume(id: string, input: { deviceId: string; createdById: string; issuedToken: string }): Promise<PairingRecord | null>;
  markExpired(id: string): Promise<PairingRecord | null>;
  markRevoked(id: string): Promise<PairingRecord | null>;
  /** Ambil + hapus token sekali-baca. Mengembalikan token bila masih ada. */
  takeIssuedToken(id: string): Promise<string | null>;
}

export class MemoryPairingStore implements PairingStore {
  private pairings = new Map<string, PairingRecord>();
  private counter = 0;

  async create(input: PairingCreateInput): Promise<PairingRecord> {
    const id = `pair_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
    const now = new Date();
    const rec: PairingRecord = {
      id,
      deviceId: null,
      codeHash: input.codeHash,
      attempts: 0,
      status: "pending",
      deviceName: input.deviceName ?? null,
      deviceModel: input.deviceModel ?? null,
      manufacturer: input.manufacturer ?? null,
      androidVersion: input.androidVersion ?? null,
      agentVersion: input.agentVersion ?? null,
      issuedToken: null,
      createdById: null,
      expiresAt: new Date(now.getTime() + (input.expiresInMs ?? 10 * 60 * 1000)),
      consumedAt: null,
      createdAt: now,
    };
    this.pairings.set(id, rec);
    return rec;
  }

  async getById(id: string): Promise<PairingRecord | null> {
    return this.pairings.get(id) ?? null;
  }

  async incrementAttempts(id: string): Promise<PairingRecord | null> {
    const rec = this.pairings.get(id);
    if (!rec) return null;
    rec.attempts += 1;
    return rec;
  }

  async consume(
    id: string,
    input: { deviceId: string; createdById: string; issuedToken: string },
  ): Promise<PairingRecord | null> {
    const rec = this.pairings.get(id);
    // Atomik di proses ini: hanya berhasil bila status masih PENDING.
    if (!rec || rec.status !== "pending") return null;
    rec.status = "consumed";
    rec.deviceId = input.deviceId;
    rec.createdById = input.createdById;
    rec.issuedToken = input.issuedToken;
    rec.consumedAt = new Date();
    return rec;
  }

  async markExpired(id: string): Promise<PairingRecord | null> {
    const rec = this.pairings.get(id);
    if (!rec) return null;
    rec.status = "expired";
    return rec;
  }

  async markRevoked(id: string): Promise<PairingRecord | null> {
    const rec = this.pairings.get(id);
    if (!rec) return null;
    rec.status = "revoked";
    return rec;
  }

  async takeIssuedToken(id: string): Promise<string | null> {
    const rec = this.pairings.get(id);
    if (!rec || rec.issuedToken === null) return null;
    const token = rec.issuedToken;
    rec.issuedToken = null;
    return token;
  }
}
