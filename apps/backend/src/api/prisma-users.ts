// PRATA Remote — Store pengguna dari PostgreSQL via Prisma (PRODUKSI)
// Dipakai saat USER_STORE=prisma. Butuh DATABASE_URL + prisma generate +
// migrate dev. Hanya dimuat saat dipilih (dynamic import di index.ts).
import { PrismaClient } from "@prisma/client";
import type { UserRecord, UserRole, UserStore } from "./users.ts";

export class PrismaUserStore implements UserStore {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const u = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    return u ? toRecord(u) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    return u ? toRecord(u) : null;
  }

  async create(input: { email: string; passwordHash: string; name?: string; role?: UserRole }): Promise<UserRecord> {
    const u = await this.prisma.user.create({
      data: {
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        name: input.name ?? null,
        role: input.role === "admin" ? "ADMIN" : "USER",
      },
    });
    return toRecord(u);
  }
}

function toRecord(u: {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: string;
  createdAt: Date;
}): UserRecord {
  return {
    id: u.id,
    email: u.email,
    passwordHash: u.passwordHash,
    name: u.name,
    role: u.role === "ADMIN" ? "admin" : "user",
    createdAt: u.createdAt,
  };
}
