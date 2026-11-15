// PRATA Remote — Store yang menulis lewat Storage Worker.
//
// WorkerBackend memakai kontrak StateBackend yang SAMA dengan
// DiskBackend, sehingga 10 adapter Disk*Store bekerja tanpa perubahan:
// yang berbeda hanyalah persist()/load() — lewat pipa NDJSON ke worker
// (yang tidak tercemar sandbox), bukan writeFileSync lokal.
// WorkerBlobStore mengimplementasikan BlobStore asinkron: put/get/
// delete/exists/size lewat worker; TANPA createWriteStream — router
// otomatis memakai jalur buffered (readRawBody + put) bila stream
// tidak tersedia.
import {
  DiskUserStore,
  DiskDeviceStore,
  DiskDeviceKeyStore,
  DiskPairingStore,
  DiskSessionStore,
  DiskPermissionStore,
  DiskTransferStore,
  DiskActivityLogStore,
  DiskAutomationRuleStore,
  DiskNotificationStore,
  emptyState,
  parseDiskState,
  sanitizeBlobId,
  stateStats,
  type DiskState,
  type StateBackend,
} from "./disk-store.ts";
import type { BlobStore } from "../api/transfers.ts";
import { WorkerStorageClient, type StorageClient } from "./worker-client.ts";

export class WorkerBackend implements StateBackend {
  state: DiskState;
  lastPersistError: Error | null = null;
  /** Rantai tulis berurutan: persist() yang dipanggil cepat berurutan
   * tidak boleh saling menyalip; flush() menunggu rantai ini kosong. */
  private chain: Promise<void> = Promise.resolve();

  private readonly client: StorageClient;
  private readonly rel: string;

  private constructor(client: StorageClient, rel: string, state: DiskState) {
    this.client = client;
    this.rel = rel;
    this.state = state;
  }

  static async create(client: StorageClient, rel: string): Promise<WorkerBackend> {
    const raw = await client.read(rel);
    let state = emptyState();
    if (raw && raw.length > 0) {
      try {
        state = parseDiskState(raw.toString("utf8"));
      } catch (err) {
        console.error(`WorkerStore: state di ${rel} rusak, mulai dari state kosong.`, err);
        state = emptyState();
        await client.write(rel, Buffer.from(JSON.stringify(state), "utf8"));
      }
    } else {
      await client.write(rel, Buffer.from(JSON.stringify(state), "utf8"));
    }
    return new WorkerBackend(client, rel, state);
  }

  async persist(): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        await this.client.write(this.rel, Buffer.from(JSON.stringify(this.state), "utf8"));
        this.lastPersistError = null;
      } catch (err) {
        this.lastPersistError = err instanceof Error ? err : new Error(String(err));
        console.error("WorkerStore: GAGAL menulis state via worker (data tetap di memori):", this.lastPersistError.message);
      }
    });
    this.chain = run.catch(() => undefined);
    await run;
  }

  /** Menunggu semua persist yang sedang berjalan selesai. */
  async flush(): Promise<void> {
    await this.chain;
  }

  async close(): Promise<void> {
    await this.persist();
  }

  stats(): Record<string, number> {
    return stateStats(this.state);
  }
}

export class WorkerBlobStore implements BlobStore {
  private readonly client: StorageClient;
  private readonly prefix: string;

  constructor(client: StorageClient, prefix: string) {
    this.client = client;
    this.prefix = prefix;
  }

  private rel(id: string): string {
    return `${this.prefix}/${sanitizeBlobId(id)}.bin`;
  }

  async put(id: string, data: Buffer): Promise<void> {
    await this.client.write(this.rel(id), data);
  }

  async get(id: string): Promise<Buffer | null> {
    return this.client.read(this.rel(id));
  }

  async delete(id: string): Promise<void> {
    await this.client.delete(this.rel(id));
  }

  async exists(id: string): Promise<boolean> {
    return this.client.exists(this.rel(id));
  }

  async size(id: string): Promise<number | null> {
    return this.client.stat(this.rel(id));
  }
}

export interface WorkerStores {
  backend: WorkerBackend;
  userStore: DiskUserStore;
  pairingStore: DiskPairingStore;
  deviceStore: DiskDeviceStore;
  sessionStore: DiskSessionStore;
  transferStore: DiskTransferStore;
  keyStore: DiskDeviceKeyStore;
  permissionStore: DiskPermissionStore;
  activityStore: DiskActivityLogStore;
  ruleStore: DiskAutomationRuleStore;
  notificationStore: DiskNotificationStore;
  blobStore: WorkerBlobStore;
}

/** Bangun 10 store + blob store di atas Storage Worker. stateRel =
 * path state JSON di dalam base dir worker (mis. "prata-store.json"),
 * blobPrefix = folder blob (mis. "blobs"). */
export async function createWorkerStores(
  client: StorageClient,
  opts: { stateRel?: string; blobPrefix?: string } = {},
): Promise<WorkerStores> {
  const backend = await WorkerBackend.create(client, opts.stateRel ?? "prata-store.json");
  return {
    backend,
    userStore: new DiskUserStore(backend),
    pairingStore: new DiskPairingStore(backend),
    deviceStore: new DiskDeviceStore(backend),
    sessionStore: new DiskSessionStore(backend),
    transferStore: new DiskTransferStore(backend),
    keyStore: new DiskDeviceKeyStore(backend),
    permissionStore: new DiskPermissionStore(backend),
    activityStore: new DiskActivityLogStore(backend),
    ruleStore: new DiskAutomationRuleStore(backend),
    notificationStore: new DiskNotificationStore(backend),
    blobStore: new WorkerBlobStore(client, opts.blobPrefix ?? "blobs"),
  };
}
