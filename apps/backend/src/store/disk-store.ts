// PRATA Remote — Disk Store (FINALISASI, Langkah 1)
// Penyimpanan persisten berbasis file JSON (WAL sederhana) + blob di disk.
//
//   apps/backend/data/prata-store.json  — seluruh 10 tabel
//   apps/backend/data/blobs/<transferId>.bin — byte transfer file
//
// Setiap mutasi menulis atomik: tulis ke `<file>.tmp-<pid>` lalu
// `renameSync` menimpa target (rename POSIX = atomik). Server yang
// dimatikan mendadak (kill -9) tidak pernah meninggalkan JSON setengah
// tulis; boot yang menemukan JSON rusak memindahkannya ke
// `<file>.corrupt-<ts>` dan mulai dari state kosong (tanpa crash).
//
// Satu DiskBackend memegang state + persist; sepuluh adapter tipis
// (DiskUserStore, DiskDeviceStore, dst.) mengimplementasikan tiap
// kontrak store di atas backend yang sama — jadi semua store menulis
// ke SATU file yang sama. DiskStore adalah default baru bila
// DATABASE_URL tidak diset. Prisma tetap tersedia (STORE=prisma)
// untuk produksi dengan PostgreSQL.
//
// CATATAN SANDBOX: jangan pernah menulis file ini lewat shell
// (python open('w') / redirect `>`): rezim EPERM memotong file jadi
// 0 byte lalu gagal tulis. Selalu pakai muse.write/muse.edit.
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { UserRecord, UserStore } from "../api/users.ts";
import type { DeviceRecord, DeviceCreateInput, DeviceStore, DeviceUpdateInput } from "../api/devices.ts";
import type { DeviceKeyRecord, DeviceKeyCreateInput, DeviceKeyStore } from "../api/device-keys.ts";
import type { PairingRecord, PairingCreateInput, PairingStore } from "../api/pairings.ts";
import type { PermissionRecord, PermissionFeature, PermissionStore } from "../api/permissions.ts";
import type { ActivityLogRecord, ActivityLogCreateInput, ActivityLogStore } from "../api/activity-logs.ts";
import type { AutomationRuleRecord, AutomationRuleCreateInput, AutomationRuleStore, AutomationRuleUpdateInput } from "../api/automation.ts";
import type { NotificationRecord, NotificationCreateInput, NotificationStore } from "../api/notifications.ts";
import type { TransferRecord, TransferCreateInput, TransferStore, TransferStatus, BlobStore } from "../api/transfers.ts";
import { newAutomationRuleId } from "../api/automation.ts";
import { newDeviceKeyId } from "../api/device-keys.ts";
import { newNotificationId } from "../api/notifications.ts";
import { newTransferId, sanitizeFileName, TRANSFER_TTL_MS } from "../api/transfers.ts";
import type { SessionRecord, SessionStore, SessionStatus } from "../store/session-store.ts";
import type { SessionType } from "../signaling/types.ts";

export interface DiskState {
  version: 1;
  users: UserRecord[];
  devices: DeviceRecord[];
  deviceKeys: DeviceKeyRecord[];
  pairings: PairingRecord[];
  sessions: SessionRecord[];
  permissions: PermissionRecord[];
  transfers: TransferRecord[];
  activityLogs: ActivityLogRecord[];
  automationRules: AutomationRuleRecord[];
  notifications: NotificationRecord[];
  counters: { user: number; device: number; pairing: number; session: number; log: number };
}

function emptyState(): DiskState {
  return {
    version: 1,
    users: [],
    devices: [],
    deviceKeys: [],
    pairings: [],
    sessions: [],
    permissions: [],
    transfers: [],
    activityLogs: [],
    automationRules: [],
    notifications: [],
    counters: { user: 0, device: 0, pairing: 0, session: 0, log: 0 },
  };
}

const DATE_FIELDS: Record<string, string[]> = {
  users: ["createdAt"],
  devices: ["lastSeenAt", "createdAt"],
  deviceKeys: ["revokedAt", "lastUsedAt", "createdAt"],
  pairings: ["expiresAt", "consumedAt", "createdAt"],
  sessions: ["startedAt", "endedAt"],
  permissions: ["updatedAt"],
  transfers: ["createdAt", "expiresAt"],
  activityLogs: ["createdAt"],
  automationRules: ["createdAt", "updatedAt"],
  notifications: ["createdAt"],
};

