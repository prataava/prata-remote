// PRATA Remote — Uji E2E restart & persistence (FINALISASI Langkah 6)
// Membuktikan DiskStore + blob disk bertahan melewati restart server:
// pairing (device + token agen) -> automation rule -> upload blob ->
// MATIKAN server -> NYALAKAN lagi (data file SAMA) -> semua MASIH ADA
// dan berfungsi. Plus: unified server menyajikan Web Dashboard di `/`.
//
// PENTING — server dijalankan IN-PROCESS (seperti smoke test), BUKAN
// di-spawn sebagai anak proses. Alasannya terbukti empiris di VM ini
// (15 Nov 19.45–19.53 WIB): anak proses dari proses yang membaca
// ~/workspace MEWARISI blokir tulis sandbox (20 probe tulis gagal
// 5 menit), begitu pula data yang mengalir lewat pipe dari sumber
// ~/workspace; sementara tulis langsung satu proses (cp, git, tar
// -xzf, uji DiskStore 13/13) lolos saat rezim mengizinkan.
// "Restart" di sini = tutup server + buang SEMUA instance store lama +
// bangun server + store Disk BARU di file data yang sama — negara
// proses lama tidak ada yang tersisa kecuali berkas di disk.
// Jalankan:  node test/persistence.e2e.mjs   (dari apps/backend)
import WebSocket from "ws";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDiskStores, DiskBlobStore } from "../src/store/disk-store.ts";
import { StoreDeviceRegistry } from "../src/registry/store-registry.ts";
import { createRestRouter } from "../src/api/router.ts";
import { startSignalingServer } from "../src/signaling/server.ts";
import { hashPassword } from "../src/api/passwords.ts";

const JWT_SECRET = "persist-e2e-secret";
const EMAIL = "admin@prata.app";
const PASSWORD = "admin123";
const BLOB_TEXT = "PRATA-PERSISTENCE-BLOB-0123456789-abcdef";
const WEB_DIR = new URL("../../web", import.meta.url).pathname;
const RELEASES_DIR = new URL("../public/releases", import.meta.url).pathname;
const BUNDLE_PATH = join(RELEASES_DIR, "prata-remote-full-release.tar.gz");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "LULUS  " : "GAGAL  "}${name}${ok ? "" : " :: " + detail}`);
}

async function boot(dataFile, blobDir) {
  const disk = createDiskStores(dataFile);
  const blobStore = new DiskBlobStore(blobDir);
  const existing = await disk.userStore.findByEmail(EMAIL);
  if (!existing) {
    await disk.userStore.create({ email: EMAIL, passwordHash: hashPassword(PASSWORD), name: "Admin" });
  }
  const presenceHolder = { current: null };
  const hooks = { disconnectDevice: null, terminateAllSessions: null };
  const deviceRegistry = new StoreDeviceRegistry(disk.deviceStore, disk.keyStore);
  const router = createRestRouter({
    userStore: disk.userStore,
    pairingStore: disk.pairingStore,
    deviceStore: disk.deviceStore,
    jwtSecret: JWT_SECRET,
    getLiveStatus: (deviceId) => (presenceHolder.current?.isOnline(deviceId) ? "online" : "offline"),
    getLiveLastSeen: (deviceId) => presenceHolder.current?.lastSeenAt(deviceId) ?? null,
    transferStore: disk.transferStore,
    blobStore,
    verifyAgentToken: (deviceId, token) => deviceRegistry.verifyAgentToken(deviceId, token),
    sendToAgent: (deviceId, msg) => {
      const s = presenceHolder.current?.getAgentSocket(deviceId);
      if (!s || s.readyState !== 1) return false;
      s.send(JSON.stringify(msg));
      return true;
    },
    disconnectDevice: (deviceId, reason) => hooks.disconnectDevice?.(deviceId, reason),
    terminateAllSessions: (controllerId, reason) =>
      hooks.terminateAllSessions?.(controllerId, reason) ?? Promise.resolve(0),
    keyStore: disk.keyStore,
    permissionStore: disk.permissionStore,
    activityStore: disk.activityStore,
    ruleStore: disk.ruleStore,
    notificationStore: disk.notificationStore,
    releasesDir: RELEASES_DIR,
    sourceBundlePath: BUNDLE_PATH,
  });
  const server = await startSignalingServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    deviceRegistry,
    sessionStore: disk.sessionStore,
    transferStore: disk.transferStore,
    blobStore,
    ruleStore: disk.ruleStore,
    notificationStore: disk.notificationStore,
    activityStore: disk.activityStore,
    permissionStore: disk.permissionStore,
    staticDir: WEB_DIR,
    onHttpRequest: router,
  });
  presenceHolder.current = server.presence;
  hooks.disconnectDevice = (deviceId, reason) => server.disconnectDevice(deviceId, reason);
  hooks.terminateAllSessions = (controllerId, reason) => server.terminateAllSessions(controllerId, reason);
  return { server, base: `http://127.0.0.1:${server.port}`, disk };
}

