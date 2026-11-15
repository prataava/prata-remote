// PRATA Remote — WebSocket Signaling Server (Command 001, Phase 1)
// Tugas server ini HANYA tiga hal:
//   1. Autentikasi (agen = token perangkat, controller = JWT HS256).
//   2. Kehadiran (online/offline/connecting) + heartbeat.
//   3. Relay pensinyalan WebRTC (offer/answer/ICE) HANYA di dalam sesi
//      yang sudah disetujui kedua pihak — tidak ada relay liar.
// Server ini TIDAK meneruskan media (video/audio/file) — itu tugas
// WebRTC peer-to-peer di Phase 2 (STUN/TURN). Server tidak pernah
// mencatat token/kata sandi ke log.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage, Role, SessionType, ErrorCode, IceServer, DeviceMetrics, FileItem, AppInfo, DeviceNotification } from "./types.ts";
import { verifyControllerToken } from "./auth.ts";
import { buildIceServers } from "./ice-config.ts";
import { PresenceTracker } from "./presence.ts";
import type { DeviceRegistry } from "../registry/device-registry.ts";
import type { SessionStore } from "../store/session-store.ts";
import type { BlobStore, TransferStore } from "../api/transfers.ts";
import { expireIfNeeded, finishTransfer } from "../api/transfers.ts";
import type { ActivityLogStore } from "../api/activity-logs.ts";
import type { AutomationRuleStore } from "../api/automation.ts";
import { createAutomationEngine } from "../api/automation-engine.ts";
import type { NotificationStore } from "../api/notifications.ts";
import type { PermissionStore } from "../api/permissions.ts";
import { PERMISSION_FEATURES } from "../api/permissions.ts";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export interface SignalingConfig {
  port: number;
  host?: string;
  jwtSecret: string;
  deviceRegistry: DeviceRegistry;
  sessionStore: SessionStore;
  heartbeatTimeoutMs?: number;
  presenceSweepMs?: number;
  authTimeoutMs?: number;
  maxMessagesPerMinute?: number;
  /** Konfigurasi ICE untuk pesan welcome. Default: buildIceServers(). */
  iceServers?: IceServer[];
  /** Store transfer file (Command 008). Bila tidak ada, ack file_transfer_done diabaikan. */
  transferStore?: TransferStore;
  blobStore?: BlobStore;
  /** Store FINAL (Bagian 1/4/6). Bila tidak ada, fitur terkait diabaikan jujur. */
  ruleStore?: AutomationRuleStore;
  notificationStore?: NotificationStore;
  activityStore?: ActivityLogStore;
  permissionStore?: PermissionStore;
  /** Hook HTTP (mis. REST router). true = permintaan sudah ditangani. */
  onHttpRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
  /** Folder Web Dashboard untuk disajikan di `/` (FINALISASI Langkah 2:
   *  backend + web satu port). Bila tidak diset, `/` mengembalikan JSON. */
  staticDir?: string;
}

export interface RunningServer {
  port: number;
  presence: PresenceTracker;
  /** Putus paksa soket agen satu device (dipakai revoke perangkat). */
  disconnectDevice: (deviceId: string, reason?: string) => void;
  /** Hentikan seluruh sesi aktif milik satu controller; kembalikan jumlah sesi. */
  terminateAllSessions: (controllerId: string, reason?: string) => Promise<number>;
  close: () => Promise<void>;
}

interface Room {
  sessionId: string;
  deviceId: string;
  controllerId: string;
  agentSocket: WebSocket;
  controllerSocket: WebSocket;
}

interface SocketState {
  authed: boolean;
  role: Role | null;
  peerId: string | null;
  isAdmin: boolean;
  deviceId: string | null;
  windowStart: number;
  messageCount: number;
}

const AUTH_TIMEOUT_MS_DEFAULT = 10_000;
const MAX_MESSAGES_PER_MINUTE_DEFAULT = 120;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[signal]", ...args);
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  send(socket, { type: "error", code, message });
}

