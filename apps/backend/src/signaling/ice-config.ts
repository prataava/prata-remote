// PRATA Remote — Konfigurasi ICE server untuk WebRTC (Command 003, Phase 2)
// STUN fallback Google selalu disertakan (publik, tanpa kredensial).
// TURN hanya ditambahkan bila env TURN_* diisi — kredensial TURN tidak
// pernah ditulis di repo; server mengembalikannya hanya ke controller
// yang sudah login (GET /api/rtc/ice-servers) dan ke peer lewat pesan
// welcome sesudah autentikasi WS.
import type { IceServer } from "./types.ts";

export const GOOGLE_STUN_SERVERS: IceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export function buildIceServers(env: NodeJS.ProcessEnv = process.env): IceServer[] {
  const servers: IceServer[] = [...GOOGLE_STUN_SERVERS];
  const turnUrls = (env.TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const username = (env.TURN_USERNAME ?? "").trim();
  const credential = (env.TURN_CREDENTIAL ?? "").trim();
  if (turnUrls.length > 0 && username && credential) {
    servers.push({ urls: turnUrls, username, credential });
  }
  return servers;
}
