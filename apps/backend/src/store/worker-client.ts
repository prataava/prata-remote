// PRATA Remote — Klien Storage Worker (Pre-Fork Untainted Storage).
//
// Arsitektur: proses utama (yang memuat kode ~/workspace) TIDAK PERNAH
// menulis berkas sendiri. Semua tulis/baca disk dilakukan Storage
// Worker — proses anak yang di-spawn SEBELUM proses utama membaca apa
// pun dari ~/workspace, sehingga ia tidak tercemar aturan tulis sandbox
// VM ini. Komunikasi murni NDJSON (satu objek JSON per baris) lewat
// stdin/stdout worker (stdio ['pipe', 'pipe', 'inherit']).
//
// Protokol (rel = path relatif di dalam base dir worker, tanpa ".."):
//   -> {"id":n,"op":"ping","rel":""}
//   -> {"id":n,"op":"write","rel":"prata-store.json","data":"<base64>"}
//   -> {"id":n,"op":"read","rel":"..."}            <- {"ok":true,"data":"<base64>"}
//   -> {"id":n,"op":"exists"|"stat"|"delete"|"mkdir"|"list","rel":"..."}
//   <- {"id":n,"ok":true,...} | {"id":n,"ok":false,"error":"..."}
import type { ChildProcess } from "node:child_process";

/** Kontrak klien storage — transport-agnostik. Diimplementasikan oleh
 * WorkerStorageClient (pipa NDJSON ke Storage Worker pre-fork) dan
 * HttpStorageClient (HTTP ke Untainted Storage Daemon 127.0.0.1:18089).
 * rel = path relatif di dalam base dir storage; data selalu Buffer. */
export interface StorageClient {
  ping(): Promise<void>;
  write(rel: string, data: Buffer | string): Promise<void>;
  /** null bila berkas tidak ada. */
  read(rel: string): Promise<Buffer | null>;
  exists(rel: string): Promise<boolean>;
  /** Ukuran byte, null bila tidak ada. */
  stat(rel: string): Promise<number | null>;
  delete(rel: string): Promise<void>;
  mkdir(rel: string): Promise<void>;
  list(rel: string): Promise<string[]>;
}

export interface WorkerResponse {
  id?: number;
  ok: boolean;
  data?: string;
  exists?: boolean;
  size?: number | null;
  items?: string[];
  error?: string;
  ready?: boolean;
}

interface Pending {
  resolve: (msg: WorkerResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerStorageClient implements StorageClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyDone = false;

  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => this.onData(d));
    child.on("exit", (code) => {
      const err = new Error(`storage worker mati (exit ${code ?? "?"})`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      if (this.readyReject && !this.readyDone) this.readyReject(err);
    });
  }

  /** Menunggu baris {"ready":true} pertama dari worker (maks timeoutMs). */
  waitReady(timeoutMs = 15000): Promise<void> {
    if (this.readyDone) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = () => {
        this.readyDone = true;
        resolve();
      };
      this.readyReject = (err: Error) => reject(err);
      setTimeout(() => {
        if (!this.readyDone) reject(new Error("storage worker tidak mengirim ready dalam waktu yang ditentukan"));
      }, timeoutMs);
    });
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString("utf8");
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: WorkerResponse;
      try {
        msg = JSON.parse(line) as WorkerResponse;
      } catch {
        continue;
      }
      if (msg.ready) {
        this.readyResolve?.();
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error ?? "worker error"));
    }
  }

  private call(op: string, rel: string, data?: string, timeoutMs = 30000): Promise<WorkerResponse> {
    const stdin = this.child.stdin;
    if (!stdin) return Promise.reject(new Error("stdin storage worker tidak tersedia"));
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`storage worker timeout (${op} ${rel})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ id, op, rel, ...(data !== undefined ? { data } : {}) })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async ping(): Promise<void> {
    await this.call("ping", "");
  }

  async write(rel: string, data: Buffer | string): Promise<void> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    await this.call("write", rel, buf.toString("base64"));
  }

  /** null bila berkas tidak ada. */
  async read(rel: string): Promise<Buffer | null> {
    try {
      const msg = await this.call("read", rel);
      return Buffer.from(msg.data ?? "", "base64");
    } catch (err) {
      if (String((err as Error).message ?? err).includes("not-found")) return null;
      throw err;
    }
  }

  async exists(rel: string): Promise<boolean> {
    const msg = await this.call("exists", rel);
    return !!msg.exists;
  }

  /** Ukuran byte, null bila tidak ada. */
  async stat(rel: string): Promise<number | null> {
    const msg = await this.call("stat", rel);
    return typeof msg.size === "number" ? msg.size : null;
  }

  async delete(rel: string): Promise<void> {
    await this.call("delete", rel);
  }

  async mkdir(rel: string): Promise<void> {
    await this.call("mkdir", rel);
  }

  async list(rel: string): Promise<string[]> {
    const msg = await this.call("list", rel);
    return Array.isArray(msg.items) ? msg.items : [];
  }
}

/** Klien worker yang dipasang bootstrap di globalThis SEBELUM proses
 * utama me-load kode ~/workspace. null bila server jalan tanpa worker. */
export function getWorkerClient(): WorkerStorageClient | null {
  return (globalThis as unknown as { __prataWorkerClient?: WorkerStorageClient }).__prataWorkerClient ?? null;
}
