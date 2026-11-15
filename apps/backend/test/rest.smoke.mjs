// PRATA Remote — Smoke test REST API + pairing (Command 002, Tugas 1)
// Menjalankan server asli (REST + WS di satu port) lalu menguji alur
// end-to-end: login -> pairing init -> poll -> confirm (QR) -> poll
// ambil token -> agent hello WS dengan token hasil pairing -> daftar
// perangkat berubah offline -> online.
// Jalankan:  node test/rest.smoke.mjs   (dari apps/backend)
import WebSocket from "ws";
import { startSignalingServer } from "../src/signaling/server.ts";
import { StoreDeviceRegistry } from "../src/registry/store-registry.ts";
import { MemorySessionStore } from "../src/store/session-store.ts";
import { MemoryUserStore } from "../src/api/users.ts";
import { MemoryPairingStore } from "../src/api/pairings.ts";
import { MemoryDeviceStore } from "../src/api/devices.ts";
import { createRestRouter } from "../src/api/router.ts";
import { hashPassword } from "../src/api/passwords.ts";
import { hashToken, verifyControllerToken } from "../src/signaling/auth.ts";
import { MemoryBlobStore, MemoryTransferStore } from "../src/api/transfers.ts";
import { MemoryDeviceKeyStore } from "../src/api/device-keys.ts";
import { MemoryPermissionStore } from "../src/api/permissions.ts";
import { MemoryActivityLogStore } from "../src/api/activity-logs.ts";
import { MemoryAutomationRuleStore } from "../src/api/automation.ts";
import { MemoryNotificationStore } from "../src/api/notifications.ts";

