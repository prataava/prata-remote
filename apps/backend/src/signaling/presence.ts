// PRATA Remote — Pelacak kehadiran perangkat (Command 001, Phase 1)
// Sumber kebenaran real-time untuk status Online/Offline/Connecting.
//
// Aturan:
// - Agen "online" sejak pesan hello terverifikasi sampai soketnya putus
//   atau tidak ada pesan apa pun selama heartbeatTimeoutMs.
// - "connecting" dipakai saat controller sudah meminta sesi tapi agen
//   belum menjawab (lihat server.ts) — di sini hanya sebagai status
//   yang bisa disiarkan, bukan status koneksi soket.
// - Controller yang "watch" sebuah device menerima setiap perubahan
//   status device itu secara langsung.
import type { WebSocket } from "ws";
import type { DeviceStatus, ServerMessage } from "./types.ts";

export interface AgentConnection {
  deviceId: string;
  socket: WebSocket;
  lastSeenAt: Date;
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

export class PresenceTracker {
  private agents = new Map<string, AgentConnection>();
  private watchers = new Map<string, Set<WebSocket>>();
  private readonly heartbeatTimeoutMs: number;

  constructor(heartbeatTimeoutMs = 45_000) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
  }

  agentConnected(deviceId: string, socket: WebSocket): void {
    this.agents.set(deviceId, { deviceId, socket, lastSeenAt: new Date() });
    this.broadcast(deviceId, "online");
  }

  agentHeartbeat(deviceId: string): void {
    const conn = this.agents.get(deviceId);
    if (conn) conn.lastSeenAt = new Date();
  }

  /** Dipanggil saat soket agen putus (atau saat sweep menemukan agen basi). */
  agentDisconnected(deviceId: string): void {
    if (!this.agents.has(deviceId)) return;
    this.agents.delete(deviceId);
    this.broadcast(deviceId, "offline");
  }

  isOnline(deviceId: string): boolean {
    return this.agents.has(deviceId);
  }

  getAgentSocket(deviceId: string): WebSocket | null {
    return this.agents.get(deviceId)?.socket ?? null;
  }

  lastSeenAt(deviceId: string): Date | null {
    return this.agents.get(deviceId)?.lastSeenAt ?? null;
  }

  onlineDeviceIds(): string[] {
    return [...this.agents.keys()];
  }

  watch(deviceId: string, socket: WebSocket): void {
    let set = this.watchers.get(deviceId);
    if (!set) {
      set = new Set();
      this.watchers.set(deviceId, set);
    }
    set.add(socket);
    // Langsung kirim status saat ini agar watcher tidak menunggu perubahan.
    send(socket, {
      type: "presence",
      deviceId,
      status: this.isOnline(deviceId) ? "online" : "offline",
      lastSeenAt: this.lastSeenAt(deviceId)?.toISOString() ?? null,
    });
  }

  unwatch(deviceId: string, socket: WebSocket): void {
    this.watchers.get(deviceId)?.delete(socket);
  }

  /** Soket-soket controller yang sedang watch device ini (salinan). */
  watchersOf(deviceId: string): Set<WebSocket> {
    return new Set(this.watchers.get(deviceId) ?? []);
  }

  unwatchAll(socket: WebSocket): void {
    for (const set of this.watchers.values()) set.delete(socket);
  }

  broadcast(deviceId: string, status: DeviceStatus): void {
    const msg: ServerMessage = {
      type: "presence",
      deviceId,
      status,
      lastSeenAt: this.lastSeenAt(deviceId)?.toISOString() ?? null,
    };
    for (const socket of this.watchers.get(deviceId) ?? []) send(socket, msg);
  }

  /** Sapu berkala: agen tanpa pesan apa pun > heartbeatTimeoutMs dianggap offline. */
  sweep(): string[] {
    const now = Date.now();
    const dropped: string[] = [];
    for (const [deviceId, conn] of this.agents) {
      if (now - conn.lastSeenAt.getTime() > this.heartbeatTimeoutMs) {
        this.agents.delete(deviceId);
        dropped.push(deviceId);
        this.broadcast(deviceId, "offline");
      }
    }
    return dropped;
  }
}