function wsConnect(port, token, role, deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => reject(new Error("ws timeout")), 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", role, token, ...(deviceId ? { deviceId } : {}) })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") { clearTimeout(timer); resolve({ ws, msg }); }
      if (msg.type === "error") { clearTimeout(timer); reject(new Error(`ws error: ${msg.code ?? msg.message}`)); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "prata-persist-"));
  const dataFile = join(dir, "prata-store.json");
  const blobDir = join(dir, "blobs");
  mkdirSync(blobDir, { recursive: true });
  console.log(`dir tes: ${dir}`);

  // ---- BOOT 1: bangun state ----
  const b1 = await boot(dataFile, blobDir);
  const port1 = new URL(b1.base).port;
  const post = async (path, body, token) => {
    const res = await fetch(`${b1.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const login = await post("/api/auth/login", { email: EMAIL, password: PASSWORD });
  check("login seed admin (boot 1)", login.status === 200 && !!login.json.token, JSON.stringify(login.json).slice(0, 200));
  const jwt = login.json.token;

  // Gerbang tulis disk SEDINI MUNGKIN: login sudah memicu persist. Bila
  // rezim sandbox sedang memblokir tulis langsung, coba sekali lagi
  // lewat mutasi baru (login ke-2); bila tetap tidak ada berkas, gagal
  // JUJUR di sini — sebelum alur lain ikut runtuh.
  let wrote = existsSync(dataFile) && statSync(dataFile).size > 100;
  if (!wrote) {
    await post("/api/auth/login", { email: EMAIL, password: PASSWORD });
    await sleep(2000);
    wrote = existsSync(dataFile) && statSync(dataFile).size > 100;
  }
  check("berkas DiskStore ada di disk (tulis tidak diblokir sandbox)", wrote, `dataFile=${existsSync(dataFile) ? statSync(dataFile).size + " byte" : "tidak ada"} (bila gagal: rezim tulis sandbox sedang memblokir — ulangi tes)`);

  const init = await post("/api/devices/pairing/init", { deviceName: "POCO X6 Pro (uji persistensi)" });
  check("pairing init", init.status === 201 && !!init.json.pairingCode, JSON.stringify(init.json).slice(0, 200));
  const confirm = await post("/api/devices/pairing/confirm", { pairingId: init.json.pairingId, pairingCode: init.json.pairingCode }, jwt);
  check("pairing confirm -> device", confirm.status === 201 && !!confirm.json.deviceId, JSON.stringify(confirm.json).slice(0, 200));
  const deviceId = confirm.json.deviceId;
  const poll = await post("/api/devices/pairing/poll", { pairingId: init.json.pairingId, pairingCode: init.json.pairingCode });
  check("pairing poll -> agentToken sekali-baca", poll.status === 200 && !!poll.json.agentToken, JSON.stringify(poll.json).slice(0, 200));
  const agentToken = poll.json.agentToken;

  const agentWs = await wsConnect(port1, agentToken, "agent", deviceId).catch((e) => ({ error: e }));
  check("agen WS hello dengan token pairing", !agentWs.error, agentWs.error?.message ?? "");
  const agentSocket = agentWs.ws;

  const ruleRes = await post("/api/automation/rules", { name: "Baterai rendah (uji persistensi)", conditionType: "battery_below", threshold: 20, deviceId }, jwt);
  check("automation rule dibuat", ruleRes.status === 201 && !!ruleRes.json.rule?.id, JSON.stringify(ruleRes.json).slice(0, 200));
  const ruleId = ruleRes.json.rule?.id;

  const upRes = await fetch(`${b1.base}/api/devices/${deviceId}/files/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "x-file-name": "uji-persistensi.txt", "x-file-mime": "text/plain" },
    body: BLOB_TEXT,
  });
  const upJ = await upRes.json().catch(() => ({}));
  check("upload blob (controller -> server)", upRes.status === 201 && !!upJ.transferId, JSON.stringify(upJ).slice(0, 200));
  const transferId = upJ.transferId;

  // Gerbang blob: jangan GET bila berkas tidak mendarat di disk
  // (unggahan hantu harus gagal di sini, bukan di tengah respons).
  check("berkas blob ada di disk sebelum restart", existsSync(join(blobDir, `${transferId}.bin`)), "blob tidak ditemukan");
  const blobA = await fetch(`${b1.base}/api/transfers/${transferId}/blob`, { headers: { authorization: `Bearer ${agentToken}` } });
  check("agen GET blob sebelum restart (byte identik)", blobA.ok && (await blobA.text()) === BLOB_TEXT, `status ${blobA.status}`);

  // ---- RESTART (simulasi): tutup server + buang semua store lama ----
  try { agentSocket.close(); } catch { /* abaikan */ }
  await b1.server.close();
  await sleep(500);

  // ---- BOOT 2: store Disk BARU di file data yang SAMA ----
  const b2 = await boot(dataFile, blobDir);
  const port2 = new URL(b2.base).port;
  const get2 = async (path, token) => {
    const res = await fetch(`${b2.base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => ({})), res };
  };
  const login2res = await fetch(`${b2.base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const lj2 = await login2res.json().catch(() => ({}));
  check("login tetap bisa sesudah restart", login2res.ok && !!lj2.token, JSON.stringify(lj2).slice(0, 200));
  const jwt2 = lj2.token;
  const devs = await get2("/api/devices", jwt2);
  check("device hasil pairing MASIH ADA sesudah restart", (devs.json.devices ?? []).some((d) => d.id === deviceId), JSON.stringify(devs.json).slice(0, 200));
  const agent2 = await wsConnect(port2, agentToken, "agent", deviceId).catch((e) => ({ error: e }));
  check("token agen LAMA tetap lolos WS hello sesudah restart", !agent2.error, agent2.error?.message ?? "");
  if (!agent2.error) agent2.ws.close();
  const rules2 = await get2("/api/automation/rules", jwt2);
  check("automation rule MASIH ADA sesudah restart", (rules2.json.rules ?? []).some((r) => r.id === ruleId), JSON.stringify(rules2.json).slice(0, 200));
  const logs2 = await get2("/api/activity-logs?limit=50", jwt2);
  const loginLogs = (logs2.json.logs ?? []).filter((l) => l.action === "login");
  check("activity logs MASIH ADA sesudah restart (login boot 1 + boot 2 tercatat)", loginLogs.length >= 2, `login tercatat=${loginLogs.length} (1 = hanya login boot 2: data boot 1 hilang)`);
  const tr2 = await get2(`/api/transfers/${transferId}`, jwt2);
  check("transfer MASIH ADA sesudah restart", tr2.status === 200 && (tr2.json.transfer?.fileName === "uji-persistensi.txt" || tr2.json.fileName === "uji-persistensi.txt"), JSON.stringify(tr2.json).slice(0, 200));
  const blobB = await fetch(`${b2.base}/api/transfers/${transferId}/blob`, { headers: { authorization: `Bearer ${agentToken}` } });
  check("blob MASIH BISA diunduh agen sesudah restart (byte identik)", blobB.ok && (await blobB.text()) === BLOB_TEXT, `status ${blobB.status}`);

  const root = await fetch(`${b2.base}/`);
  const rootText = await root.text();
  check("GET / menyajikan Web Dashboard lengkap", root.ok && rootText.includes("js/app.js"), `status ${root.status}, ${rootText.length} byte`);
  const appJs = await fetch(`${b2.base}/js/app.js`);
  check("GET /js/app.js 200", appJs.ok, `status ${appJs.status}`);
  const apks = await get2("/api/releases/apks", jwt2);
  check("GET /api/releases/apks 200", apks.status === 200, `status ${apks.status}`);
  const bundle = await fetch(`${b2.base}/api/releases/source-bundle`, { headers: { authorization: `Bearer ${jwt2}` } });
  check("GET /api/releases/source-bundle 200 (bundel 187 KB)", bundle.ok && Number(bundle.headers.get("content-length") ?? 0) > 100000, `status ${bundle.status}, len=${bundle.headers.get("content-length")}`);

  await b2.server.close();
  rmSync(dir, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nRINGKASAN PERSISTENCE E2E: ${passed} lulus, ${failed} gagal`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