function reviveDates(state: DiskState): void {
  for (const [collection, fields] of Object.entries(DATE_FIELDS)) {
    const rows = (state as unknown as Record<string, Record<string, unknown>[]>)[collection];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      for (const f of fields) {
        const v = row[f];
        if (typeof v === "string") row[f] = new Date(v);
      }
    }
  }
}

function desc<T extends { createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Backend bersama: muat state dari disk, tulis atomik tiap mutasi. */
export class DiskBackend {
  readonly filePath: string;
  state: DiskState;
  lastPersistError: Error | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = emptyState();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(join(this.filePath, ".."), { recursive: true });
      this.persist();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DiskState>;
      const next = emptyState();
      for (const key of Object.keys(next) as (keyof DiskState)[]) {
        if (key === "counters") {
          if (parsed.counters) next.counters = { ...next.counters, ...parsed.counters };
        } else if (Array.isArray((parsed as Record<string, unknown>)[key])) {
          (next as unknown as Record<string, unknown[]>)[key] = (parsed as Record<string, unknown[]>)[key];
        }
      }
      reviveDates(next);
      this.state = next;
    } catch (err) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try { renameSync(this.filePath, backup); } catch { /* abaikan */ }
      console.error(`DiskStore: file rusak, dipindah ke ${backup}, mulai dari state kosong.`, err);
      this.state = emptyState();
      this.persist();
    }
  }

  /** Tulis atomik seluruh state ke disk (sinkron — dipanggil tiap mutasi). */
  persist(): void {
    try {
      const tmp = `${this.filePath}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.filePath);
      this.lastPersistError = null;
    } catch (err) {
      this.lastPersistError = err instanceof Error ? err : new Error(String(err));
      console.error("DiskStore: GAGAL menulis state ke disk (data tetap di memori):", this.lastPersistError.message);
    }
  }

  close(): void {
    this.persist();
  }

  /** Statistik isi store (untuk /healthz & tes). */
  stats(): Record<string, number> {
    return {
      users: this.state.users.length,
      devices: this.state.devices.length,
      deviceKeys: this.state.deviceKeys.length,
      pairings: this.state.pairings.length,
      sessions: this.state.sessions.length,
      permissions: this.state.permissions.length,
      transfers: this.state.transfers.length,
      activityLogs: this.state.activityLogs.length,
      automationRules: this.state.automationRules.length,
      notifications: this.state.notifications.length,
    };
  }
}

// --- Adapter store (satu backend, sepuluh kontrak) ---

export class DiskUserStore implements UserStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.db.state.users.find((u) => u.email === email.toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.db.state.users.find((u) => u.id === id) ?? null;
  }

  async create(input: { email: string; passwordHash: string; name?: string; role?: "user" | "admin" }): Promise<UserRecord> {
    const email = input.email.toLowerCase();
    if (this.db.state.users.some((u) => u.email === email)) throw new Error(`Email sudah terdaftar: ${email}`);
    const rec: UserRecord = {
      id: `user_${Date.now().toString(36)}_${(this.db.state.counters.user++).toString(36)}`,
      email,
      passwordHash: input.passwordHash,
      name: input.name ?? null,
      role: input.role ?? "user",
      createdAt: new Date(),
    };
    this.db.state.users.push(rec);
    this.db.persist();
    return { ...rec };
  }
}

export class DiskDeviceStore implements DeviceStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async create(input: DeviceCreateInput): Promise<DeviceRecord> {
    const rec: DeviceRecord = {
      id: input.id ?? `dev_${Date.now().toString(36)}_${(this.db.state.counters.device++).toString(36)}`,
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
    this.db.state.devices.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async getById(id: string): Promise<DeviceRecord | null> {
    return this.db.state.devices.find((d) => d.id === id) ?? null;
  }

  async listByOwner(ownerId: string): Promise<DeviceRecord[]> {
    return desc(this.db.state.devices.filter((d) => d.ownerId === ownerId)).map((d) => ({ ...d }));
  }

  async touchLastSeen(id: string, at: Date): Promise<void> {
    const rec = this.db.state.devices.find((d) => d.id === id);
    if (rec) {
      rec.lastSeenAt = at;
      this.db.persist();
    }
  }

  async update(id: string, patch: DeviceUpdateInput): Promise<DeviceRecord | null> {
    const rec = this.db.state.devices.find((d) => d.id === id);
    if (!rec) return null;
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.group !== undefined) rec.group = patch.group;
    if (patch.agentTokenHash !== undefined) rec.agentTokenHash = patch.agentTokenHash ?? "";
    this.db.persist();
    return { ...rec };
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.db.state.devices.findIndex((d) => d.id === id);
    if (idx < 0) return false;
    this.db.state.devices.splice(idx, 1);
    this.db.persist();
    return true;
  }
}

export class DiskDeviceKeyStore implements DeviceKeyStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

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
    this.db.state.deviceKeys.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async getByHash(keyHash: string): Promise<DeviceKeyRecord | null> {
    return this.db.state.deviceKeys.find((r) => r.keyHash === keyHash) ?? null;
  }

  async listByDevice(deviceId: string): Promise<DeviceKeyRecord[]> {
    return desc(this.db.state.deviceKeys.filter((r) => r.deviceId === deviceId)).map((r) => ({ ...r }));
  }

  async revoke(id: string): Promise<DeviceKeyRecord | null> {
    const rec = this.db.state.deviceKeys.find((r) => r.id === id);
    if (!rec) return null;
    rec.revoked = true;
    rec.revokedAt = new Date();
    this.db.persist();
    return { ...rec };
  }

  async revokeAllForDevice(deviceId: string): Promise<number> {
    let n = 0;
    for (const rec of this.db.state.deviceKeys) {
      if (rec.deviceId === deviceId && !rec.revoked) {
        rec.revoked = true;
        rec.revokedAt = new Date();
        n++;
      }
    }
    if (n > 0) this.db.persist();
    return n;
  }

  async markUsed(id: string, at: Date): Promise<void> {
    const rec = this.db.state.deviceKeys.find((r) => r.id === id);
    if (rec) {
      rec.lastUsedAt = at;
      this.db.persist();
    }
  }
}

export class DiskPairingStore implements PairingStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async create(input: PairingCreateInput): Promise<PairingRecord> {
    const id = `pair_${Date.now().toString(36)}_${(this.db.state.counters.pairing++).toString(36)}`;
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
    this.db.state.pairings.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async getById(id: string): Promise<PairingRecord | null> {
    return this.db.state.pairings.find((p) => p.id === id) ?? null;
  }

  async incrementAttempts(id: string): Promise<PairingRecord | null> {
    const rec = this.db.state.pairings.find((p) => p.id === id);
    if (!rec) return null;
    rec.attempts += 1;
    this.db.persist();
    return { ...rec };
  }

  async consume(id: string, input: { deviceId: string; createdById: string; issuedToken: string }): Promise<PairingRecord | null> {
    const rec = this.db.state.pairings.find((p) => p.id === id);
    if (!rec || rec.status !== "pending") return null;
    rec.status = "consumed";
    rec.deviceId = input.deviceId;
    rec.createdById = input.createdById;
    rec.issuedToken = input.issuedToken;
    rec.consumedAt = new Date();
    this.db.persist();
    return { ...rec };
  }

  async markExpired(id: string): Promise<PairingRecord | null> {
    const rec = this.db.state.pairings.find((p) => p.id === id);
    if (!rec) return null;
    rec.status = "expired";
    this.db.persist();
    return { ...rec };
  }

  async markRevoked(id: string): Promise<PairingRecord | null> {
    const rec = this.db.state.pairings.find((p) => p.id === id);
    if (!rec) return null;
    rec.status = "revoked";
    this.db.persist();
    return { ...rec };
  }

  async takeIssuedToken(id: string): Promise<string | null> {
    const rec = this.db.state.pairings.find((p) => p.id === id);
    if (!rec || rec.issuedToken === null) return null;
    const token = rec.issuedToken;
    rec.issuedToken = null;
    this.db.persist();
    return token;
  }
}

export class DiskSessionStore implements SessionStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async create(input: { deviceId: string; controllerId: string; type: SessionType }): Promise<SessionRecord> {
    const rec: SessionRecord = {
      id: `ses_${Date.now().toString(36)}_${(this.db.state.counters.session++).toString(36)}`,
      deviceId: input.deviceId,
      controllerId: input.controllerId,
      type: input.type,
      status: "requested",
      startedAt: new Date(),
      endedAt: null,
      endedReason: null,
    };
    this.db.state.sessions.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async setStatus(id: string, status: SessionStatus, reason?: string): Promise<SessionRecord | null> {
    const rec = this.db.state.sessions.find((s) => s.id === id);
    if (!rec) return null;
    rec.status = status;
    if (status === "ended" || status === "rejected") {
      rec.endedAt = new Date();
      rec.endedReason = reason ?? null;
    }
    this.db.persist();
    return { ...rec };
  }

  async get(id: string): Promise<SessionRecord | null> {
    return this.db.state.sessions.find((s) => s.id === id) ?? null;
  }

  async listActiveForDevice(deviceId: string): Promise<SessionRecord[]> {
    return this.db.state.sessions
      .filter((s) => s.deviceId === deviceId && s.status === "active")
      .map((s) => ({ ...s }));
  }
}

export class DiskPermissionStore implements PermissionStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async upsert(deviceId: string, feature: PermissionFeature, granted: boolean): Promise<PermissionRecord> {
    const existing = this.db.state.permissions.find((r) => r.deviceId === deviceId && r.feature === feature);
    if (existing) {
      existing.granted = granted;
      existing.updatedAt = new Date();
      this.db.persist();
      return { ...existing };
    }
    const rec: PermissionRecord = { deviceId, feature, granted, updatedAt: new Date() };
    this.db.state.permissions.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async listByDevice(deviceId: string): Promise<PermissionRecord[]> {
    return this.db.state.permissions.filter((r) => r.deviceId === deviceId).map((r) => ({ ...r }));
  }

  async get(deviceId: string, feature: PermissionFeature): Promise<PermissionRecord | null> {
    return this.db.state.permissions.find((r) => r.deviceId === deviceId && r.feature === feature) ?? null;
  }
}

export class DiskTransferStore implements TransferStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async create(input: TransferCreateInput): Promise<TransferRecord> {
    const now = new Date();
    const rec: TransferRecord = {
      id: newTransferId(),
      deviceId: input.deviceId,
      ownerId: input.ownerId,
      direction: input.direction,
      docId: input.docId ?? null,
      fileName: sanitizeFileName(input.fileName),
      mimeType: input.mimeType ?? null,
      size: input.size ?? null,
      sha256Hash: null,
      status: input.direction === "download" ? "waiting-upload" : "ready",
      createdAt: now,
      expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS),
    };
    this.db.state.transfers.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async get(id: string): Promise<TransferRecord | null> {
    return this.db.state.transfers.find((t) => t.id === id) ?? null;
  }

  async setStatus(id: string, status: TransferStatus, error?: string | null): Promise<TransferRecord | null> {
    const rec = this.db.state.transfers.find((t) => t.id === id);
    if (!rec) return null;
    rec.status = status;
    if (error !== undefined) rec.error = error;
    this.db.persist();
    return { ...rec };
  }

  async setSha256(id: string, sha256: string): Promise<void> {
    const rec = this.db.state.transfers.find((t) => t.id === id);
    if (rec) {
      rec.sha256Hash = sha256;
      this.db.persist();
    }
  }

  async setSize(id: string, size: number): Promise<void> {
    const rec = this.db.state.transfers.find((t) => t.id === id);
    if (rec) {
      rec.size = size;
      this.db.persist();
    }
  }

  async delete(id: string): Promise<void> {
    const idx = this.db.state.transfers.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.db.state.transfers.splice(idx, 1);
      this.db.persist();
    }
  }

  /** Tandai transfer kedaluwarsa (status terminal) — dipakai cleanup berkala. */
  async expireStale(now: Date): Promise<TransferRecord[]> {
    const expired: TransferRecord[] = [];
    for (const rec of this.db.state.transfers) {
      const terminal = rec.status === "done" || rec.status === "failed" || rec.status === "expired";
      if (!terminal && now.getTime() > new Date(rec.expiresAt).getTime()) {
        rec.status = "expired";
        expired.push({ ...rec });
      }
    }
    if (expired.length > 0) this.db.persist();
    return expired;
  }

  /** Semua rekaman transfer (salinan) — dipakai cleanup blob berkala. */
  async listAll(): Promise<TransferRecord[]> {
    return this.db.state.transfers.map((t) => ({ ...t }));
  }
}

export class DiskActivityLogStore implements ActivityLogStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async append(input: ActivityLogCreateInput): Promise<ActivityLogRecord> {
    const rec: ActivityLogRecord = {
      id: `log_${Date.now().toString(36)}_${(this.db.state.counters.log++).toString(36)}`,
      userId: input.userId,
      deviceId: input.deviceId ?? null,
      action: input.action,
      detail: input.detail ?? null,
      createdAt: new Date(),
    };
    this.db.state.activityLogs.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async listByOwner(userId: string, limit = 100): Promise<ActivityLogRecord[]> {
    return desc(this.db.state.activityLogs.filter((r) => r.userId === userId))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByDevice(deviceId: string, limit = 100): Promise<ActivityLogRecord[]> {
    return desc(this.db.state.activityLogs.filter((r) => r.deviceId === deviceId))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class DiskAutomationRuleStore implements AutomationRuleStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

  async create(input: AutomationRuleCreateInput): Promise<AutomationRuleRecord> {
    const now = new Date();
    const rec: AutomationRuleRecord = {
      id: newAutomationRuleId(),
      ownerId: input.ownerId,
      deviceId: input.deviceId ?? null,
      name: input.name,
      conditionType: input.conditionType,
      threshold: input.threshold ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    this.db.state.automationRules.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async get(id: string): Promise<AutomationRuleRecord | null> {
    return this.db.state.automationRules.find((r) => r.id === id) ?? null;
  }

  async listByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    return desc(this.db.state.automationRules.filter((r) => r.ownerId === ownerId)).map((r) => ({ ...r }));
  }

  async listEnabledByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    return (await this.listByOwner(ownerId)).filter((r) => r.enabled);
  }

  async update(id: string, patch: AutomationRuleUpdateInput): Promise<AutomationRuleRecord | null> {
    const rec = this.db.state.automationRules.find((r) => r.id === id);
    if (!rec) return null;
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.deviceId !== undefined) rec.deviceId = patch.deviceId;
    if (patch.conditionType !== undefined) rec.conditionType = patch.conditionType;
    if (patch.threshold !== undefined) rec.threshold = patch.threshold;
    if (patch.enabled !== undefined) rec.enabled = patch.enabled;
    rec.updatedAt = new Date();
    this.db.persist();
    return { ...rec };
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.db.state.automationRules.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    this.db.state.automationRules.splice(idx, 1);
    this.db.persist();
    return true;
  }
}

export class DiskNotificationStore implements NotificationStore {
  private readonly db: DiskBackend;

  constructor(db: DiskBackend) {
    this.db = db;
  }

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
    this.db.state.notifications.push(rec);
    this.db.persist();
    return { ...rec };
  }

  async listByOwner(
    ownerId: string,
    opts?: { packageName?: string; kind?: "device" | "automation"; limit?: number },
  ): Promise<NotificationRecord[]> {
    const limit = opts?.limit ?? 100;
    return desc(this.db.state.notifications.filter((r) => r.ownerId === ownerId))
      .filter((r) => !opts?.packageName || r.packageName === opts.packageName)
      .filter((r) => !opts?.kind || r.kind === opts.kind)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async listByDevice(deviceId: string, limit = 100): Promise<NotificationRecord[]> {
    return desc(this.db.state.notifications.filter((r) => r.deviceId === deviceId))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

// --- Blob di disk (streaming) ---

function sanitizeBlobId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200) || "blob";
}

/** BlobStore berbasis file: `<dir>/<transferId>.bin`, tulis/baca streaming. */
export class DiskBlobStore implements BlobStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private filePath(id: string): string {
    return join(this.dir, `${sanitizeBlobId(id)}.bin`);
  }

  put(id: string, data: Buffer): void {
    const tmp = `${this.filePath(id)}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, this.filePath(id));
  }

  get(id: string): Buffer | null {
    try {
      return readFileSync(this.filePath(id));
    } catch {
      return null;
    }
  }

  delete(id: string): void {
    try { unlinkSync(this.filePath(id)); } catch { /* sudah tidak ada */ }
  }

  exists(id: string): boolean {
    return existsSync(this.filePath(id));
  }

  size(id: string): number | null {
    try {
      return statSync(this.filePath(id)).size;
    } catch {
      return null;
    }
  }

  /** Stream tulis: byte mengalir dari request ke disk tanpa menahan RAM. */
  createWriteStream(id: string): ReturnType<typeof createWriteStream> {
    return createWriteStream(this.filePath(id));
  }

  /** Stream baca: byte mengalir dari disk ke respons HTTP. */
  createReadStream(id: string): ReturnType<typeof createReadStream> | null {
    try {
      return createReadStream(this.filePath(id));
    } catch {
      return null;
    }
  }

  /** Daftar semua id blob yang ada di disk. */
  listIds(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".bin"))
        .map((f) => f.slice(0, -4));
    } catch {
      return [];
    }
  }

  /**
   * Bersihkan blob yatim/kedaluwarsa: hapus file yang transfer-nya sudah
   * terminal/kedaluwarsa, atau yang tidak punya transfer sama sekali dan
   * lebih tua dari TTL. Mengembalikan jumlah file yang dihapus.
   */
  sweep(keepIds: Set<string>, olderThanMs = TRANSFER_TTL_MS): number {
    let removed = 0;
    const now = Date.now();
    for (const id of this.listIds()) {
      if (keepIds.has(id)) continue;
      try {
        const mtime = statSync(this.filePath(id)).mtimeMs;
        if (now - mtime > olderThanMs) {
          unlinkSync(this.filePath(id));
          removed++;
        }
      } catch { /* abaikan */ }
    }
    return removed;
  }
}