const JWT_SECRET = "rest-smoke-secret";
const EMAIL = "owner@prata.test";
const PASSWORD = "KataSandiKuat123";
const DEVICE_NAME = "POCO X6 Pro";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "LULUS  " : "GAGAL  "}${name}${ok ? "" : " :: " + detail}`);
}

async function main() {
  const userStore = new MemoryUserStore();
  const pairingStore = new MemoryPairingStore();
  const deviceStore = new MemoryDeviceStore();
  const user = await userStore.create({ email: EMAIL, passwordHash: hashPassword(PASSWORD), name: "Pemilik Tes" });

  const presenceHolder = { current: null };
  const serverHooks = { disconnectDevice: null, terminateAllSessions: null };
  const transferStore = new MemoryTransferStore();
  const blobStore = new MemoryBlobStore();
  const deviceRegistry = new StoreDeviceRegistry(deviceStore);
  const keyStore = new MemoryDeviceKeyStore();
  const permissionStore = new MemoryPermissionStore();
  const activityStore = new MemoryActivityLogStore();
  const ruleStore = new MemoryAutomationRuleStore();
  const notificationStore = new MemoryNotificationStore();
  const restRouter = createRestRouter({
    userStore,
    pairingStore,
    deviceStore,
    jwtSecret: JWT_SECRET,
    getLiveStatus: (deviceId) => (presenceHolder.current?.isOnline(deviceId) ? "online" : "offline"),
    getLiveLastSeen: (deviceId) => presenceHolder.current?.lastSeenAt(deviceId) ?? null,
    transferStore,
    blobStore,
    verifyAgentToken: (deviceId, token) => deviceRegistry.verifyAgentToken(deviceId, token),
    sendToAgent: (deviceId, msg) => {
      const s = presenceHolder.current?.getAgentSocket(deviceId);
      if (!s || s.readyState !== 1) return false;
      s.send(JSON.stringify(msg));
      return true;
    },
    disconnectDevice: (deviceId, reason) => serverHooks.disconnectDevice?.(deviceId, reason),
    terminateAllSessions: (controllerId, reason) =>
      serverHooks.terminateAllSessions?.(controllerId, reason) ?? Promise.resolve(0),
    keyStore,
    permissionStore,
    activityStore,
    ruleStore,
    notificationStore,
  });
  const server = await startSignalingServer({
    port: 0,
    jwtSecret: JWT_SECRET,
    deviceRegistry,
    sessionStore: new MemorySessionStore(),
    transferStore,
    blobStore,
    ruleStore,
    notificationStore,
    activityStore,
    permissionStore,
    onHttpRequest: restRouter,
  });
  presenceHolder.current = server.presence;
  serverHooks.disconnectDevice = (deviceId, reason) => server.disconnectDevice(deviceId, reason);
  serverHooks.terminateAllSessions = (controllerId, reason) => server.terminateAllSessions(controllerId, reason);
  const base = `http://127.0.0.1:${server.port}`;

  const post = async (path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (path, token) => {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const getBytes = async (path, token) => {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  };
  const waitWsType = (ws, type, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const onMsg = (raw) => {
        let m;
        try {
          m = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (m.type === type) {
          ws.off("message", onMsg);
          resolve(m);
        }
      };
      ws.on("message", onMsg);
      setTimeout(() => {
        ws.off("message", onMsg);
        reject(new Error(`timeout menunggu WS ${type}`));
      }, timeoutMs);
    });

  try {
    // 1) login benar -> JWT valid untuk WS
    const login = await post("/api/auth/login", { email: EMAIL, password: PASSWORD });
    check("login benar -> 200 + token", login.status === 200 && typeof login.json.token === "string", JSON.stringify(login.json));
    const jwt = login.json.token;
    const claims = verifyControllerToken(jwt, JWT_SECRET);
    check("JWT login terverifikasi (sub + role)", claims.sub === user.id && claims.role === "user");

    // 2) login gagal: pesan sama untuk password salah & email tak dikenal
    const wrongPass = await post("/api/auth/login", { email: EMAIL, password: "salah" });
    const unknownEmail = await post("/api/auth/login", { email: "tidak@ada.test", password: "salah" });
    check(
      "login gagal -> 401 pesan sama (anti-enumerasi)",
      wrongPass.status === 401 &&
        unknownEmail.status === 401 &&
        wrongPass.json.error?.code === "invalid-credentials" &&
        wrongPass.json.error?.message === unknownEmail.json.error?.message,
      JSON.stringify({ wrongPass, unknownEmail }),
    );

    // 3) GET /api/devices tanpa token / token palsu -> 401
    const noAuth = await get("/api/devices");
    const badAuth = await get("/api/devices", "jwt.palsu.xxx");
    check("GET /devices tanpa token -> 401", noAuth.status === 401);
    check("GET /devices token palsu -> 401", badAuth.status === 401);

    // 3b) GET /api/rtc/ice-servers: wajib JWT; berisi STUN Google
    const iceNoAuth = await get("/api/rtc/ice-servers");
    check("GET /rtc/ice-servers tanpa token -> 401", iceNoAuth.status === 401);
    const iceOk = await get("/api/rtc/ice-servers", jwt);
    check(
      "GET /rtc/ice-servers -> 200 + STUN Google",
      iceOk.status === 200 &&
        Array.isArray(iceOk.json.iceServers) &&
        iceOk.json.iceServers.some((s) => JSON.stringify(s.urls).includes("stun.l.google.com:19302")),
      JSON.stringify(iceOk.json),
    );

    // 4) pairing init -> kode 6 karakter + qrPayload
    const init = await post("/api/devices/pairing/init", { deviceName: DEVICE_NAME, model: DEVICE_NAME, manufacturer: "POCO" });
    check(
      "pairing init -> 201 + kode + qrPayload",
      init.status === 201 &&
        /^[A-Z2-9]{6}$/.test(init.json.pairingCode) &&
        init.json.qrPayload === `prata://pair/${init.json.pairingId}/${init.json.pairingCode}`,
      JSON.stringify(init.json),
    );
    const pairingId = init.json.pairingId;
    const pairingCode = init.json.pairingCode;

    // 5) poll sebelum confirm -> pending, tanpa token
    const pollPending = await post("/api/devices/pairing/poll", { pairingId, pairingCode });
    check(
      "poll sebelum confirm -> pending tanpa token",
      pollPending.status === 200 && pollPending.json.status === "pending" && pollPending.json.agentToken === null,
      JSON.stringify(pollPending.json),
    );

    // 6) confirm kode salah -> 401; pairing tetap pending
    const wrongCode = await post("/api/devices/pairing/confirm", { pairingId, pairingCode: "ZZZZZZ" }, jwt);
    check("confirm kode salah -> 401", wrongCode.status === 401 && wrongCode.json.error?.code === "invalid-code");

    // 7) confirm via qrPayload -> 201, TANPA agentToken di respons controller
    const confirm = await post(
      "/api/devices/pairing/confirm",
      { qrPayload: `prata://pair/${pairingId}/${pairingCode}` },
      jwt,
    );
    check(
      "confirm via QR -> 201 device, tanpa agentToken",
      confirm.status === 201 &&
        typeof confirm.json.deviceId === "string" &&
        confirm.json.deviceName === DEVICE_NAME &&
        !("agentToken" in confirm.json),
      JSON.stringify(confirm.json),
    );
    const deviceId = confirm.json.deviceId;

    // 8) poll sesudah confirm -> consumed + token (sekali)
    const pollOk = await post("/api/devices/pairing/poll", { pairingId, pairingCode });
    check(
      "poll sesudah confirm -> consumed + agentToken",
      pollOk.status === 200 &&
        pollOk.json.status === "consumed" &&
        typeof pollOk.json.agentToken === "string" &&
        pollOk.json.agentToken.length >= 32 &&
        pollOk.json.deviceId === deviceId,
      JSON.stringify({ ...pollOk.json, agentToken: pollOk.json.agentToken ? "<token>" : null }),
    );
    const agentToken = pollOk.json.agentToken;

    // 9) poll kedua -> token sudah diambil, tidak keluar lagi
    const pollAgain = await post("/api/devices/pairing/poll", { pairingId, pairingCode });
    check(
      "poll kedua -> tokenAlreadyCollected, token null",
      pollAgain.json.status === "consumed" && pollAgain.json.agentToken === null && pollAgain.json.tokenAlreadyCollected === true,
      JSON.stringify(pollAgain.json),
    );

    // 10) confirm ulang -> 409
    const confirmAgain = await post("/api/devices/pairing/confirm", { pairingId, pairingCode }, jwt);
    check("confirm ulang -> 409 pairing-consumed", confirmAgain.status === 409);

    // 11) GET /devices -> 1 perangkat, status offline (agen belum hello)
    const listBefore = await get("/api/devices", jwt);
    check(
      "GET /devices -> 1 perangkat offline",
      listBefore.status === 200 &&
        listBefore.json.devices?.length === 1 &&
        listBefore.json.devices[0].id === deviceId &&
        listBefore.json.devices[0].status === "offline",
      JSON.stringify(listBefore.json),
    );

    // 12) token hasil pairing BENAR-BENAR bisa hello WS sebagai agen
    const agentWs = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise((resolve, reject) => {
      agentWs.once("open", resolve);
      agentWs.once("error", reject);
    });
    const welcomePromise = new Promise((resolve, reject) => {
      agentWs.once("message", (raw) => resolve(JSON.parse(raw.toString("utf8"))));
      setTimeout(() => reject(new Error("timeout welcome")), 5000);
    });
    agentWs.send(JSON.stringify({ type: "hello", role: "agent", deviceId, token: agentToken }));
    const welcome = await welcomePromise;
    check("WS hello token hasil pairing -> welcome", welcome.type === "welcome" && welcome.peerId === deviceId, JSON.stringify(welcome));

    // 13) JWT hasil login juga bisa hello WS sebagai controller
    const ctrlWs = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise((resolve, reject) => {
      ctrlWs.once("open", resolve);
      ctrlWs.once("error", reject);
    });
    const ctrlWelcomePromise = new Promise((resolve, reject) => {
      ctrlWs.once("message", (raw) => resolve(JSON.parse(raw.toString("utf8"))));
      setTimeout(() => reject(new Error("timeout welcome")), 5000);
    });
    ctrlWs.send(JSON.stringify({ type: "hello", role: "controller", token: jwt }));
    const ctrlWelcome = await ctrlWelcomePromise;
    check("WS hello JWT login -> welcome controller", ctrlWelcome.type === "welcome" && ctrlWelcome.peerId === user.id);

    // 14) GET /devices sesudah agen online -> status online
    const listAfter = await get("/api/devices", jwt);
    check(
      "GET /devices sesudah agen hello -> status online",
      listAfter.json.devices?.[0]?.status === "online",
      JSON.stringify(listAfter.json),
    );

    // 14b) Transfer file (Command 008): download Agent -> Controller
    // Controller minta file -> Agent menerima file_upload_requested via WS.
    const dlReqPromise = waitWsType(agentWs, "file_upload_requested");
    const createDl = await post(
      "/api/transfers",
      { deviceId, docId: "doc-123", fileName: "catatan.txt", size: 10, mimeType: "text/plain" },
      jwt,
    );
    check(
      "POST /api/transfers -> 201 + transferId",
      createDl.status === 201 && typeof createDl.json.transferId === "string",
      JSON.stringify(createDl.json),
    );
    const dlId = createDl.json.transferId;
    const dlReq = await dlReqPromise;
    check("Agent menerima file_upload_requested", dlReq.transferId === dlId && dlReq.docId === "doc-123");

    // Alias FINAL (Bagian 2): POST /api/devices/:id/files/request-download
    const aliasDl = await post(
      `/api/devices/${deviceId}/files/request-download`,
      { docId: "doc-789", fileName: "alias.txt" },
      jwt,
    );
    check(
      "POST /devices/:id/files/request-download (alias) -> 201",
      aliasDl.status === 201 && typeof aliasDl.json.transferId === "string",
      JSON.stringify(aliasDl.json),
    );

    // GET blob sebelum Agent upload -> 409 (belum siap)
    const earlyBlob = await getBytes(`/api/transfers/${dlId}/blob`, jwt);
    check("GET blob sebelum upload -> 409", earlyBlob.status === 409);

    // Agent PUT blob dengan token agen -> 200 ready
    const fileBytes = Buffer.from("halo dunia", "utf8");
    const putBlob = await fetch(`${base}/api/transfers/${dlId}/blob`, {
      method: "PUT",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/octet-stream" },
      body: fileBytes,
    });
    const putJson = await putBlob.json().catch(() => ({}));
    check("PUT blob (token agen) -> 200 ready", putBlob.status === 200 && putJson.status === "ready", JSON.stringify(putJson));

    // GET status -> ready
    const dlStatus = await get(`/api/transfers/${dlId}`, jwt);
    check("GET transfer -> status ready", dlStatus.json.transfer?.status === "ready", JSON.stringify(dlStatus.json));

    // Controller GET blob -> byte sama persis
    const gotBlob = await getBytes(`/api/transfers/${dlId}/blob`, jwt);
    check(
      "GET blob (JWT pemilik) -> byte sama",
      gotBlob.status === 200 && Buffer.compare(gotBlob.buffer, fileBytes) === 0,
      `status=${gotBlob.status} len=${gotBlob.buffer.length}`,
    );

    // GET blob kedua -> tidak tersedia lagi (sekali pakai)
    const gotAgain = await getBytes(`/api/transfers/${dlId}/blob`, jwt);
    check("GET blob kedua -> tidak tersedia lagi (sekali pakai)", gotAgain.status === 404 || gotAgain.status === 409, `status=${gotAgain.status}`);

    // PUT blob dengan token salah -> 401
    const createDl2 = await post("/api/transfers", { deviceId, docId: "doc-456", fileName: "x.bin" }, jwt);
    const dl2Id = createDl2.json.transferId;
    const putBad = await fetch(`${base}/api/transfers/${dl2Id}/blob`, {
      method: "PUT",
      headers: { authorization: "Bearer token-salah", "content-type": "application/octet-stream" },
      body: Buffer.from("x"),
    });
    check("PUT blob token salah -> 401", putBad.status === 401);

    // 14c) Upload Controller -> Agent
    const upReqPromise = waitWsType(agentWs, "file_download_ready");
    const upBytes = Buffer.from("isi kiriman", "utf8");
    const upload = await fetch(`${base}/api/devices/${deviceId}/files/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "x-file-name": "dari-controller.txt", "x-file-mime": "text/plain" },
      body: upBytes,
    });
    const uploadJson = await upload.json().catch(() => ({}));
    check("POST upload file -> 201 ready", upload.status === 201 && uploadJson.status === "ready", JSON.stringify(uploadJson));
    const upId = uploadJson.transferId;
    const upReq = await upReqPromise;
    check("Agent menerima file_download_ready", upReq.transferId === upId && upReq.fileName === "dari-controller.txt");

    // Agent GET blob dengan token agen -> byte sama
    const agentBlob = await getBytes(`/api/transfers/${upId}/blob`, agentToken);
    check(
      "Agent GET blob upload -> byte sama",
      agentBlob.status === 200 && Buffer.compare(agentBlob.buffer, upBytes) === 0,
      `status=${agentBlob.status}`,
    );

    // Agent ack file_transfer_done -> status done + controller diberitahu
    const donePromise = waitWsType(ctrlWs, "file_transfer_done");
    agentWs.send(JSON.stringify({ type: "file_transfer_done", transferId: upId, ok: true }));
    const doneMsg = await donePromise;
    check("file_transfer_done diteruskan ke controller", doneMsg.transferId === upId && doneMsg.ok === true);
    const upStatus = await get(`/api/transfers/${upId}`, jwt);
    check("GET transfer upload -> status done", upStatus.json.transfer?.status === "done", JSON.stringify(upStatus.json));

    // Upload tanpa X-File-Name -> 400
    const noName = await fetch(`${base}/api/devices/${deviceId}/files/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      body: Buffer.from("x"),
    });
    check("Upload tanpa X-File-Name -> 400", noName.status === 400);

    // 14d) PATCH perangkat + activity logs (FINAL, Bagian 6)
    const patchRes = await fetch(`${base}/api/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ name: "POCO X6 Pro Kerja", group: "Kerja" }),
    });
    const patchJson = await patchRes.json();
    check(
      "PATCH /devices/:id -> nama + grup berubah",
      patchRes.status === 200 && patchJson.device?.name === "POCO X6 Pro Kerja" && patchJson.device?.group === "Kerja",
      JSON.stringify(patchJson),
    );
    const logs = await get("/api/activity-logs?limit=20", jwt);
    check(
      "GET /activity-logs mencatat login + pairing",
      logs.status === 200 &&
        logs.json.logs?.some((l) => l.action === "login") &&
        logs.json.logs?.some((l) => l.action === "pairing"),
      JSON.stringify(logs.json.logs?.map((l) => l.action)),
    );

    // 14e) Automation CRUD + evaluasi metrik (FINAL, Bagian 6)
    const ruleCreate = await post(
      "/api/automation/rules",
      { name: "Baterai kritis", conditionType: "battery_below", threshold: 20, deviceId },
      jwt,
    );
    check(
      "POST /automation/rules -> 201",
      ruleCreate.status === 201 && typeof ruleCreate.json.rule?.id === "string",
      JSON.stringify(ruleCreate.json),
    );
    const ruleId = ruleCreate.json.rule.id;
    const ruleBad = await post("/api/automation/rules", { name: "Salah", conditionType: "tidak-ada" }, jwt);
    check("POST rule conditionType tak dikenal -> 400", ruleBad.status === 400);
    const ruleList = await get("/api/automation/rules", jwt);
    check("GET /automation/rules -> 1 aturan", ruleList.json.rules?.length === 1);
    const rulePatchRes = await fetch(`${base}/api/automation/rules/${ruleId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ enabled: false }),
    });
    const rulePatchJson = await rulePatchRes.json();
    check("PATCH rule -> disabled", rulePatchRes.status === 200 && rulePatchJson.rule?.enabled === false, JSON.stringify(rulePatchJson));
    const ruleDeleteRes = await fetch(`${base}/api/automation/rules/${ruleId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    check("DELETE rule -> 200", ruleDeleteRes.status === 200);
    const ruleList2 = await get("/api/automation/rules", jwt);
    check("GET /automation/rules sesudah hapus -> 0", ruleList2.json.rules?.length === 0);

    // Evaluasi otomatisasi lewat metrik: aturan aktif + baterai rendah.
    const ruleLive = await post(
      "/api/automation/rules",
      { name: "Baterai kritis", conditionType: "battery_below", threshold: 50, deviceId },
      jwt,
    );
    const alertPromise = waitWsType(ctrlWs, "automation_alert");
    agentWs.send(JSON.stringify({ type: "device_metrics", metrics: { batteryPct: 12, charging: false } }));
    const autoAlert = await alertPromise;
    check("automation_alert via metrik -> controller", autoAlert.ruleName === "Baterai kritis", JSON.stringify(autoAlert));
    const autoNotifs = await get("/api/notifications?kind=automation", jwt);
    check("GET /notifications?kind=automation -> 1", autoNotifs.json.notifications?.length === 1, JSON.stringify(autoNotifs.json));
    await fetch(`${base}/api/automation/rules/${ruleLive.json.rule.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });

    // 14f) Sesi screen + terminate-all (FINAL, Bagian 6)
    const agentInbox = [];
    const ctrlInbox = [];
    agentWs.on("message", (raw) => {
      try {
        agentInbox.push(JSON.parse(raw.toString("utf8")));
      } catch {}
    });
    ctrlWs.on("message", (raw) => {
      try {
        ctrlInbox.push(JSON.parse(raw.toString("utf8")));
      } catch {}
    });
    const waitInbox = (inbox, pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          const found = inbox.find(pred);
          if (found) return resolve(found);
          if (Date.now() - start > timeoutMs) return reject(new Error("timeout inbox"));
          setTimeout(tick, 25);
        };
        tick();
      });
    ctrlWs.send(JSON.stringify({ type: "session-request", deviceId, sessionType: "screen" }));
    const sessReq = await waitInbox(agentInbox, (m) => m.type === "session-request");
    agentWs.send(JSON.stringify({ type: "session-accept", sessionId: sessReq.sessionId }));
    const sessAcc = await waitInbox(ctrlInbox, (m) => m.type === "session-accepted");
    check("sesi screen aktif (request -> accept)", sessAcc.sessionId === sessReq.sessionId);
    const term = await post("/api/sessions/terminate-all", {}, jwt);
    check("terminate-all -> 200, 1 sesi dihentikan", term.status === 200 && term.json.terminated === 1, JSON.stringify(term.json));
    const sessEnd = await waitInbox(agentInbox, (m) => m.type === "session-ended" && m.sessionId === sessReq.sessionId);
    check("agent menerima session-ended sesudah terminate-all", !!sessEnd);
    const logsAfterTerm = await get("/api/activity-logs?limit=20", jwt);
    check(
      "activity log mencatat session-start + terminate-all",
      logsAfterTerm.json.logs?.some((l) => l.action === "session-start") &&
        logsAfterTerm.json.logs?.some((l) => l.action === "terminate-all"),
      JSON.stringify(logsAfterTerm.json.logs?.map((l) => l.action)),
    );

    // 14g) Revoke perangkat (FINAL, Bagian 6): soket putus + token mati
    const agentClosed = new Promise((resolve) => {
      agentWs.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    const revoke = await post(`/api/devices/${deviceId}/revoke`, {}, jwt);
    check("POST /devices/:id/revoke -> 200", revoke.status === 200 && revoke.json.revoked === true, JSON.stringify(revoke.json));
    check("soket agen terputus sesudah revoke", await agentClosed);
    const keys = await get(`/api/devices/${deviceId}/keys`, jwt);
    check(
      "GET /devices/:id/keys -> kunci utama revoked",
      keys.json.keys?.length === 1 && keys.json.keys[0].revoked === true,
      JSON.stringify(keys.json),
    );
    const helloAgain = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await new Promise((resolve, reject) => {
      helloAgain.once("open", resolve);
      helloAgain.once("error", reject);
    });
    const authFailed = new Promise((resolve) => {
      helloAgain.once("message", (raw) => {
        try {
          resolve(JSON.parse(raw.toString("utf8")));
        } catch {
          resolve(null);
        }
      });
      setTimeout(() => resolve(null), 5000);
    });
    helloAgain.send(JSON.stringify({ type: "hello", role: "agent", deviceId, token: agentToken }));
    const failedMsg = await authFailed;
    check("hello dengan token tercabut -> auth-failed", failedMsg?.type === "error" && failedMsg?.code === "auth-failed", JSON.stringify(failedMsg));
    helloAgain.close();

    // 15) pairing kedaluwarsa -> confirm 410
    const shortLived = await pairingStore.create({ codeHash: hashToken("ABCDEF"), expiresInMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    const expiredConfirm = await post("/api/devices/pairing/confirm", { pairingId: shortLived.id, pairingCode: "ABCDEF" }, jwt);
    check("confirm pairing kedaluwarsa -> 410", expiredConfirm.status === 410 && expiredConfirm.json.error?.code === "pairing-expired");

    // 16) 5x kode salah -> dicabut; percobaan ke-6 -> 410 revoked
    const lockInit = await post("/api/devices/pairing/init", { deviceName: "HP Lockout" });
    const lockId = lockInit.json.pairingId;
    let fifthStatus = 0;
    for (let i = 0; i < 5; i++) {
      const r = await post("/api/devices/pairing/confirm", { pairingId: lockId, pairingCode: "ZZZZZZ" }, jwt);
      fifthStatus = r.status;
    }
    const sixth = await post("/api/devices/pairing/confirm", { pairingId: lockId, pairingCode: "ZZZZZZ" }, jwt);
    check(
      "5x kode salah -> dicabut (ke-6 = 410 revoked)",
      fifthStatus === 401 && sixth.status === 410 && sixth.json.error?.code === "pairing-revoked",
      JSON.stringify(sixth.json),
    );

    // 17) rate limit pairing/init: 10/menit/IP (dijalankan terakhir)
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const r = await post("/api/devices/pairing/init", { deviceName: `Spam ${i}` });
      if (r.status === 429) {
        limited = true;
        break;
      }
    }
    check("pairing init ke-11+ dari IP sama -> 429", limited);

    agentWs.close();
    ctrlWs.close();
    await server.close();
  } catch (err) {
    console.error("SMOKE ERROR:", err);
    await server.close().catch(() => {});
    process.exitCode = 1;
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nRINGKASAN rest smoke: ${results.length - failed.length}/${results.length} lulus, ${failed.length} gagal`);
  if (failed.length > 0) process.exitCode = 1;
}

main();
