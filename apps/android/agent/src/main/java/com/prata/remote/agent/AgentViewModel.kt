package com.prata.remote.agent

// PRATA Remote — ViewModel Agent (Command 002 Tugas 2 + Command 003 Tugas 2)
// Alur pairing (tidak berubah): cek token tersimpan -> bila ada, langsung
// Paired + hubungkan WS; bila tidak ada, minta kode pairing (REST init) ->
// tampilkan QR -> polling tiap 3 detik sampai controller confirm -> simpan
// token -> Paired + hubungkan WS + jalankan Foreground Service.
// Kode kedaluwarsa dihitung mundur; bila habis, minta kode baru otomatis.
//
// Tambahan Command 003 (berbagi layar):
//  - User ketuk "Mulai Berbagi Layar" -> Activity meminta izin tangkap
//    layar (MediaProjectionManager intent, dialog sistem, HARUS tap
//    "Start Now") -> token izin diteruskan ke Foreground Service ->
//    service mengaktifkan MediaProjection (tipe mediaProjection) ->
//    ViewModel membuat ScreenCapturerAndroid + WebRtcClient.
//  - Controller request sesi "screen" -> agent accept HANYA bila sharing
//    sudah On -> agent (offerer) membuat offer, kirim via WebSocket,
//    terima answer + ICE candidates.
//  - Berhenti berbagi / sesi berakhir / controller menolak -> dispose
//    WebRTC, kembali ke mode keepalive. Semua logika WebRTC lewat
//    WebRtcClient; tidak ada PeerConnection di Composable.
import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.projection.MediaProjection
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.prata.remote.agent.service.AccessibilityController
import com.prata.remote.agent.service.AgentForegroundService
import com.prata.remote.agent.service.AgentMetricsBridge
import com.prata.remote.agent.service.AppManager
import com.prata.remote.agent.service.FileBrowser
import com.prata.remote.agent.service.MediaProjectionHolder
import com.prata.remote.agent.service.NotificationBridge
import com.prata.remote.agent.service.PrataNotificationListenerService
import com.prata.remote.agent.service.SafFolderStore
import com.prata.remote.shared.model.IceCandidateDto
import com.prata.remote.shared.model.IceServerDto
import com.prata.remote.shared.model.PairingInitRequest
import com.prata.remote.shared.model.PairingPollRequest
import com.prata.remote.shared.model.SdpDto
import com.prata.remote.shared.model.defaultIceServers
import com.prata.remote.shared.network.ApiResult
import com.prata.remote.shared.network.RetrofitClient
import com.prata.remote.shared.security.TokenStore
import com.prata.remote.shared.signaling.ConnectionState
import com.prata.remote.shared.signaling.SignalingClient
import com.prata.remote.shared.signaling.SignalingEvent
import com.prata.remote.shared.util.ServerConfig
import com.prata.remote.shared.webrtc.StreamQuality
import com.prata.remote.shared.webrtc.WebRtcClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.PeerConnection
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.VideoTrack

sealed interface SharingState {
    data object Off : SharingState
    data object WaitingProjection : SharingState
    data object On : SharingState
    data class Failed(val message: String) : SharingState
}

sealed interface AgentUiState {
    data object Loading : AgentUiState
    data class Unpaired(
        val pairingCode: String,
        val qrPayload: String,
        val secondsLeft: Int,
        val isPolling: Boolean,
        val error: String?,
    ) : AgentUiState
    data class Paired(
        val deviceId: String,
        val wsState: ConnectionState,
        val running: Boolean,
        val error: String?,
        val sharing: SharingState = SharingState.Off,
        val iceText: String? = null,
        val a11yEnabled: Boolean = false,
        val safFolderName: String? = null,
        val notifEnabled: Boolean = false,
        val camera: SharingState = SharingState.Off,
        val cameraFacing: String = "back",
    ) : AgentUiState
}

class AgentViewModel(application: Application) : AndroidViewModel(application) {
    private val tokenStore = TokenStore(application)
    private val serverConfig = ServerConfig(application)
    // Klien signaling dibuat ulang tiap kali terhubung, agar selalu memakai
    // alamat server terbaru (bukan alamat saat ViewModel pertama dibuat).
    private var signaling: SignalingClient? = null

    private fun freshSignaling(): SignalingClient {
        signaling?.disconnect()
        return SignalingClient(serverConfig.wsBaseUrl()).also { signaling = it }
    }

    private val _uiState = MutableStateFlow<AgentUiState>(AgentUiState.Loading)
    val uiState: StateFlow<AgentUiState> = _uiState.asStateFlow()

    private val _serverUrl = MutableStateFlow(serverConfig.serverUrl)
    val serverUrl: StateFlow<String> = _serverUrl.asStateFlow()

