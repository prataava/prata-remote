package com.prata.remote.shared.model

// PRATA Remote — DTO WebRTC (Command 003, Phase 2)
// Bentuk JSON yang dipertukarkan lewat signaling:
//   webrtc_offer / webrtc_answer -> payload {type: "offer"|"answer", sdp}
//   webrtc_ice_candidate         -> payload {sdpMid, sdpMLineIndex, candidate}
//   welcome / GET /api/rtc/ice-servers -> iceServers [{urls, username?, credential?}]
// Konverter ke/dari tipe org.webrtc tinggal di sini agar ViewModel tidak
// berurusan dengan detail library.
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.SessionDescription

data class IceServerDto(
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

data class SdpDto(
    val type: String,
    val sdp: String,
)

data class IceCandidateDto(
    val sdpMid: String?,
    val sdpMLineIndex: Int,
    val candidate: String,
)

/** Fallback STUN publik bila konfigurasi ICE server belum diterima. */
fun defaultIceServers(): List<IceServerDto> = listOf(
    IceServerDto(listOf("stun:stun.l.google.com:19302")),
    IceServerDto(listOf("stun:stun1.l.google.com:19302")),
)

fun IceServerDto.toWebRtc(): PeerConnection.IceServer {
    val builder = PeerConnection.IceServer.builder(urls)
    if (username != null) builder.setUsername(username)
    if (credential != null) builder.setPassword(credential)
    return builder.createIceServer()
}

fun List<IceServerDto>.toWebRtc(): List<PeerConnection.IceServer> = map { it.toWebRtc() }

fun SdpDto.toSessionDescription(): SessionDescription {
    val type = if (type == "answer") SessionDescription.Type.ANSWER else SessionDescription.Type.OFFER
    return SessionDescription(type, sdp)
}

fun SessionDescription.toDto(): SdpDto {
    val type = if (type == SessionDescription.Type.ANSWER) "answer" else "offer"
    return SdpDto(type = type, sdp = description)
}

fun IceCandidateDto.toIceCandidate(): IceCandidate = IceCandidate(sdpMid, sdpMLineIndex, candidate)

fun IceCandidate.toDto(): IceCandidateDto =
    IceCandidateDto(sdpMid = sdpMid, sdpMLineIndex = sdpMLineIndex, candidate = sdp)