export async function startSignalingServer(config: SignalingConfig): Promise<RunningServer> {
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 45_000;
  const presenceSweepMs = config.presenceSweepMs ?? 10_000;
  const authTimeoutMs = config.authTimeoutMs ?? AUTH_TIMEOUT_MS_DEFAULT;
  const maxMessagesPerMinute = config.maxMessagesPerMinute ?? MAX_MESSAGES_PER_MINUTE_DEFAULT;
  const iceServers = config.iceServers ?? buildIceServers();
  const presence = new PresenceTracker(heartbeatTimeoutMs);
  const rooms = new Map<string, Room>();
  // Soket controller per user id — SATU user bisa punya banyak koneksi
  // (Android Controller + Web Dashboard). Satu Set per user: koneksi kedua
  // TIDAK boleh menimpa yang pertama, dan menutup satu koneksi TIDAK
  // boleh menghapus entri user lain (bug lama: Map satu soket per user).
  const controllerSockets = new Map<string, Set<WebSocket>>();
  // Soket controller yang meminta tiap sesi (dipakai session-accept/
  // reject agar jawaban sampai ke peminta yang tepat bila user punya
  // beberapa koneksi).
  const sessionRequestSockets = new Map<string, WebSocket>();

  function sendToControllers(userId: string, msg: ServerMessage): void {
    const set = controllerSockets.get(userId);
    if (!set) return;
    for (const s of set) send(s, msg);
  }
  // Permintaan relay yang menunggu jawaban Agen (Command 008 + FINAL).
  // Dipasangkan lewat requestId; dibersihkan saat soket controller putus.
  type PendingKind = "file_list" | "file_op" | "app_list" | "app_command";
  const pendingRequests = new Map<string, { controllerSocket: WebSocket; deviceId: string; createdAt: number; kind: PendingKind }>();
  const PENDING_TIMEOUT_MS = 60_000;
  // Mesin otomatisasi (FINAL, Bagian 6): aktif bila ketiga store tersedia.
  const automationEngine =
    config.ruleStore && config.notificationStore && config.activityStore
      ? createAutomationEngine({
          ruleStore: config.ruleStore,
          notificationStore: config.notificationStore,
          activityStore: config.activityStore,
          notify: (ownerId, alert) => {
            sendToControllers(ownerId, { type: "automation_alert", ...alert });
          },
        })
      : null;
  const startedAt = Date.now();

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttp(req, res).catch((err: unknown) => {
      log("HTTP error:", err instanceof Error ? err.message : String(err));
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal-error", message: "Terjadi kesalahan di server." } }));
      }
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // CORS untuk Web Dashboard (FINAL, Bagian 7): dashboard disajikan dari
    // origin lain (mis. http.server :8000) dan memanggil REST API ini.
    // Origin diizinkan lewat env CORS_ORIGIN (default "*" untuk dev;
    // produksi isi dengan origin dashboard yang sebenarnya).
    const corsOrigin = process.env.CORS_ORIGIN ?? "*";
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name, X-File-Mime, X-Folder-DocId");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, PUT, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          devicesOnline: presence.onlineDeviceIds(),
          activeSessions: rooms.size,
          time: new Date().toISOString(),
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      // Bila staticDir diset, root menyajikan Web Dashboard (index.html).
      // Tanpa staticDir, pertahankan respons JSON lama.
      if (config.staticDir) {
        serveStatic(req, res, url.pathname);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "prata-remote-signaling", version: "0.1.0", health: "/healthz" }));
      return;
    }
    if (config.staticDir && req.method === "GET" && !url.pathname.startsWith("/api/")) {
      serveStatic(req, res, url.pathname);
      return;
    }
    if (config.onHttpRequest) {
      const handled = await config.onHttpRequest(req, res);
      if (handled) return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "not-found", message: "Rute tidak ditemukan." } }));
  }

  const STATIC_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain; charset=utf-8",
  };

  /** Sajikan berkas statis dari staticDir; SPA fallback ke index.html. */
  function serveStatic(_req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const root = resolve(config.staticDir as string);
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    let target = resolve(join(root, rel));
    // Cegah traversal: target wajib tetap di dalam root.
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "forbidden", message: "Jalur tidak diizinkan." } }));
      return;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      // SPA fallback: rute tanpa ekstensi -> index.html (dashboard SPA).
      if (!extname(target)) {
        target = join(root, "index.html");
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not-found", message: "Berkas tidak ditemukan." } }));
        return;
      }
    }
    if (!existsSync(target)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not-found", message: "Berkas tidak ditemukan." } }));
      return;
    }
    const type = STATIC_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": statSync(target).size });
    createReadStream(target).pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  async function endSessionsForDevice(deviceId: string, reason: string): Promise<void> {
    for (const [sessionId, room] of [...rooms]) {
      if (room.deviceId !== deviceId) continue;
      rooms.delete(sessionId);
      await config.sessionStore.setStatus(sessionId, "ended", reason).catch(() => null);
      await config.activityStore
        ?.append({ userId: room.controllerId, deviceId, action: "session-end", detail: `${sessionId}: ${reason}` })
        .catch(() => null);
      await automationEngine
        ?.evaluate({ kind: "session_ended", ownerId: room.controllerId, deviceId })
        .catch(() => null);
      send(room.controllerSocket, { type: "session-ended", sessionId, reason });
    }
  }

  async function endSessionsForController(controllerId: string, reason: string): Promise<void> {
    for (const [sessionId, room] of [...rooms]) {
      if (room.controllerId !== controllerId) continue;
      rooms.delete(sessionId);
      await config.sessionStore.setStatus(sessionId, "ended", reason).catch(() => null);
      await config.activityStore
        ?.append({ userId: controllerId, deviceId: room.deviceId, action: "session-end", detail: `${sessionId}: ${reason}` })
        .catch(() => null);
      await automationEngine
        ?.evaluate({ kind: "session_ended", ownerId: controllerId, deviceId: room.deviceId })
        .catch(() => null);
      send(room.agentSocket, { type: "session-ended", sessionId, reason });
    }
  }

  /** Putus paksa soket agen (revoke perangkat): close handler membereskan
   *  presence + sesi + evaluasi offline. */
  function disconnectDevice(deviceId: string, reason = "device-revoked"): void {
    const socket = presence.getAgentSocket(deviceId);
    if (socket) socket.close(4403, reason);
  }

  /** Evaluasi aturan device_offline untuk satu device yang baru offline. */
  async function handleDeviceOffline(deviceId: string): Promise<void> {
    if (!automationEngine) return;
    const ownerId = await config.deviceRegistry.getOwner(deviceId);
    if (!ownerId) return;
    await automationEngine.evaluate({ kind: "offline", ownerId, deviceId }).catch(() => null);
  }

  const sweepTimer = setInterval(() => {
    const dropped = presence.sweep();
    for (const deviceId of dropped) {
      log("presence sweep: offline", deviceId);
      void endSessionsForDevice(deviceId, "agent-timeout");
      void handleDeviceOffline(deviceId);
    }
  }, presenceSweepMs);
  sweepTimer.unref?.();

  wss.on("connection", (socket: WebSocket) => {
    const state: SocketState = {
      authed: false,
      role: null,
      peerId: null,
      isAdmin: false,
      deviceId: null,
      windowStart: Date.now(),
      messageCount: 0,
    };

    const authTimer = setTimeout(() => {
      if (!state.authed) {
        sendError(socket, "auth-required", "Kirim pesan hello dalam 10 detik setelah terhubung.");
        socket.close(4401, "auth timeout");
      }
    }, authTimeoutMs);
    authTimer.unref?.();

    // Pesan dari satu soket diproses BERURUTAN (antrean promise). Tanpa ini,
    // pesan accept + offer yang dikirim berurutan bisa diproses terbalik
    // (offer tiba sebelum rooms.set) dan ditolak not-in-session — persis
    // alur agent Command 003 (accept lalu langsung offer).
    let messageQueue = Promise.resolve();
    socket.on("message", (raw: Buffer) => {
      messageQueue = messageQueue.then(() => handleMessage(socket, state, raw)).catch((err: unknown) => {
        log("handleMessage error:", err instanceof Error ? err.message : String(err));
        sendError(socket, "bad-message", "Gagal memproses pesan.");
      });
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      presence.unwatchAll(socket);
      for (const [requestId, pending] of [...pendingRequests]) {
        if (pending.controllerSocket === socket) pendingRequests.delete(requestId);
      }
      if (state.role === "agent" && state.deviceId) {
        presence.agentDisconnected(state.deviceId);
        log("agent offline:", state.deviceId);
        void endSessionsForDevice(state.deviceId, "agent-disconnected");
        void handleDeviceOffline(state.deviceId);
      }
      if (state.role === "controller" && state.peerId) {
        const set = controllerSockets.get(state.peerId);
        if (set) {
          set.delete(socket);
          if (set.size === 0) controllerSockets.delete(state.peerId);
        }
        void endSessionsForController(state.peerId, "controller-disconnected");
      }
    });

    socket.on("error", () => {
      // close handler di atas yang membereskan state.
    });

    async function handleMessage(socket: WebSocket, state: SocketState, raw: Buffer): Promise<void> {
      // Rate limit sederhana per soket (jendela 60 detik, geser).
      const now = Date.now();
      if (now - state.windowStart >= 60_000) {
        state.windowStart = now;
        state.messageCount = 0;
      }
      state.messageCount += 1;
      if (state.messageCount > maxMessagesPerMinute) {
        sendError(socket, "rate-limited", "Terlalu banyak pesan, koneksi ditutup.");
        socket.close(4409, "rate limited");
        return;
      }

      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString("utf8")) as ClientMessage;
      } catch {
        sendError(socket, "bad-message", "Pesan harus JSON yang valid.");
        return;
      }
      if (!msg || typeof msg.type !== "string") {
        sendError(socket, "bad-message", "Pesan harus punya field type.");
        return;
      }

      // ---- Autentikasi: hanya hello yang boleh sebelum authed ----
      if (!state.authed) {
        if (msg.type !== "hello") {
          sendError(socket, "auth-required", "Kirim pesan hello dulu.");
          socket.close(4401, "auth required");
          return;
        }
        await handleHello(socket, state, msg);
        return;
      }

      // ---- Pesan sesudah autentikasi ----
      switch (msg.type) {
        case "hello":
          sendError(socket, "bad-message", "Sudah terautentikasi, hello tidak diperlukan lagi.");
          return;
        case "heartbeat": {
          if (state.role === "agent" && state.deviceId) presence.agentHeartbeat(state.deviceId);
          return;
        }
        case "watch": {
          if (state.role !== "controller") return sendError(socket, "bad-message", "Hanya controller yang bisa watch.");
          const owner = await config.deviceRegistry.getOwner(msg.deviceId);
          if (owner === null) return sendError(socket, "unknown-session", `Perangkat tidak dikenal: ${msg.deviceId}`);
          if (!state.isAdmin && owner !== state.peerId) {
            return sendError(socket, "not-owner", "Perangkat ini bukan milikmu.");
          }
          presence.watch(msg.deviceId, socket);
          return;
        }
        case "unwatch": {
          presence.unwatch(msg.deviceId, socket);
          return;
        }
        case "session-request":
          await handleSessionRequest(socket, state, msg.deviceId, msg.sessionType);
          return;
        case "session-accept":
          await handleSessionAccept(socket, state, msg.sessionId);
          return;
        case "session-reject":
          await handleSessionReject(socket, state, msg.sessionId, msg.reason);
          return;
        case "offer":
        case "answer":
        case "ice":
        case "webrtc_offer":
        case "webrtc_answer":
        case "webrtc_ice_candidate":
          await handleRelay(socket, state, msg);
          return;
        case "device_metrics":
          await handleDeviceMetrics(socket, state, msg.metrics);
          return;
        case "file_list_request":
          await handleFileListRequest(socket, state, msg);
          return;
        case "file_list_response":
          await handleFileListResponse(socket, state, msg);
          return;
        case "file_transfer_done":
          await handleFileTransferDone(socket, state, msg);
          return;
        case "file_mkdir_request":
        case "file_rename_request":
        case "file_delete_request":
          await handleFileOpRequest(socket, state, msg);
          return;
        case "file_op_response":
          await handleFileOpResponse(socket, state, msg);
          return;
        case "app_list_request":
          await handleAppListRequest(socket, state, msg);
          return;
        case "app_list_response":
          await handleAppListResponse(socket, state, msg);
          return;
        case "app_command":
          await handleAppCommand(socket, state, msg);
          return;
        case "app_command_response":
          await handleAppCommandResponse(socket, state, msg);
          return;
        case "device_notification":
          await handleDeviceNotification(socket, state, msg);
          return;
        case "permission_report":
          await handlePermissionReport(socket, state, msg);
          return;
        case "session-end":
          await handleSessionEnd(socket, state, msg.sessionId, msg.reason);
          return;
        case "bye":
          socket.close(1000, "bye");
          return;
        default:
          sendError(socket, "bad-message", `Tipe pesan tidak dikenal: ${(msg as { type: string }).type}`);
          return;
      }
    }

    async function handleHello(socket: WebSocket, state: SocketState, msg: ClientMessage): Promise<void> {
      if (msg.type !== "hello") return;
      if (msg.role === "agent") {
        const ok = await config.deviceRegistry.verifyAgentToken(msg.deviceId, msg.token);
        if (!ok) {
          sendError(socket, "auth-failed", "Token perangkat tidak valid.");
          socket.close(4403, "auth failed");
          return;
        }
        state.authed = true;
        state.role = "agent";
        state.peerId = msg.deviceId;
        state.deviceId = msg.deviceId;
        clearTimeout(authTimer);
        presence.agentConnected(msg.deviceId, socket);
        log("agent online:", msg.deviceId);
        send(socket, {
          type: "welcome",
          peerId: msg.deviceId,
          role: "agent",
          serverTime: new Date().toISOString(),
          iceServers,
        });
        return;
      }
      // controller
      try {
        const claims = verifyControllerToken(msg.token, config.jwtSecret);
        state.authed = true;
        state.role = "controller";
        state.peerId = claims.sub;
        state.isAdmin = claims.role === "admin";
        let set = controllerSockets.get(claims.sub);
        if (!set) {
          set = new Set<WebSocket>();
          controllerSockets.set(claims.sub, set);
        }
        set.add(socket);
        clearTimeout(authTimer);
        log("controller online:", claims.sub, claims.role);
        send(socket, {
          type: "welcome",
          peerId: claims.sub,
          role: "controller",
          serverTime: new Date().toISOString(),
          iceServers,
        });
      } catch (err) {
        sendError(socket, "auth-failed", err instanceof Error ? err.message : "Token controller tidak valid.");
        socket.close(4403, "auth failed");
      }
    }

    async function handleSessionRequest(
      socket: WebSocket,
      state: SocketState,
      deviceId: string,
      sessionType: SessionType,
    ): Promise<void> {
      if (state.role !== "controller" || !state.peerId) {
        return sendError(socket, "bad-message", "Hanya controller yang bisa meminta sesi.");
      }
      const owner = await config.deviceRegistry.getOwner(deviceId);
      if (owner === null) return sendError(socket, "unknown-session", `Perangkat tidak dikenal: ${deviceId}`);
      if (!state.isAdmin && owner !== state.peerId) {
        return sendError(socket, "not-owner", "Perangkat ini bukan milikmu.");
      }
      if (!presence.isOnline(deviceId)) {
        return sendError(socket, "device-offline", `Perangkat offline: ${deviceId}`);
      }
      const rec = await config.sessionStore.create({ deviceId, controllerId: state.peerId, type: sessionType });
      sessionRequestSockets.set(rec.id, socket);
      const agentSocket = presence.getAgentSocket(deviceId);
      if (!agentSocket) {
        await config.sessionStore.setStatus(rec.id, "ended", "agent-gone");
        return sendError(socket, "device-offline", `Perangkat offline: ${deviceId}`);
      }
      presence.broadcast(deviceId, "connecting");
      send(agentSocket, { type: "session-request", sessionId: rec.id, from: state.peerId, sessionType });
      log("session requested:", rec.id, "device", deviceId, "by", state.peerId);
    }

    async function handleSessionAccept(socket: WebSocket, state: SocketState, sessionId: string): Promise<void> {
      if (state.role !== "agent" || !state.deviceId) {
        return sendError(socket, "bad-message", "Hanya agen yang bisa menerima sesi.");
      }
      const rec = await config.sessionStore.get(sessionId);
      if (!rec || rec.deviceId !== state.deviceId || rec.status !== "requested") {
        return sendError(socket, "unknown-session", `Sesi tidak ditemukan/bukan milikmu: ${sessionId}`);
      }
      const controllerSocket =
        sessionRequestSockets.get(sessionId) ?? controllerSockets.get(rec.controllerId)?.values().next().value ?? null;
      sessionRequestSockets.delete(sessionId);
      if (!controllerSocket) {
        await config.sessionStore.setStatus(sessionId, "ended", "controller-gone");
        presence.broadcast(state.deviceId, "online");
        return sendError(socket, "unknown-session", "Controller peminta sesi sudah tidak terhubung.");
      }
      await config.sessionStore.setStatus(sessionId, "active");
      rooms.set(sessionId, {
        sessionId,
        deviceId: rec.deviceId,
        controllerId: rec.controllerId,
        agentSocket: socket,
        controllerSocket,
      });
      presence.broadcast(state.deviceId, "online");
      await config.activityStore
        ?.append({ userId: rec.controllerId, deviceId: rec.deviceId, action: "session-start", detail: `${sessionId}: ${rec.type}` })
        .catch(() => null);
      await automationEngine
        ?.evaluate({ kind: "session_started", ownerId: rec.controllerId, deviceId: rec.deviceId })
        .catch(() => null);
      send(controllerSocket, { type: "session-accepted", sessionId, deviceId: rec.deviceId });
      log("session active:", sessionId, "device", rec.deviceId);
    }

    async function handleSessionReject(
      socket: WebSocket,
      state: SocketState,
      sessionId: string,
      reason?: string,
    ): Promise<void> {
      if (state.role !== "agent" || !state.deviceId) {
        return sendError(socket, "bad-message", "Hanya agen yang bisa menolak sesi.");
      }
      const rec = await config.sessionStore.get(sessionId);
      if (!rec || rec.deviceId !== state.deviceId || rec.status !== "requested") {
        return sendError(socket, "unknown-session", `Sesi tidak ditemukan/bukan milikmu: ${sessionId}`);
      }
      await config.sessionStore.setStatus(sessionId, "rejected", reason);
      presence.broadcast(state.deviceId, "online");
      const controllerSocket =
        sessionRequestSockets.get(sessionId) ?? controllerSockets.get(rec.controllerId)?.values().next().value ?? null;
      sessionRequestSockets.delete(sessionId);
      if (controllerSocket) {
        send(controllerSocket, { type: "session-rejected", sessionId, deviceId: rec.deviceId, reason });
      }
      log("session rejected:", sessionId, "device", rec.deviceId);
    }

    // Command 007 (Phase 3): metrik perangkat dari Agen diteruskan ke
    // semua controller pemilik — yang watch device ini ATAU yang sedang
    // di room sesi aktif dengannya. Tanpa sesi pun metrik mengalir: ini
    // memang tujuan monitoring (tanpa screen streaming).
    async function handleDeviceMetrics(
      socket: WebSocket,
      state: SocketState,
      metrics: DeviceMetrics,
    ): Promise<void> {
      void socket;
      if (state.role !== "agent" || !state.deviceId) {
        return sendError(socket, "bad-message", "Hanya agen yang bisa mengirim metrik perangkat.");
      }
      if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
        return sendError(socket, "bad-message", "Metrik perangkat harus berupa objek.");
      }
      const deviceId = state.deviceId;
      const out: ServerMessage = {
        type: "device_metrics",
        deviceId,
        metrics,
        at: new Date().toISOString(),
      };
      const targets = new Set<WebSocket>(presence.watchersOf(deviceId));
      for (const room of rooms.values()) {
        if (room.deviceId === deviceId) targets.add(room.controllerSocket);
      }
      for (const target of targets) send(target, out);
      // Otomatisasi (FINAL, Bagian 6): evaluasi aturan metrik pemilik.
      if (automationEngine) {
        const ownerId = await config.deviceRegistry.getOwner(deviceId);
        if (ownerId) {
          await automationEngine.evaluate({ kind: "metrics", ownerId, deviceId, metrics }).catch(() => null);
        }
      }
    }

    // Command 008 (Phase 3): relay browsing file controller <-> agen.
    // Tanpa sesi screen pun bisa (seperti device_metrics).
    async function handleFileListRequest(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "file_list_request" }>,
    ): Promise<void> {
      if (state.role !== "controller" || !state.peerId) {
        return sendError(socket, "bad-message", "Hanya controller yang bisa meminta daftar file.");
      }
      const owner = await config.deviceRegistry.getOwner(msg.deviceId);
      if (owner === null) return sendError(socket, "unknown-session", `Perangkat tidak dikenal: ${msg.deviceId}`);
      if (!state.isAdmin && owner !== state.peerId) {
        return sendError(socket, "not-owner", "Perangkat ini bukan milikmu.");
      }
      if (!presence.isOnline(msg.deviceId)) {
        return sendError(socket, "device-offline", `Perangkat offline: ${msg.deviceId}`);
      }
      const agentSocket = presence.getAgentSocket(msg.deviceId);
      if (!agentSocket) {
        return sendError(socket, "device-offline", `Perangkat offline: ${msg.deviceId}`);
      }
      pendingRequests.set(msg.requestId, { controllerSocket: socket, deviceId: msg.deviceId, createdAt: Date.now(), kind: "file_list" });
      send(agentSocket, { type: "file_list_request", requestId: msg.requestId, docId: msg.docId ?? null });
    }

    async function handleFileListResponse(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "file_list_response" }>,
    ): Promise<void> {
      void socket;
      if (state.role !== "agent" || !state.deviceId) return;
      const pending = pendingRequests.get(msg.requestId);
      if (!pending || pending.kind !== "file_list") return; // Jawaban basi / requestId tak dikenal — abaikan.
      pendingRequests.delete(msg.requestId);
      if (pending.deviceId !== state.deviceId) return;
      if (Date.now() - pending.createdAt > PENDING_TIMEOUT_MS) return;
      const items: FileItem[] = Array.isArray(msg.items) ? msg.items : [];
      send(pending.controllerSocket, {
        type: "file_list_response",
        requestId: msg.requestId,
        items,
        error: typeof msg.error === "string" ? msg.error : undefined,
      });
    }

    // Relay generik controller -> agen untuk operasi yang dijawab lewat
    // requestId (file_mkdir/rename/delete, app_list, app_command).
    async function relayToAgent(
      socket: WebSocket,
      state: SocketState,
      deviceId: string,
      requestId: string,
      kind: PendingKind,
      forward: ServerMessage,
    ): Promise<boolean> {
      if (state.role !== "controller" || !state.peerId) {
        sendError(socket, "bad-message", "Hanya controller yang bisa meminta operasi ini.");
        return false;
      }
      const owner = await config.deviceRegistry.getOwner(deviceId);
      if (owner === null) {
        sendError(socket, "unknown-session", `Perangkat tidak dikenal: ${deviceId}`);
        return false;
      }
      if (!state.isAdmin && owner !== state.peerId) {
        sendError(socket, "not-owner", "Perangkat ini bukan milikmu.");
        return false;
      }
      if (!presence.isOnline(deviceId)) {
        sendError(socket, "device-offline", `Perangkat offline: ${deviceId}`);
        return false;
      }
      const agentSocket = presence.getAgentSocket(deviceId);
      if (!agentSocket) {
        sendError(socket, "device-offline", `Perangkat offline: ${deviceId}`);
        return false;
      }
      pendingRequests.set(requestId, { controllerSocket: socket, deviceId, createdAt: Date.now(), kind });
      send(agentSocket, forward);
      return true;
    }

    // Jawaban agen untuk operasi relay generik — diteruskan ke peminta.
    function forwardPendingResponse(
      state: SocketState,
      requestId: string,
      kind: PendingKind,
      forward: (target: WebSocket) => void,
    ): void {
      if (state.role !== "agent" || !state.deviceId) return;
      const pending = pendingRequests.get(requestId);
      if (!pending || pending.kind !== kind) return;
      pendingRequests.delete(requestId);
      if (pending.deviceId !== state.deviceId) return;
      if (Date.now() - pending.createdAt > PENDING_TIMEOUT_MS) return;
      forward(pending.controllerSocket);
    }

    async function handleFileOpRequest(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "file_mkdir_request" | "file_rename_request" | "file_delete_request" }>,
    ): Promise<void> {
      const forward: ServerMessage =
        msg.type === "file_mkdir_request"
          ? { type: "file_mkdir_request", requestId: msg.requestId, parentDocId: msg.parentDocId ?? null, name: msg.name }
          : msg.type === "file_rename_request"
            ? { type: "file_rename_request", requestId: msg.requestId, docId: msg.docId, newName: msg.newName }
            : { type: "file_delete_request", requestId: msg.requestId, docId: msg.docId };
      await relayToAgent(socket, state, msg.deviceId, msg.requestId, "file_op", forward);
    }

    async function handleFileOpResponse(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "file_op_response" }>,
    ): Promise<void> {
      void socket;
      forwardPendingResponse(state, msg.requestId, "file_op", (target) => {
        send(target, { type: "file_op_response", requestId: msg.requestId, ok: msg.ok, error: msg.error });
      });
    }

    async function handleAppListRequest(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "app_list_request" }>,
    ): Promise<void> {
      await relayToAgent(socket, state, msg.deviceId, msg.requestId, "app_list", {
        type: "app_list_request",
        requestId: msg.requestId,
      });
    }

    async function handleAppListResponse(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "app_list_response" }>,
    ): Promise<void> {
      void socket;
      forwardPendingResponse(state, msg.requestId, "app_list", (target) => {
        const apps: AppInfo[] = Array.isArray(msg.apps) ? msg.apps : [];
        send(target, {
          type: "app_list_response",
          requestId: msg.requestId,
          apps,
          error: typeof msg.error === "string" ? msg.error : undefined,
        });
      });
    }

    async function handleAppCommand(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "app_command" }>,
    ): Promise<void> {
      await relayToAgent(socket, state, msg.deviceId, msg.requestId, "app_command", {
        type: "app_command",
        requestId: msg.requestId,
        command: msg.command,
        packageName: msg.packageName,
      });
    }

    async function handleAppCommandResponse(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "app_command_response" }>,
    ): Promise<void> {
      void socket;
      forwardPendingResponse(state, msg.requestId, "app_command", (target) => {
        send(target, { type: "app_command_response", requestId: msg.requestId, ok: msg.ok, error: msg.error });
      });
    }

    // Notifikasi perangkat (FINAL, Bagian 4): simpan riwayat + teruskan
    // real-time ke semua controller pemilik (watcher / room / soket owner).
    async function handleDeviceNotification(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "device_notification" }>,
    ): Promise<void> {
      void socket;
      if (state.role !== "agent" || !state.deviceId) {
        return sendError(socket, "bad-message", "Hanya agen yang bisa mengirim notifikasi perangkat.");
      }
      const deviceId = state.deviceId;
      const ownerId = await config.deviceRegistry.getOwner(deviceId);
      if (!ownerId) return;
      const at = typeof msg.at === "string" && msg.at ? msg.at : new Date().toISOString();
      const notif: DeviceNotification = {
        packageName: msg.packageName,
        appName: msg.appName,
        title: msg.title ?? null,
        text: msg.text ?? null,
        at,
      };
      await config.notificationStore
        ?.append({
          ownerId,
          deviceId,
          kind: "device",
          packageName: notif.packageName,
          appName: notif.appName,
          title: notif.title,
          text: notif.text,
        })
        .catch(() => null);
      const out: ServerMessage = { type: "device_notification", deviceId, ...notif };
      const targets = new Set<WebSocket>(presence.watchersOf(deviceId));
      for (const room of rooms.values()) {
        if (room.deviceId === deviceId) targets.add(room.controllerSocket);
      }
      const ownerSet = controllerSockets.get(ownerId);
      if (ownerSet) for (const s of ownerSet) targets.add(s);
      for (const target of targets) send(target, out);
    }

    // Laporan izin fitur Agent (FINAL, Bagian 1).
    async function handlePermissionReport(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "permission_report" }>,
    ): Promise<void> {
      void socket;
      if (state.role !== "agent" || !state.deviceId) return;
      if (!config.permissionStore || !Array.isArray(msg.permissions)) return;
      for (const item of msg.permissions) {
        if (typeof item?.feature !== "string" || typeof item?.granted !== "boolean") continue;
        if (!(PERMISSION_FEATURES as readonly string[]).includes(item.feature)) continue;
        await config.permissionStore
          .upsert(state.deviceId, item.feature as (typeof PERMISSION_FEATURES)[number], item.granted)
          .catch(() => null);
      }
    }

    // Ack Agent sesudah menyimpan file kiriman controller: tandai transfer
    // done/failed + hapus blob + beri tahu controller pemilik.
    async function handleFileTransferDone(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<ClientMessage, { type: "file_transfer_done" }>,
    ): Promise<void> {
      void socket;
      if (state.role !== "agent" || !state.deviceId) return;
      if (!config.transferStore || !config.blobStore) return;
      const rec = await config.transferStore.get(msg.transferId);
      if (!rec || rec.deviceId !== state.deviceId) return;
      const fresh = await expireIfNeeded(config.transferStore, config.blobStore, rec);
      if (fresh.status === "expired") return;
      await finishTransfer(config.transferStore, config.blobStore, fresh, msg.ok, msg.error ?? null);
      sendToControllers(rec.ownerId, { type: "file_transfer_done", transferId: msg.transferId, ok: msg.ok, error: msg.error });
    }

    async function handleRelay(
      socket: WebSocket,
      state: SocketState,
      msg: Extract<
        ClientMessage,
        { type: "offer" | "answer" | "ice" | "webrtc_offer" | "webrtc_answer" | "webrtc_ice_candidate" }
      >,
    ): Promise<void> {
      const room = rooms.get(msg.sessionId);
      if (!room) return sendError(socket, "not-in-session", `Tidak ada sesi aktif: ${msg.sessionId}`);
      const isAgent = state.role === "agent" && state.deviceId === room.deviceId;
      const isController = state.role === "controller" && state.peerId === room.controllerId;
      if (!isAgent && !isController) {
        return sendError(socket, "not-in-session", "Kamu bukan pihak dari sesi ini.");
      }
      const target = isAgent ? room.controllerSocket : room.agentSocket;
      const from = state.peerId ?? "";
      // Normalisasi: alias lama (offer/answer/ice) diteruskan dengan nama
      // kanonik webrtc_* agar semua klien cukup menangani satu nama.
      const canonical =
        msg.type === "offer" || msg.type === "webrtc_offer"
          ? "webrtc_offer"
          : msg.type === "answer" || msg.type === "webrtc_answer"
            ? "webrtc_answer"
            : "webrtc_ice_candidate";
      send(target, { type: canonical, sessionId: msg.sessionId, from, payload: msg.payload });
    }

    async function handleSessionEnd(
      socket: WebSocket,
      state: SocketState,
      sessionId: string,
      reason?: string,
    ): Promise<void> {
      const room = rooms.get(sessionId);
      if (!room) return sendError(socket, "not-in-session", `Tidak ada sesi aktif: ${sessionId}`);
      const isAgent = state.role === "agent" && state.deviceId === room.deviceId;
      const isController = state.role === "controller" && state.peerId === room.controllerId;
      if (!isAgent && !isController) {
        return sendError(socket, "not-in-session", "Kamu bukan pihak dari sesi ini.");
      }
      rooms.delete(sessionId);
      await config.sessionStore.setStatus(sessionId, "ended", reason ?? "ended-by-peer").catch(() => null);
      await config.activityStore
        ?.append({ userId: room.controllerId, deviceId: room.deviceId, action: "session-end", detail: `${sessionId}: ${reason ?? "ended-by-peer"}` })
        .catch(() => null);
      await automationEngine
        ?.evaluate({ kind: "session_ended", ownerId: room.controllerId, deviceId: room.deviceId })
        .catch(() => null);
      const target = isAgent ? room.controllerSocket : room.agentSocket;
      send(target, { type: "session-ended", sessionId, reason });
      presence.broadcast(room.deviceId, "online");
      log("session ended:", sessionId, "reason:", reason ?? "ended-by-peer");
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host ?? "0.0.0.0", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  log(`listening on ${config.host ?? "0.0.0.0"}:${port} (ws + http /healthz)`);

  return {
    port,
    presence,
    disconnectDevice,
    terminateAllSessions: async (controllerId: string, reason = "terminated-by-user"): Promise<number> => {
      let count = 0;
      for (const room of rooms.values()) {
        if (room.controllerId === controllerId) count++;
      }
      await endSessionsForController(controllerId, reason);
      return count;
    },
    close: async () => {
      clearInterval(sweepTimer);
      for (const client of wss.clients) client.close(1001, "server-shutdown");
      await new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    },
  };
}
