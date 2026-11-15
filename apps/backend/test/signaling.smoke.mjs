// PRATA Remote — Smoke test signaling server (Command 001)
// Menjalankan server asli (bukan mock) di port acak, lalu menguji alur
// end-to-end dengan dua klien WebSocket sungguhan (agen + controller).
// Jalankan:  node test/signaling.smoke.mjs   (dari apps/backend)
// Butuh: paket "ws" terpasang (npm install) atau ter-symlink di node_modules.
import WebSocket from "ws";
import { startSignalingServer } from "../src/signaling/server.ts";
import { MemoryDeviceStore } from "../src/api/devices.ts";
import { StoreDeviceRegistry } from "../src/registry/store-registry.ts";
import { hashToken } from "../src/signaling/auth.ts";
import { MemorySessionStore } from "../src/store/session-store.ts";
import { mintControllerToken } from "../src/signaling/auth.ts";
import { MemoryActivityLogStore } from "../src/api/activity-logs.ts";
import { MemoryAutomationRuleStore } from "../src/api/automation.ts";
import { MemoryNotificationStore } from "../src/api/notifications.ts";
import { MemoryPermissionStore } from "../src/api/permissions.ts";

const JWT_SECRET = "smoke-test-secret";
const DEVICE_ID = "device-1";
const AGENT_TOKEN = "token-abc-123";
const USER_ID = "user-1";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "LULUS  " : "GAGAL  "}${name}${ok ? "" : " :: " + detail}`);
}

function jwt(sub, role = "user") {
  return mintControllerToken({ sub, role, expiresInSec: 300 }, JWT_SECRET);
}

function makeClient(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    queue.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: (pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const found = queue.find(pred);
        if (found) return resolve(found);
        const waiter = { pred, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`timeout menunggu pesan: ${JSON.stringify(queue.slice(-3))}`));
        }, timeoutMs);
      }),
    close: () => ws.close(),
  };
}

const open = (client) =>
  new Promise((resolve, reject) => {
    client.ws.once("open", resolve);
    client.ws.once("error", reject);
    setTimeout(() => reject(new Error("timeout open")), 5000);
  });

const closed = (client) =>
  new Promise((resolve) => {
    if (client.ws.readyState === WebSocket.CLOSED) return resolve();
    client.ws.once("close", () => resolve());
    setTimeout(resolve, 5000);
  });

async function main() {
  const deviceStore = new MemoryDeviceStore();
  await deviceStore.create({
    id: DEVICE_ID,
    ownerId: USER_ID,
    name: "HP Tes",
    agentTokenHash: hashToken(AGENT_TOKEN),
  });
  const registry = new StoreDeviceRegistry(deviceStore);
  const ruleStore = new MemoryAutomationRuleStore();
  const notificationStore = new MemoryNotificationStore();
  const activityStore = new MemoryActivityLogStore();
  const permissionStore = new MemoryPermissionStore();
  const server = await startSignalingServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    deviceRegistry: registry,
    sessionStore: new MemorySessionStore(),
    ruleStore,
    notificationStore,
    activityStore,
    permissionStore,
  });
  const url = `ws://127.0.0.1:${server.port}`;
  console.log(`server smoke di ${url}`);

  try {
    // 1) healthz
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    const healthJson = await health.json();
    check("healthz 200 + status ok", health.ok && healthJson.status === "ok", JSON.stringify(healthJson));

    // 2) agen hello -> welcome + online
    const agent = makeClient(url);
    await open(agent);
    agent.send({ type: "hello", role: "agent", deviceId: DEVICE_ID, token: AGENT_TOKEN });
    const welcomeAgent = await agent.waitFor((m) => m.type === "welcome");
    check("agen hello -> welcome", welcomeAgent.peerId === DEVICE_ID && welcomeAgent.role === "agent");
    check(
      "welcome agen berisi iceServers STUN",
      Array.isArray(welcomeAgent.iceServers) &&
        welcomeAgent.iceServers.some((s) => JSON.stringify(s.urls).includes("stun.l.google.com:19302")),
      JSON.stringify(welcomeAgent.iceServers),
    );

    // 3) controller hello (JWT) -> welcome
    const ctrl = makeClient(url);
    await open(ctrl);
    ctrl.send({ type: "hello", role: "controller", token: jwt(USER_ID) });
    const welcomeCtrl = await ctrl.waitFor((m) => m.type === "welcome");
    check("controller hello JWT -> welcome", welcomeCtrl.peerId === USER_ID && welcomeCtrl.role === "controller");
    check(
      "welcome controller berisi iceServers STUN",
      Array.isArray(welcomeCtrl.iceServers) &&
        welcomeCtrl.iceServers.some((s) => JSON.stringify(s.urls).includes("stun.l.google.com:19302")),
      JSON.stringify(welcomeCtrl.iceServers),
    );

    // 4) controller watch -> presence online
    ctrl.send({ type: "watch", deviceId: DEVICE_ID });
    const presenceOnline = await ctrl.waitFor((m) => m.type === "presence" && m.deviceId === DEVICE_ID);
    check("watch -> presence online", presenceOnline.status === "online", JSON.stringify(presenceOnline));

    // 5) session-request -> agen menerima -> accept -> controller menerima accepted
    ctrl.send({ type: "session-request", deviceId: DEVICE_ID, sessionType: "screen" });
    const req = await agent.waitFor((m) => m.type === "session-request");
    check("session-request diteruskan ke agen", typeof req.sessionId === "string" && req.from === USER_ID);
    const connecting = await ctrl.waitFor((m) => m.type === "presence" && m.status === "connecting");
    check("presence connecting saat diminta", connecting.deviceId === DEVICE_ID);
    agent.send({ type: "session-accept", sessionId: req.sessionId });
    const accepted = await ctrl.waitFor((m) => m.type === "session-accepted");
    check("session-accept -> session-accepted", accepted.sessionId === req.sessionId);

    // 6) relay webrtc_offer/webrtc_answer/webrtc_ice_candidate dua arah
    ctrl.send({ type: "webrtc_offer", sessionId: req.sessionId, payload: { type: "offer", sdp: "offer-sdp" } });
    const offer = await agent.waitFor((m) => m.type === "webrtc_offer");
    check("webrtc_offer controller -> agen", offer.payload?.sdp === "offer-sdp" && offer.from === USER_ID);
    agent.send({ type: "webrtc_answer", sessionId: req.sessionId, payload: { type: "answer", sdp: "answer-sdp" } });
    const answer = await ctrl.waitFor((m) => m.type === "webrtc_answer");
    check("webrtc_answer agen -> controller", answer.payload?.sdp === "answer-sdp" && answer.from === DEVICE_ID);
    agent.send({ type: "webrtc_ice_candidate", sessionId: req.sessionId, payload: { candidate: "c1" } });
    const ice = await ctrl.waitFor((m) => m.type === "webrtc_ice_candidate");
    check("webrtc_ice_candidate agen -> controller", ice.payload?.candidate === "c1");

    // 6b) alias lama (offer/answer/ice) tetap diterima, diteruskan sebagai webrtc_*
    ctrl.send({ type: "offer", sessionId: req.sessionId, payload: { sdp: "legacy-sdp" } });
    const legacyOffer = await agent.waitFor((m) => m.type === "webrtc_offer" && m.payload?.sdp === "legacy-sdp");
    check("alias offer lama -> diteruskan sebagai webrtc_offer", legacyOffer.from === USER_ID);

    // 6c) accept + offer berurutan tanpa jeda (alur agent Command 003):
    // agen mengirim session-accept lalu langsung webrtc_offer — server
    // harus memproses berurutan agar offer tidak ditolak not-in-session.
    ctrl.send({ type: "session-request", deviceId: DEVICE_ID, sessionType: "screen" });
    const req2 = await agent.waitFor((m) => m.type === "session-request" && m.sessionId !== req.sessionId);
    agent.send({ type: "session-accept", sessionId: req2.sessionId });
    agent.send({ type: "webrtc_offer", sessionId: req2.sessionId, payload: { type: "offer", sdp: "back-to-back-sdp" } });
    const b2b = await ctrl.waitFor((m) => m.type === "webrtc_offer" && m.payload?.sdp === "back-to-back-sdp");
    check("accept + offer berurutan -> controller terima webrtc_offer", b2b.sessionId === req2.sessionId);
    ctrl.send({ type: "session-end", sessionId: req2.sessionId, reason: "selesai-tes-2" });
    await agent.waitFor((m) => m.type === "session-ended" && m.sessionId === req2.sessionId);
    ctrl.send({ type: "offer", sessionId: "ses_tidak_ada", payload: { sdp: "x" } });
    const relayErr = await ctrl.waitFor((m) => m.type === "error" && m.code === "not-in-session");
    check("offer sesi tak dikenal -> error not-in-session", true, JSON.stringify(relayErr));

    // 7) device_metrics (Command 007): agen kirim -> controller yang
    // watch menerima, tanpa perlu sesi screen streaming.
    const metrics = {
      batteryPct: 87,
      charging: false,
      storageTotalBytes: 128000000000,
      storageFreeBytes: 42000000000,
      ramTotalBytes: 8000000000,
      ramAvailBytes: 3100000000,
    };
    agent.send({ type: "device_metrics", metrics });
    const dm = await ctrl.waitFor((m) => m.type === "device_metrics" && m.deviceId === DEVICE_ID);
    check(
      "device_metrics agen -> controller watcher",
      dm.metrics?.batteryPct === 87 && dm.metrics?.ramAvailBytes === 3100000000 && typeof dm.at === "string",
      JSON.stringify(dm),
    );

    // 7b) controller lain yang tidak watch & tidak di room TIDAK menerima.
    const ctrl2 = makeClient(url);
    await open(ctrl2);
    ctrl2.send({ type: "hello", role: "controller", token: jwt(USER_ID) });
    await ctrl2.waitFor((m) => m.type === "welcome");
    agent.send({ type: "device_metrics", metrics: { ...metrics, batteryPct: 86 } });
    const dm2 = await ctrl.waitFor((m) => m.type === "device_metrics" && m.metrics?.batteryPct === 86);
    check("device_metrics kedua -> watcher tetap menerima", dm2.deviceId === DEVICE_ID);
    let ctrl2GotMetrics = false;
    ctrl2
      .waitFor((m) => m.type === "device_metrics", 400)
      .then(() => {
        ctrl2GotMetrics = true;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    check("device_metrics TIDAK bocor ke controller non-watcher", !ctrl2GotMetrics);
    ctrl2.close();

    // 7c) controller mengirim device_metrics -> ditolak (hanya agen).
    ctrl.send({ type: "device_metrics", metrics });
    const dmErr = await ctrl.waitFor((m) => m.type === "error" && m.code === "bad-message");
    check("device_metrics dari controller -> error bad-message", true, JSON.stringify(dmErr));

    // 7d) agen mengirim metrik bukan objek -> ditolak.
    agent.send({ type: "device_metrics", metrics: "bukan-objek" });
    const dmBad = await agent.waitFor((m) => m.type === "error" && m.code === "bad-message");
    check("device_metrics bukan objek -> error bad-message", true, JSON.stringify(dmBad));

    // 7e) file_list relay (Command 008): controller -> agen -> controller
    ctrl.send({ type: "file_list_request", requestId: "req-1", deviceId: DEVICE_ID, docId: null });
    const listReq = await agent.waitFor((m) => m.type === "file_list_request" && m.requestId === "req-1");
    check("file_list_request controller -> agen", listReq.docId === null, JSON.stringify(listReq));
    agent.send({
      type: "file_list_response",
      requestId: "req-1",
      items: [{ name: "Dokumen", isDirectory: true, size: null, mimeType: null, lastModified: 1000, docId: "doc:1" }],
    });
    const listResp = await ctrl.waitFor((m) => m.type === "file_list_response" && m.requestId === "req-1");
    check(
      "file_list_response agen -> controller",
      listResp.items?.[0]?.name === "Dokumen" && listResp.items?.[0]?.isDirectory === true,
      JSON.stringify(listResp),
    );

    // 7f) file_list_request perangkat tak dikenal -> error unknown-session
    ctrl.send({ type: "file_list_request", requestId: "req-2", deviceId: "device-tidak-ada", docId: null });
    const listErr = await ctrl.waitFor((m) => m.type === "error" && m.code === "unknown-session");
    check("file_list_request device tak dikenal -> error", true, JSON.stringify(listErr));

    // 7g) file_mkdir relay (FINAL, Bagian 2): controller -> agen -> controller
    ctrl.send({ type: "file_mkdir_request", requestId: "op-1", deviceId: DEVICE_ID, parentDocId: null, name: "Folder Baru" });
    const mkdirReq = await agent.waitFor((m) => m.type === "file_mkdir_request" && m.requestId === "op-1");
    check("file_mkdir_request controller -> agen", mkdirReq.name === "Folder Baru", JSON.stringify(mkdirReq));
    agent.send({ type: "file_op_response", requestId: "op-1", ok: true });
    const mkdirResp = await ctrl.waitFor((m) => m.type === "file_op_response" && m.requestId === "op-1");
    check("file_op_response agen -> controller", mkdirResp.ok === true, JSON.stringify(mkdirResp));

    // 7h) app_list relay (FINAL, Bagian 3): controller -> agen -> controller
    ctrl.send({ type: "app_list_request", requestId: "app-1", deviceId: DEVICE_ID });
    const appReq = await agent.waitFor((m) => m.type === "app_list_request" && m.requestId === "app-1");
    check("app_list_request controller -> agen", true, JSON.stringify(appReq));
    agent.send({
      type: "app_list_response",
      requestId: "app-1",
      apps: [{ packageName: "com.contoh.app", label: "Contoh", versionName: "1.0", isSystemApp: false }],
    });
    const appResp = await ctrl.waitFor((m) => m.type === "app_list_response" && m.requestId === "app-1");
    check(
      "app_list_response agen -> controller",
      appResp.apps?.[0]?.packageName === "com.contoh.app" && appResp.apps?.[0]?.isSystemApp === false,
      JSON.stringify(appResp),
    );

    // 7i) app_command relay (FINAL, Bagian 3)
    ctrl.send({ type: "app_command", requestId: "app-2", deviceId: DEVICE_ID, command: "open", packageName: "com.contoh.app" });
    const cmdReq = await agent.waitFor((m) => m.type === "app_command" && m.requestId === "app-2");
    check("app_command controller -> agen", cmdReq.command === "open", JSON.stringify(cmdReq));
    agent.send({ type: "app_command_response", requestId: "app-2", ok: true });
    const cmdResp = await ctrl.waitFor((m) => m.type === "app_command_response" && m.requestId === "app-2");
    check("app_command_response agen -> controller", cmdResp.ok === true, JSON.stringify(cmdResp));

    // 7j) device_notification (FINAL, Bagian 4): agen -> controller + tersimpan
    agent.send({
      type: "device_notification",
      deviceId: DEVICE_ID,
      packageName: "com.whatsapp",
      appName: "WhatsApp",
      title: "Pesan baru",
      text: "Halo dari tes",
      at: new Date().toISOString(),
    });
    const notif = await ctrl.waitFor((m) => m.type === "device_notification" && m.packageName === "com.whatsapp");
    check("device_notification agen -> controller", notif.appName === "WhatsApp" && notif.title === "Pesan baru", JSON.stringify(notif));
    const storedNotifs = await notificationStore.listByOwner(USER_ID);
    check("device_notification tersimpan di store", storedNotifs.length === 1 && storedNotifs[0].kind === "device");

    // 7k) permission_report (FINAL, Bagian 1): agen -> store
    agent.send({
      type: "permission_report",
      permissions: [
        { feature: "screen", granted: true },
        { feature: "accessibility", granted: false },
        { feature: "bukan-fitur", granted: true },
      ],
    });
    await new Promise((r) => setTimeout(r, 200));
    const perms = await permissionStore.listByDevice(DEVICE_ID);
    check(
      "permission_report tersimpan (fitur tak dikenal diabaikan)",
      perms.length === 2 && perms.find((p) => p.feature === "screen")?.granted === true,
      JSON.stringify(perms),
    );

    // 7l) automation_alert (FINAL, Bagian 6): metrik baterai rendah -> alert
    await ruleStore.create({ ownerId: USER_ID, deviceId: DEVICE_ID, name: "Baterai rendah", conditionType: "battery_below", threshold: 50 });
    agent.send({ type: "device_metrics", metrics: { batteryPct: 10, charging: false } });
    const alert = await ctrl.waitFor((m) => m.type === "automation_alert");
    check("automation_alert baterai rendah -> controller", alert.ruleName === "Baterai rendah", JSON.stringify(alert));
    const autoNotifs = await notificationStore.listByOwner(USER_ID, { kind: "automation" });
    check("automation_alert tersimpan sebagai notifikasi", autoNotifs.length === 1, JSON.stringify(autoNotifs));
    const autoLogs = await activityStore.listByOwner(USER_ID);
    check("automation_alert tercatat di activity log", autoLogs.some((l) => l.action === "automation-alert"));

    // 7m) Regresi multi-koneksi (FINAL): koneksi kedua user yang sama
    // menutup TIDAK boleh mematikan push ke koneksi pertama.
    await ruleStore.create({ ownerId: USER_ID, deviceId: DEVICE_ID, name: "Penyimpanan penuh", conditionType: "storage_above", threshold: 90 });
    const ctrl3 = makeClient(url);
    await open(ctrl3);
    ctrl3.send({ type: "hello", role: "controller", token: jwt(USER_ID) });
    await ctrl3.waitFor((m) => m.type === "welcome");
    ctrl3.close();
    await new Promise((r) => setTimeout(r, 200));
    agent.send({ type: "device_metrics", metrics: { batteryPct: 80, storageTotalBytes: 100, storageFreeBytes: 5 } });
    const alert2 = await ctrl.waitFor((m) => m.type === "automation_alert" && m.ruleName === "Penyimpanan penuh");
    check("automation_alert tetap sampai sesudah koneksi kedua ditutup", alert2.ruleName === "Penyimpanan penuh", JSON.stringify(alert2));

    // 8) session-end -> agen menerima session-ended
    ctrl.send({ type: "session-end", sessionId: req.sessionId, reason: "selesai-tes" });
    const ended = await agent.waitFor((m) => m.type === "session-ended" && m.sessionId === req.sessionId);
    check("session-end -> session-ended di agen", ended.sessionId === req.sessionId);

    // 9) agen putus -> presence offline di controller
    agent.close();
    const presenceOffline = await ctrl.waitFor((m) => m.type === "presence" && m.status === "offline");
    check("agen putus -> presence offline", presenceOffline.deviceId === DEVICE_ID);

    // 10) auth negatif: token agen salah -> error + tutup
    const badAgent = makeClient(url);
    await open(badAgent);
    badAgent.send({ type: "hello", role: "agent", deviceId: DEVICE_ID, token: "token-salah" });
    const badAgentErr = await badAgent.waitFor((m) => m.type === "error");
    check("token agen salah -> error auth-failed", badAgentErr.code === "auth-failed");
    await closed(badAgent);
    check("token agen salah -> koneksi ditutup", badAgent.ws.readyState === WebSocket.CLOSED);

    // 11) auth negatif: JWT palsu -> error + tutup
    const badCtrl = makeClient(url);
    await open(badCtrl);
    badCtrl.send({ type: "hello", role: "controller", token: jwt(USER_ID).slice(0, -4) + "xxxx" });
    const badCtrlErr = await badCtrl.waitFor((m) => m.type === "error");
    check("JWT palsu -> error auth-failed", badCtrlErr.code === "auth-failed");
    await closed(badCtrl);
    check("JWT palsu -> koneksi ditutup", badCtrl.ws.readyState === WebSocket.CLOSED);

    // 12) pesan sebelum hello -> ditolak
    const early = makeClient(url);
    await open(early);
    early.send({ type: "heartbeat" });
    const earlyErr = await early.waitFor((m) => m.type === "error");
    check("pesan sebelum hello -> error auth-required", earlyErr.code === "auth-required");
    await closed(early);

    ctrl.close();
    await server.close();
  } catch (err) {
    console.error("SMOKE ERROR:", err);
    await server.close().catch(() => {});
    process.exitCode = 1;
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nRINGKASAN smoke: ${results.length - failed.length}/${results.length} lulus, ${failed.length} gagal`);
  if (failed.length > 0) process.exitCode = 1;
}

main();
