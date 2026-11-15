// PRATA Remote — Seed user pertama (Command 002, Tugas 1)
// Membuat user controller dari environment (dipakai produksi awal):
//   SEED_EMAIL=owner@prata.test SEED_PASSWORD=KataSandiKuat123 SEED_NAME=Pemilik \
//     node prisma/seed.ts
// Bila user sudah ada, tidak dibuat ulang. Kata sandi di-hash scrypt.
// Butuh: DATABASE_URL + npx prisma generate.
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/api/passwords.ts";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = (process.env.SEED_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.SEED_PASSWORD ?? "";
  const name = (process.env.SEED_NAME ?? "").trim() || null;
  if (!email || !password) {
    console.error("SEED_EMAIL dan SEED_PASSWORD wajib diisi.");
    process.exit(1);
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`User sudah ada: ${email} (id ${existing.id}). Tidak dibuat ulang.`);
    return;
  }
  const user = await prisma.user.create({
    data: { email, passwordHash: hashPassword(password), name, role: "ADMIN" },
  });
  console.log(`User dibuat: ${user.email} (id ${user.id}, role ADMIN).`);
}

main()
  .catch((err: unknown) => {
    console.error("Seed gagal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
