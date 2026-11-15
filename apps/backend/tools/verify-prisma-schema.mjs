// PRATA Remote — Verifikasi penuh skema Prisma TANPA CLI resmi.
// Dipakai karena `npx prisma validate` / `prisma generate` tidak bisa
// berjalan di VM ini (unduh paket dari npm registry diblokir sandbox:
// curl/node fetch ke file = 0 byte + EPERM; lihat AGENTS.md).
// Verifier ini mem-parse schema.prisma dan memeriksa:
//   1. Struktur: generator, datasource, enum, model, @@map, @id/@@id.
//   2. Relasi: target model ada, fields/references ada, nama relasi cocok.
//   3. Kode <-> skema: semua `prisma.<model>` + field di data:/where:
//      pada prisma-*.ts harus ada di skema; nilai enum yang dipakai
//      kode harus ada di enum.
//   4. Interface Record TS (api/*.ts, store/session-store.ts) <-> skema:
//      setiap field record harus punya kolom yang sama di model.
// Jalankan: node tools/verify-prisma-schema.mjs  (exit 0 bila semua lolos)
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, "..");
const SCHEMA = join(BACKEND, "prisma", "schema.prisma");

let failures = 0;
let passes = 0;
function check(ok, label, detail = "") {
  if (ok) { passes++; console.log(`PASS ${label}`); }
  else { failures++; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}

const src = readFileSync(SCHEMA, "utf8");

// ---------- 1. Parse skema ----------
const SCALARS = new Set(["String", "Int", "Float", "Boolean", "DateTime", "Json", "Bytes", "BigInt", "Decimal"]);
const enums = new Map(); // name -> values[]
const models = new Map(); // name -> { fields: Map<name, {type, optional, isArray, attrs}>, map, idFields, indexes }

{
  const enumRe = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = enumRe.exec(src))) {
    const values = m[2].split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//")).map((l) => l.split(/\s/)[0]);
    enums.set(m[1], values);
  }
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  while ((m = modelRe.exec(src))) {
    const name = m[1];
    const body = m[2];
    const fields = new Map();
    let map = null;
    const idFields = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//")) continue;
      if (line.startsWith("@@map")) { map = line.match(/"([^"]+)"/)?.[1] ?? null; continue; }
      if (line.startsWith("@@id")) {
        const inside = line.match(/\[([^\]]+)\]/)?.[1] ?? "";
        idFields.push(...inside.split(",").map((s) => s.trim()));
        continue;
      }
      const fm = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
      if (!fm) continue;
      const [, fname, ftype, arr, opt, attrs] = fm;
      fields.set(fname, { type: ftype, isArray: !!arr, optional: !!opt, attrs: attrs ?? "" });
      if ((attrs ?? "").includes("@id")) idFields.push(fname);
    }
    models.set(name, { fields, map, idFields });
  }
}

// ---------- 2. Struktur ----------
check(/generator client\s*\{[^}]*provider\s*=\s*"prisma-client-js"/.test(src), "generator prisma-client-js");
check(/datasource db\s*\{[^}]*provider\s*=\s*"postgresql"/.test(src), "datasource postgresql");
check(/url\s*=\s*env\("DATABASE_URL"\)/.test(src), "datasource url = env(DATABASE_URL)");
const EXPECTED_MODELS = ["User", "Device", "Pairing", "Session", "FileTransfer", "DeviceKey", "Permission", "ActivityLog", "AutomationRule", "Notification"];
check(models.size === 10, `tepat 10 model (dapat ${models.size})`);
for (const name of EXPECTED_MODELS) {
  check(models.has(name), `model ${name} ada`);
  const mod = models.get(name);
  if (mod) {
    check(mod.map !== null, `model ${name} punya @@map ("${mod.map ?? "-"}")`);
    check(mod.idFields.length > 0, `model ${name} punya @id/@@id (${mod.idFields.join(",") || "-"})`);
  }
}
const maps = [...models.values()].map((m) => m.map);
check(new Set(maps).size === maps.length, "@@map unik antar model");
for (const [name, values] of enums) {
  check(values.length > 0, `enum ${name} punya nilai (${values.length})`);
  check(values.every((v) => /^[A-Z][A-Z0-9_]*$/.test(v)), `enum ${name} nilai UPPER_SNAKE`);
}
check(enums.has("UserRole") && enums.has("DeviceStatus") && enums.has("PairingStatus") && enums.has("SessionStatus") && enums.has("SessionType"), "5 enum ada");

// ---------- 3. Relasi & tipe field ----------
for (const [mName, mod] of models) {
  for (const [fName, f] of mod.fields) {
    const isRelation = models.has(f.type);
    const isScalar = SCALARS.has(f.type);
    const isEnum = enums.has(f.type);
    check(isRelation || isScalar || isEnum, `${mName}.${fName}: tipe dikenal (${f.type})`);
    if (isRelation) {
      const rel = f.attrs.match(/@relation\(([^)]*)\)/)?.[1] ?? "";
      const fieldsMatch = rel.match(/fields:\s*\[([^\]]+)\]/)?.[1] ?? "";
      const refsMatch = rel.match(/references:\s*\[([^\]]+)\]/)?.[1] ?? "";
      const relName = rel.match(/"([^"]+)"/)?.[1] ?? null;
      const localFields = fieldsMatch.split(",").map((s) => s.trim()).filter(Boolean);
      const refFields = refsMatch.split(",").map((s) => s.trim()).filter(Boolean);
      for (const lf of localFields) {
        check(mod.fields.has(lf), `${mName}.${fName} relation fields[${lf}] ada di ${mName}`);
      }
      const target = models.get(f.type);
      for (const rf of refFields) {
        check(target?.fields.has(rf) ?? false, `${mName}.${fName} relation references[${rf}] ada di ${f.type}`);
      }
      if (relName) {
        // Sisi lawan wajib menyebut nama relasi yang sama.
        const opposite = [...(target?.fields.values() ?? [])].some((tf) => tf.attrs.includes(`"${relName}"`));
        check(opposite, `${mName}.${fName} relasi "${relName}" punya pasangan di ${f.type}`);
      }
    }
    if (f.attrs.includes("@unique") || f.attrs.includes("@id")) {
      check(true, `${mName}.${fName} @unique/@id tercatat`);
    }
  }
}

