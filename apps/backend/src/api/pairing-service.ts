// PRATA Remote — Layanan pairing (Command 002, Tugas 1)
// Satu-satunya tempat logika alur pairing hidup. Store tetap dumb.
//
// Alur lengkap:
//   1. init    — Agent (belum terdaftar) minta kode -> server membuat
//                Pairing PENDING + kode 6 karakter (hanya hash disimpan)
//                + mengembalikan kode + qrPayload `prata://pair/<id>/<kode>`.
//   2. confirm — Controller (JWT) mengirim hasil scan QR -> server
//                memverifikasi hash kode, membuat Device + agentToken
//                permanen (hanya hash disimpan di Device), menandai
//                Pairing CONSUMED. Token ASLI tidak dikembalikan ke
//                controller — hanya ke agent lewat poll.
//   3. poll    — Agent mengambil agentToken SEKALI dengan membuktikan
//                ia memegang kode (hash cocok). Sesudah dibaca, token
//                dihapus dari rekaman pairing (issuedToken -> null).
// Keamanan: kode kedaluwarsa 10 menit; 5x kode salah -> REVOKED;
// token agen 256-bit acak; semua perbandingan hash timing-safe.
import { randomBytes, randomInt } from "node:crypto";
import { hashToken, hashEquals } from "../signaling/auth.ts";
import { ApiError } from "./http-utils.ts";
import type { DeviceStore, DeviceRecord } from "./devices.ts";
import type { PairingStore, PairingRecord } from "./pairings.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_CONFIRM_ATTEMPTS = 5;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // tanpa 0/O/1/I/L

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export function buildQrPayload(pairingId: string, code: string): string {
  return `prata://pair/${pairingId}/${code}`;
}

export function parseQrPayload(qrPayload: string): { pairingId: string; code: string } | null {
  const m = /^prata:\/\/pair\/([A-Za-z0-9_-]+)\/([A-Za-z0-9]+)$/.exec(qrPayload.trim());
  if (!m) return null;
  return { pairingId: m[1], code: m[2].toUpperCase() };
}

export function generateAgentToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface PairingInitResult {
  pairing: PairingRecord;
  code: string;
  qrPayload: string;
}

export async function initPairing(
  store: PairingStore,
  input: { deviceName?: string; deviceModel?: string; manufacturer?: string; androidVersion?: string; agentVersion?: string },
): Promise<PairingInitResult> {
  const code = generatePairingCode();
  const pairing = await store.create({ ...input, codeHash: hashToken(code), expiresInMs: PAIRING_TTL_MS });
  return { pairing, code, qrPayload: buildQrPayload(pairing.id, code) };
}

function verifyCode(pairing: PairingRecord, code: string): boolean {
  return hashEquals(pairing.codeHash, hashToken(code.trim().toUpperCase()));
}

function ensureUsable(pairing: PairingRecord): void {
  if (pairing.status === "consumed") {
    throw new ApiError(409, "pairing-consumed", "Kode pairing ini sudah dipakai.");
  }
  if (pairing.status === "revoked") {
    throw new ApiError(410, "pairing-revoked", "Kode pairing ini sudah dicabut (terlalu banyak kode salah).");
  }
  if (pairing.status === "expired" || pairing.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, "pairing-expired", "Kode pairing sudah kedaluwarsa. Minta kode baru dari Agent.");
  }
}

export interface PollResult {
  status: "pending" | "consumed" | "expired" | "revoked";
  deviceId: string | null;
  deviceName: string | null;
  agentToken: string | null;
  tokenAlreadyCollected: boolean;
}

export async function pollPairing(
  store: PairingStore,
  input: { pairingId: string; pairingCode: string },
): Promise<PollResult> {
  const pairing = await store.getById(input.pairingId);
  if (!pairing) throw new ApiError(404, "pairing-not-found", "Pairing tidak ditemukan.");
  if (!verifyCode(pairing, input.pairingCode)) {
    throw new ApiError(401, "invalid-code", "Kode pairing salah.");
  }
  if (pairing.status === "expired" || (pairing.status === "pending" && pairing.expiresAt.getTime() <= Date.now())) {
    if (pairing.status === "pending") await store.markExpired(pairing.id);
    return { status: "expired", deviceId: pairing.deviceId, deviceName: pairing.deviceName, agentToken: null, tokenAlreadyCollected: false };
  }
  if (pairing.status === "revoked") {
    return { status: "revoked", deviceId: null, deviceName: pairing.deviceName, agentToken: null, tokenAlreadyCollected: false };
  }
  if (pairing.status === "pending") {
    return { status: "pending", deviceId: null, deviceName: pairing.deviceName, agentToken: null, tokenAlreadyCollected: false };
  }
  // consumed: token hanya keluar sekali
  const token = await store.takeIssuedToken(pairing.id);
  return {
    status: "consumed",
    deviceId: pairing.deviceId,
    deviceName: pairing.deviceName,
    agentToken: token,
    tokenAlreadyCollected: token === null,
  };
}

export interface ConfirmResult {
  device: DeviceRecord;
}

export async function confirmPairing(
  deps: { pairingStore: PairingStore; deviceStore: DeviceStore },
  input: { pairingId: string; pairingCode: string; controllerId: string; deviceName?: string },
): Promise<ConfirmResult> {
  const pairing = await deps.pairingStore.getById(input.pairingId);
  if (!pairing) throw new ApiError(404, "pairing-not-found", "Pairing tidak ditemukan.");
  if (pairing.status !== "pending") ensureUsable(pairing);
  if (pairing.expiresAt.getTime() <= Date.now()) {
    await deps.pairingStore.markExpired(pairing.id);
    throw new ApiError(410, "pairing-expired", "Kode pairing sudah kedaluwarsa. Minta kode baru dari Agent.");
  }
  if (pairing.attempts >= MAX_CONFIRM_ATTEMPTS) {
    await deps.pairingStore.markRevoked(pairing.id);
    throw new ApiError(410, "pairing-revoked", "Kode pairing ini sudah dicabut (terlalu banyak kode salah).");
  }
  if (!verifyCode(pairing, input.pairingCode)) {
    const updated = await deps.pairingStore.incrementAttempts(pairing.id);
    if (updated && updated.attempts >= MAX_CONFIRM_ATTEMPTS) {
      await deps.pairingStore.markRevoked(pairing.id);
    }
    throw new ApiError(401, "invalid-code", "Kode pairing salah.");
  }
  const agentToken = generateAgentToken();
  const device = await deps.deviceStore.create({
    ownerId: input.controllerId,
    name: input.deviceName ?? pairing.deviceName ?? "Perangkat Android",
    model: pairing.deviceModel ?? undefined,
    manufacturer: pairing.manufacturer ?? undefined,
    androidVersion: pairing.androidVersion ?? undefined,
    agentVersion: pairing.agentVersion ?? undefined,
    agentTokenHash: hashToken(agentToken),
  });
  // consume() atomik: hanya berhasil bila status masih PENDING (di kedua
  // implementasi store). Bila null, pairing direbut proses lain -> 409.
  const consumed = await deps.pairingStore.consume(pairing.id, {
    deviceId: device.id,
    createdById: input.controllerId,
    issuedToken: agentToken,
  });
  if (!consumed) {
    throw new ApiError(409, "pairing-consumed", "Kode pairing ini sudah dipakai.");
  }
  return { device };
}
