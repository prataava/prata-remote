// PRATA Remote — Mesin evaluasi aturan otomatisasi (FINAL, Bagian 6)
// Dipanggil server saat (a) metrik perangkat masuk, (b) perangkat offline,
// (c) sesi remote dimulai/berakhir. Aturan yang kondisinya terpenuhi
// menghasilkan: entri notifikasi kind "automation" + activity log +
// event WS automation_alert ke controller pemilik (lewat callback notify).
import type { ActivityLogStore } from "./activity-logs.ts";
import type { AutomationRuleStore } from "./automation.ts";
import type { NotificationStore } from "./notifications.ts";
import type { DeviceMetrics } from "../signaling/types.ts";

export interface AutomationEvent {
  /** Jenis pemicu: metrik masuk / perangkat offline / sesi mulai / sesi akhir. */
  kind: "metrics" | "offline" | "session_started" | "session_ended";
  ownerId: string;
  deviceId: string;
  metrics?: DeviceMetrics;
}

export interface AutomationAlert {
  ruleId: string;
  ruleName: string;
  deviceId: string;
  message: string;
  at: string;
}

export interface AutomationEngineDeps {
  ruleStore: AutomationRuleStore;
  notificationStore: NotificationStore;
  activityStore: ActivityLogStore;
  /** Kirim alert ke controller pemilik (WS). Boleh null bila tak ada WS. */
  notify?: (ownerId: string, alert: AutomationAlert) => void;
  /** Anti-spam: satu aturan yang sama tidak memicu lebih dari sekali per jendela ini. */
  cooldownMs?: number;
}

/** Persen penyimpanan TERPAKAI dari metrik (null bila data tak lengkap). */
export function storageUsedPct(metrics: DeviceMetrics): number | null {
  const total = metrics.storageTotalBytes;
  const free = metrics.storageFreeBytes;
  if (total == null || free == null || total <= 0) return null;
  return Math.round(((total - free) / total) * 100);
}

export function createAutomationEngine(deps: AutomationEngineDeps) {
  const cooldownMs = deps.cooldownMs ?? 15 * 60 * 1000;
  const lastFired = new Map<string, number>();

  async function fire(ruleId: string, ruleName: string, event: AutomationEvent, message: string): Promise<void> {
    const now = Date.now();
    const key = `${ruleId}:${event.deviceId}:${event.kind}`;
    const last = lastFired.get(key) ?? 0;
    if (now - last < cooldownMs) return; // Anti-spam: satu alert per 15 menit per aturan.
    lastFired.set(key, now);
    const alert: AutomationAlert = {
      ruleId,
      ruleName,
      deviceId: event.deviceId,
      message,
      at: new Date().toISOString(),
    };
    await deps.notificationStore.append({
      ownerId: event.ownerId,
      deviceId: event.deviceId,
      kind: "automation",
      title: ruleName,
      text: message,
    });
    await deps.activityStore.append({
      userId: event.ownerId,
      deviceId: event.deviceId,
      action: "automation-alert",
      detail: `${ruleName}: ${message}`,
    });
    deps.notify?.(event.ownerId, alert);
  }

  async function evaluate(event: AutomationEvent): Promise<void> {
    const rules = await deps.ruleStore.listEnabledByOwner(event.ownerId);
    for (const rule of rules) {
      // Aturan device-spesifik hanya berlaku untuk device itu.
      if (rule.deviceId && rule.deviceId !== event.deviceId) continue;
      switch (rule.conditionType) {
        case "battery_below": {
          if (event.kind !== "metrics" || event.metrics?.batteryPct == null) break;
          const threshold = rule.threshold ?? 20;
          if (event.metrics.batteryPct < threshold) {
            await fire(rule.id, rule.name, event, `Baterai perangkat ${event.metrics.batteryPct}% (di bawah ${threshold}%).`);
          }
          break;
        }
        case "storage_above": {
          if (event.kind !== "metrics" || !event.metrics) break;
          const used = storageUsedPct(event.metrics);
          const threshold = rule.threshold ?? 90;
          if (used != null && used > threshold) {
            await fire(rule.id, rule.name, event, `Penyimpanan perangkat terpakai ${used}% (di atas ${threshold}%).`);
          }
          break;
        }
        case "device_offline": {
          if (event.kind === "offline") {
            await fire(rule.id, rule.name, event, "Perangkat terputus dari server (offline).");
          }
          break;
        }
        case "session_started": {
          if (event.kind === "session_started") {
            await fire(rule.id, rule.name, event, "Sesi remote dimulai.");
          }
          break;
        }
        case "session_ended": {
          if (event.kind === "session_ended") {
            await fire(rule.id, rule.name, event, "Sesi remote berakhir.");
          }
          break;
        }
      }
    }
  }

  return { evaluate };
}
