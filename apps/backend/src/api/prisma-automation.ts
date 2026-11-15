// PRATA Remote — Store aturan otomatisasi dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat AUTOMATION_RULE_STORE=prisma. Hanya dimuat saat dipilih.
import { PrismaClient } from "@prisma/client";
import type {
  AutomationConditionType,
  AutomationRuleCreateInput,
  AutomationRuleRecord,
  AutomationRuleStore,
  AutomationRuleUpdateInput,
} from "./automation.ts";

function toRecord(r: {
  id: string;
  ownerId: string;
  deviceId: string | null;
  name: string;
  conditionType: string;
  threshold: number | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AutomationRuleRecord {
  return {
    id: r.id,
    ownerId: r.ownerId,
    deviceId: r.deviceId,
    name: r.name,
    conditionType: r.conditionType as AutomationConditionType,
    threshold: r.threshold,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class PrismaAutomationRuleStore implements AutomationRuleStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async create(input: AutomationRuleCreateInput): Promise<AutomationRuleRecord> {
    const r = await this.prisma.automationRule.create({
      data: {
        ownerId: input.ownerId,
        deviceId: input.deviceId ?? null,
        name: input.name,
        conditionType: input.conditionType,
        threshold: input.threshold ?? null,
      },
    });
    return toRecord(r);
  }

  async get(id: string): Promise<AutomationRuleRecord | null> {
    const r = await this.prisma.automationRule.findUnique({ where: { id } });
    return r ? toRecord(r) : null;
  }

  async listByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    const rows = await this.prisma.automationRule.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async listEnabledByOwner(ownerId: string): Promise<AutomationRuleRecord[]> {
    const rows = await this.prisma.automationRule.findMany({
      where: { ownerId, enabled: true },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toRecord);
  }

  async update(id: string, patch: AutomationRuleUpdateInput): Promise<AutomationRuleRecord | null> {
    const r = await this.prisma.automationRule
      .update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.deviceId !== undefined ? { deviceId: patch.deviceId } : {}),
          ...(patch.conditionType !== undefined ? { conditionType: patch.conditionType } : {}),
          ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        },
      })
      .catch(() => null);
    return r ? toRecord(r) : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.prisma.automationRule.delete({ where: { id } }).then(
      () => true,
      () => false,
    );
  }
}
