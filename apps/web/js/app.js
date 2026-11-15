// PRATA Remote — Aplikasi Web Dashboard (FINAL, Bagian 7)
// SPA statis: 8 halaman, semua tombol terhubung ke REST/WS nyata.
// Tanpa framework build — buka index.html lewat server statis apa pun
// (mis. `python3 -m http.server 8000` di apps/web).
(function () {
  "use strict";

  var $ = function (sel) { return document.querySelector(sel); };
  var pageEl = null;
  var ws = null;
  var wsConnected = false;

  var S = {
    page: "overview",
    devices: [],
    presence: {},       // deviceId -> {status, lastSeenAt}
    metrics: {},        // deviceId -> {metrics, at}
    notifications: [],  // riwayat notifikasi (dari REST + WS live)
    alerts: [],         // alert otomatisasi terbaru
    logs: [],
    rules: [],
    health: null,
    monitorHistory: [], // {at, deviceId, status} maks 50
    live: {
      deviceId: null, sessionId: null, status: "idle", // idle|waiting|connected|failed|ended
      statusText: "Pilih perangkat lalu mulai sesi.", rtc: null,
      quality: "medium", latencyMs: null, pingTimer: null, lastText: "",
    },
    files: { deviceId: null, path: [], items: [], loading: false, error: null, status: null },
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtBytes(b) {
    if (b == null) return "—";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
    return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("id-ID"); } catch (e) { return iso; }
  }
  function fmtClock(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleTimeString("id-ID"); } catch (e) { return iso; }
  }
  function deviceById(id) { return S.devices.find(function (d) { return d.id === id; }) || null; }
  function statusOf(d) {
    var p = S.presence[d.id];
    return p ? p.status : (d.status || "offline");
  }
  function statusChip(st) {
    var cls = st === "online" ? "online" : st === "connecting" ? "connecting" : "offline";
    var label = st === "online" ? "Online" : st === "connecting" ? "Menghubungkan" : "Offline";
    return '<span class="chip ' + cls + '">' + label + "</span>";
  }
  function showError(msg) {
    var box = $("#page-error");
    if (box) { box.textContent = msg; box.classList.remove("hidden"); }
  }
  function clearError() {
    var box = $("#page-error");
    if (box) box.classList.add("hidden");
  }

  // ---------- WebSocket ----------

  function connectWS() {
    if (ws) ws.disconnect();
    ws = new PrataWS(PrataApi.serverUrl(), PrataApi.jwt(), {
      onOpen: function () { setWsStatus(true, "Terhubung"); },
      onClose: function () { setWsStatus(false, "Terputus — mencoba lagi…"); },
      onWelcome: function (msg) {
        S.devices.forEach(function (d) { ws.watch(d.id); });
      },
      onMessage: handleWsMessage,
    });
    ws.connect();
  }

  function setWsStatus(on, text) {
    wsConnected = on;
    var dot = document.querySelector("#ws-status .ws-dot");
    var txt = $("#ws-status-text");
    if (dot) dot.className = "ws-dot " + (on ? "on" : "off");
    if (txt) txt.textContent = text;
  }

  function handleWsMessage(msg) {
    if (msg.type === "presence") {
      S.presence[msg.deviceId] = { status: msg.status, lastSeenAt: msg.lastSeenAt };
      S.monitorHistory.unshift({ at: new Date().toISOString(), deviceId: msg.deviceId, status: msg.status });
      S.monitorHistory = S.monitorHistory.slice(0, 50);
      if (["overview", "devices", "monitoring"].indexOf(S.page) >= 0) render();
      return;
    }
    if (msg.type === "device_metrics") {
      S.metrics[msg.deviceId] = { metrics: msg.metrics || {}, at: msg.at || new Date().toISOString() };
      if (["overview", "monitoring"].indexOf(S.page) >= 0) render();
      return;
    }
    if (msg.type === "device_notification") {
      S.notifications.unshift({
        id: "ws-" + Date.now(), deviceId: msg.deviceId, kind: "device",
        packageName: msg.packageName, appName: msg.appName, title: msg.title, text: msg.text,
        createdAt: msg.at || new Date().toISOString(),
      });
      S.notifications = S.notifications.slice(0, 100);
      return;
    }
    if (msg.type === "automation_alert") {
      S.alerts.unshift({ ruleId: msg.ruleId, ruleName: msg.ruleName, deviceId: msg.deviceId, message: msg.message, at: msg.at || new Date().toISOString() });
      S.alerts = S.alerts.slice(0, 20);
      if (S.page === "overview") render();
      return;
    }
    // Pesan sesi live (hanya relevan di halaman Live Control).
    if (S.page === "live") handleLiveMessage(msg);
  }

  // ---------- Live Control ----------

  function handleLiveMessage(msg) {
    var L = S.live;
    if (msg.type === "session-accepted") {
      L.sessionId = msg.sessionId;
      L.status = "waiting";
      L.statusText = "Agent menerima sesi — menunggu offer…";
      updateLiveStatus();
      return;
    }
    if (msg.type === "session-rejected") {
      L.status = "failed";
      L.statusText = "Agent menolak sesi: " + (msg.reason || "tanpa alasan");
      updateLiveStatus();
      return;
    }
    if (msg.type === "session-ended") {
      endLiveSession("Sesi berakhir: " + (msg.reason || "dari Agent"));
      return;
    }
    if ((msg.type === "webrtc_offer" || msg.type === "offer") && msg.sessionId === L.sessionId) {
      startRtcAnswer(msg.payload);
      return;
    }
    if ((msg.type === "webrtc_ice_candidate" || msg.type === "ice") && msg.sessionId === L.sessionId && L.rtc) {
      L.rtc.addIce(msg.payload);
      return;
    }
    if (msg.type === "error") {
      L.status = "failed";
      L.statusText = "Kesalahan signaling: " + (msg.message || "?");
      updateLiveStatus();
    }
  }

  async function startRtcAnswer(offerPayload) {
    var L = S.live;
    try {
      var rtc = new LiveRtc(ws.iceServers, {
        onTrack: function (stream) {
          var v = $("#live-video");
          if (v && stream) v.srcObject = stream;
        },
        onIceCandidate: function (cand) {
          if (L.sessionId) ws.sendIce(L.sessionId, cand);
        },
        onIceState: function (state) {
          if (state === "connected" || state === "completed") {
            L.status = "connected";
            L.statusText = "Terhubung — layar/kamera Agent tampil di atas.";
            startPingLoop();
          } else if (state === "failed") {
            L.status = "failed";
            L.statusText = "Koneksi ICE gagal.";
          }
          updateLiveStatus();
        },
        onControlMessage: function (data) {
          try {
            var obj = JSON.parse(data);
            if (obj.action === "pong" && obj.t) {
              L.latencyMs = Date.now() - obj.t;
              var lat = $("#live-latency");
              if (lat) lat.textContent = L.latencyMs + " ms";
            } else if (obj.action === "clipboard") {
              var cb = $("#live-clipboard-out");
              if (cb) cb.textContent = obj.text || "—";
            } else if (obj.action === "photo-result") {
              var ph = $("#live-photo-status");
              if (ph) ph.textContent = obj.ok ? ("Foto tersimpan di Agent: " + (obj.fileName || "")) : ("Gagal mengambil foto: " + (obj.error || "?"));
            }
          } catch (e) { /* abaikan */ }
        },
      });
      L.rtc = rtc;
      var answer = await rtc.start(L.sessionId, offerPayload);
      ws.sendAnswer(L.sessionId, answer);
      L.statusText = "Menunggu koneksi ICE…";
      updateLiveStatus();
    } catch (e) {
      L.status = "failed";
      L.statusText = "Gagal memulai WebRTC: " + e.message;
      updateLiveStatus();
    }
  }

  function startPingLoop() {
    var L = S.live;
    stopPingLoop();
    L.pingTimer = setInterval(function () {
      if (L.rtc) L.rtc.sendControl({ action: "ping", t: Date.now() });
    }, 5000);
  }
  function stopPingLoop() {
    if (S.live.pingTimer) { clearInterval(S.live.pingTimer); S.live.pingTimer = null; }
  }

  function updateLiveStatus() {
    var el = $("#live-status");
    if (el) el.textContent = S.live.statusText;
    var overlay = $("#live-overlay");
    if (overlay) overlay.style.display = S.live.status === "connected" ? "none" : "flex";
    var lat = $("#live-latency");
    if (lat) lat.textContent = S.live.latencyMs != null ? (S.live.latencyMs + " ms") : "latensi —";
  }

  function endLiveSession(reason) {
    var L = S.live;
    stopPingLoop();
    if (L.sessionId && ws) ws.endSession(L.sessionId, "stopped-by-web");
    if (L.rtc) { L.rtc.close(); L.rtc = null; }
    L.sessionId = null;
    L.status = "ended";
    L.statusText = reason || "Sesi berakhir.";
    var v = $("#live-video");
    if (v) v.srcObject = null;
    updateLiveStatus();
  }

  function liveSend(obj) {
    var L = S.live;
    if (L.status !== "connected" || !L.rtc) return false;
    return L.rtc.sendControl(obj);
  }

  // ---------- Render halaman ----------

  function render() {
    if (!pageEl) pageEl = $("#page");
    document.querySelectorAll("#app-nav button").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-page") === S.page);
    });
    var html = '<div id="page-error" class="error-box hidden"></div>';
    if (S.page === "overview") html += pageOverview();
    else if (S.page === "devices") html += pageDevices();
    else if (S.page === "live") html += pageLive();
    else if (S.page === "files") html += pageFiles();
    else if (S.page === "monitoring") html += pageMonitoring();
    else if (S.page === "automation") html += pageAutomation();
    else if (S.page === "security") html += pageSecurity();
    else if (S.page === "settings") html += pageSettings();
    pageEl.innerHTML = html;
    afterRender();
  }

  function afterRender() {
    // Isi ulang nilai yang hilang saat re-render (input yang sedang diketik
    // di halaman Live tidak ikut di-render ulang oleh event WS).
    if (S.page === "live") {
      var sel = $("#live-device");
      if (sel && S.live.deviceId) sel.value = S.live.deviceId;
      updateLiveStatus();
    }
    if (S.page === "files") {
      var fsel = $("#files-device");
      if (fsel && S.files.deviceId) fsel.value = S.files.deviceId;
    }
  }

  function deviceOptions(selectedId) {
    return S.devices.map(function (d) {
      return '<option value="' + esc(d.id) + '"' + (d.id === selectedId ? " selected" : "") + ">" + esc(d.name) + " (" + esc(statusOf(d)) + ")</option>";
    }).join("");
  }

  function metricCard(deviceId, label) {
    var m = S.metrics[deviceId];
    var d = deviceById(deviceId);
    if (!d) return "";
    var met = m ? m.metrics : {};
    var batt = met.batteryPct != null ? met.batteryPct + "%" : "—";
    var stor = (met.storageTotalBytes && met.storageFreeBytes != null)
      ? Math.round((1 - met.storageFreeBytes / met.storageTotalBytes) * 100) + "% terpakai"
      : "—";
    return '<div class="card"><h3>' + esc(d.name) + '</h3>' +
      '<div class="muted small">' + statusChip(statusOf(d)) + " &nbsp;" + esc(label || "") + "</div>" +
      '<div style="margin-top:10px">Baterai: <b>' + batt + "</b>" + (met.charging ? " (mengisi daya)" : "") + "</div>" +
      '<div>Penyimpanan: <b>' + stor + "</b></div>" +
      '<div class="small muted">Terakhir diperbarui: ' + (m ? fmtClock(m.at) : "belum ada data") + "</div></div>";
  }

  function pageOverview() {
    var total = S.devices.length;
    var online = S.devices.filter(function (d) { return statusOf(d) === "online"; }).length;
    var activeSessions = S.health ? S.health.activeSessions : "—";
    var alerts = S.alerts.slice(0, 5);
    return '<div class="page-head"><h1>Overview</h1><p>Ringkasan perangkat, sesi, dan alert otomatisasi.</p></div>' +
      '<div class="grid cols-4">' +
      '<div class="card"><div class="stat-num cyan">' + total + '</div><div class="stat-label">Perangkat terdaftar</div></div>' +
      '<div class="card"><div class="stat-num mint">' + online + '</div><div class="stat-label">Online saat ini</div></div>' +
      '<div class="card"><div class="stat-num violet">' + activeSessions + '</div><div class="stat-label">Sesi aktif</div></div>' +
      '<div class="card"><div class="stat-num">' + S.rules.filter(function (r) { return r.enabled; }).length + '</div><div class="stat-label">Aturan otomatisasi aktif</div></div>' +
      "</div>" +
      '<div style="height:16px"></div>' +
      (alerts.length ? '<div class="card"><h2>Alert Otomatisasi Terbaru</h2>' +
        alerts.map(function (a) { return '<div class="alert-box">' + esc(a.message) + ' <span class="muted small">(' + fmtClock(a.at) + ")</span></div>"; }).join("") + "</div><div style='height:16px'></div>" : "") +
      '<div class="grid cols-3">' + S.devices.map(function (d) { return metricCard(d.id); }).join("") + "</div>" +
      (S.devices.length === 0 ? '<div class="card"><p class="muted">Belum ada perangkat. Pairing perangkat pertama dari Device Center.</p></div>' : "");
  }

  function pageDevices() {
    return '<div class="page-head"><h1>Device Center</h1><p>Kelola perangkat, pairing baru, ubah nama/grup, dan cabut akses.</p></div>' +
      '<div class="grid cols-2">' +
      '<div class="card"><h2>Pairing Perangkat Baru</h2>' +
      '<p class="muted small">Di aplikasi Agent: buka menu pairing untuk menampilkan kode QR. Tempel payload QR di bawah, atau isi ID pairing + kode 6 karakter.</p>' +
      '<label>Payload QR (prata://pair/...)</label>' +
      '<input id="pair-qr" type="text" placeholder="prata://pair/&lt;id&gt;/&lt;KODE&gt;">' +
      '<div class="form-row"><div><label>ID Pairing</label><input id="pair-id" type="text"></div>' +
      '<div><label>Kode (6 karakter)</label><input id="pair-code" type="text" maxlength="6"></div></div>' +
      '<div style="margin-top:12px"><button class="btn primary" type="button" data-action="pair-confirm">Konfirmasi Pairing</button></div>' +
      '<div id="pair-status" class="small" style="margin-top:8px"></div></div>' +
      '<div class="card"><h2>Pencarian &amp; Filter</h2>' +
      '<label>Cari perangkat</label><input id="dev-search" type="text" placeholder="Nama / model / grup…">' +
      '<label>Grup</label><select id="dev-group-filter"><option value="">Semua grup</option>' +
      Array.from(new Set(S.devices.map(function (d) { return d.group; }).filter(Boolean))).map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + "</option>"; }).join("") +
      "</select>" +
      '<div style="margin-top:12px"><button class="btn" type="button" data-action="refresh-devices">Muat Ulang Daftar</button></div></div>' +
      "</div>" +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>Daftar Perangkat (' + S.devices.length + ")</h2><div id='device-list'>" + deviceListHtml("") + "</div></div>";
  }

  function deviceListHtml(filter) {
    var q = (filter || "").toLowerCase();
    var groupFilter = ($("#dev-group-filter") || { value: "" }).value || "";
    var list = S.devices.filter(function (d) {
      if (groupFilter && d.group !== groupFilter) return false;
      if (!q) return true;
      return [d.name, d.model, d.manufacturer, d.group].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) return '<p class="muted">Tidak ada perangkat yang cocok.</p>';
    return list.map(function (d) {
      var m = S.metrics[d.id];
      var batt = m && m.metrics.batteryPct != null ? m.metrics.batteryPct + "%" : "—";
      return '<div class="device-row"><div class="name"><b>' + esc(d.name) + "</b> " + statusChip(statusOf(d)) +
        '<div class="small muted">' + esc(d.model || "") + (d.androidVersion ? " • Android " + esc(d.androidVersion) : "") +
        " • Grup: " + esc(d.group || "—") + " • Baterai: " + batt +
        " • Terakhir terlihat: " + fmtTime(d.lastSeenAt) + "</div></div>" +
        '<button class="btn sm" type="button" data-action="device-edit" data-id="' + esc(d.id) + '">Ubah</button>' +
        '<button class="btn sm" type="button" data-action="device-perms" data-id="' + esc(d.id) + '">Izin</button>' +
        '<button class="btn sm danger" type="button" data-action="device-revoke" data-id="' + esc(d.id) + '">Revoke</button>' +
        '<button class="btn sm danger" type="button" data-action="device-delete" data-id="' + esc(d.id) + '">Hapus</button></div>' +
        '<div id="device-detail-' + esc(d.id) + '"></div>';
    }).join("");
  }

  function pageLive() {
    var L = S.live;
    return '<div class="page-head"><h1>Live Control</h1><p>Lihat layar/kamera Agent secara live dan kendalikan dari browser.</p></div>' +
      '<div class="card"><div class="form-row">' +
      '<div><label>Perangkat</label><select id="live-device">' + deviceOptions(L.deviceId) + "</select></div>" +
      '<div><button class="btn primary" type="button" data-action="live-start" data-kind="screen">Mulai Sesi Layar</button></div>' +
      '<div><button class="btn" type="button" data-action="live-start" data-kind="camera-back">Kamera Belakang</button></div>' +
      '<div><button class="btn" type="button" data-action="live-start" data-kind="camera-front">Kamera Depan</button></div>' +
      '<div><button class="btn danger" type="button" data-action="live-stop">Hentikan Sesi</button></div>' +
      "</div>" +
      '<div id="live-status" class="small" style="margin-top:10px">' + esc(L.statusText) + "</div></div>" +
      '<div style="height:16px"></div>' +
      '<div class="video-wrap"><video id="live-video" autoplay playsinline muted></video>' +
      '<div class="video-overlay" id="live-overlay" style="display:' + (L.status === "connected" ? "none" : "flex") + '">Belum ada stream. Mulai sesi layar/kamera di atas.</div></div>' +
      '<div class="quickbar">' +
      '<button class="btn sm" type="button" data-action="live-global" data-name="BACK">Back</button>' +
      '<button class="btn sm" type="button" data-action="live-global" data-name="HOME">Home</button>' +
      '<button class="btn sm" type="button" data-action="live-global" data-name="RECENTS">Recents</button>' +
      '<button class="btn sm" type="button" data-action="live-global" data-name="LOCK">Lock</button>' +
      '<button class="btn sm" type="button" data-action="live-global" data-name="SCREENSHOT">Screenshot</button>' +
      '<button class="btn sm" type="button" data-action="live-volume" data-name="DOWN">Vol −</button>' +
      '<button class="btn sm" type="button" data-action="live-volume" data-name="UP">Vol +</button>' +
      '<button class="btn sm" type="button" data-action="live-volume" data-name="MUTE">Mute</button>' +
      '<button class="btn sm" type="button" data-action="live-photo">Ambil Foto</button>' +
      '<button class="btn sm" type="button" data-action="live-clipboard-get">Amb. Clipboard</button>' +
      "</div>" +
      '<div class="quickbar"><span class="small muted">Kualitas:</span>' +
      ["low", "medium", "high"].map(function (p) {
        return '<button class="btn sm' + (L.quality === p ? " primary" : "") + '" type="button" data-action="live-quality" data-preset="' + p + '">' + p + "</button>";
      }).join("") +
      '<span class="small muted" style="align-self:center">Latensi: <b id="live-latency">' + (L.latencyMs != null ? L.latencyMs + " ms" : "—") + "</b></span></div>" +
      '<div id="live-photo-status" class="small" style="margin-top:8px"></div>' +
      '<div class="card" style="margin-top:16px"><h2>Keyboard Remote</h2>' +
      '<p class="muted small">Ketik di bawah — teks lengkap dikirim ke Agent (ACTION_SET_TEXT). Enter mengirim tombol ENTER.</p>' +
      '<input id="live-text" type="text" placeholder="Ketik teks untuk Agent…">' +
      '<div class="small muted" style="margin-top:8px">Clipboard Agent: <span id="live-clipboard-out">—</span></div></div>';
  }

  function pageFiles() {
    var F = S.files;
    var crumbs = F.path.map(function (p, i) { return '<button class="btn sm ghost" type="button" data-action="files-crumb" data-index="' + i + '">' + esc(p.name) + "</button>"; }).join(" / ");
    return '<div class="page-head"><h1>File Transfer</h1><p>Jelajahi folder SAF Agent, buat folder, hapus, unduh, dan kirim file.</p></div>' +
      '<div class="card"><div class="form-row">' +
      '<div><label>Perangkat</label><select id="files-device">' + deviceOptions(F.deviceId) + "</select></div>" +
      '<div><button class="btn primary" type="button" data-action="files-load">Buka Folder</button></div>' +
      '<div><label>Unggah file ke folder ini</label><input id="files-upload" type="file"></div>' +
      "</div>" +
      '<div class="form-row" style="margin-top:10px"><div><label>Folder baru</label><input id="files-mkdir-name" type="text" placeholder="Nama folder"></div>' +
      '<div><button class="btn" type="button" data-action="files-mkdir">Buat Folder</button></div>' +
      '<div><button class="btn" type="button" data-action="files-refresh">Muat Ulang</button></div></div>' +
      '<div id="files-status" class="small" style="margin-top:8px">' + esc(F.status || "") + "</div></div>" +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>' + (F.path.length ? crumbs : "Folder Akses Agent") + "</h2>" +
      '<div id="files-list">' + filesListHtml() + "</div></div>";
  }

  function filesListHtml() {
    var F = S.files;
    if (F.loading) return '<p class="muted">Memuat…</p>';
    if (F.error) return '<p style="color:var(--danger)">' + esc(F.error) + '</p><button class="btn" type="button" data-action="files-refresh">Coba Lagi</button>';
    if (!F.items.length) return '<p class="muted">Folder kosong atau belum ada perangkat dipilih.</p>';
    return F.items.map(function (it) {
      return '<div class="file-row"><div class="name">' + (it.isDirectory ? "[DIR] " : "[FILE] ") + "<b>" + esc(it.name) + "</b>" +
        '<div class="small muted">' + (it.isDirectory ? "Folder" : fmtBytes(it.size) + " • " + fmtTime(it.lastModified ? new Date(it.lastModified).toISOString() : null)) + "</div></div>" +
        (it.isDirectory
          ? '<button class="btn sm" type="button" data-action="files-open" data-docid="' + esc(it.docId) + '" data-name="' + esc(it.name) + '">Buka</button>'
          : '<button class="btn sm" type="button" data-action="files-download" data-docid="' + esc(it.docId) + '" data-name="' + esc(it.name) + '">Unduh</button>') +
        '<button class="btn sm" type="button" data-action="files-rename" data-docid="' + esc(it.docId) + '" data-name="' + esc(it.name) + '">Rename</button>' +
        '<button class="btn sm danger" type="button" data-action="files-delete" data-docid="' + esc(it.docId) + '" data-name="' + esc(it.name) + '">Hapus</button></div>';
    }).join("");
  }

  function pageMonitoring() {
    return '<div class="page-head"><h1>Monitoring</h1><p>Metrik real-time per perangkat (diperbarui tiap 15 detik oleh Agent).</p></div>' +
      '<div class="grid cols-2">' + S.devices.map(function (d) {
        var m = S.metrics[d.id];
        var met = m ? m.metrics : {};
        var batt = met.batteryPct;
        var storUsed = (met.storageTotalBytes && met.storageFreeBytes != null)
          ? Math.round((1 - met.storageFreeBytes / met.storageTotalBytes) * 100) : null;
        var ramUsed = (met.ramTotalBytes && met.ramAvailBytes != null)
          ? Math.round((1 - met.ramAvailBytes / met.ramTotalBytes) * 100) : null;
        function gauge(label, pct, cls, text) {
          return '<div style="margin-top:10px"><div class="small muted">' + label + '</div><div class="gauge"><div class="gauge-bar"><div class="gauge-fill ' + cls + '" style="width:' + (pct == null ? 0 : pct) + '%"></div></div><div class="gauge-num">' + text + "</div></div></div>";
        }
        return '<div class="card"><h3>' + esc(d.name) + " " + statusChip(statusOf(d)) + "</h3>" +
          gauge("Baterai" + (met.charging ? " (mengisi daya)" : ""), batt, batt != null && batt < 20 ? "warn" : "mint", batt != null ? batt + "%" : "Tidak diketahui") +
          gauge("Penyimpanan terpakai", storUsed, storUsed != null && storUsed > 90 ? "warn" : "", storUsed != null ? storUsed + "%" : "Tidak diketahui") +
          gauge("RAM terpakai", ramUsed, "violet", ramUsed != null ? ramUsed + "%" : "Tidak diketahui") +
          '<div class="small muted" style="margin-top:10px">Penyimpanan: ' + fmtBytes(met.storageFreeBytes) + " bebas dari " + fmtBytes(met.storageTotalBytes) +
          "<br>RAM: " + fmtBytes(met.ramAvailBytes) + " tersedia dari " + fmtBytes(met.ramTotalBytes) +
          "<br>Terakhir diperbarui: " + (m ? fmtClock(m.at) : "belum ada data") + "</div></div>";
      }).join("") + "</div>" +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>Riwayat Status Koneksi</h2>' +
      (S.monitorHistory.length ? '<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Perangkat</th><th>Status</th></tr></thead><tbody>' +
        S.monitorHistory.map(function (h) {
          var d = deviceById(h.deviceId);
          return "<tr><td>" + fmtTime(h.at) + "</td><td>" + esc(d ? d.name : h.deviceId) + "</td><td>" + statusChip(h.status) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<p class="muted">Belum ada perubahan status sejak dashboard dibuka.</p>') + "</div>";
  }

  function pageAutomation() {
    var condLabels = {
      battery_below: "Baterai di bawah X%",
      storage_above: "Penyimpanan terpakai di atas X%",
      device_offline: "Perangkat offline",
      session_started: "Sesi remote dimulai",
      session_ended: "Sesi remote berakhir",
    };
    return '<div class="page-head"><h1>Automation</h1><p>Aturan otomatis: kondisi perangkat → alert &amp; log. Cooldown 15 menit per aturan.</p></div>' +
      '<div class="card"><h2>Buat Aturan Baru</h2><div class="form-row">' +
      '<div><label>Nama aturan</label><input id="rule-name" type="text" placeholder="mis. Baterai HP Kerja rendah"></div>' +
      '<div><label>Kondisi</label><select id="rule-cond">' +
      Object.keys(condLabels).map(function (k) { return '<option value="' + k + '">' + condLabels[k] + "</option>"; }).join("") + "</select></div>" +
      '<div><label>Ambang (%) — kosong bila tidak perlu</label><input id="rule-threshold" type="number" min="0" max="100" placeholder="20"></div>' +
      '<div><label>Perangkat (kosong = semua)</label><select id="rule-device"><option value="">Semua perangkat</option>' + deviceOptions(null) + "</select></div>" +
      '<div><button class="btn primary" type="button" data-action="rule-create">Buat Aturan</button></div>' +
      "</div></div>" +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>Aturan (' + S.rules.length + ")</h2>" +
      (S.rules.length ? S.rules.map(function (r) {
        var d = r.deviceId ? deviceById(r.deviceId) : null;
        return '<div class="rule-row"><div class="name"><b>' + esc(r.name) + "</b>" +
          '<div class="small muted">' + esc(condLabels[r.conditionType] || r.conditionType) +
          (r.threshold != null ? " — ambang " + r.threshold + "%" : "") +
          " • Perangkat: " + esc(d ? d.name : "Semua") + " • Dibuat " + fmtTime(r.createdAt) + "</div></div>" +
          '<button class="btn sm" type="button" data-action="rule-toggle" data-id="' + esc(r.id) + '" data-enabled="' + (!r.enabled) + '">' + (r.enabled ? "Nonaktifkan" : "Aktifkan") + "</button>" +
          '<button class="btn sm danger" type="button" data-action="rule-delete" data-id="' + esc(r.id) + '">Hapus</button></div>';
      }).join("") : '<p class="muted">Belum ada aturan.</p>') + "</div>";
  }

  function pageSecurity() {
    return '<div class="page-head"><h1>Security &amp; Activity Logs</h1><p>Audit trail keamanan &amp; tombol darurat penghentian sesi.</p></div>' +
      '<div class="card"><h2>Darurat</h2>' +
      '<p class="muted">Hentikan seluruh sesi remote aktif milik akun ini dari satu tombol.</p>' +
      '<button class="btn danger" type="button" data-action="terminate-all">Terminate All Sessions</button> ' +
      '<span id="terminate-status" class="small"></span></div>' +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>Notifikasi Terbaru</h2>' +
      (S.notifications.length ? S.notifications.slice(0, 10).map(function (n) {
        return '<div class="file-row"><div class="name"><b>' + esc(n.appName || n.packageName || "?") + "</b> " + (n.kind === "automation" ? '<span class="chip violet">automation</span>' : "") +
          '<div class="small muted">' + esc(n.title || "") + (n.text ? " — " + esc(n.text) : "") + " • " + fmtTime(n.createdAt) + "</div></div></div>";
      }).join("") : '<p class="muted">Belum ada notifikasi.</p>') +
      '<div style="margin-top:8px"><button class="btn sm" type="button" data-action="refresh-logs">Muat Ulang Log &amp; Notifikasi</button></div></div>' +
      '<div style="height:16px"></div>' +
      '<div class="card"><h2>Activity Logs</h2><div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Aksi</th><th>Perangkat</th><th>Detail</th></tr></thead><tbody>' +
      (S.logs.length ? S.logs.map(function (l) {
        var d = l.deviceId ? deviceById(l.deviceId) : null;
        return "<tr><td>" + fmtTime(l.createdAt) + "</td><td>" + esc(l.action) + "</td><td>" + esc(d ? d.name : (l.deviceId || "—")) + "</td><td>" + esc(l.detail || "") + "</td></tr>";
      }).join("") : '<tr><td colspan="4" class="muted">Belum ada log.</td></tr>') +
      "</tbody></table></div></div>";
  }

  function pageSettings() {
    var u = PrataApi.user() || {};
    return '<div class="page-head"><h1>Settings</h1><p>Akun, koneksi server, dan status STUN/TURN.</p></div>' +
      '<div class="grid cols-2">' +
      '<div class="card"><h2>Akun</h2>' +
      '<p>Nama: <b>' + esc(u.name || "—") + "</b><br>Email: <b>" + esc(u.email || "—") + "</b><br>Peran: <b>" + esc(u.role || "—") + "</b></p>" +
      '<button class="btn danger" type="button" data-action="logout-remote">Logout Jarak Jauh (hentikan semua sesi + keluar)</button></div>' +
      '<div class="card"><h2>Koneksi Server</h2>' +
      '<label>Alamat server backend</label><input id="settings-server" type="text" value="' + esc(PrataApi.serverUrl()) + '">' +
      '<div style="margin-top:12px"><button class="btn" type="button" data-action="save-server">Simpan Alamat Server</button></div>' +
      '<p class="small muted">Menyimpan alamat baru akan memuat ulang koneksi WebSocket.</p>' +
      '<h2 style="margin-top:20px">STUN / TURN</h2><div id="ice-status"><button class="btn sm" type="button" data-action="check-ice">Periksa Server ICE</button></div></div>' +
      '<div class="card"><h2>Download APK &amp; Release</h2>' +
      '<p class="small muted">APK Agent &amp; Controller hasil build GitHub Actions (atau yang diletakkan di folder rilis server), plus bundel sumber lengkap. Unduh langsung dari HP.</p>' +
      '<div id="releases-list"><p class="muted">Memuat daftar rilis…</p></div>' +
      '<div style="margin-top:12px"><button class="btn sm" type="button" data-action="refresh-releases">Muat Ulang Daftar Rilis</button></div></div>' +
      "</div>";
  }

  function refreshReleases() {
    var el = $("#releases-list");
    if (!el) return;
    PrataApi.listApks().then(function (res) {
      var apks = res.apks || [];
      var bundle = res.sourceBundle || null;
      var html = "";
      if (!apks.length && !bundle) {
        html = "<p class='muted'>Belum ada APK di server. Push ke GitHub (workflow build-android) lalu letakkan APK hasil build di folder rilis server, atau build lokal di Android Studio.</p>";
      } else {
        if (apks.length) {
          html += apks.map(function (a) {
            return "<p><b>" + esc(a.name) + "</b> — " + fmtBytes(a.size) + " • " + esc(a.modifiedAt.slice(0, 10)) +
              "<br><a class='btn sm' href='" + esc(PrataApi.apkDownloadUrl(a.name)) + "'>Unduh APK</a></p>";
          }).join("");
        }
        if (bundle) {
          html += "<p><b>" + esc(bundle.name) + "</b> — " + fmtBytes(bundle.size) + " • " + esc(bundle.modifiedAt.slice(0, 10)) +
            "<br><a class='btn sm' href='" + esc(PrataApi.sourceBundleUrl()) + "'>Unduh Bundel Sumber</a></p>";
        }
      }
      el.innerHTML = html;
    }).catch(function (e) {
      el.innerHTML = "<p class='error-box'>Gagal memuat daftar rilis: " + esc(e.message) + "</p>";
    });
  }

  // ---------- Aksi (delegasi klik) ----------

  function refreshDevices() {
    return PrataApi.listDevices().then(function (res) {
      S.devices = res.devices || [];
      if (ws) S.devices.forEach(function (d) { ws.watch(d.id); });
      return S.devices;
    });
  }
  function refreshHealth() {
    return PrataApi.health().then(function (h) { S.health = h; }).catch(function () { /* abaikan */ });
  }
  function refreshRules() {
    return PrataApi.listRules().then(function (res) { S.rules = res.rules || []; }).catch(function () { S.rules = []; });
  }
  function refreshLogs() {
    return Promise.all([
      PrataApi.activityLogs(100).then(function (res) { S.logs = res.logs || []; }).catch(function () { S.logs = []; }),
      PrataApi.notifications(100).then(function (res) { S.notifications = res.notifications || []; }).catch(function () { S.notifications = []; }),
    ]);
  }

  function loadFilesList() {
    var F = S.files;
    if (!F.deviceId || !ws) return;
    F.loading = true; F.error = null;
    var listEl = $("#files-list");
    if (listEl) listEl.innerHTML = "<p class='muted'>Memuat…</p>";
    var docId = F.path.length ? F.path[F.path.length - 1].docId : null;
    ws.fileList(F.deviceId, docId).then(function (msg) {
      F.loading = false;
      if (msg.error) { F.error = msg.error === "saf-folder-not-granted" ? "Agent belum memilih folder akses — minta pemilik Agent memilih folder di dashboard Agent." : msg.error; }
      else F.items = msg.items || [];
      if (S.page === "files") render();
    }).catch(function (e) {
      F.loading = false; F.error = e.message;
      if (S.page === "files") render();
    });
  }

  function setFilesStatus(text) {
    var el = $("#files-status");
    if (el) el.textContent = text;
    S.files.status = text;
  }

  async function downloadFromAgent(docId, fileName) {
    var deviceId = S.files.deviceId;
    if (!deviceId) return;
    setFilesStatus("Meminta unduhan " + fileName + "…");
    try {
      var created = await PrataApi.createTransfer(deviceId, docId, fileName);
      var transferId = created.transferId;
      var ready = false;
      for (var i = 0; i < 30; i++) {
        await new Promise(function (r) { setTimeout(r, 2000); });
        var st = await PrataApi.getTransfer(transferId);
        if (st.transfer.status === "ready") { ready = true; break; }
        if (["done", "failed", "expired"].indexOf(st.transfer.status) >= 0) break;
      }
      if (!ready) { setFilesStatus("Agent tidak mengunggah file (waktu habis)."); return; }
      var blob = await PrataApi.downloadBlob(transferId);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      setFilesStatus("Terunduh: " + fileName);
    } catch (e) {
      setFilesStatus("Gagal mengunduh: " + e.message);
    }
  }

  function handleAction(action, el) {
    var id = el.getAttribute("data-id");
    var L = S.live;
    if (action === "refresh-devices") {
      refreshDevices().then(function () { render(); }).catch(function (e) { showError(e.message); });
    } else if (action === "pair-confirm") {
      var qr = ($("#pair-qr") || { value: "" }).value.trim();
      var pid = ($("#pair-id") || { value: "" }).value.trim();
      var code = ($("#pair-code") || { value: "" }).value.trim();
      var payload = qr ? { qrPayload: qr } : { pairingId: pid, pairingCode: code };
      var st = $("#pair-status");
      if (st) st.textContent = "Mengonfirmasi pairing…";
      PrataApi.pairingConfirm(payload).then(function (res) {
        if (st) st.textContent = "Berhasil dipasangkan: " + (res.deviceName || res.deviceId);
        refreshDevices().then(function () { render(); });
      }).catch(function (e) { if (st) st.textContent = "Gagal: " + e.message; });
    } else if (action === "device-edit") {
      var d = deviceById(id);
      if (!d) return;
      var name = window.prompt("Nama baru perangkat:", d.name);
      if (name == null) return;
      var group = window.prompt("Grup perangkat (mis. Kerja / Pribadi / Testing):", d.group || "");
      if (group == null) return;
      PrataApi.updateDevice(id, { name: name.trim() || d.name, group: group.trim() || null }).then(function () {
        refreshDevices().then(function () { render(); });
      }).catch(function (e) { showError(e.message); });
    } else if (action === "device-perms") {
      var detail = $("#device-detail-" + id);
      if (!detail) return;
      PrataApi.listPermissions(id).then(function (res) {
        var labels = { screen: "Layar", accessibility: "Aksesibilitas", saf: "Folder File (SAF)", notification: "Notifikasi", camera: "Kamera" };
        detail.innerHTML = '<div class="small" style="padding:8px 4px">' +
          (res.permissions || []).map(function (p) {
            return esc(labels[p.feature] || p.feature) + ": " + (p.granted ? "Aktif" : "Tidak aktif");
          }).join(" • ") + "</div>";
      }).catch(function (e) { detail.innerHTML = '<div class="small" style="color:var(--danger)">Gagal memuat izin: ' + esc(e.message) + "</div>"; });
    } else if (action === "device-revoke") {
      if (!window.confirm("Cabut akses perangkat ini? Token Agent langsung dicabut dan koneksinya diputus.")) return;
      PrataApi.revokeDevice(id).then(function () { refreshDevices().then(function () { render(); }); }).catch(function (e) { showError(e.message); });
    } else if (action === "device-delete") {
      if (!window.confirm("Hapus perangkat ini secara permanen?")) return;
      PrataApi.deleteDevice(id).then(function () { refreshDevices().then(function () { render(); }); }).catch(function (e) { showError(e.message); });
    } else if (action === "live-start") {
      var sel = $("#live-device");
      var devId = sel ? sel.value : null;
      if (!devId) { showError("Pilih perangkat dulu."); return; }
      if (L.status === "connected" || L.status === "waiting") endLiveSession("Sesi sebelumnya dihentikan.");
      L.deviceId = devId;
      L.status = "waiting";
      L.statusText = "Meminta sesi ke Agent…";
      updateLiveStatus();
      ws.watch(devId);
      ws.requestSession(devId, el.getAttribute("data-kind") || "screen");
    } else if (action === "live-stop") {
      endLiveSession("Sesi dihentikan dari Web Dashboard.");
    } else if (action === "live-global") {
      liveSend({ action: "global", name: el.getAttribute("data-name") });
    } else if (action === "live-volume") {
      liveSend({ action: "volume", name: el.getAttribute("data-name") });
    } else if (action === "live-quality") {
      var preset = el.getAttribute("data-preset");
      if (liveSend({ action: "quality", preset: preset })) {
        L.quality = preset;
        document.querySelectorAll('[data-action="live-quality"]').forEach(function (b) {
          b.classList.toggle("primary", b.getAttribute("data-preset") === preset);
        });
      }
    } else if (action === "live-photo") {
      liveSend({ action: "photo" });
      var ph = $("#live-photo-status");
      if (ph) ph.textContent = "Mengambil foto di Agent…";
    } else if (action === "live-clipboard-get") {
      liveSend({ action: "clipboard_get" });
    } else if (action === "files-load") {
      var fsel = $("#files-device");
      S.files.deviceId = fsel ? fsel.value : null;
      S.files.path = [];
      loadFilesList();
    } else if (action === "files-refresh") {
      loadFilesList();
    } else if (action === "files-open") {
      S.files.path.push({ docId: el.getAttribute("data-docid"), name: el.getAttribute("data-name") });
      loadFilesList();
    } else if (action === "files-crumb") {
      var idx = parseInt(el.getAttribute("data-index"), 10);
      S.files.path = S.files.path.slice(0, idx + 1);
      loadFilesList();
    } else if (action === "files-mkdir") {
      var name = ($("#files-mkdir-name") || { value: "" }).value.trim();
      if (!name) { setFilesStatus("Isi nama folder dulu."); return; }
      var parent = S.files.path.length ? S.files.path[S.files.path.length - 1].docId : null;
      ws.fileMkdir(S.files.deviceId, parent, name).then(function (msg) {
        setFilesStatus(msg.ok ? "Folder dibuat." : ("Gagal membuat folder: " + (msg.error || "?")));
        if (msg.ok) loadFilesList();
      }).catch(function (e) { setFilesStatus("Gagal: " + e.message); });
    } else if (action === "files-rename") {
      var newName = window.prompt("Nama baru untuk \"" + el.getAttribute("data-name") + "\":", el.getAttribute("data-name"));
      if (!newName || newName === el.getAttribute("data-name")) return;
      ws.fileRename(S.files.deviceId, el.getAttribute("data-docid"), newName).then(function (msg) {
        setFilesStatus(msg.ok ? "Berhasil diganti nama." : ("Gagal: " + (msg.error || "?")));
        if (msg.ok) loadFilesList();
      }).catch(function (e) { setFilesStatus("Gagal: " + e.message); });
    } else if (action === "files-delete") {
      if (!window.confirm("Hapus \"" + el.getAttribute("data-name") + "\" dari Agent?")) return;
      ws.fileDelete(S.files.deviceId, el.getAttribute("data-docid")).then(function (msg) {
        setFilesStatus(msg.ok ? "File dihapus." : ("Gagal menghapus: " + (msg.error || "?")));
        if (msg.ok) loadFilesList();
      }).catch(function (e) { setFilesStatus("Gagal: " + e.message); });
    } else if (action === "files-download") {
      downloadFromAgent(el.getAttribute("data-docid"), el.getAttribute("data-name"));
    } else if (action === "rule-create") {
      var rname = ($("#rule-name") || { value: "" }).value.trim();
      var cond = ($("#rule-cond") || { value: "" }).value;
      var thRaw = ($("#rule-threshold") || { value: "" }).value.trim();
      var rdev = ($("#rule-device") || { value: "" }).value || null;
      if (!rname) { showError("Isi nama aturan dulu."); return; }
      PrataApi.createRule({
        name: rname, conditionType: cond,
        threshold: thRaw === "" ? null : parseInt(thRaw, 10),
        deviceId: rdev,
      }).then(function () { refreshRules().then(function () { render(); }); }).catch(function (e) { showError(e.message); });
    } else if (action === "rule-toggle") {
      PrataApi.updateRule(id, { enabled: el.getAttribute("data-enabled") === "true" }).then(function () {
        refreshRules().then(function () { render(); });
      }).catch(function (e) { showError(e.message); });
    } else if (action === "rule-delete") {
      if (!window.confirm("Hapus aturan ini?")) return;
      PrataApi.deleteRule(id).then(function () { refreshRules().then(function () { render(); }); }).catch(function (e) { showError(e.message); });
    } else if (action === "terminate-all") {
      if (!window.confirm("Hentikan SELURUH sesi remote aktif milik akun ini?")) return;
      PrataApi.terminateAll().then(function (res) {
        var st = $("#terminate-status");
        if (st) st.textContent = "Sesi dihentikan: " + (res.terminated || 0);
        refreshLogs().then(function () { render(); });
      }).catch(function (e) { showError(e.message); });
    } else if (action === "refresh-logs") {
      refreshLogs().then(function () { render(); }).catch(function (e) { showError(e.message); });
    } else if (action === "save-server") {
      var url = ($("#settings-server") || { value: "" }).value.trim();
      if (!url) return;
      PrataApi.setServerUrl(url);
      connectWS();
      var ice = $("#ice-status");
      if (ice) ice.textContent = "Alamat server disimpan — koneksi WebSocket dimulai ulang.";
    } else if (action === "check-ice") {
      PrataApi.iceServers().then(function (res) {
        var ice = $("#ice-status");
        var servers = res.iceServers || [];
        var turn = servers.filter(function (s) { return String(s.urls).indexOf("turn") >= 0; }).length;
        if (ice) ice.innerHTML = "<p>Server ICE: <b>" + servers.length + "</b> (STUN " + (servers.length - turn) + ", TURN " + turn + ").</p>";
      }).catch(function (e) {
        var ice = $("#ice-status");
        if (ice) ice.textContent = "Gagal memeriksa ICE: " + e.message;
      });
    } else if (action === "refresh-releases") {
      refreshReleases();
    } else if (action === "logout-remote") {
      PrataApi.terminateAll().catch(function () { /* tetap keluar */ }).finally(function () { doLogout(); });
    }
  }

  function doLogout() {
    if (ws) ws.disconnect();
    PrataApi.clearSession();
    endLiveSession("Keluar.");
    location.reload();
  }

  // ---------- Boot ----------

  function showPage(name) {
    if (S.page === "live" && name !== "live" && S.live.status === "connected") {
      // Biarkan sesi tetap jalan saat pindah halaman? Tidak — hentikan agar
      // tidak ada stream yang berjalan tanpa layar.
      endLiveSession("Sesi dihentikan (pindah halaman).");
    }
    S.page = name;
    if (name === "devices") refreshDevices().then(function () { render(); }).catch(function (e) { render(); showError(e.message); });
    else if (name === "automation") refreshRules().then(function () { render(); });
    else if (name === "security") refreshLogs().then(function () { render(); });
    else if (name === "overview") Promise.all([refreshDevices(), refreshHealth(), refreshRules()]).then(function () { render(); });
    else if (name === "settings") { render(); refreshReleases(); }
    else render();
  }

  function boot() {
    pageEl = $("#page");
    var loginView = $("#login-view");
    var pageView = $("#page-view");
    var nav = $("#app-nav");
    var logoutBtn = $("#btn-logout");

    logoutBtn.addEventListener("click", function () { doLogout(); });

    if (!PrataApi.isLoggedIn()) {
      loginView.classList.remove("hidden");
      pageView.classList.add("hidden");
      nav.classList.add("hidden");
      logoutBtn.classList.add("hidden");
      $("#header-user").textContent = "";
      $("#login-server").value = PrataApi.serverUrl();
      $("#login-form").addEventListener("submit", function (ev) {
        ev.preventDefault();
        var email = $("#login-email").value.trim();
        var password = $("#login-password").value;
        var server = $("#login-server").value.trim();
        if (server) PrataApi.setServerUrl(server);
        var errBox = $("#login-error");
        errBox.classList.add("hidden");
        PrataApi.login(email, password).then(function (res) {
          PrataApi.saveSession(res.token, res.user);
          location.reload();
        }).catch(function (e) {
          errBox.textContent = e.message || "Login gagal.";
          errBox.classList.remove("hidden");
        });
      });
      return;
    }

    var u = PrataApi.user() || {};
    $("#header-user").textContent = u.email || "";
    connectWS();
    refreshDevices().catch(function () { /* daftar dimuat ulang di halaman */ });
    refreshHealth();
    refreshRules();
    refreshLogs();

    nav.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-page]");
      if (!btn) return;
      showPage(btn.getAttribute("data-page"));
    });

    pageEl.addEventListener("click", function (ev) {
      var el = ev.target.closest("[data-action]");
      if (!el) return;
      handleAction(el.getAttribute("data-action"), el);
    });

    // Pencarian perangkat (input) + upload file (input file) + teks live.
    pageEl.addEventListener("input", function (ev) {
      var t = ev.target;
      if (t.id === "dev-search") {
        var list = $("#device-list");
        if (list) list.innerHTML = deviceListHtml(t.value);
      } else if (t.id === "live-text") {
        var v = t.value;
        if (v !== S.live.lastText) {
          S.live.lastText = v;
          liveSend({ action: "text", text: v });
        }
      }
    });
    pageEl.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t.id === "dev-group-filter") {
        var list = $("#device-list");
        var q = ($("#dev-search") || { value: "" }).value;
        if (list) list.innerHTML = deviceListHtml(q);
      } else if (t.id === "files-upload" && t.files && t.files[0]) {
        var file = t.files[0];
        if (!S.files.deviceId) { setFilesStatus("Pilih perangkat dulu."); return; }
        var folder = S.files.path.length ? S.files.path[S.files.path.length - 1].docId : null;
        setFilesStatus("Mengunggah " + file.name + "…");
        PrataApi.uploadFile(S.files.deviceId, file, folder).then(function () {
          setFilesStatus("File dikirim — menunggu Agent menyimpannya…");
        }).catch(function (e) { setFilesStatus("Gagal mengunggah: " + e.message); });
      } else if (t.id === "live-device") {
        S.live.deviceId = t.value;
      } else if (t.id === "files-device") {
        S.files.deviceId = t.value;
        S.files.path = [];
      }
    });
    pageEl.addEventListener("keydown", function (ev) {
      var t = ev.target;
      if (t.id === "live-text" && ev.key === "Enter") {
        ev.preventDefault();
        liveSend({ action: "key", code: "ENTER" });
      }
    });

    // Interaksi mouse di video: klik = tap, drag = swipe (saat mouseup).
    var dragStart = null;
    var dragStartTime = 0;
    pageEl.addEventListener("mousedown", function (ev) {
      if (ev.target.id !== "live-video") return;
      dragStart = { x: ev.offsetX, y: ev.offsetY, w: ev.target.clientWidth, h: ev.target.clientHeight };
      dragStartTime = Date.now();
    });
    pageEl.addEventListener("mouseup", function (ev) {
      if (ev.target.id !== "live-video" || !dragStart) return;
      var dx = ev.offsetX - dragStart.x;
      var dy = ev.offsetY - dragStart.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var threshold = Math.max(50, 0.05 * Math.min(dragStart.w, dragStart.h));
      if (dist >= threshold) {
        liveSend({
          action: "swipe",
          startX: dragStart.x / dragStart.w, startY: dragStart.y / dragStart.h,
          endX: ev.offsetX / dragStart.w, endY: ev.offsetY / dragStart.h,
          duration: Math.min(1000, Math.max(100, Date.now() - dragStartTime)),
        });
      } else {
        liveSend({ action: "tap", x: ev.offsetX / dragStart.w, y: ev.offsetY / dragStart.h });
      }
      dragStart = null;
    });

    showPage("overview");
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
