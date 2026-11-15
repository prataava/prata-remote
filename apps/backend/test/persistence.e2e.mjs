// PRATA Remote — Uji E2E restart & persistence (FINALISASI Langkah 6)
// Membuktikan DiskStore + blob disk bertahan melewati restart server:
// pairing (device + token agen) -> automation rule -> upload blob ->
// MATIKAN server -> NYALAKAN lagi (data file SAMA) -> semua MASIH ADA
// dan berfungsi. Plus: unified server menyajikan Web Dashboard di `/`.
// Jalankan:  node test/persistence.e2e.mjs   (dari apps/backend)
// CATATAN SANDBOX: proses yang sudah membaca ~/workspace kadang tidak bisa
// menulis (EPERM, rezim datang-pergi). Tes ini mem-probe rezim tulis dulu:
// bila masih diblokir sesudah ~5 menit, tes GAGAL JUJUR dengan diagnosis
// (bukan false-pass) — ulangi saat rezim membaik.
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 18098;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "persist-e2e-secret";
const SEED = "admin@prata.app:admin123:Admin";
const BLOB_TEXT = "PRATA-PERSISTENCE-BLOB-0123456789-abcdef";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "LULUS  " : "GAGAL  "}${name}${ok ? "" : " :: " + detail}`);
}

async function probeWrite(dir) {
  // Proses anak BERSIH (skrip inline, tidak membaca ~/workspace): bila ia
  // tidak bisa menulis, rezim sandbox sedang memblokir tulis.
  const probe = join(dir, "probe.txt");
  for (let i = 0; i < 20; i++) {
    const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], 'x')", probe], { stdio: "ignore" });
    const code = await new Promise((res) => child.on("close", res));
    if (code === 0 && existsSync(probe)) return true;
    await sleep(15000);
  }
  return false;
}

function startServer(dataFile, blobDir) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    PRATA_DEV: "1",
    JWT_SECRET,
    PRATA_SEED_USER: SEED,
    PRATA_DATA_FILE: dataFile,
    PRATA_BLOB_DIR: blobDir,
  };
  const child = spawn(process.execPath, ["src/index.ts"], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });
  return { child, log: () => out };
}

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch { /* belum naik */ }
    await sleep(250);
  }
  return false;
}

async function stopServer(srv) {
  srv.child.kill("SIGTERM");
  await new Promise((res) => srv.child.on("exit", res));
  await sleep(500);
}

function wsConnect(token, role, deviceId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
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

  if (!(await probeWrite(dir))) {
    check("rezim tulis sandbox mengizinkan tulis (probe 5 menit)", false, "tulis diblokir EPERM — ulangi tes saat rezim membaik; BUKAN kegagalan kode");
    console.log(`\nRINGKASAN PERSISTENCE E2E: ${results.filter((r) => r.ok).length} lulus, ${results.filter((r) => !r.ok).length} gagal`);
    process.exit(1);
  }
  check("rezim tulis sandbox mengizinkan tulis (probe)", true);

  // ---- SERVER A: bangun state ----
  const srvA = startServer(dataFile, blobDir);
  check("server A naik (healthz)", await waitHealth(), srvA.log().slice(-500));
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@prata.app", password: "admin123" }) });
  const lj = await login.json();
  check("login seed admin (server A)", login.ok && !!lj.token, JSON.stringify(lj).slice(0, 200));
  const jwt = lj.token;
  const auth = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };

  const init = await fetch(`${BASE}/api/devices/pairing/init`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceName: "POCO X6 Pro (uji persistensi)" }) });
  const pj = await init.json();
  check("pairing init", init.status === 201 && !!pj.pairingCode, JSON.stringify(pj).slice(0, 200));
  const confirm = await fetch(`${BASE}/api/devices/pairing/confirm`, { method: "POST", headers: auth, body: JSON.stringify({ pairingId: pj.pairingId, pairingCode: pj.pairingCode }) });
  const cj = await confirm.json();
  check("pairing confirm -> device", confirm.status === 201 && !!cj.deviceId, JSON.stringify(cj).slice(0, 200));
  const deviceId = cj.deviceId;
  const poll = await fetch(`${BASE}/api/devices/pairing/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairingId: pj.pairingId, pairingCode: pj.pairingCode }) });
  const polj = await poll.json();
  check("pairing poll -> agentToken sekali-baca", poll.ok && !!polj.agentToken, JSON.stringify(polj).slice(0, 200));
  const agentToken = polj.agentToken;

  const agentWs = await wsConnect(agentToken, "agent", deviceId).catch((e) => ({ error: e }));
  check("agen WS hello dengan token pairing", !agentWs.error, agentWs.error?.message ?? "");
  const agentSocket = agentWs.ws;

  const ruleRes = await fetch(`${BASE}/api/automation/rules`, { method: "POST", headers: auth, body: JSON.stringify({ name: "Baterai rendah (uji persistensi)", conditionType: "battery_below", threshold: 20, deviceId }) });
  const ruleJ = await ruleRes.json();
  check("automation rule dibuat", ruleRes.status === 201 && !!ruleJ.rule?.id, JSON.stringify(ruleJ).slice(0, 200));
  const ruleId = ruleJ.rule?.id;

  const up = await fetch(`${BASE}/api/devices/${deviceId}/files/upload`, { method: "POST", headers: { Authorization: `Bearer ${jwt}`, "X-File-Name": "uji-persistensi.txt", "X-File-Mime": "text/plain" }, body: BLOB_TEXT });
  const upJ = await up.json();
  check("upload blob (controller -> server)", up.status === 201 && !!upJ.transferId, JSON.stringify(upJ).slice(0, 200));
  const transferId = upJ.transferId;

  const blobA = await fetch(`${BASE}/api/transfers/${transferId}/blob`, { headers: { Authorization: `Bearer ${agentToken}` } });
  check("agen GET blob sebelum restart (byte identik)", blobA.ok && (await blobA.text()) === BLOB_TEXT, `status ${blobA.status}`);
  check("berkas DiskStore ada di disk sebelum restart", existsSync(dataFile) && statSync(dataFile).size > 100, `size=${existsSync(dataFile) ? statSync(dataFile).size : "tidak ada"}`);
  check("berkas blob ada di disk sebelum restart", existsSync(join(blobDir, `${transferId}.bin`)), "blob tidak ditemukan");

  // ---- RESTART ----
  await stopServer(srvA);
  check("server A mati (SIGTERM)", srvA.child.exitCode !== null, `exit=${srvA.child.exitCode}`);
  const srvB = startServer(dataFile, blobDir);
  check("server B naik (healthz, data file SAMA)", await waitHealth(), srvB.log().slice(-500));

  // ---- VERIFIKASI SESUDAH RESTART ----
  const login2 = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@prata.app", password: "admin123" }) });
  const lj2 = await login2.json();
  check("login tetap bisa sesudah restart", login2.ok && !!lj2.token, JSON.stringify(lj2).slice(0, 200));
  const jwt2 = lj2.token;
  const auth2 = { Authorization: `Bearer ${jwt2}` };
  const devs = await (await fetch(`${BASE}/api/devices`, { headers: auth2 })).json();
  check("device hasil pairing MASIH ADA sesudah restart", (devs.devices ?? []).some((d) => d.id === deviceId), JSON.stringify(devs).slice(0, 200));
  const agent2 = await wsConnect(agentToken, "agent", deviceId).catch((e) => ({ error: e }));
  check("token agen LAMA tetap lolos WS hello sesudah restart", !agent2.error, agent2.error?.message ?? "");
  if (!agent2.error) agent2.ws.close();
  const rules2 = await (await fetch(`${BASE}/api/automation/rules`, { headers: auth2 })).json();
  check("automation rule MASIH ADA sesudah restart", (rules2.rules ?? []).some((r) => r.id === ruleId), JSON.stringify(rules2).slice(0, 200));
  const logs2 = await (await fetch(`${BASE}/api/activity-logs?limit=50`, { headers: auth2 })).json();
  check("activity logs MASIH ADA sesudah restart (login tercatat)", (logs2.logs ?? []).some((l) => l.action === "login"), `jumlah log=${(logs2.logs ?? []).length}`);
  const tr2 = await fetch(`${BASE}/api/transfers/${transferId}`, { headers: auth2 });
  const tr2j = await tr2.json();
  check("transfer MASIH ADA sesudah restart", tr2.ok && (tr2j.transfer?.fileName === "uji-persistensi.txt" || tr2j.fileName === "uji-persistensi.txt"), JSON.stringify(tr2j).slice(0, 200));
  const blobB = await fetch(`${BASE}/api/transfers/${transferId}/blob`, { headers: { Authorization: `Bearer ${agentToken}` } });
  check("blob MASIH BISA diunduh agen sesudah restart (byte identik)", blobB.ok && (await blobB.text()) === BLOB_TEXT, `status ${blobB.status}`);

  // unified server: Web Dashboard di /
  const root = await fetch(`${BASE}/`);
  const rootText = await root.text();
  check("GET / menyajikan Web Dashboard lengkap", root.ok && rootText.includes("js/app.js"), `status ${root.status}, ${rootText.length} byte`);
  const appJs = await fetch(`${BASE}/js/app.js`);
  check("GET /js/app.js 200", appJs.ok, `status ${appJs.status}`);
  const apks = await fetch(`${BASE}/api/releases/apks`, { headers: auth2 });
  check("GET /api/releases/apks 200", apks.ok, `status ${apks.status}`);
  const bundle = await fetch(`${BASE}/api/releases/source-bundle`, { headers: auth2 });
  check("GET /api/releases/source-bundle 200 (bundel 187 KB)", bundle.ok && Number(bundle.headers.get("content-length") ?? 0) > 100000, `status ${bundle.status}, len=${bundle.headers.get("content-length")}`);

  // bersih-bersih: ack transfer agar blob terhapus, tutup soket, matikan server
  try { agentSocket.send(JSON.stringify({ type: "file_transfer_done", transferId, ok: true })); } catch { /* abaikan */ }
  try { agentSocket.close(); } catch { /* abaikan */ }
  await stopServer(srvB);
  check("server B mati (SIGTERM)", srvB.child.exitCode !== null, `exit=${srvB.child.exitCode}`);
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
