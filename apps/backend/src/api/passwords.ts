// PRATA Remote — Hash kata sandi (Command 002, Tugas 1)
// scrypt bawaan Node (node:crypto) — kuat, standar, tanpa dependensi native.
// Format simpanan: scrypt$v1$<N>$<r>$<p>$<saltHex>$<hashHex>
// Yang disimpan di tabel users.passwordHash HANYA string ini; kata sandi
// mentah tidak pernah disimpan dan tidak pernah masuk log.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/** Hash kata sandi baru (dipakai seed + registrasi user). */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$v1$${N}$${R}$${P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verifikasi kata sandi terhadap hash simpanan. false bila format rusak. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 7 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
    const n = Number.parseInt(parts[2], 10);
    const r = Number.parseInt(parts[3], 10);
    const p = Number.parseInt(parts[4], 10);
    const salt = Buffer.from(parts[5], "hex");
    const expected = Buffer.from(parts[6], "hex");
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Hash dummy untuk user yang tidak ditemukan — dipakai login agar waktu
// respons login gagal nyaris sama untuk email terdaftar/tidak (mengurangi
// enumerasi user lewat timing). Bukan kredensial siapa pun.
const DUMMY_HASH = hashPassword(`dummy-${randomBytes(8).toString("hex")}`);

/** Verifikasi login yang tahan enumerasi: user null tetap dihitung scrypt. */
export function verifyLoginPassword(password: string, storedHash: string | null): boolean {
  return verifyPassword(password, storedHash ?? DUMMY_HASH) && storedHash !== null;
}
