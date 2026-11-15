// PRATA Remote — Klien REST Web Dashboard (FINAL, Bagian 7)
// Semua panggilan memakai JWT dari localStorage. Bentuk respons mengikuti
// apps/backend/src/api/router.ts persis (lihat README web).
(function (global) {
  "use strict";
  var LS_SERVER = "prata_web_server";
  var LS_JWT = "prata_web_jwt";
  var LS_USER = "prata_web_user";

  function serverUrl() {
    return (localStorage.getItem(LS_SERVER) || "http://localhost:8080").replace(/\/+$/, "");
  }
  function setServerUrl(url) { localStorage.setItem(LS_SERVER, url.replace(/\/+$/, "")); }
  function jwt() { return localStorage.getItem(LS_JWT); }
  function user() {
    try { return JSON.parse(localStorage.getItem(LS_USER) || "null"); } catch (e) { return null; }
  }
  function saveSession(token, userObj) {
    localStorage.setItem(LS_JWT, token);
    localStorage.setItem(LS_USER, JSON.stringify(userObj || null));
  }
  function clearSession() {
    localStorage.removeItem(LS_JWT);
    localStorage.removeItem(LS_USER);
  }

  function ApiError(status, code, message) {
    var err = new Error(message || ("HTTP " + status));
    err.status = status; err.code = code;
    return err;
  }

  async function req(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (opts.headers) Object.assign(headers, opts.headers);
    var token = jwt();
    if (token) headers["Authorization"] = "Bearer " + token;
    var init = { method: opts.method || "GET", headers: headers };
    if (opts.body !== undefined) init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    var res;
    try {
      res = await fetch(serverUrl() + path, init);
    } catch (e) {
      throw ApiError(0, "network-error", "Tidak bisa terhubung ke server " + serverUrl() + ". Periksa alamat server & pastikan backend berjalan.");
    }
    if (opts.raw) return res;
    var data = null;
    try { data = await res.json(); } catch (e) { /* bukan JSON */ }
    if (!res.ok) {
      var errObj = data && data.error ? data.error : {};
      throw ApiError(res.status, errObj.code || "http-error", errObj.message || ("HTTP " + res.status));
    }
    return data;
  }

  async function reqBlob(path) {
    var res = await req(path, { raw: true });
    if (!res.ok) {
      var data = null;
      try { data = await res.json(); } catch (e) { /* abaikan */ }
      var errObj = data && data.error ? data.error : {};
      throw ApiError(res.status, errObj.code || "http-error", errObj.message || ("HTTP " + res.status));
    }
    return res.blob();
  }

  var Api = {
    serverUrl: serverUrl,
    setServerUrl: setServerUrl,
    jwt: jwt,
    user: user,
    saveSession: saveSession,
    clearSession: clearSession,
    isLoggedIn: function () { return !!jwt(); },

    health: function () { return req("/healthz"); },
    login: function (email, password) { return req("/api/auth/login", { method: "POST", body: { email: email, password: password } }); },
    iceServers: function () { return req("/api/rtc/ice-servers"); },

    listDevices: function () { return req("/api/devices"); },
    getDevice: function (id) { return req("/api/devices/" + encodeURIComponent(id)); },
    updateDevice: function (id, patch) { return req("/api/devices/" + encodeURIComponent(id), { method: "PATCH", body: patch }); },
    deleteDevice: function (id) { return req("/api/devices/" + encodeURIComponent(id), { method: "DELETE" }); },
    revokeDevice: function (id) { return req("/api/devices/" + encodeURIComponent(id) + "/revoke", { method: "POST", body: {} }); },
    listPermissions: function (id) { return req("/api/devices/" + encodeURIComponent(id) + "/permissions"); },
    listKeys: function (id) { return req("/api/devices/" + encodeURIComponent(id) + "/keys"); },

    pairingConfirm: function (payload) { return req("/api/devices/pairing/confirm", { method: "POST", body: payload }); },

    terminateAll: function () { return req("/api/sessions/terminate-all", { method: "POST", body: {} }); },
    activityLogs: function (limit, deviceId) {
      var q = "?limit=" + (limit || 100);
      if (deviceId) q += "&deviceId=" + encodeURIComponent(deviceId);
      return req("/api/activity-logs" + q);
    },
    notifications: function (limit, pkg, kind) {
      var q = "?limit=" + (limit || 100);
      if (pkg) q += "&package=" + encodeURIComponent(pkg);
      if (kind) q += "&kind=" + encodeURIComponent(kind);
      return req("/api/notifications" + q);
    },

    listRules: function () { return req("/api/automation/rules"); },
    listApks: function () { return req("/api/releases/apks"); },
    apkDownloadUrl: function (name) { return serverUrl() + "/api/releases/apks/" + encodeURIComponent(name); },
    sourceBundleUrl: function () { return serverUrl() + "/api/releases/source-bundle"; },
    createRule: function (rule) { return req("/api/automation/rules", { method: "POST", body: rule }); },
    updateRule: function (id, patch) { return req("/api/automation/rules/" + encodeURIComponent(id), { method: "PATCH", body: patch }); },
    deleteRule: function (id) { return req("/api/automation/rules/" + encodeURIComponent(id), { method: "DELETE" }); },

    createTransfer: function (deviceId, docId, fileName) {
      return req("/api/devices/" + encodeURIComponent(deviceId) + "/files/request-download", { method: "POST", body: { docId: docId, fileName: fileName } });
    },
    getTransfer: function (transferId) { return req("/api/transfers/" + encodeURIComponent(transferId)); },
    downloadBlob: function (transferId) { return reqBlob("/api/transfers/" + encodeURIComponent(transferId) + "/blob"); },
    uploadFile: function (deviceId, file, folderDocId) {
      var headers = { "X-File-Name": file.name };
      if (file.type) headers["X-File-Mime"] = file.type;
      if (folderDocId) headers["X-Folder-DocId"] = folderDocId;
      return fetch(serverUrl() + "/api/devices/" + encodeURIComponent(deviceId) + "/files/upload", {
        method: "POST",
        headers: Object.assign(headers, jwt() ? { "Authorization": "Bearer " + jwt() } : {}),
        body: file,
      }).then(function (res) {
        if (!res.ok) return res.json().then(function (data) {
          var e = data && data.error ? data.error : {};
          throw ApiError(res.status, e.code || "http-error", e.message || ("HTTP " + res.status));
        });
        return res.json();
      });
    },
  };

  global.PrataApi = Api;
})(window);
