// PRATA Remote — Bootstrap backend (Command 001 + 002)
// Menjalankan signaling server (WS) + REST API di SATU server HTTP.
// Konfigurasi lewat environment:
//   PORT                 (default 8080)
//   HOST                 (default 0.0.0.0)
//   JWT_SECRET           (WAJIB, kecuali PRATA_DEV=1)
//   PRATA_DEV=1          (pengembangan: secret dev + seed dev aktif)
//   USER_STORE           memory | disk | prisma  (default: disk bila DATABASE_URL kosong, prisma bila ada)
//   PAIRING_STORE        memory | disk | prisma  (default sama)
//   DEVICE_STORE         memory | disk | prisma  (default sama; alias lama: DEVICE_REGISTRY)
//   SESSION_STORE        memory | disk | prisma  (default sama)
//   TRANSFER_STORE       memory | disk | prisma  (default sama; metadata transfer file)
//   DEVICE_KEY_STORE     memory | disk | prisma  (default sama; kunci perangkat)
//   PERMISSION_STORE     memory | disk | prisma  (default sama; izin fitur Agent)
//   ACTIVITY_LOG_STORE   memory | disk | prisma  (default sama; audit trail)
//   AUTOMATION_RULE_STORE memory | disk | prisma (default sama; aturan otomatisasi)
//   NOTIFICATION_STORE   memory | disk | prisma  (default sama; riwayat notifikasi)
//   BLOB_STORE           disk | memory          (default disk — byte di data/blobs/)
//   DATABASE_URL         (wajib bila ada store prisma)
//   PRATA_DATA_FILE      (default apps/backend/data/prata-store.json)
//   PRATA_BLOB_DIR       (default apps/backend/data/blobs)
//   PRATA_WEB_DIR        (default apps/web — dashboard disajikan di port yang sama)
//   PRATA_RELEASES_DIR   (default apps/backend/public/releases — APK rilis)
//   PRATA_SOURCE_BUNDLE  (default apps/backend/public/releases/prata-remote-full-release.tar.gz)
//   LOGIN_TOKEN_TTL_SEC  (default 28800 = 8 jam)
//   PRATA_SEED_USER      "email:password[:nama]" (dev: buat user bila belum ada)
//   PRATA_AGENT_TOKENS   "device-1:token-1,device-2:token-2" (dev: seed perangkat)
//   PRATA_AGENT_OWNERS   "device-1:user-1" (dev: pemilik perangkat seed)
//   HEARTBEAT_TIMEOUT_MS (default 45000)
//   PRESENCE_SWEEP_MS    (default 10000)
//   TURN_URLS            "turn:turn.contoh.com:3478" (opsional, dipisah koma)
//   TURN_USERNAME        (opsional, wajib bila TURN_URLS diisi)
//   TURN_CREDENTIAL      (opsional, wajib bila TURN_URLS diisi)
// Jalankan:  node src/index.ts   (Node >= 22, type-stripping aktif)
//   atau:    npm run dev         (watch mode)
import { startSignalingServer } from "./signaling/server.ts";
import { buildIceServers } from "./signaling/ice-config.ts";
import type { PresenceTracker } from "./signaling/presence.ts";
import { StoreDeviceRegistry } from "./registry/store-registry.ts";
import { MemorySessionStore } from "./store/session-store.ts";
import { MemoryUserStore } from "./api/users.ts";
import { MemoryPairingStore } from "./api/pairings.ts";
import { MemoryDeviceStore } from "./api/devices.ts";
import { createRestRouter } from "./api/router.ts";
import { hashPassword } from "./api/passwords.ts";
import { hashToken } from "./signaling/auth.ts";
import { MemoryBlobStore, MemoryTransferStore } from "./api/transfers.ts";
import type { BlobStore } from "./api/transfers.ts";
import type { TransferStore } from "./api/transfers.ts";
import { MemoryDeviceKeyStore } from "./api/device-keys.ts";
import type { DeviceKeyStore } from "./api/device-keys.ts";
import { MemoryPermissionStore } from "./api/permissions.ts";
import type { PermissionStore } from "./api/permissions.ts";
import { MemoryActivityLogStore } from "./api/activity-logs.ts";
import type { ActivityLogStore } from "./api/activity-logs.ts";
import { MemoryAutomationRuleStore } from "./api/automation.ts";
import type { AutomationRuleStore } from "./api/automation.ts";
import { MemoryNotificationStore } from "./api/notifications.ts";
import type { NotificationStore } from "./api/notifications.ts";
import type { DeviceStore } from "./api/devices.ts";
import type { UserStore } from "./api/users.ts";
import type { PairingStore } from "./api/pairings.ts";
import type { SessionStore } from "./store/session-store.ts";
import { createDiskStores, cleanupDiskStores, DiskBlobStore } from "./store/disk-store.ts";
import type { DiskBackend } from "./store/disk-store.ts";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_SECRET = "dev-only-change-me";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parsePairs(envValue: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (envValue ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return map;
}

type StoreKind = "memory" | "disk" | "prisma";

/** Default store: disk (persisten file) bila DATABASE_URL kosong;
 *  prisma bila DATABASE_URL diset. Env eksplisit selalu menang. */
function defaultStoreKind(): StoreKind {
  return process.env.DATABASE_URL ? "prisma" : "disk";
}

function storeKind(name: string, fallback: StoreKind = defaultStoreKind()): StoreKind {
  const raw = (process.env[name] ?? fallback).toLowerCase();
  if (raw !== "memory" && raw !== "disk" && raw !== "prisma") {
    throw new Error(`${name} tidak dikenal: ${raw} (pilih memory|disk|prisma)`);
  }
  return raw as StoreKind;
}

/** DEVICE_REGISTRY lama (env|prisma) dipetakan ke DEVICE_STORE (memory|disk|prisma). */
function legacyDeviceStoreKind(): StoreKind {
  const raw = (process.env.DEVICE_REGISTRY ?? "").toLowerCase();
  if (!raw || raw === "env") return defaultStoreKind();
  if (raw === "prisma") return "prisma";
  throw new Error(`DEVICE_REGISTRY tidak dikenal: ${raw} (pilih env|prisma)`);
}

function deviceStoreKind(): StoreKind {
  return process.env.DEVICE_STORE ? storeKind("DEVICE_STORE") : legacyDeviceStoreKind();
}

// Satu instance DiskBackend bersama untuk semua adapter disk.
let diskStoresInstance: ReturnType<typeof createDiskStores> | null = null;

function diskStores(): ReturnType<typeof createDiskStores> {
  if (!diskStoresInstance) {
    const here = dirname(fileURLToPath(import.meta.url));
    const dataFile = process.env.PRATA_DATA_FILE ?? join(here, "..", "data", "prata-store.json");
    diskStoresInstance = createDiskStores(dataFile);
  }
  return diskStoresInstance;
}

async function buildUserStore(kind: StoreKind): Promise<UserStore> {
  if (kind === "prisma") {
    const { PrismaUserStore } = await import("./api/prisma-users.ts");
    return new PrismaUserStore();
  }
  if (kind === "disk") return diskStores().userStore;
  return new MemoryUserStore();
}

async function buildPairingStore(kind: StoreKind): Promise<PairingStore> {
  if (kind === "prisma") {
    const { PrismaPairingStore } = await import("./api/prisma-pairings.ts");
    return new PrismaPairingStore();
  }
  if (kind === "disk") return diskStores().pairingStore;
  return new MemoryPairingStore();
}

async function buildDeviceStore(kind: StoreKind): Promise<DeviceStore> {
  if (kind === "prisma") {
    const { PrismaDeviceStore } = await import("./api/prisma-devices.ts");
    return new PrismaDeviceStore();
  }
  if (kind === "disk") return diskStores().deviceStore;
  return new MemoryDeviceStore();
}

async function buildSessionStore(kind: StoreKind): Promise<SessionStore> {
  if (kind === "prisma") {
    const { PrismaSessionStore } = await import("./store/prisma-session-store.ts");
    return new PrismaSessionStore();
  }
  if (kind === "disk") return diskStores().sessionStore;
  return new MemorySessionStore();
}

async function buildTransferStore(kind: StoreKind): Promise<TransferStore> {
  if (kind === "prisma") {
    const { PrismaTransferStore } = await import("./api/prisma-transfers.ts");
    return new PrismaTransferStore();
  }
  if (kind === "disk") return diskStores().transferStore;
  return new MemoryTransferStore();
}

async function buildDeviceKeyStore(kind: StoreKind): Promise<DeviceKeyStore> {
  if (kind === "prisma") {
    const { PrismaDeviceKeyStore } = await import("./api/prisma-device-keys.ts");
    return new PrismaDeviceKeyStore();
  }
  if (kind === "disk") return diskStores().keyStore;
  return new MemoryDeviceKeyStore();
}

async function buildPermissionStore(kind: StoreKind): Promise<PermissionStore> {
  if (kind === "prisma") {
    const { PrismaPermissionStore } = await import("./api/prisma-permissions.ts");
    return new PrismaPermissionStore();
  }
  if (kind === "disk") return diskStores().permissionStore;
  return new MemoryPermissionStore();
}

async function buildActivityLogStore(kind: StoreKind): Promise<ActivityLogStore> {
  if (kind === "prisma") {
    const { PrismaActivityLogStore } = await import("./api/prisma-activity-logs.ts");
    return new PrismaActivityLogStore();
  }
  if (kind === "disk") return diskStores().activityStore;
  return new MemoryActivityLogStore();
}

async function buildAutomationRuleStore(kind: StoreKind): Promise<AutomationRuleStore> {
  if (kind === "prisma") {
    const { PrismaAutomationRuleStore } = await import("./api/prisma-automation.ts");
    return new PrismaAutomationRuleStore();
  }
  if (kind === "disk") return diskStores().ruleStore;
  return new MemoryAutomationRuleStore();
}

async function buildNotificationStore(kind: StoreKind): Promise<NotificationStore> {
  if (kind === "prisma") {
    const { PrismaNotificationStore } = await import("./api/prisma-notifications.ts");
    return new PrismaNotificationStore();
  }
  if (kind === "disk") return diskStores().notificationStore;
  return new MemoryNotificationStore();
}

function buildBlobStore(): BlobStore {
  const kind = (process.env.BLOB_STORE ?? "disk").toLowerCase();
  if (kind === "memory") return new MemoryBlobStore();
  if (kind !== "disk") throw new Error(`BLOB_STORE tidak dikenal: ${kind} (pilih disk|memory)`);
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = process.env.PRATA_BLOB_DIR ?? join(here, "..", "data", "blobs");
  return new DiskBlobStore(dir);
}

/** Seed user dev dari PRATA_SEED_USER (hanya bila PRATA_DEV=1). */
async function seedDevUser(userStore: UserStore): Promise<void> {
  const raw = process.env.PRATA_SEED_USER;
  if (!raw) return;
  const parts = raw.split(":");
  const email = parts[0]?.trim();
  const password = parts[1]?.trim();
  const name = parts[2]?.trim();
  if (!email || !password) {
    console.warn("PRATA_SEED_USER diabaikan: format harus email:password[:nama].");
    return;
  }
  if (await userStore.findByEmail(email)) return;
  await userStore.create({ email, passwordHash: hashPassword(password), name: name || undefined });
  console.log(`Seed user dev dibuat: ${email}`);
}

/** Seed perangkat dev dari PRATA_AGENT_TOKENS ke DeviceStore (satu sumber kebenaran). */
async function seedEnvDevices(deviceStore: DeviceStore): Promise<void> {
  const tokens = parsePairs(process.env.PRATA_AGENT_TOKENS);
  if (tokens.size === 0) return;
  const owners = parsePairs(process.env.PRATA_AGENT_OWNERS);
  for (const [deviceId, token] of tokens) {
    if (await deviceStore.getById(deviceId)) continue;
    await deviceStore.create({
      id: deviceId,
      ownerId: owners.get(deviceId) ?? "dev-owner",
      name: deviceId,
      agentTokenHash: hashToken(token),
    });
  }
  console.log(`Seed perangkat dev: ${tokens.size} perangkat dari PRATA_AGENT_TOKENS.`);
}

async function main(): Promise<void> {
  const isDev = process.env.PRATA_DEV === "1";
  let jwtSecret = process.env.JWT_SECRET ?? "";
  if (!jwtSecret) {
    if (!isDev) {
      console.error(
        "FATAL: JWT_SECRET belum diset. Set JWT_SECRET di environment, atau jalankan dengan PRATA_DEV=1 (pengembangan saja).",
      );
      process.exit(1);
    }
    jwtSecret = DEV_SECRET;
    console.warn("PERINGATAN: PRATA_DEV=1 — memakai JWT secret dev. JANGAN dipakai di produksi.");
  }
  if (process.env.DEVICE_REGISTRY) {
    console.warn("PERINGATAN: DEVICE_REGISTRY sudah tidak dipakai (Command 002). Pakai DEVICE_STORE.");
  }
  if (isDev) {
    console.warn("PERINGATAN: mode pengembangan (PRATA_DEV=1). Store memory + seed dev aktif bila dipilih.");
  }

  const userStore = await buildUserStore(storeKind("USER_STORE"));
  const pairingStore = await buildPairingStore(storeKind("PAIRING_STORE"));
  const deviceStore = await buildDeviceStore(deviceStoreKind());
  const sessionStore = await buildSessionStore(storeKind("SESSION_STORE"));
  const transferStore = await buildTransferStore(storeKind("TRANSFER_STORE"));
  // Blob byte di DISK secara default (data/blobs/) — streaming, TTL cleanup.
  const blobStore: BlobStore = buildBlobStore();
  const keyStore = await buildDeviceKeyStore(storeKind("DEVICE_KEY_STORE"));
  const permissionStore = await buildPermissionStore(storeKind("PERMISSION_STORE"));
  const activityStore = await buildActivityLogStore(storeKind("ACTIVITY_LOG_STORE"));
  const ruleStore = await buildAutomationRuleStore(storeKind("AUTOMATION_RULE_STORE"));
  const notificationStore = await buildNotificationStore(storeKind("NOTIFICATION_STORE"));
  const diskBackend: DiskBackend | null = diskStoresInstance?.backend ?? null;
  const here = dirname(fileURLToPath(import.meta.url));
  const webDir = process.env.PRATA_WEB_DIR ?? join(here, "..", "..", "web");
  const releasesDir = process.env.PRATA_RELEASES_DIR ?? join(here, "..", "public", "releases");
  const sourceBundlePath =
    process.env.PRATA_SOURCE_BUNDLE ?? join(releasesDir, "prata-remote-full-release.tar.gz");
  console.log(
    `Store: ${storeKind("USER_STORE") === "disk" ? "disk (persisten)" : storeKind("USER_STORE")} | data: ${diskBackend?.filePath ?? "-"} | blob: ${blobStore instanceof DiskBlobStore ? (blobStore as DiskBlobStore).dir : "memory"} | web: ${existsSync(webDir) ? webDir : "tidak ditemukan"} | rilis: ${releasesDir}`,
  );
  if (isDev) {
    await seedDevUser(userStore);
    await seedEnvDevices(deviceStore);
  }

  // Presence diisi sesudah signaling server jalan; router membaca lewat holder.
  let presenceRef: PresenceTracker | null = null;
  // Pengirim WS ke agen (Command 008): dipakai router untuk
  // file_download_request / file_upload_ready. Diisi sesudah server jalan.
  let sendToAgentRef: ((deviceId: string, msg: Record<string, unknown>) => boolean) | null = null;
  let disconnectDeviceRef: ((deviceId: string, reason?: string) => void) | null = null;
  let terminateAllSessionsRef: ((controllerId: string, reason?: string) => Promise<number>) | null = null;
  const deviceRegistry = new StoreDeviceRegistry(deviceStore, keyStore);
  const iceServers = buildIceServers();
  const turnConfigured = iceServers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
  console.log(
    `Konfigurasi ICE: ${iceServers.length} entri (${turnConfigured ? "STUN + TURN" : "STUN saja, TURN belum dikonfigurasi"}).`,
  );
  const restRouter = createRestRouter({
    userStore,
    pairingStore,
    deviceStore,
    jwtSecret,
    loginTokenTtlSec: envInt("LOGIN_TOKEN_TTL_SEC", 8 * 3600),
    iceServers,
    getLiveStatus: (deviceId) => (presenceRef?.isOnline(deviceId) ? "online" : "offline"),
    getLiveLastSeen: (deviceId) => presenceRef?.lastSeenAt(deviceId) ?? null,
    transferStore,
    blobStore,
    verifyAgentToken: (deviceId, token) => deviceRegistry.verifyAgentToken(deviceId, token),
    sendToAgent: (deviceId, msg) => sendToAgentRef?.(deviceId, msg) ?? false,
    disconnectDevice: (deviceId, reason) => disconnectDeviceRef?.(deviceId, reason),
    terminateAllSessions: (controllerId, reason) => terminateAllSessionsRef?.(controllerId, reason) ?? Promise.resolve(0),
    keyStore,
    permissionStore,
    activityStore,
    ruleStore,
    notificationStore,
    releasesDir,
    sourceBundlePath,
  });

  const server = await startSignalingServer({
    port: envInt("PORT", 8080),
    host: process.env.HOST ?? "0.0.0.0",
    jwtSecret,
    deviceRegistry,
    sessionStore,
    heartbeatTimeoutMs: envInt("HEARTBEAT_TIMEOUT_MS", 45_000),
    presenceSweepMs: envInt("PRESENCE_SWEEP_MS", 10_000),
    iceServers,
    transferStore,
    blobStore,
    ruleStore,
    notificationStore,
    activityStore,
    permissionStore,
    staticDir: existsSync(webDir) ? webDir : undefined,
    onHttpRequest: restRouter,
  });
  presenceRef = server.presence;
  disconnectDeviceRef = (deviceId, reason) => server.disconnectDevice(deviceId, reason);
  terminateAllSessionsRef = (controllerId, reason) => server.terminateAllSessions(controllerId, reason);
  sendToAgentRef = (deviceId, msg) => {
    const socket = server.presence.getAgentSocket(deviceId);
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(msg));
    return true;
  };

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} diterima, menutup server...`);
    clearInterval(cleanupTimer);
    diskBackend?.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Cleanup berkala: transfer kedaluwarsa + blob yatim (hanya bila disk).
  const cleanupTimer = setInterval(
    () => {
      if (diskStoresInstance && blobStore instanceof DiskBlobStore) {
        void cleanupDiskStores(diskStoresInstance.transferStore, blobStore).then((r) => {
          if (r.expired > 0 || r.blobsRemoved > 0) {
            console.log(`Cleanup disk: ${r.expired} transfer kedaluwarsa, ${r.blobsRemoved} blob dihapus.`);
          }
        }).catch((err: unknown) => {
          console.error("Cleanup disk gagal:", err instanceof Error ? err.message : String(err));
        });
      }
    },
    60_000,
  );
  cleanupTimer.unref();
}

main().catch((err: unknown) => {
  console.error("FATAL: gagal menjalankan server:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
