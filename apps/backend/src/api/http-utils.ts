// PRATA Remote — Utilitas HTTP REST (Command 002, Tugas 1)
// Dipakai semua handler: kirim JSON, baca body JSON, error API terstruktur.
import type { IncomingMessage, ServerResponse } from "node:http";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error("REST internal error:", err instanceof Error ? err.stack ?? err.message : String(err));
  sendJson(res, 500, { error: { code: "internal-error", message: "Terjadi kesalahan di server." } });
}

/** Baca body sebagai JSON object. Body kosong -> {}. Batas 64 KB. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new ApiError(413, "body-too-large", "Body permintaan melebihi 64 KB.");
    chunks.push(buf);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "bad-json", "Body harus JSON yang valid.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "bad-json", "Body harus objek JSON.");
  }
  return parsed as Record<string, unknown>;
}

/** Baca body mentah sebagai Buffer. Batas default 50 MB (transfer file). */
export async function readRawBody(req: IncomingMessage, maxBytes = 50 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new ApiError(413, "body-too-large", `Body melebihi ${maxBytes} byte.`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Kirim byte sebagai unduhan file (Content-Disposition attachment). */
export function sendBytes(res: ServerResponse, data: Buffer, contentType: string, fileName: string): void {
  const safeName = fileName.replace(/["\r\n]/g, "_");
  const encoded = encodeURIComponent(fileName);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": data.length,
    "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`,
  });
  res.end(data);
}

/** Kirim stream sebagai unduhan file (tanpa menahan byte di RAM). */
export function sendStream(
  res: ServerResponse,
  stream: NodeJS.ReadableStream,
  contentLength: number | null,
  contentType: string,
  fileName: string,
): void {
  const safeName = fileName.replace(/["\r\n]/g, "_");
  const encoded = encodeURIComponent(fileName);
  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encoded}`,
  };
  if (contentLength !== null) headers["content-length"] = String(contentLength);
  res.writeHead(200, headers);
  stream.pipe(res);
}

/**
 * Alirkan body request mentah ke WritableStream (mis. file blob di disk)
 * sambil menghitung ukuran + SHA-256 secara inkremental. Menolak bila
 * melebihi maxBytes (413). Mengembalikan {size, sha256Hex}.
 */
export async function streamRequestToStream(
  req: IncomingMessage,
  dest: NodeJS.WritableStream,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ size: number; sha256Hex: string }> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  let total = 0;
  // Tangkap error tujuan SEJAK AWAL: 'error' yang meletus sebelum
  // finalizer dipasang tidak boleh hilang diam-diam (kasus nyata:
  // tulis disk EPERM -> unggahan 201 palsu dengan blob hantu).
  let destError: Error | null = null;
  const onDestError = (err: Error) => { destError ??= err; };
  dest.on("error", onDestError);
  try {
    for await (const chunk of req) {
      if (destError) throw destError;
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) {
        dest.destroy(new ApiError(413, "body-too-large", `Body melebihi ${maxBytes} byte.`));
        throw new ApiError(413, "body-too-large", `Body melebihi ${maxBytes} byte.`);
      }
      hash.update(buf);
      if (!dest.write(buf)) {
        await new Promise<void>((resolve, reject) => {
          dest.once("drain", () => resolve());
          dest.once("error", (err: Error) => reject(err));
        });
      }
      if (destError) throw destError;
    }
  } catch (err) {
    dest.destroy(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  await new Promise<void>((resolve, reject) => {
    if (destError) { reject(destError); return; }
    dest.on("error", reject);
    dest.end(() => { if (destError) reject(destError); else resolve(); });
  });
  if (destError) throw destError;
  return { size: total, sha256Hex: hash.digest("hex") };
}

export function requireString(body: Record<string, unknown>, field: string, opts?: { maxLen?: number }): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(400, "bad-request", `Field '${field}' wajib diisi.`);
  }
  if (opts?.maxLen && value.length > opts.maxLen) {
    throw new ApiError(400, "bad-request", `Field '${field}' melebihi ${opts.maxLen} karakter.`);
  }
  return value.trim();
}

export function optionalString(body: Record<string, unknown>, field: string, maxLen = 200): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ApiError(400, "bad-request", `Field '${field}' harus string.`);
  if (value.length > maxLen) throw new ApiError(400, "bad-request", `Field '${field}' melebihi ${maxLen} karakter.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function getBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}
