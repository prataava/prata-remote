package com.prata.remote.shared.webrtc

// PRATA Remote — Klien WebRTC (Command 003, Phase 2 + Command 004)
// Satu kelas untuk kedua peran: Agent membuat Offer (pengirim layar),
// Controller membuat Answer (penerima). Logic PeerConnection TIDAK
// dicampur dengan UI Compose — ViewModel yang memanggilnya.
// Dibangun di thread Main (syarat PeerConnectionFactory Android).
// Semua operasi SDP memakai coroutine suspend agar ViewModel tidak
// berurusan dengan callback SdpObserver.
// Command 004: DataChannel "prata_control" untuk remote touch — dibuat
// oleh offerer (Agent) sebelum createOffer; penerima (Controller)
// mendapatkannya lewat onDataChannel. EGL context diekspos lewat
// eglContext agar SurfaceViewRenderer memakai context yang SAMA.
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import com.prata.remote.shared.model.IceCandidateDto
import com.prata.remote.shared.model.IceServerDto
import com.prata.remote.shared.model.SdpDto
import com.prata.remote.shared.model.toDto
import com.prata.remote.shared.model.toIceCandidate
import com.prata.remote.shared.model.toSessionDescription
import com.prata.remote.shared.model.toWebRtc
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Preset kualitas stream (FINAL, Bagian 3): diubah dinamis via DataChannel. */
enum class StreamQuality(val width: Int, val height: Int, val fps: Int, val maxBitrateBps: Int) {
    LOW(854, 480, 15, 600_000),
    MEDIUM(1280, 720, 24, 1_500_000),
    HIGH(1920, 1080, 30, 3_500_000),
}

