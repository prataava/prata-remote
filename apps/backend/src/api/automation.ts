// PRATA Remote — Store aturan otomatisasi (FINAL, Bagian 1 & 6)
// conditionType ∈ battery_below, storage_above (persen penyimpanan
// TERPAKAI di atas ambang), device_offline, session_started,
// session_ended. threshold dipakai battery_below & storage_above (0..100).
import { randomBytes } from "node:crypto";

export type AutomationConditionType =
  | "battery_below"
  | "storage_above"
  | "device_offline"
  | "session_started"
  | "session_ended";

export const AUTOMATION_CONDITIONS: readonly AutomationConditionType[] = [
  "battery_below",
  "storage_above",
  "device_offline",
  "session_started",
  "session_ended",
];

export interface AutomationRuleRecord {
  id: string;
  ownerId: string;
  deviceId: string | null;
  name: string;
  conditionType: AutomationConditionType;
  threshold: number | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationRuleCreateInput {
  ownerId: string;
  deviceId?: string | null;
  name: string;
  conditionType: AutomationConditionType;
  threshold?: number | null;
}

export interface AutomationRuleUpdateInput {
  name?: string;
  deviceId?: string | null;
  conditionType?: AutomationConditionType;
  threshold?: number | null;
  enabled?: boolean;
}

export interface AutomationRuleStore {
  create(input: AutomationRuleCreateInput): Promise<AutomationRuleRecord>;
  get(id: string): Promise<AutomationRuleRecord | null>;
  listByOwner(ownerId: string): Promise<AutomationRuleRecord[]>;
  listEnabledByOwner(ownerId: string): Promise<AutomationRuleRecord[]>;
  update(id: string, patch: AutomationRuleUpdateInput): Promise<AutomationRuleRecord | null>;
  delete(id: string): Promise<boolean>;
}

export function newAutomationRuleId(): string {
  return `rule_${Date.now().toString(36)}_${randomBytes(6).toString("base64url")}`;
}

export class MemoryAutomationRuleStore implements AutomationRuleStore {
  private readonly records = new Map<string, AutomationRuleRecord>();

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
    this.records.set(rec.id, rec);
    return { ...rec };
  }

  async get(id: string): Promise<AutomationRuleRecord | null> {
    const rec = this.records.get(id);
    return rec ? { ...rec } : null;
  }

  async listByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
  }

  async listEnabledByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    return (await this.listByOwner(ownerId)).filter((r) => r.enabled);
  }

  async update(id: string, patch: AutomationRuleUpdateInput): Promise<AutomationRuleRecord | null> {
    const rec = this.records.get(id);
    if (!rec) return null;
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.deviceId !== undefined) rec.deviceId = patch.deviceId;
    if (patch.conditionType !== undefined) rec.conditionType = patch.conditionType;
    if (patch.threshold !== undefined) rec.threshold = patch.threshold;
    if (patch.enabled !== undefined) rec.enabled = patch.enabled;
    rec.updatedAt = new Date();
    return { ...rec };
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}