    private var pairingId: String? = null
    private var pairingCode: String? = null
    private var pollJob: Job? = null
    private var countdownJob: Job? = null
    private var wsCollectJob: Job? = null
    private var eventsJob: Job? = null
    private var projectionJob: Job? = null

    // --- State WebRTC (Command 003) ---
    private var iceServers: List<IceServerDto> = emptyList()
    private var webRtcClient: WebRtcClient? = null
    private var activeSessionId: String? = null
    /** Jenis sesi aktif: "screen" atau "camera". */
    private var activeSessionKind: String = "screen"
    /** True bila MediaProjection pernah berhasil di sesi ini (izin layar). */
    private var screenGranted: Boolean = false

    private val rtcListener = object : WebRtcClient.Listener {
        override fun onLocalIceCandidate(candidate: IceCandidateDto) {
            val sessionId = activeSessionId ?: return
            signaling?.sendIce(sessionId, candidate)
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            // Callback WebRTC datang dari thread internal — post ke Main.
            viewModelScope.launch { updatePaired { it.copy(iceText = iceTextFor(state)) } }
        }

        // Agent tidak menerima video masuk.
        override fun onRemoteVideoTrack(track: VideoTrack) = Unit

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) {
                viewModelScope.launch { updatePaired { it.copy(iceText = "ICE: failed") } }
            }
        }

        // Command 005/006: pesan remote control dari Controller dieksekusi
        // lewat PrataAccessibilityService (bila aktif). Tanpa layanan itu,
        // perintah ditolak dengan jujur dan hanya dicatat ke Logcat.
        override fun onControlMessage(message: String) {
            try {
                val obj = JSONObject(message)
                when (obj.optString("action")) {
                    "tap" -> {
                        val x = obj.optDouble("x", Double.NaN).toFloat()
                        val y = obj.optDouble("y", Double.NaN).toFloat()
                        if (x.isNaN() || y.isNaN()) {
                            android.util.Log.w("PRATA-DATACHANNEL", "Tap tanpa koordinat: $message")
                            return
                        }
                        val ok = AccessibilityController.performTap(x, y)
                        android.util.Log.i(
                            "PRATA-DATACHANNEL",
                            "tap x=$x y=$y -> ${if (ok) "dieksekusi" else "ditolak (layanan aksesibilitas belum aktif)"}",
                        )
                    }
                    "swipe" -> {
                        val startX = obj.optDouble("startX", Double.NaN).toFloat()
                        val startY = obj.optDouble("startY", Double.NaN).toFloat()
                        val endX = obj.optDouble("endX", Double.NaN).toFloat()
                        val endY = obj.optDouble("endY", Double.NaN).toFloat()
                        val duration = obj.optLong("duration", 300)
                        if (startX.isNaN() || startY.isNaN() || endX.isNaN() || endY.isNaN()) {
                            android.util.Log.w("PRATA-DATACHANNEL", "Swipe tanpa koordinat: $message")
                            return
                        }
                        val ok = AccessibilityController.performSwipe(startX, startY, endX, endY, duration)
                        android.util.Log.i(
                            "PRATA-DATACHANNEL",
                            "swipe ($startX,$startY)->($endX,$endY) ${duration}ms -> ${if (ok) "dieksekusi" else "ditolak (layanan aksesibilitas belum aktif)"}",
                        )
                    }
                    "text" -> {
                        if (!obj.has("text")) {
                            android.util.Log.w("PRATA-DATACHANNEL", "Text tanpa isi: $message")
                            return
                        }
                        val text = obj.optString("text")
                        val ok = AccessibilityController.setText(text)
                        android.util.Log.i(
                            "PRATA-DATACHANNEL",
                            "text ${text.length} karakter -> ${if (ok) "diisi" else "ditolak (tidak ada node input fokus / layanan belum aktif)"}",
                        )
                    }
                    "key" -> {
                        when (obj.optString("code")) {
                            "ENTER" -> {
                                val ok = AccessibilityController.pressEnter()
                                android.util.Log.i(
                                    "PRATA-DATACHANNEL",
                                    "key ENTER -> ${if (ok) "dieksekusi" else "ditolak (tidak ada node input fokus / layanan belum aktif)"}",
                                )
                            }
                            else -> android.util.Log.w(
                                "PRATA-DATACHANNEL",
                                "Kode tombol tidak didukung: $message",
                            )
                        }
                    }
                    // FINAL (Bagian 3): aksi global OS via AccessibilityService.
                    "global" -> {
                        val name = obj.optString("name")
                        val ok = AccessibilityController.performGlobal(name)
                        android.util.Log.i("PRATA-DATACHANNEL", "global $name -> ${if (ok) "dieksekusi" else "ditolak"}")
                    }
                    // FINAL (Bagian 3): volume via AudioManager.
                    "volume" -> {
                        val audio = getApplication<Application>().getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                        val volName = obj.optString("name")
                        when (volName) {
                            "UP" -> audio?.adjustVolume(AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                            "DOWN" -> audio?.adjustVolume(AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                            "MUTE" -> audio?.adjustVolume(AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
                            else -> android.util.Log.w("PRATA-DATACHANNEL", "Aksi volume tidak dikenal: $volName")
                        }
                    }
                    // FINAL (Bagian 3): kualitas stream dinamis.
                    "quality" -> {
                        val preset = when (obj.optString("preset")) {
                            "low" -> StreamQuality.LOW
                            "high" -> StreamQuality.HIGH
                            else -> StreamQuality.MEDIUM
                        }
                        val ok = webRtcClient?.setQuality(preset) ?: false
                        android.util.Log.i("PRATA-DATACHANNEL", "quality ${preset.name} -> ${if (ok) "diterapkan" else "ditolak (stream belum jalan)"}")
                    }
                    // FINAL (Bagian 3): pengukuran latensi — jawab pong.
                    "ping" -> {
                        val t = obj.optLong("t", 0)
                        webRtcClient?.sendControlMessage(
                            JSONObject().put("action", "pong").put("t", t).toString(),
                        )
                    }
                    // FINAL (Bagian 5): ambil foto dari frame stream -> SAF.
                    "photo" -> {
                        viewModelScope.launch(Dispatchers.IO) {
                            val bytes = webRtcClient?.takePhotoJpeg()
                            if (bytes == null) {
                                webRtcClient?.sendControlMessage(
                                    JSONObject().put("action", "photo-result").put("ok", false).put("error", "no-frame").toString(),
                                )
                                return@launch
                            }
                            val app = getApplication<Application>()
                            val treeUri = SafFolderStore(app).treeUri
                            if (treeUri == null) {
                                webRtcClient?.sendControlMessage(
                                    JSONObject().put("action", "photo-result").put("ok", false).put("error", "saf-folder-not-granted").toString(),
                                )
                                return@launch
                            }
                            try {
                                val name = "prata-foto-${System.currentTimeMillis()}.jpg"
                                val saved = FileBrowser.saveIncomingFile(app, treeUri, null, name, "image/jpeg", bytes.inputStream())
                                webRtcClient?.sendControlMessage(
                                    JSONObject().put("action", "photo-result").put("ok", true).put("fileName", saved).toString(),
                                )
                            } catch (e: Exception) {
                                webRtcClient?.sendControlMessage(
                                    JSONObject().put("action", "photo-result").put("ok", false).put("error", e.message ?: "gagal-menyimpan-foto").toString(),
                                )
                            }
                        }
                    }
                    // FINAL (Bagian 3): sinkronisasi clipboard (eksplisit).
                    "clipboard_get" -> {
                        val text = AccessibilityController.getClipboard()
                        webRtcClient?.sendControlMessage(
                            JSONObject().put("action", "clipboard").put("text", text ?: JSONObject.NULL).toString(),
                        )
                    }
                    "clipboard_set" -> {
                        val text = obj.optString("text")
                        val ok = AccessibilityController.setClipboard(text)
                        webRtcClient?.sendControlMessage(
                            JSONObject().put("action", "clipboard-set-result").put("ok", ok).toString(),
                        )
                    }
                    else -> android.util.Log.w("PRATA-DATACHANNEL", "Aksi tidak dikenal: $message")
                }
            } catch (_: Exception) {
                android.util.Log.w("PRATA-DATACHANNEL", "Pesan bukan JSON valid: $message")
            }
        }
    }

    private fun iceTextFor(state: PeerConnection.IceConnectionState): String = when (state) {
        PeerConnection.IceConnectionState.NEW -> "ICE: baru"
        PeerConnection.IceConnectionState.CHECKING -> "ICE: connecting…"
        PeerConnection.IceConnectionState.CONNECTED -> "ICE: connected"
        PeerConnection.IceConnectionState.COMPLETED -> "ICE: connected"
        PeerConnection.IceConnectionState.DISCONNECTED -> "ICE: disconnected"
        PeerConnection.IceConnectionState.FAILED -> "ICE: failed"
        PeerConnection.IceConnectionState.CLOSED -> "ICE: ditutup"
    }

    private fun updatePaired(transform: (AgentUiState.Paired) -> AgentUiState.Paired) {
        val current = _uiState.value
        if (current is AgentUiState.Paired) _uiState.value = transform(current)
    }

    init {
        val token = tokenStore.agentToken
        val deviceId = tokenStore.deviceId
        // Status layanan aksesibilitas diikuti seumur ViewModel (bukan per
        // enterPaired) agar indikator dashboard selalu benar.
        viewModelScope.launch {
            AccessibilityController.isEnabled.collect { enabled ->
                updatePaired { it.copy(a11yEnabled = enabled) }
                reportPermissions()
            }
        }
        // Status Notification Listener diikuti seumur ViewModel.
        viewModelScope.launch {
            PrataNotificationListenerService.isEnabled.collect { enabled ->
                updatePaired { it.copy(notifEnabled = enabled) }
                reportPermissions()
            }
        }
        if (!token.isNullOrBlank() && !deviceId.isNullOrBlank()) {
            enterPaired(deviceId)
        } else {
            requestPairing()
        }
    }

    fun onServerUrlChanged(newUrl: String) {
        _serverUrl.value = newUrl
    }

    fun saveServerUrl() {
        val url = _serverUrl.value.trim().trimEnd('/')
        if (url.isEmpty()) return
        serverConfig.serverUrl = url
        // Alamat server berubah -> koneksi lama tidak berlaku; minta pairing ulang.
        stopLoops()
        signaling?.disconnect()
        if (tokenStore.hasAgentToken) {
            enterPaired(tokenStore.deviceId ?: return)
        } else {
            requestPairing()
        }
    }

    fun requestPairing() {
        stopLoops()
        _uiState.value = AgentUiState.Loading
        viewModelScope.launch {
            val api = RetrofitClient.api(serverConfig.serverUrl)
            val result = RetrofitClient.safeCall {
                api.pairingInit(
                    PairingInitRequest(
                        deviceName = Build.MODEL,
                        deviceModel = Build.MODEL,
                        manufacturer = Build.MANUFACTURER,
                        androidVersion = Build.VERSION.RELEASE,
                        agentVersion = "0.1.0",
                    ),
                )
            }
            when (result) {
                is ApiResult.Ok -> {
                    pairingId = result.value.pairingId
                    pairingCode = result.value.pairingCode
                    _uiState.value = AgentUiState.Unpaired(
                        pairingCode = result.value.pairingCode,
                        qrPayload = result.value.qrPayload,
                        secondsLeft = result.value.expiresInSec,
                        isPolling = true,
                        error = null,
                    )
                    startCountdown(result.value.expiresInSec)
                    startPolling()
                }
                is ApiResult.Err -> {
                    _uiState.value = AgentUiState.Unpaired(
                        pairingCode = "",
                        qrPayload = "",
                        secondsLeft = 0,
                        isPolling = false,
                        error = result.message,
                    )
                }
            }
        }
    }

    fun refreshPairing() = requestPairing()

    private fun startCountdown(seconds: Int) {
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            var left = seconds
            while (left > 0) {
                delay(1000)
                left -= 1
                val current = _uiState.value
                if (current is AgentUiState.Unpaired) {
                    _uiState.value = current.copy(secondsLeft = left)
                } else {
                    break
                }
            }
            // Kode habis -> minta kode baru otomatis.
            if (_uiState.value is AgentUiState.Unpaired) requestPairing()
        }
    }

    private fun startPolling() {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (true) {
                delay(3000)
                val id = pairingId ?: break
                val code = pairingCode ?: break
                val api = RetrofitClient.api(serverConfig.serverUrl)
                val result = RetrofitClient.safeCall { api.pairingPoll(PairingPollRequest(id, code)) }
                if (result is ApiResult.Ok) {
                    val poll = result.value
                    if (poll.status == "consumed" && !poll.agentToken.isNullOrBlank() && !poll.deviceId.isNullOrBlank()) {
                        tokenStore.agentToken = poll.agentToken
                        tokenStore.deviceId = poll.deviceId
                        stopLoops()
                        enterPaired(poll.deviceId)
                        break
                    }
                    if (poll.status == "expired" || poll.status == "revoked") {
                        requestPairing()
                        break
                    }
                }
            }
        }
    }

    private fun enterPaired(deviceId: String) {
        stopLoops()
        // Pertahankan status berbagi layar bila enterPaired dipanggil ulang
        // saat sharing sedang berjalan (mis. ganti alamat server / mulai lagi).
        val previous = _uiState.value as? AgentUiState.Paired
        val app = getApplication<Application>()
        _uiState.value = AgentUiState.Paired(
            deviceId = deviceId,
            wsState = ConnectionState.Connecting,
            running = true,
            error = null,
            sharing = previous?.sharing ?: SharingState.Off,
            iceText = previous?.iceText,
            a11yEnabled = AccessibilityController.isEnabled.value,
            safFolderName = SafFolderStore(app).treeUri?.lastPathSegment?.takeLast(40),
            notifEnabled = PrataNotificationListenerService.isEnabled.value,
            camera = previous?.camera ?: SharingState.Off,
            cameraFacing = previous?.cameraFacing ?: "back",
        )
        AgentForegroundService.start(getApplication())
        val token = tokenStore.agentToken ?: return
        val client = freshSignaling()
        client.connectAsAgent(deviceId, token)
        // Command 007: daftarkan pengirim metrik — loop di Foreground
        // Service memanggilnya tiap 15 detik; kirim hanya saat WS terhubung
        // (dicek di sendDeviceMetrics). Dicabut di stopLoops/stopAgent.
        AgentMetricsBridge.registerSender { metrics ->
            client.sendDeviceMetrics(metrics)
        }
        // FINAL (Bagian 4): daftarkan pengirim notifikasi perangkat.
        NotificationBridge.sender = { obj ->
            client.sendDeviceNotification(
                obj.optString("packageName"),
                obj.optString("appName"),
                if (obj.isNull("title")) null else obj.optString("title"),
                if (obj.isNull("text")) null else obj.optString("text"),
                obj.optString("at"),
            )
        }
        wsCollectJob?.cancel()
        wsCollectJob = viewModelScope.launch {
            client.connectionState.collect { wsState ->
                val current = _uiState.value
                if (current is AgentUiState.Paired) {
                    _uiState.value = current.copy(wsState = wsState)
                }
            }
        }
        eventsJob?.cancel()
        eventsJob = viewModelScope.launch {
            client.events.collect { event ->
                when (event) {
                    is SignalingEvent.Welcome -> {
                        iceServers = event.iceServers
                        reportPermissions()
                    }
                    is SignalingEvent.SessionRequest -> handleSessionRequest(event)
                    is SignalingEvent.FileListRequest -> handleFileListRequest(event)
                    is SignalingEvent.FileMkdirRequest -> handleFileOpRequest(event)
                    is SignalingEvent.FileRenameRequest -> handleFileOpRequest(event)
                    is SignalingEvent.FileDeleteRequest -> handleFileOpRequest(event)
                    is SignalingEvent.FileDownloadRequest -> handleFileDownloadRequest(event)
                    is SignalingEvent.FileUploadReady -> handleFileUploadReady(event)
                    is SignalingEvent.AppListRequest -> handleAppListRequest(event)
                    is SignalingEvent.AppCommandRequest -> handleAppCommandRequest(event)
                    is SignalingEvent.Answer -> {
                        if (event.sessionId == activeSessionId) {
                            val sdp = parseSdp(event.payload)
                            if (sdp != null) webRtcClient?.setRemoteDescription(sdp)
                        }
                    }
                    is SignalingEvent.Ice -> {
                        if (event.sessionId == activeSessionId) {
                            val candidate = parseIce(event.payload)
                            if (candidate != null) webRtcClient?.addIceCandidate(candidate)
                        }
                    }
                    is SignalingEvent.SessionEnded -> {
                        if (event.sessionId == activeSessionId) endActiveSession()
                    }
                    is SignalingEvent.SessionRejected -> {
                        if (event.sessionId == activeSessionId) endActiveSession()
                    }
                    else -> Unit
                }
            }
        }
    }

    fun startAgent() {
        val deviceId = tokenStore.deviceId ?: return
        enterPaired(deviceId)
    }

    fun stopAgent() {
        if ((_uiState.value as? AgentUiState.Paired)?.sharing != SharingState.Off) {
            stopScreenShare()
        }
        if ((_uiState.value as? AgentUiState.Paired)?.camera != SharingState.Off) {
            stopCameraSession()
        }
        AgentMetricsBridge.unregisterSender()
        NotificationBridge.sender = null
        signaling?.disconnect()
        AgentForegroundService.stop(getApplication())
        val current = _uiState.value
        if (current is AgentUiState.Paired) {
            _uiState.value = current.copy(wsState = ConnectionState.Disconnected, running = false)
        }
    }

    // --- Berbagi layar (Command 003) ---

    /** Dipanggil Activity sesudah user menyetujui dialog tangkap layar. */
    fun onScreenCaptureResult(resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK || data == null) {
            updatePaired { it.copy(sharing = SharingState.Failed("Izin berbagi layar ditolak.")) }
            return
        }
        AgentForegroundService.startStream(getApplication(), resultCode, data)
        updatePaired { it.copy(sharing = SharingState.WaitingProjection) }
        startProjectionCollection()
    }

    /** Dipanggil Activity bila user membatalkan / menolak dialog sistem. */
    fun onScreenCaptureDenied() {
        updatePaired { it.copy(sharing = SharingState.Failed("Izin berbagi layar ditolak.")) }
    }

    private fun startProjectionCollection() {
        projectionJob?.cancel()
        projectionJob = viewModelScope.launch {
            MediaProjectionHolder.projection.collect { projection ->
                if (projection == null) return@collect
                if (webRtcClient != null) return@collect
                try {
                    val capturer = ScreenCapturerAndroid(
                        projection,
                        object : MediaProjection.Callback() {
                            override fun onStop() {
                                viewModelScope.launch { stopScreenShare() }
                            }
                        },
                    )
                    val client = WebRtcClient(
                        getApplication(),
                        iceServers.ifEmpty { defaultIceServers() },
                        rtcListener,
                    )
                    webRtcClient = client
                    // DataChannel dibuat SEBELUM offer pertama agar
                    // dinegosiasikan di SDP (hanya offerer yang membuat).
                    client.createControlChannel()
                    client.attachScreenCapturer(capturer)
                    screenGranted = true
                    reportPermissions()
                    updatePaired { it.copy(sharing = SharingState.On) }
                } catch (e: Exception) {
                    updatePaired {
                        it.copy(sharing = SharingState.Failed("Gagal memulai tangkap layar: ${e.message}"))
                    }
                }
            }
        }
    }

    private fun handleSessionRequest(event: SignalingEvent.SessionRequest) {
        when (event.sessionType) {
            "screen" -> {
                if (activeSessionId != null) {
                    signaling?.rejectSession(event.sessionId, "session-busy")
                    return
                }
                val current = _uiState.value as? AgentUiState.Paired
                if (current == null || current.sharing != SharingState.On) {
                    signaling?.rejectSession(event.sessionId, "screen-sharing-off")
                    return
                }
                signaling?.acceptSession(event.sessionId)
                startPeerConnectionForSession(event.sessionId)
            }
            "camera", "camera-front", "camera-back" -> {
                if (activeSessionId != null) {
                    signaling?.rejectSession(event.sessionId, "session-busy")
                    return
                }
                startCameraSession(event.sessionId, event.sessionType)
            }
            else -> signaling?.rejectSession(event.sessionId, "unsupported-session-type")
        }
    }

    private fun startPeerConnectionForSession(sessionId: String) {
        val client = webRtcClient
        if (client == null) {
            signaling?.rejectSession(sessionId, "screen-sharing-not-ready")
            return
        }
        activeSessionId = sessionId
        viewModelScope.launch {
            try {
                val offer = client.createOffer()
                signaling?.sendOffer(sessionId, offer)
            } catch (e: Exception) {
                activeSessionId = null
                updatePaired {
                    it.copy(sharing = SharingState.Failed("Gagal membuat offer: ${e.message}"))
                }
                signaling?.rejectSession(sessionId, "offer-failed")
            }
        }
    }

    /** Sesi WebRTC berakhir (dari controller / ditolak) — proyeksi tetap jalan. */
    private fun endActiveSession() {
        if (activeSessionKind == "camera") {
            AgentForegroundService.stopCamera(getApplication())
            updatePaired { it.copy(camera = SharingState.Off, iceText = null) }
        } else {
            updatePaired { it.copy(iceText = null) }
        }
        disposeWebRtc()
        activeSessionId = null
        activeSessionKind = "screen"
    }

    // --- Sesi kamera (FINAL, Bagian 5) ---

    private fun startCameraSession(sessionId: String, sessionType: String) {
        val app = getApplication<Application>()
        val front = sessionType == "camera-front"
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            updatePaired { it.copy(camera = SharingState.Failed("Izin kamera belum diberikan di Agent.")) }
            signaling?.rejectSession(sessionId, "camera-permission-missing")
            return
        }
        AgentForegroundService.startCamera(app)
        try {
            val enumerator = Camera2Enumerator(app)
            val deviceName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) == front }
            val capturer: CameraVideoCapturer? = deviceName?.let { enumerator.createCapturer(it, null) }
            if (capturer == null) {
                AgentForegroundService.stopCamera(app)
                updatePaired { it.copy(camera = SharingState.Failed("Kamera ${if (front) "depan" else "belakang"} tidak ditemukan.")) }
                signaling?.rejectSession(sessionId, "camera-not-found")
                return
            }
            val client = WebRtcClient(app, iceServers.ifEmpty { defaultIceServers() }, rtcListener)
            webRtcClient = client
            client.createControlChannel()
            client.attachCapturer(capturer, 1280, 720, 24)
            activeSessionId = sessionId
            activeSessionKind = "camera"
            updatePaired { it.copy(camera = SharingState.On, cameraFacing = if (front) "front" else "back") }
            signaling?.acceptSession(sessionId)
            viewModelScope.launch {
                try {
                    val offer = client.createOffer()
                    signaling?.sendOffer(sessionId, offer)
                } catch (e: Exception) {
                    stopCameraSession()
                    signaling?.endSession(sessionId, "offer-failed")
                }
            }
        } catch (e: Exception) {
            AgentForegroundService.stopCamera(app)
            updatePaired { it.copy(camera = SharingState.Failed("Gagal memulai kamera: ${e.message}")) }
            signaling?.rejectSession(sessionId, "camera-failed")
        }
    }

    /** Hentikan sesi kamera (dari Agent / controller / error offer). */
    fun stopCameraSession() {
        if (activeSessionKind != "camera" && webRtcClient == null) return
        AgentForegroundService.stopCamera(getApplication())
        disposeWebRtc()
        activeSessionId?.let { signaling?.endSession(it, "camera-stopped") }
        activeSessionId = null
        activeSessionKind = "screen"
        updatePaired { it.copy(camera = SharingState.Off, iceText = null) }
    }

    fun stopScreenShare() {
        val current = _uiState.value as? AgentUiState.Paired
        if (current?.sharing == SharingState.Off && webRtcClient == null && activeSessionId == null) return
        AgentForegroundService.stopStream(getApplication())
        disposeWebRtc()
        activeSessionId?.let { signaling?.endSession(it, "screen-share-stopped") }
        activeSessionId = null
        projectionJob?.cancel()
        updatePaired { it.copy(sharing = SharingState.Off, iceText = null) }
    }

    private fun disposeWebRtc() {
        try {
            webRtcClient?.dispose()
        } catch (_: Exception) {
        }
        webRtcClient = null
    }

    private fun parseSdp(json: String): SdpDto? {
        return try {
            val obj = JSONObject(json)
            SdpDto(type = obj.getString("type"), sdp = obj.getString("sdp"))
        } catch (_: Exception) {
            null
        }
    }

    private fun parseIce(json: String): IceCandidateDto? {
        return try {
            val obj = JSONObject(json)
            IceCandidateDto(
                sdpMid = obj.optString("sdpMid").ifEmpty { null },
                sdpMLineIndex = obj.getInt("sdpMLineIndex"),
                candidate = obj.getString("candidate"),
            )
        } catch (_: Exception) {
            null
        }
    }

    // --- File Manager SAF (FINAL, Bagian 2) ---

    private fun handleFileListRequest(event: SignalingEvent.FileListRequest) {
        viewModelScope.launch(Dispatchers.IO) {
            val app = getApplication<Application>()
            val treeUri = SafFolderStore(app).treeUri
            if (treeUri == null) {
                signaling?.sendFileListResponse(event.requestId, emptyList(), "saf-folder-not-granted")
                return@launch
            }
            try {
                val items = FileBrowser.listFolder(app, treeUri, event.docId)
                signaling?.sendFileListResponse(event.requestId, items)
            } catch (e: Exception) {
                signaling?.sendFileListResponse(event.requestId, emptyList(), e.message ?: "gagal-membaca-folder")
            }
        }
    }

    private fun handleFileOpRequest(event: SignalingEvent) {
        val requestId = when (event) {
            is SignalingEvent.FileMkdirRequest -> event.requestId
            is SignalingEvent.FileRenameRequest -> event.requestId
            is SignalingEvent.FileDeleteRequest -> event.requestId
            else -> return
        }
        viewModelScope.launch(Dispatchers.IO) {
            val app = getApplication<Application>()
            val treeUri = SafFolderStore(app).treeUri
            if (treeUri == null) {
                signaling?.sendFileOpResponse(requestId, false, "saf-folder-not-granted")
                return@launch
            }
            try {
                when (event) {
                    is SignalingEvent.FileMkdirRequest -> FileBrowser.mkdir(app, treeUri, event.parentDocId, event.name)
                    is SignalingEvent.FileRenameRequest -> FileBrowser.rename(app, treeUri, event.docId, event.newName)
                    is SignalingEvent.FileDeleteRequest -> FileBrowser.delete(app, treeUri, event.docId)
                    else -> return@launch
                }
                signaling?.sendFileOpResponse(requestId, true)
            } catch (e: Exception) {
                signaling?.sendFileOpResponse(requestId, false, e.message ?: "operasi-file-gagal")
            }
        }
    }

    private fun handleFileDownloadRequest(event: SignalingEvent.FileDownloadRequest) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val app = getApplication<Application>()
                val treeUri = SafFolderStore(app).treeUri
                if (treeUri == null) {
                    android.util.Log.w("PRATA-FILE", "Unggah blob ditolak: folder SAF belum dipilih.")
                    return@launch
                }
                val input = FileBrowser.openInputStream(app, treeUri, event.docId)
                if (input == null) {
                    android.util.Log.w("PRATA-FILE", "Unggah blob ditolak: file tidak ditemukan ${event.docId}.")
                    return@launch
                }
                val body = object : RequestBody() {
                    override fun contentType() = "application/octet-stream".toMediaType()
                    override fun writeTo(sink: BufferedSink) {
                        input.use { it.copyTo(sink.outputStream()) }
                    }
                }
                val result = RetrofitClient.safeCall {
                    RetrofitClient.api(serverConfig.serverUrl)
                        .uploadBlob("Bearer ${tokenStore.agentToken}", event.transferId, body)
                }
                android.util.Log.i("PRATA-FILE", "upload blob ${event.transferId} -> $result")
            } catch (e: Exception) {
                android.util.Log.w("PRATA-FILE", "Gagal mengunggah blob: ${e.message}")
            }
        }
    }

    private fun handleFileUploadReady(event: SignalingEvent.FileUploadReady) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val app = getApplication<Application>()
                val api = RetrofitClient.api(serverConfig.serverUrl)
                val resp = api.downloadBlob("Bearer ${tokenStore.agentToken}", event.transferId)
                if (!resp.isSuccessful || resp.body() == null) {
                    signaling?.sendFileTransferDone(event.transferId, false, "unduh-blob-gagal-http-${resp.code()}")
                    return@launch
                }
                val treeUri = SafFolderStore(app).treeUri
                if (treeUri == null) {
                    signaling?.sendFileTransferDone(event.transferId, false, "saf-folder-not-granted")
                    return@launch
                }
                val savedName = resp.body()!!.byteStream().use { input ->
                    FileBrowser.saveIncomingFile(app, treeUri, event.docId, event.fileName, event.mimeType, input)
                }
                signaling?.sendFileTransferDone(event.transferId, true)
                android.util.Log.i("PRATA-FILE", "File kiriman tersimpan: $savedName")
            } catch (e: Exception) {
                signaling?.sendFileTransferDone(event.transferId, false, e.message ?: "gagal-menyimpan-file")
            }
        }
    }

    // --- App Manager (FINAL, Bagian 3) ---

    private fun handleAppListRequest(event: SignalingEvent.AppListRequest) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val apps = AppManager.listInstalledApps(getApplication())
                signaling?.sendAppListResponse(event.requestId, apps)
            } catch (e: Exception) {
                signaling?.sendAppListResponse(event.requestId, emptyList(), e.message ?: "gagal-membaca-aplikasi")
            }
        }
    }

    private fun handleAppCommandRequest(event: SignalingEvent.AppCommandRequest) {
        viewModelScope.launch(Dispatchers.IO) {
            val app = getApplication<Application>()
            val ok = try {
                when (event.command) {
                    "open" -> AppManager.openApp(app, event.packageName)
                    "settings" -> AppManager.openAppSettings(app, event.packageName)
                    "uninstall" -> AppManager.uninstallApp(app, event.packageName)
                    else -> false
                }
            } catch (_: Exception) {
                false
            }
            signaling?.sendAppCommandResponse(event.requestId, ok, if (ok) null else "perintah-gagal")
        }
    }

    // --- SAF / Notifikasi / Izin (FINAL) ---

    /** Dipanggil Activity sesudah user memilih folder lewat picker sistem. */
    fun onSafFolderPicked(uri: android.net.Uri) {
        val app = getApplication<Application>()
        try {
            app.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            android.util.Log.w("PRATA-SAF", "takePersistableUriPermission gagal: ${e.message}")
        }
        SafFolderStore(app).treeUri = uri
        updatePaired { it.copy(safFolderName = uri.lastPathSegment?.takeLast(40) ?: "Folder terpilih") }
        reportPermissions()
    }

    /** Buka Pengaturan Notification Listener sistem (aktivasi manual). */
    fun openNotificationSettings() {
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        getApplication<Application>().startActivity(intent)
    }

    /** Buka Pengaturan Aksesibilitas sistem (aktivasi manual oleh user). */
    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        getApplication<Application>().startActivity(intent)
    }

    /** Dipanggil Activity sesudah hasil permintaan izin kamera. */
    fun onCameraPermissionResult(granted: Boolean) {
        if (!granted) {
            updatePaired { it.copy(camera = SharingState.Failed("Izin kamera ditolak.")) }
        }
        reportPermissions()
    }

    /** Laporkan status izin fitur Agent ke server (FINAL, Bagian 1). */
    private fun reportPermissions() {
        val app = getApplication<Application>()
        val client = signaling ?: return
        val perms = listOf(
            "screen" to screenGranted,
            "accessibility" to AccessibilityController.isEnabled.value,
            "saf" to SafFolderStore(app).hasFolder(),
            "notification" to NotificationManagerCompat.getEnabledListenerPackages(app).contains(app.packageName),
            "camera" to (ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED),
        )
        client.sendPermissionReport(perms)
    }

    private fun stopLoops() {
        AgentMetricsBridge.unregisterSender()
        NotificationBridge.sender = null
        pollJob?.cancel()
        countdownJob?.cancel()
        wsCollectJob?.cancel()
        eventsJob?.cancel()
    }

    override fun onCleared() {
        stopLoops()
        projectionJob?.cancel()
        disposeWebRtc()
        signaling?.disconnect()
        super.onCleared()
    }
}
