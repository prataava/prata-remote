// PRATA Remote — Klien Untainted Storage Daemon (HTTP).
//
// Server & tes TIDAK PERNAH menulis berkas sendiri: semua tulis/baca
// disk (state JSON + blob) lewat HTTP ke daemon lokal
// http://127.0.0.1:18089 — proses daemon yang tidak pernah membaca
// ~/workspace sehingga tidak tercemar aturan tulis sandbox VM ini.
// Daemon boleh di-restart; data tetap di PRATA_DAEMON_DIR miliknya.
import type { StorageClient } from "./worker-client.ts";

export class HttpStorageClient implements StorageClient {
  private readonly base: string;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, "");
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `storage daemon tidak terjangkau (${this.base}): ${err instanceof Error ? err.message : String(err)} — jalankan dulu: cd /tmp && node /tmp/prata-daemon.mjs`,
      );
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || json.ok === false) {
      const msg = typeof json.error === "string" ? json.error : `daemon HTTP ${res.status}`;
      const err = new Error(msg);
      (err as unknown as { status?: number }).status = res.status;
      throw err;
    }
    return json;
  }

  async ping(): Promise<void> {
    await this.post("/v1/ping", {});
  }

  async write(rel: string, data: Buffer | string): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    await this.post("/v1/write", { rel, data: buf.toString("base64") });
  }

  /** null bila berkas tidak ada. */
  async read(rel: string): Promise<Buffer | null> {
    try {
      const msg = await this.post("/v1/read", { rel });
      return Buffer.from(typeof msg.data === "string" ? msg.data : "", "base64");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || String((err as Error).message ?? "").includes("not-found")) return null;
      throw err;
    }
  }

  async exists(rel: string): Promise<boolean> {
    const msg = await this.post("/v1/exists", { rel });
    return msg.exists === true;
  }

  async stat(rel: string): Promise<number | null> {
    const msg = await this.post("/v1/stat", { rel });
    return typeof msg.size === "number" ? msg.size : null;
  }

  async delete(rel: string): Promise<void> {
    await this.post("/v1/delete", { rel });
  }

  async mkdir(rel: string): Promise<void> {
    await this.post("/v1/mkdir", { rel });
  }

  async list(rel: string): Promise<string[]> {
    const msg = await this.post("/v1/list", { rel });
    return Array.isArray(msg.items) ? (msg.items as string[]) : [];
  }
}