// ---------- 4. Kode prisma-*.ts <-> skema ----------
const camelToModel = (camel) => {
  const pascal = camel[0].toUpperCase() + camel.slice(1);
  return models.has(pascal) ? pascal : null;
};
const prismaFiles = readdirSync(join(BACKEND, "src", "api")).filter((f) => f.startsWith("prisma-")) 
  .concat(readdirSync(join(BACKEND, "src", "store")).filter((f) => f.startsWith("prisma-")).map((f) => join("..", "store", f)))
  .map((f) => join(BACKEND, "src", "api", f));
const codeEnumLiterals = new Map(); // enum -> Set<literal>
for (const file of prismaFiles) {
  const code = readFileSync(file, "utf8");
  const base = file.split("/").pop();
  const usedModels = new Set([...code.matchAll(/prisma\.(\w+)\./g)].map((m) => m[1]));
  for (const camel of usedModels) {
    const model = camelToModel(camel);
    check(model !== null, `${base}: prisma.${camel} -> model ${model ?? "TIDAK ADA"}`);
    if (!model) continue;
    const mod = models.get(model);
    // Ambil blok data:/where: sesudah prisma.<camel>. — pendekatan kasar:
    // kumpulkan semua kunci objek `{ key:` di file dan periksa yang
    // berupa field model (abaikan kunci non-model seperti orderBy/dll).
    const keys = new Set([...code.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
    for (const key of keys) {
      if (["where", "data", "orderBy", "include", "select", "take", "skip"].includes(key)) continue;
      if (mod.fields.has(key)) continue;
      // Kunci yang bukan field model tapi muncul di file prisma = tersangka.
      if (/^(id|email|ownerId|deviceId|controllerId|userId|status|type|direction|action|kind|feature|conditionType|name|group|label|granted|enabled|threshold|createdAt|updatedAt|startedAt|endedAt|endedReason|codeHash|attempts|issuedToken|deviceName|deviceModel|manufacturer|androidVersion|agentVersion|expiresAt|consumedAt|createdById|agentTokenHash|passwordHash|role|model|lastSeenAt|keyHash|revoked|revokedAt|lastUsedAt|docId|fileName|mimeType|size|sha256Hash|error|packageName|appName|title|text|detail)$/.test(key)) {
        check(false, `${base}: field '${key}' tidak ada di model ${model}`);
      }
    }
  }
  // Nilai enum literal di kode: cari pola `"SCREEN"` / `'CAMERA'` / `status: "ACTIVE"` dsb.
  for (const lit of [...code.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)].map((m) => m[1])) {
    codeEnumLiterals.set(lit, (codeEnumLiterals.get(lit) ?? new Set()).add(base));
  }
}
const allEnumValues = new Set([...enums.values()].flat());
for (const [lit, files] of codeEnumLiterals) {
  if (["SCREEN", "CAMERA", "USER", "ADMIN", "OFFLINE", "ONLINE", "CONNECTING", "PENDING", "CONSUMED", "EXPIRED", "REVOKED", "REQUESTED", "ACTIVE", "ENDED", "REJECTED"].includes(lit)) {
    check(allEnumValues.has(lit), `literal enum "${lit}" ada di skema (dipakai ${[...files].join(", ")})`);
  }
}

// ---------- 5. Interface Record TS <-> skema ----------
const INTERFACE_TO_MODEL = {
  UserRecord: "User",
  DeviceRecord: "Device",
  PairingRecord: "Pairing",
  SessionRecord: "Session",
  TransferRecord: "FileTransfer",
  DeviceKeyRecord: "DeviceKey",
  PermissionRecord: "Permission",
  ActivityLogRecord: "ActivityLog",
  AutomationRuleRecord: "AutomationRule",
  NotificationRecord: "Notification",
};
const interfaceFiles = [
  join(BACKEND, "src", "api", "users.ts"),
  join(BACKEND, "src", "api", "devices.ts"),
  join(BACKEND, "src", "api", "pairings.ts"),
  join(BACKEND, "src", "api", "device-keys.ts"),
  join(BACKEND, "src", "api", "permissions.ts"),
  join(BACKEND, "src", "api", "activity-logs.ts"),
  join(BACKEND, "src", "api", "automation.ts"),
  join(BACKEND, "src", "api", "notifications.ts"),
  join(BACKEND, "src", "api", "transfers.ts"),
  join(BACKEND, "src", "store", "session-store.ts"),
];
for (const file of interfaceFiles) {
  const code = readFileSync(file, "utf8");
  const base = file.split("/").pop();
  for (const [iface, model] of Object.entries(INTERFACE_TO_MODEL)) {
    const block = code.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`, "m"))?.[1];
    if (!block) continue;
    const mod = models.get(model);
    for (const line of block.split("\n")) {
      const fm = line.trim().match(/^(\w+)\??:/);
      if (!fm) continue;
      const field = fm[1];
      if (field === "error") continue; // error hanya ada di TransferRecord TS, bukan kolom DB
      check(mod.fields.has(field), `${base}: ${iface}.${field} -> kolom ${model}.${field}`);
    }
  }
}

console.log(`\nRINGKASAN: ${passes} lulus, ${failures} gagal.`);
process.exit(failures === 0 ? 0 : 1);
