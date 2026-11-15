// PRATA Remote — Klien WebSocket signaling Web Dashboard (FINAL, Bagian 7)
// Protokol sama dengan apps/backend/src/signaling/types.ts: hello
// controller -> welcome (iceServers) -> watch/session-request -> relay
// webrtc_offer/answer/ice. Permintaan file/app dipasangkan lewat
// requestId (Promise + timeout 60 dtk). Reconnect backoff maks 5x.
(function (global) {
  "use strict";

  function wsBase(serverUrl) {
    var u = serverUrl.replace(/\/+$/, "");
    if (u.indexOf("https://") === 0) return "wss://" + u.slice(8);
    if (u.indexOf("http://") === 0) return "ws://" + u.slice(7);
    return u;
  }

  function PrataWS(serverUrl, token, handlers) {
    this.serverUrl = serverUrl;
    this.token = token;
    this.handlers = handlers || {};
    this.ws = null;
    this.connected = false;
    this.iceServers = [];
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pending = new Map(); // requestId -> {resolve, reject, timer}
    this.wantReconnect = true;
  }

  PrataWS.prototype.connect = function () {
    var self = this;
    this.wantReconnect = true;
    var ws = new WebSocket(wsBase(this.serverUrl));
    this.ws = ws;
    ws.onopen = function () {
      self.connected = true;
      self.reconnectAttempts = 0;
      self.send({ type: "hello", role: "controller", token: self.token });
      self.heartbeatTimer = setInterval(function () { self.send({ type: "heartbeat" }); }, 15000);
      if (self.handlers.onOpen) self.handlers.onOpen();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      self.handle(msg);
    };
    ws.onclose = function () {
      self.connected = false;
      clearInterval(self.heartbeatTimer);
      if (self.handlers.onClose) self.handlers.onClose();
      if (self.wantReconnect && self.reconnectAttempts < 5) {
        var delay = [1000, 2000, 4000, 8000, 16000][self.reconnectAttempts];
        self.reconnectAttempts += 1;
        self.reconnectTimer = setTimeout(function () { self.connect(); }, delay);
      }
    };
    ws.onerror = function () { /* onclose yang menangani */ };
  };

  PrataWS.prototype.disconnect = function () {
    this.wantReconnect = false;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.ws) { try { this.ws.close(); } catch (e) { /* abaikan */ } }
    this.ws = null;
    this.connected = false;
  };

  PrataWS.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  };

  PrataWS.prototype.handle = function (msg) {
    if (msg.type === "welcome") {
      this.iceServers = msg.iceServers || [];
      if (this.handlers.onWelcome) this.handlers.onWelcome(msg);
      return;
    }
    // Jawaban relay yang dipasangkan lewat requestId.
    if (msg.requestId && this.pending.has(msg.requestId)) {
      var p = this.pending.get(msg.requestId);
      this.pending.delete(msg.requestId);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    if (this.handlers.onMessage) this.handlers.onMessage(msg);
  };

  // Permintaan relay -> Promise jawaban (timeout 60 dtk).
  PrataWS.prototype.request = function (msg) {
    var self = this;
    var requestId = "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    msg.requestId = requestId;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        self.pending.delete(requestId);
        reject(new Error("Waktu habis menunggu jawaban Agent (60 dtk)."));
      }, 60000);
      self.pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
      if (!self.send(msg)) {
        clearTimeout(timer);
        self.pending.delete(requestId);
        reject(new Error("WebSocket belum terhubung."));
      }
    });
  };

  PrataWS.prototype.watch = function (deviceId) { return this.send({ type: "watch", deviceId: deviceId }); };
  PrataWS.prototype.unwatch = function (deviceId) { return this.send({ type: "unwatch", deviceId: deviceId }); };
  PrataWS.prototype.requestSession = function (deviceId, sessionType) {
    return this.send({ type: "session-request", deviceId: deviceId, sessionType: sessionType || "screen" });
  };
  PrataWS.prototype.endSession = function (sessionId, reason) {
    return this.send({ type: "session-end", sessionId: sessionId, reason: reason || "stopped-by-web" });
  };
  PrataWS.prototype.sendOffer = function (sessionId, payload) {
    return this.send({ type: "webrtc_offer", sessionId: sessionId, payload: payload });
  };
  PrataWS.prototype.sendAnswer = function (sessionId, payload) {
    return this.send({ type: "webrtc_answer", sessionId: sessionId, payload: payload });
  };
  PrataWS.prototype.sendIce = function (sessionId, payload) {
    return this.send({ type: "webrtc_ice_candidate", sessionId: sessionId, payload: payload });
  };
  PrataWS.prototype.fileList = function (deviceId, docId) {
    return this.request({ type: "file_list_request", deviceId: deviceId, docId: docId || null });
  };
  PrataWS.prototype.fileMkdir = function (deviceId, parentDocId, name) {
    return this.request({ type: "file_mkdir_request", deviceId: deviceId, parentDocId: parentDocId || null, name: name });
  };
  PrataWS.prototype.fileRename = function (deviceId, docId, newName) {
    return this.request({ type: "file_rename_request", deviceId: deviceId, docId: docId, newName: newName });
  };
  PrataWS.prototype.fileDelete = function (deviceId, docId) {
    return this.request({ type: "file_delete_request", deviceId: deviceId, docId: docId });
  };
  PrataWS.prototype.appList = function (deviceId) {
    return this.request({ type: "app_list_request", deviceId: deviceId });
  };
  PrataWS.prototype.appCommand = function (deviceId, command, packageName) {
    return this.request({ type: "app_command", deviceId: deviceId, command: command, packageName: packageName });
  };

  global.PrataWS = PrataWS;
})(window);
