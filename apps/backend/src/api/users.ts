// PRATA Remote — Store pengguna (Command 002, Tugas 1)
// Kontrak baca user untuk login. Implementasi:
// - "memory" -> MemoryUserStore (pengembangan + smoke test)
// - "prisma" -> PrismaUserStore (produksi; file terpisah, dynamic import)
export type UserRole = "user" | "admin";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: UserRole;
  createdAt: Date;
}

export interface UserStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(input: { email: string; passwordHash: string; name?: string; role?: UserRole }): Promise<UserRecord>;
}

export class MemoryUserStore implements UserStore {
  private byId = new Map<string, UserRecord>();
  private byEmail = new Map<string, UserRecord>();
  private counter = 0;

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.byEmail.get(email.toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async create(input: { email: string; passwordHash: string; name?: string; role?: UserRole }): Promise<UserRecord> {
    const email = input.email.toLowerCase();
    if (this.byEmail.has(email)) throw new Error(`Email sudah terdaftar: ${email}`);
    const rec: UserRecord = {
      id: `user_${Date.now().toString(36)}_${(this.counter++).toString(36)}`,
      email,
      passwordHash: input.passwordHash,
      name: input.name ?? null,
      role: input.role ?? "user",
      createdAt: new Date(),
    };
    this.byId.set(rec.id, rec);
    this.byEmail.set(email, rec);
    return rec;
  }
}
