// PRATA Remote — WebRTC Live Control Web Dashboard (FINAL, Bagian 7)
// Peran penerima (answerer): terima webrtc_offer dari Agent ->
// setRemoteDescription -> createAnswer -> kirim webrtc_answer.
// Video masuk ke <video> via srcObject. DataChannel "prata_control"
// dipakai dua arah: kirim tap/swipe/key/global/volume/quality/ping,
// terima pong/clipboard/photo-result.
(function (global) {
  "use strict";

  function LiveRtc(iceServers, callbacks) {
    this.iceServers = iceServers || [];
    this.cb = callbacks || {};
    this.pc = null;
    this.channel = null;
    this.sessionId = null;
  }

  LiveRtc.prototype.start = async function (sessionId, offerPayload) {
    var self = this;
    this.sessionId = sessionId;
    var pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    pc.onicecandidate = function (ev) {
      if (ev.candidate && self.cb.onIceCandidate) {
        self.cb.onIceCandidate({
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex,
          candidate: ev.candidate.candidate,
        });
      }
    };
    pc.ontrack = function (ev) {
      if (self.cb.onTrack) self.cb.onTrack(ev.streams[0] || null, ev.track);
    };
    pc.ondatachannel = function (ev) {
      self.channel = ev.channel;
      self.channel.onmessage = function (mev) {
        if (self.cb.onControlMessage) self.cb.onControlMessage(mev.data);
      };
      self.channel.onopen = function () { if (self.cb.onChannelOpen) self.cb.onChannelOpen(); };
    };
    pc.oniceconnectionstatechange = function () {
      if (self.cb.onIceState) self.cb.onIceState(pc.iceConnectionState);
    };
    await pc.setRemoteDescription(new RTCSessionDescription(offerPayload));
    var answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { type: answer.type, sdp: answer.sdp };
  };

  LiveRtc.prototype.addIce = async function (candidate) {
    if (!this.pc) return;
    try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { /* abaikan */ }
  };

  LiveRtc.prototype.sendControl = function (obj) {
    if (this.channel && this.channel.readyState === "open") {
      this.channel.send(typeof obj === "string" ? obj : JSON.stringify(obj));
      return true;
    }
    return false;
  };

  LiveRtc.prototype.close = function () {
    try { if (this.channel) this.channel.close(); } catch (e) { /* abaikan */ }
    try { if (this.pc) this.pc.close(); } catch (e) { /* abaikan */ }
    this.channel = null;
    this.pc = null;
    this.sessionId = null;
  };

  global.LiveRtc = LiveRtc;
})(window);