/** Bangun semua store disk dari satu backend bersama. */
export function createDiskStores(filePath: string): {
  backend: DiskBackend;
  userStore: DiskUserStore;
  pairingStore: DiskPairingStore;
  deviceStore: DiskDeviceStore;
  sessionStore: DiskSessionStore;
  transferStore: DiskTransferStore;
  keyStore: DiskDeviceKeyStore;
  permissionStore: DiskPermissionStore;
  activityStore: DiskActivityLogStore;
  ruleStore: DiskAutomationRuleStore;
  notificationStore: DiskNotificationStore;
} {
  const backend = new DiskBackend(filePath);
  return {
    backend,
    userStore: new DiskUserStore(backend),
    pairingStore: new DiskPairingStore(backend),
    deviceStore: new DiskDeviceStore(backend),
    sessionStore: new DiskSessionStore(backend),
    transferStore: new DiskTransferStore(backend),
    keyStore: new DiskDeviceKeyStore(backend),
    permissionStore: new DiskPermissionStore(backend),
    activityStore: new DiskActivityLogStore(backend),
    ruleStore: new DiskAutomationRuleStore(backend),
    notificationStore: new DiskNotificationStore(backend),
  };
}

/**
 * Cleanup berkala (dipanggil server tiap 60 detik): tandai transfer
 * kedaluwarsa, hapus blob transfer terminal/kedaluwarsa & blob yatim
 * yang lebih tua dari TTL. Mengembalikan {expired, blobsRemoved}.
 */
export async function cleanupDiskStores(
  transferStore: DiskTransferStore,
  blobStore: DiskBlobStore,
): Promise<{ expired: number; blobsRemoved: number }> {
  const expired = await transferStore.expireStale(new Date());
  const all = await transferStore.listAll();
  const keepIds = new Set(
    all.filter((t) => t.status === "waiting-upload" || t.status === "ready").map((t) => t.id),
  );
  const blobsRemoved = blobStore.sweep(keepIds);
  return { expired: expired.length, blobsRemoved };
}