class WebRtcClient(
    context: Context,
    iceServers: List<IceServerDto>,
    private val listener: Listener,
) {
    interface Listener {
        fun onLocalIceCandidate(candidate: IceCandidateDto)
        fun onIceConnectionChange(state: PeerConnection.IceConnectionState)
        fun onRemoteVideoTrack(track: VideoTrack)
        fun onConnectionChange(state: PeerConnection.PeerConnectionState)
        /** Pesan teks dari DataChannel "prata_control" (mis. JSON tap). */
        fun onControlMessage(message: String)
    }

    private val appContext = context.applicationContext
    private val eglBase: EglBase = EglBase.create()

    /**
     * SATU-SATUNYA EGL context untuk PeerConnectionFactory, capturer, dan
     * SurfaceViewRenderer. Jangan buat EglBase kedua di ViewModel/UI —
     * mismatch context adalah sumber crash WebRTC yang paling umum.
     */
    val eglContext: EglBase.Context get() = eglBase.eglBaseContext

    private val factory: PeerConnectionFactory
    private var peerConnection: PeerConnection? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var videoSender: RtpSender? = null
    private var capturer: VideoCapturer? = null
    private var dataChannel: DataChannel? = null
    private var disposed = false
    private var currentQuality = StreamQuality.MEDIUM

    /** Frame terakhir dari track lokal (untuk ambil foto). Di-retain. */
    private var latestFrame: VideoFrame.I420Buffer? = null
    private val frameSink = VideoSink { frame ->
        val i420 = try {
            frame.buffer.toI420()
        } catch (_: Exception) {
            null
        } ?: return@VideoSink
        synchronized(this) {
            latestFrame?.release()
            i420.retain()
            latestFrame = i420
        }
    }

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers.toWebRtc()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        peerConnection = factory.createPeerConnection(rtcConfig, pcObserver)
    }

    private val pcObserver = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: org.webrtc.IceCandidate) {
            listener.onLocalIceCandidate(candidate.toDto())
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            listener.onIceConnectionChange(state)
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            listener.onConnectionChange(state)
        }

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out org.webrtc.MediaStream>) {
            val track = receiver.track()
            if (track is VideoTrack) listener.onRemoteVideoTrack(track)
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onRemoveTrack(receiver: RtpReceiver) = Unit
        override fun onDataChannel(channel: DataChannel) {
            // Pihak penerima (Controller): channel dibuat oleh offerer (Agent).
            channel.registerObserver(dataChannelObserver)
            dataChannel = channel
        }
        override fun onRenegotiationNeeded() = Unit
        override fun onAddStream(stream: org.webrtc.MediaStream) = Unit
        override fun onRemoveStream(stream: org.webrtc.MediaStream) = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
    }

    private val dataChannelObserver = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) = Unit

        override fun onStateChange() = Unit

        override fun onMessage(buffer: DataChannel.Buffer) {
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            listener.onControlMessage(String(bytes, Charsets.UTF_8))
        }
    }

    /**
     * Buat DataChannel "prata_control". Hanya dipanggil pihak OFFERER
     * (Agent), SEBELUM createOffer, agar channel dinegosiasikan di SDP.
     * Pihak penerima (Controller) mendapatkannya lewat onDataChannel.
     */
    fun createControlChannel(): DataChannel? {
        check(!disposed) { "WebRtcClient sudah di-dispose." }
        val channel = peerConnection?.createDataChannel(CONTROL_CHANNEL_LABEL, DataChannel.Init())
        if (channel != null) {
            channel.registerObserver(dataChannelObserver)
            dataChannel = channel
        }
        return channel
    }

    /** Kirim pesan teks lewat DataChannel. False bila channel belum OPEN. */
    fun sendControlMessage(message: String): Boolean {
        val channel = dataChannel ?: return false
        if (channel.state() != DataChannel.State.OPEN) return false
        val bytes = message.toByteArray(Charsets.UTF_8)
        return channel.send(DataChannel.Buffer(java.nio.ByteBuffer.wrap(bytes), false))
    }

    /**
     * Pasang capturer (mis. ScreenCapturerAndroid dari MediaProjection atau
     * CameraCapturer dari Camera2Enumerator) sebagai video track dan mulai
     * capture. Kembalikan track-nya. Sink frame lokal dipasang agar
     * takePhotoJpeg() bisa mengambil foto dari stream sendiri.
     */
    fun attachCapturer(capturer: VideoCapturer, width: Int = 1280, height: Int = 720, fps: Int = 30): VideoTrack {
        check(!disposed) { "WebRtcClient sudah di-dispose." }
        this.capturer = capturer
        videoSource = factory.createVideoSource(capturer.isScreencast)
        val helper = SurfaceTextureHelper.create("PrataCaptureThread", eglBase.eglBaseContext)
        capturer.initialize(helper, appContext, videoSource?.capturerObserver)
        capturer.startCapture(width, height, fps)
        val track = factory.createVideoTrack(SCREEN_TRACK_ID, videoSource)
        videoTrack = track
        videoSender = peerConnection?.addTrack(track, listOf(SCREEN_STREAM_ID))
        track.addSink(frameSink)
        return track
    }

    /** Alias lama (Command 003): capturer layar. */
    fun attachScreenCapturer(capturer: VideoCapturer, width: Int = 1280, height: Int = 720, fps: Int = 30): VideoTrack =
        attachCapturer(capturer, width, height, fps)

    /**
     * Ubah kualitas stream secara dinamis (FINAL, Bagian 3): format
     * capture + bitrate pengirim. Mengembalikan false bila belum ada
     * capturer/track aktif.
     */
    fun setQuality(preset: StreamQuality): Boolean {
        if (disposed) return false
        val cap = capturer ?: return false
        currentQuality = preset
        try {
            cap.changeCaptureFormat(preset.width, preset.height, preset.fps)
        } catch (_: Exception) {
            return false
        }
        try {
            val sender = videoSender ?: return true
            val params = sender.parameters
            val encoding = params.encodings.firstOrNull()
            if (encoding != null) {
                encoding.maxBitrateBps = preset.maxBitrateBps
                sender.parameters = params
            }
        } catch (_: Exception) {
            // Bitrate gagal diubah — format capture tetap berlaku.
        }
        return true
    }

    fun currentQuality(): StreamQuality = currentQuality

    /**
     * Ambil foto JPEG dari frame terakhir track lokal (FINAL, Bagian 5).
     * Null bila belum ada frame (mis. stream belum jalan).
     */
    fun takePhotoJpeg(quality: Int = 85): ByteArray? {
        val buffer = synchronized(this) { latestFrame } ?: return null
        val width = buffer.width
        val height = buffer.height
        if (width <= 0 || height <= 0) return null
        val ySize = width * height
        val uvWidth = (width + 1) / 2
        val uvHeight = (height + 1) / 2
        val nv21 = ByteArray(ySize + uvWidth * uvHeight * 2)
        try {
            copyPlane(buffer.dataY, buffer.strideY, nv21, 0, width, width, height)
            // NV21: chroma interleaved V dulu, lalu U.
            val vPlane = buffer.dataV
            val uPlane = buffer.dataU
            var outPos = ySize
            val vBytes = ByteArray(uvWidth)
            val uBytes = ByteArray(uvWidth)
            for (row in 0 until uvHeight) {
                vPlane.position(row * buffer.strideV)
                vPlane.get(vBytes, 0, minOf(uvWidth, vPlane.remaining()))
                uPlane.position(row * buffer.strideU)
                uPlane.get(uBytes, 0, minOf(uvWidth, uPlane.remaining()))
                for (col in 0 until uvWidth) {
                    nv21[outPos++] = vBytes[col]
                    nv21[outPos++] = uBytes[col]
                }
            }
        } catch (_: Exception) {
            return null
        }
        val out = ByteArrayOutputStream()
        val image = YuvImage(nv21, ImageFormat.NV21, width, height, null)
        if (!image.compressToJpeg(Rect(0, 0, width, height), quality.coerceIn(1, 100), out)) return null
        return out.toByteArray()
    }

    private fun copyPlane(src: java.nio.ByteBuffer, srcStride: Int, dst: ByteArray, dstOffset: Int, dstStride: Int, width: Int, height: Int) {
        val row = ByteArray(width)
        for (y in 0 until height) {
            src.position(y * srcStride)
            src.get(row, 0, minOf(width, src.remaining()))
            System.arraycopy(row, 0, dst, dstOffset + y * dstStride, width)
        }
    }

    suspend fun createOffer(): SdpDto = suspendCancellableCoroutine { cont ->
        val pc = peerConnection
        if (pc == null) {
            cont.resumeWithException(IllegalStateException("PeerConnection tidak ada."))
            return@suspendCancellableCoroutine
        }
        pc.createOffer(
            object : SdpObserver {
                override fun onCreateSuccess(desc: SessionDescription) {
                    pc.setLocalDescription(
                        object : SdpObserver {
                            override fun onSetSuccess() {
                                if (cont.isActive) cont.resume(desc.toDto())
                            }

                            override fun onSetFailure(error: String?) {
                                if (cont.isActive) cont.resumeWithException(IllegalStateException("setLocalDescription gagal: $error"))
                            }

                            override fun onCreateSuccess(p0: SessionDescription?) = Unit
                            override fun onCreateFailure(p0: String?) = Unit
                        },
                        desc,
                    )
                }

                override fun onCreateFailure(error: String?) {
                    if (cont.isActive) cont.resumeWithException(IllegalStateException("createOffer gagal: $error"))
                }

                override fun onSetSuccess() = Unit
                override fun onSetFailure(error: String?) = Unit
            },
            MediaConstraints(),
        )
    }

    suspend fun createAnswer(): SdpDto = suspendCancellableCoroutine { cont ->
        val pc = peerConnection
        if (pc == null) {
            cont.resumeWithException(IllegalStateException("PeerConnection tidak ada."))
            return@suspendCancellableCoroutine
        }
        pc.createAnswer(
            object : SdpObserver {
                override fun onCreateSuccess(desc: SessionDescription) {
                    pc.setLocalDescription(
                        object : SdpObserver {
                            override fun onSetSuccess() {
                                if (cont.isActive) cont.resume(desc.toDto())
                            }

                            override fun onSetFailure(error: String?) {
                                if (cont.isActive) cont.resumeWithException(IllegalStateException("setLocalDescription gagal: $error"))
                            }

                            override fun onCreateSuccess(p0: SessionDescription?) = Unit
                            override fun onCreateFailure(p0: String?) = Unit
                        },
                        desc,
                    )
                }

                override fun onCreateFailure(error: String?) {
                    if (cont.isActive) cont.resumeWithException(IllegalStateException("createAnswer gagal: $error"))
                }

                override fun onSetSuccess() = Unit
                override fun onSetFailure(error: String?) = Unit
            },
            MediaConstraints(),
        )
    }

    /** Set remote description. Kembalikan true bila berhasil. */
    suspend fun setRemoteDescription(sdp: SdpDto): Boolean = suspendCancellableCoroutine { cont ->
        val pc = peerConnection
        if (pc == null) {
            cont.resume(false)
            return@suspendCancellableCoroutine
        }
        pc.setRemoteDescription(
            object : SdpObserver {
                override fun onSetSuccess() {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onSetFailure(error: String?) {
                    if (cont.isActive) cont.resume(false)
                }

                override fun onCreateSuccess(p0: SessionDescription?) = Unit
                override fun onCreateFailure(p0: String?) = Unit
            },
            sdp.toSessionDescription(),
        )
    }

    fun addIceCandidate(candidate: IceCandidateDto) {
        peerConnection?.addIceCandidate(candidate.toIceCandidate())
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        try {
            dataChannel?.close()
        } catch (_: Exception) {
        }
        dataChannel = null
        try {
            capturer?.stopCapture()
        } catch (_: Exception) {
        }
        try {
            capturer?.dispose()
        } catch (_: Exception) {
        }
        synchronized(this) {
            latestFrame?.release()
            latestFrame = null
        }
        videoTrack?.removeSink(frameSink)
        videoTrack?.dispose()
        videoSource?.dispose()
        peerConnection?.close()
        peerConnection?.dispose()
        factory.dispose()
        eglBase.release()
    }

    companion object {
        const val SCREEN_TRACK_ID = "screen-track"
        const val SCREEN_STREAM_ID = "screen-stream"
        const val CONTROL_CHANNEL_LABEL = "prata_control"
    }
}
