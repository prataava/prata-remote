// PRATA Remote — Autentikasi signaling (Command 001, Phase 1)
// Dua jalur, keduanya berbasis token. TIDAK ADA kata sandi HP yang
// dikirim ke server — agen memakai token perangkat, controller memakai JWT.
//
// - Controller: JWT HS256 (header.payload.signature, HMAC-SHA256).
//   Verifikasi ditulis tangan dengan node:crypto agar server hanya
//   bergantung pada paket "ws" — tanpa pustaka JWT tambahan.
//   JWT diterbitkan oleh service auth (Phase 1 berikutnya) dengan
//   klaim: sub = id pengguna, role = "user" | "admin", exp = kedaluwarsa.
// - Agen: token perangkat opaque; yang disimpan/dibandingkan adalah
//   SHA-256 dari token (lihat Device.agentTokenHash di schema.prisma).
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export interface ControllerClaims {
  sub: string;
  role: "user" | "admin";
  exp: number;
  iat?: number;
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Verifikasi JWT HS256. Melempar Error bila format/signature/kedaluwarsa tidak sah. */
export function verifyControllerToken(token: string, secret: string): ControllerClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("JWT harus punya 3 segmen");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64urlDecode(headerB64).toString("utf8")) as { alg?: string; typ?: string };
  if (header.alg !== "HS256") throw new Error(`alg JWT tidak didukung: ${header.alg ?? "?"}`);
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const actual = base64urlDecode(signatureB64);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Signature JWT tidak cocok");
  }
  const claims = JSON.parse(base64urlDecode(payloadB64).toString("utf8")) as ControllerClaims;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw new Error("Klaim sub JWT tidak ada");
  }
  if (typeof claims.exp !== "number" || Date.now() / 1000 > claims.exp) {
    throw new Error("JWT kedaluwarsa");
  }
  return claims;
}

/** SHA-256 hex dari sebuah token/kode. Dipakai untuk agentTokenHash & codeHash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Perbandingan hash yang tahan timing-attack. */
export function hashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Mint JWT HS256 (dipakai smoke test & kelak service auth). Bukan untuk produksi tanpa exp pendek. */
export function mintControllerToken(
  claims: Omit<ControllerClaims, "exp"> & { expiresInSec: number },
  secret: string,
): string {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64urlEncode(
    JSON.stringify({
      sub: claims.sub,
      role: claims.role,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + claims.expiresInSec,
    }),
  );
  const signature = base64urlEncode(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
