package com.prata.remote.controller

// PRATA Remote — ViewModel Remote Control Controller (Command 004 + FINAL)
// Peran penerima WebRTC: kirim session-request "screen"/"camera-front"/
// "camera-back" -> terima webrtc_offer dari Agent -> setRemoteDescription ->
// createAnswer -> kirim webrtc_answer. Video masuk dirender
// SurfaceViewRenderer dengan EGL context yang SAMA dari WebRtcClient
// (jangan buat EglBase kedua). Tap pada video dikirim sebagai JSON
// {"action":"tap","x":..,"y":..} lewat DataChannel "prata_control"
// (koordinat ternormalisasi 0..1). Server FINAL mendukung beberapa
// koneksi WS per user (Map<userId, Set<socket>>); satu sesi remote
// tetap satu per perangkat pada satu waktu.
import android.app.Application
import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.prata.remote.shared.model.AppInfoDto
import com.prata.remote.shared.model.DeviceMetrics
import com.prata.remote.shared.model.FileItemDto
import com.prata.remote.shared.model.IceCandidateDto
import com.prata.remote.shared.model.IceServerDto
import com.prata.remote.shared.model.SdpDto
import com.prata.remote.shared.model.defaultIceServers
import com.prata.remote.shared.network.ApiResult
import com.prata.remote.shared.network.RetrofitClient
import com.prata.remote.shared.security.TokenStore
import com.prata.remote.shared.signaling.ConnectionState
import com.prata.remote.shared.signaling.SignalingClient
import com.prata.remote.shared.signaling.SignalingEvent
import com.prata.remote.shared.util.ServerConfig
import com.prata.remote.shared.webrtc.WebRtcClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import org.webrtc.EglBase
import org.webrtc.PeerConnection
import org.webrtc.VideoTrack
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

enum class RemoteStatus {
    Connecting,
    WaitingOffer,
    WaitingIce,
    Connected,
    Failed,
    Ended,
}

data class FilesUiState(
    val currentDocId: String? = null,
    val path: List<Pair<String, String>> = emptyList(),
    val items: List<FileItemDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val downloading: String? = null,
    val uploadStatus: String? = null,
    val opStatus: String? = null,
)

data class AppsUiState(
    val apps: List<AppInfoDto> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val statusText: String? = null,
    val systemOnly: Boolean = false,
)

data class RemoteControlUiState(
    val deviceName: String,
    val status: RemoteStatus = RemoteStatus.Connecting,
    val statusText: String = "Menghubungkan ke server…",
    val remoteVideoTrack: VideoTrack? = null,
    val error: String? = null,
    // Command 007: metrik terakhir dari Agent (null = belum ada).
    val metrics: DeviceMetrics? = null,
    val metricsUpdatedAt: Long? = null,
    // FINAL: File Manager, App Manager, Notifikasi, aksi cepat, kualitas.
    val files: FilesUiState = FilesUiState(),
    val apps: AppsUiState = AppsUiState(),
    val notifications: List<SignalingEvent.DeviceNotificationReceived> = emptyList(),
    val automationAlerts: List<SignalingEvent.AutomationAlertReceived> = emptyList(),
    val latencyMs: Long? = null,
    val quality: String = "medium",
    val sessionKind: String = "screen",
    val clipboardText: String? = null,
    val photoStatus: String? = null,
)

class RemoteControlViewModel(
    application: Application,
    private val deviceId: String,
    deviceName: String,
) : AndroidViewModel(application) {
    private val tokenStore = TokenStore(application)
    private val serverConfig = ServerConfig(application)

    private val _uiState = MutableStateFlow(RemoteControlUiState(deviceName = deviceName))
    val uiState: StateFlow<RemoteControlUiState> = _uiState.asStateFlow()

    private val _eglContext = MutableStateFlow<EglBase.Context?>(null)
    val eglContext: StateFlow<EglBase.Context?> = _eglContext.asStateFlow()

    private var signaling: SignalingClient? = null
    private var webRtcClient: WebRtcClient? = null
    private var sessionId: String? = null
    private var iceServers: List<IceServerDto> = emptyList()
    private var eventsJob: Job? = null
    private var connectionJob: Job? = null
    private var pingJob: Job? = null
    // FINAL: jenis sesi aktif ("screen" | "camera-front" | "camera-back").
    private var sessionType: String = "screen"
    private var pendingFileListRequestId: String? = null
    private var pendingFileOpRequestId: String? = null
    private var pendingAppListRequestId: String? = null
    private var pendingAppCommandRequestId: String? = null
    private var lastSentText: String? = null

    // Listener WebRTC dipanggil dari thread internal WebRTC — semua
    // perubahan state UI dipost ke Main lewat viewModelScope.launch.
    private val rtcListener = object : WebRtcClient.Listener {
        override fun onLocalIceCandidate(candidate: IceCandidateDto) {
            val id = sessionId ?: return
            signaling?.sendIce(id, candidate)
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            viewModelScope.launch {
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        updateState {
                            it.copy(
                                status = RemoteStatus.Connected,
                                statusText = "Terhubung — menampilkan layar Agent",
                            )
                        }
                        startPingLoop()
                    }
                    PeerConnection.IceConnectionState.FAILED -> updateState {
                        it.copy(
                            status = RemoteStatus.Failed,
                            statusText = "Koneksi ICE gagal.",
                            error = "Koneksi ICE gagal.",
                        )
                    }
                    PeerConnection.IceConnectionState.CHECKING ->
                        updateState { it.copy(statusText = "ICE: connecting…") }
                    PeerConnection.IceConnectionState.DISCONNECTED ->
                        updateState { it.copy(statusText = "ICE: disconnected") }
                    else -> Unit
                }
            }
        }

        override fun onRemoteVideoTrack(track: VideoTrack) {
            viewModelScope.launch {
                updateState { it.copy(remoteVideoTrack = track) }
            }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            if (state == PeerConnection.PeerConnectionState.FAILED) {
                viewModelScope.launch {
                    updateState {
                        it.copy(
                            status = RemoteStatus.Failed,
                            statusText = "Koneksi peer gagal.",
                            error = "Koneksi peer gagal.",
                        )
                    }
                }
            }
        }

        // FINAL: balasan DataChannel dari Agent — latensi (pong), clipboard,
        // dan hasil ambil foto. Dijalankan dari thread WebRTC -> post ke Main.
        override fun onControlMessage(message: String) {
            viewModelScope.launch {
                try {
                    val obj = JSONObject(message)
                    when (obj.optString("action")) {
                        "pong" -> {
                            val t = obj.optLong("t", 0L)
                            if (t > 0) {
                                updateState { it.copy(latencyMs = System.currentTimeMillis() - t) }
                            }
                        }
                        "clipboard" -> updateState { it.copy(clipboardText = obj.optString("text")) }
                        "clipboard-set-result" -> updateState {
                            it.copy(photoStatus = if (obj.optBoolean("ok", false)) "Clipboard Agent diperbarui." else "Gagal mengatur clipboard Agent.")
                        }
                        "photo-result" -> updateState {
                            it.copy(
                                photoStatus = if (obj.optBoolean("ok", false)) {
                                    "Foto tersimpan di Agent: ${obj.optString("fileName")}"
                                } else {
                                    "Gagal mengambil foto: ${obj.optString("error")}"
                                },
                            )
                        }
                        else -> Unit
                    }
                } catch (_: Exception) {
                }
            }
        }
    }

    init {
        connectAndRequest()
    }

    private fun updateState(transform: (RemoteControlUiState) -> RemoteControlUiState) {
        _uiState.value = transform(_uiState.value)
    }

    /** Sesi kita bila id cocok; bila belum ada sesi, adopsi id ini. */
    private fun isOurSession(id: String): Boolean {
        if (sessionId == null) {
            sessionId = id
            return true
        }
        return sessionId == id
    }

    private fun connectAndRequest() {
        val jwt = tokenStore.jwt
        if (jwt.isNullOrBlank()) {
            updateState {
                it.copy(
                    status = RemoteStatus.Failed,
                    statusText = "Belum login.",
                    error = "Belum login. Masuk dulu dari layar login.",
                )
            }
            return
        }
        updateState {
            it.copy(status = RemoteStatus.Connecting, statusText = "Menghubungkan ke server…", error = null)
        }
        val client = SignalingClient(serverConfig.wsBaseUrl())
        signaling = client
        client.connectAsController(jwt)
        eventsJob?.cancel()
        eventsJob = viewModelScope.launch {
            client.events.collect { event -> handleEvent(event) }
        }
        connectionJob?.cancel()
        connectionJob = viewModelScope.launch {
            client.connectionState.collect { state ->
                if (state is ConnectionState.Error) {
                    updateState {
                        it.copy(
                            status = RemoteStatus.Failed,
                            statusText = "Tidak bisa terhubung ke server.",
                            error = state.message,
                        )
                    }
                }
            }
        }
    }

    private suspend fun handleEvent(event: SignalingEvent) {
        when (event) {
            is SignalingEvent.Welcome -> {
                // Welcome kedua (reconnect) tidak boleh membuat client baru
                // atau meminta sesi kedua.
                if (webRtcClient != null) return
                iceServers = event.iceServers
                val client = WebRtcClient(
                    getApplication(),
                    iceServers.ifEmpty { defaultIceServers() },
                    rtcListener,
                )
                webRtcClient = client
                _eglContext.value = client.eglContext
                // Command 007: watch agar metrik perangkat mengalir ke
                // controller ini tanpa perlu sesi screen streaming.
                signaling?.watch(deviceId)
                signaling?.requestSession(deviceId, sessionType)
                requestFileList()
                requestAppList()
            }
            is SignalingEvent.SessionAccepted -> {
                sessionId = event.sessionId
                updateState {
                    it.copy(status = RemoteStatus.WaitingOffer, statusText = "Menunggu offer dari Agent…")
                }
            }
            is SignalingEvent.Offer -> {
                val client = webRtcClient ?: return
                if (!isOurSession(event.sessionId)) return
                val sdp = parseSdp(event.payload)
                if (sdp == null) {
                    updateState {
                        it.copy(
                            status = RemoteStatus.Failed,
                            statusText = "Offer tidak valid.",
                            error = "Offer dari Agent tidak bisa dibaca.",
                        )
                    }
                    return
                }
                try {
                    val applied = client.setRemoteDescription(sdp)
                    if (!applied) {
                        updateState {
                            it.copy(
                                status = RemoteStatus.Failed,
                                statusText = "Gagal menerapkan offer.",
                                error = "Gagal menerapkan offer dari Agent.",
                            )
                        }
                        return
                    }
                    val answer = client.createAnswer()
                    signaling?.sendAnswer(event.sessionId, answer)
                    updateState {
                        it.copy(status = RemoteStatus.WaitingIce, statusText = "Menunggu koneksi ICE…")
                    }
                } catch (e: Exception) {
                    updateState {
                        it.copy(
                            status = RemoteStatus.Failed,
                            statusText = "Gagal membuat answer.",
                            error = e.message,
                        )
                    }
                }
            }
            is SignalingEvent.Ice -> {
                if (!isOurSession(event.sessionId)) return
                val candidate = parseIce(event.payload) ?: return
                webRtcClient?.addIceCandidate(candidate)
            }
            is SignalingEvent.DeviceMetricsReceived -> {
                // Hanya metrik perangkat yang sedang dilihat.
                if (event.deviceId != deviceId) return
                updateState {
                    it.copy(metrics = event.metrics, metricsUpdatedAt = System.currentTimeMillis())
                }
            }
            is SignalingEvent.SessionRejected -> {
                if (!isOurSession(event.sessionId)) return
                val reason = event.reason
                updateState {
                    it.copy(
                        status = RemoteStatus.Failed,
                        statusText = "Agent menolak sesi.",
                        error = if (reason.isNullOrBlank()) "Agent menolak sesi." else "Agent menolak sesi: $reason",
                    )
                }
            }
            is SignalingEvent.SessionEnded -> {
                if (!isOurSession(event.sessionId)) return
                endRemoteSession()
            }
            is SignalingEvent.FileListResponse -> {
                if (event.requestId != pendingFileListRequestId) return
                pendingFileListRequestId = null
                updateState {
                    val files = it.files
                    it.copy(
                        files = files.copy(
                            items = event.items,
                            loading = false,
                            error = event.error?.let { err ->
                                if (err == "saf-folder-not-granted") {
                                    "Agent belum memilih folder akses — minta pemilik Agent memilih folder di dashboard Agent."
                                } else {
                                    "Gagal memuat folder: $err"
                                }
                            },
                        ),
                    )
                }
            }
            is SignalingEvent.FileOpResponse -> {
                if (event.requestId != pendingFileOpRequestId) return
                pendingFileOpRequestId = null
                updateState {
                    val files = it.files
                    it.copy(
                        files = files.copy(
                            opStatus = if (event.ok) "Operasi file berhasil." else "Operasi file gagal: ${event.error ?: "?"}",
                        ),
                    )
                }
                if (event.ok) refreshFiles()
            }
            is SignalingEvent.FileTransferDone -> {
                updateState {
                    val files = it.files
                    it.copy(
                        files = files.copy(
                            uploadStatus = if (event.ok) "File berhasil dikirim ke Agent." else "Pengiriman file gagal: ${event.error ?: "?"}",
                        ),
                    )
                }
            }
            is SignalingEvent.AppListResponse -> {
                if (event.requestId != pendingAppListRequestId) return
                pendingAppListRequestId = null
                updateState {
                    val apps = it.apps
                    it.copy(
                        apps = apps.copy(
                            apps = event.apps,
                            loading = false,
                            error = event.error?.let { err -> "Gagal memuat aplikasi: $err" },
                        ),
                    )
                }
            }
            is SignalingEvent.AppCommandResponse -> {
                if (event.requestId != pendingAppCommandRequestId) return
                pendingAppCommandRequestId = null
                updateState {
                    val apps = it.apps
                    it.copy(
                        apps = apps.copy(
                            statusText = if (event.ok) "Perintah aplikasi berhasil dikirim." else "Perintah aplikasi gagal: ${event.error ?: "?"}",
                        ),
                    )
                }
            }
            is SignalingEvent.DeviceNotificationReceived -> {
                if (event.deviceId != deviceId) return
                updateState {
                    it.copy(notifications = (listOf(event) + it.notifications).take(100))
                }
            }
            is SignalingEvent.AutomationAlertReceived -> {
                if (event.deviceId != deviceId) return
                updateState {
                    it.copy(automationAlerts = (listOf(event) + it.automationAlerts).take(20))
                }
            }
            is SignalingEvent.Error -> {
                updateState {
                    it.copy(
                        status = RemoteStatus.Failed,
                        statusText = "Kesalahan signaling.",
                        error = event.message,
                    )
                }
            }
            is SignalingEvent.Disconnected -> {
                val current = _uiState.value
                if (current.status != RemoteStatus.Ended && current.status != RemoteStatus.Failed) {
                    updateState { it.copy(statusText = "Koneksi signaling terputus, mencoba lagi…") }
                }
            }
            else -> Unit
        }
    }

    /** Sesi berakhir dari sisi Agent — proyeksi di Agent tetap jalan. */
    private fun endRemoteSession() {
        disposeWebRtc()
        updateState {
            it.copy(status = RemoteStatus.Ended, statusText = "Sesi berakhir.", remoteVideoTrack = null)
        }
    }

    /**
     * Kirim tap lewat DataChannel "prata_control". Koordinat ternormalisasi
     * 0..1 terhadap area tampilan; Agent memetakan ke layarnya sendiri.
     */
    fun sendTap(xNorm: Float, yNorm: Float): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject()
            .put("action", "tap")
            .put("x", xNorm.toDouble())
            .put("y", yNorm.toDouble())
        return client.sendControlMessage(json.toString())
    }

    /** Kirim satu swipe utuh (hanya saat drag selesai — bukan per frame). */
    fun sendSwipe(
        startXNorm: Float,
        startYNorm: Float,
        endXNorm: Float,
        endYNorm: Float,
        durationMs: Long,
    ): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject()
            .put("action", "swipe")
            .put("startX", startXNorm.toDouble())
            .put("startY", startYNorm.toDouble())
            .put("endX", endXNorm.toDouble())
            .put("endY", endYNorm.toDouble())
            .put("duration", durationMs)
        return client.sendControlMessage(json.toString())
    }

    /**
     * Kirim TEKS LENGKAP yang diketik sejauh ini (bukan delta): Agent
     * memakai ACTION_SET_TEXT yang MENGGANTI isi field — jadi teks penuh
     * adalah kontrak yang benar. Backspace bekerja karena teks yang
     * dikirim memendek. Duplikat tidak dikirim ulang.
     */
    fun sendText(text: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        if (text == lastSentText) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "text").put("text", text)
        val ok = client.sendControlMessage(json.toString())
        if (ok) lastSentText = text
        return ok
    }

    /** Kirim tombol khusus, mis. "ENTER". */
    fun sendKey(code: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "key").put("code", code)
        return client.sendControlMessage(json.toString())
    }

    // --- Aksi cepat DataChannel (FINAL, Bagian 3) ---

    /** Aksi global Android: HOME, BACK, RECENTS, LOCK, SCREENSHOT. */
    fun sendGlobal(name: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "global").put("name", name)
        return client.sendControlMessage(json.toString())
    }

    /** Volume Agent: UP, DOWN, atau MUTE. */
    fun sendVolume(name: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "volume").put("name", name)
        return client.sendControlMessage(json.toString())
    }

    /** Kualitas stream: low (480p@15), medium (720p@24), high (1080p@30). */
    fun sendQuality(preset: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "quality").put("preset", preset)
        val ok = client.sendControlMessage(json.toString())
        if (ok) updateState { it.copy(quality = preset) }
        return ok
    }

    /** Minta Agent mengambil foto dari frame kamera/layar terakhir. */
    fun sendPhoto(): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        updateState { it.copy(photoStatus = "Mengambil foto di Agent…") }
        return client.sendControlMessage(JSONObject().put("action", "photo").toString())
    }

    /** Minta isi clipboard Agent saat ini. */
    fun sendClipboardGet(): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        return client.sendControlMessage(JSONObject().put("action", "clipboard_get").toString())
    }

    /** Set clipboard Agent (butuh persetujuan eksplisit — tombol ini). */
    fun sendClipboardSet(text: String): Boolean {
        if (_uiState.value.status != RemoteStatus.Connected) return false
        val client = webRtcClient ?: return false
        val json = JSONObject().put("action", "clipboard_set").put("text", text)
        return client.sendControlMessage(json.toString())
    }

    /** Ping DataChannel tiap 5 detik saat terhubung; pong mengisi latencyMs. */
    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = viewModelScope.launch {
            while (_uiState.value.status == RemoteStatus.Connected) {
                webRtcClient?.sendControlMessage(
                    JSONObject().put("action", "ping").put("t", System.currentTimeMillis()).toString(),
                )
                delay(5_000L)
            }
        }
    }

    // --- Sesi kamera (FINAL, Bagian 5) ---

    /** Beralih ke sesi kamera (depan/belakang) — koneksi dimulai ulang. */
    fun startCameraSession(front: Boolean) {
        sessionType = if (front) "camera-front" else "camera-back"
        updateState { it.copy(sessionKind = sessionType) }
        val current = _uiState.value
        if (current.status == RemoteStatus.Failed || current.status == RemoteStatus.Ended) {
            retry()
        } else {
            stopSession()
            connectAndRequest()
        }
    }

    /** Kembali ke sesi layar dari sesi kamera. */
    fun startScreenSession() {
        sessionType = "screen"
        updateState { it.copy(sessionKind = "screen") }
        val current = _uiState.value
        if (current.status == RemoteStatus.Failed || current.status == RemoteStatus.Ended) {
            retry()
        } else {
            stopSession()
            connectAndRequest()
        }
    }

    // --- File Manager (FINAL, Bagian 2) ---

    fun requestFileList(docId: String? = null) {
        val requestId = UUID.randomUUID().toString()
        pendingFileListRequestId = requestId
        updateState { it.copy(files = it.files.copy(loading = true, error = null, currentDocId = docId)) }
        signaling?.sendFileListRequest(requestId, deviceId, docId)
    }

    fun refreshFiles() {
        requestFileList(_uiState.value.files.currentDocId)
    }

    fun openFolder(item: FileItemDto) {
        if (!item.isDirectory) return
        updateState {
            val files = it.files
            it.copy(files = files.copy(path = files.path + (item.docId to item.name)))
        }
        requestFileList(item.docId)
    }

    fun navigateUp() {
        val files = _uiState.value.files
        if (files.path.isEmpty()) return
        val newPath = files.path.dropLast(1)
        updateState { it.copy(files = files.copy(path = newPath)) }
        requestFileList(newPath.lastOrNull()?.first)
    }

    fun mkdirFolder(name: String) {
        val clean = name.trim()
        if (clean.isEmpty()) return
        val requestId = UUID.randomUUID().toString()
        pendingFileOpRequestId = requestId
        signaling?.sendFileMkdirRequest(requestId, deviceId, _uiState.value.files.currentDocId, clean)
    }

    fun renameItem(item: FileItemDto, newName: String) {
        val clean = newName.trim()
        if (clean.isEmpty() || clean == item.name) return
        val requestId = UUID.randomUUID().toString()
        pendingFileOpRequestId = requestId
        signaling?.sendFileRenameRequest(requestId, deviceId, item.docId, clean)
    }

    fun deleteItem(item: FileItemDto) {
        val requestId = UUID.randomUUID().toString()
        pendingFileOpRequestId = requestId
        signaling?.sendFileDeleteRequest(requestId, deviceId, item.docId)
    }

    /** Unduh file dari Agent ke folder Downloads HP Controller. */
    fun downloadFile(item: FileItemDto) {
        if (item.isDirectory) return
        viewModelScope.launch(Dispatchers.IO) {
            val jwt = tokenStore.jwt
            if (jwt.isNullOrBlank()) return@launch
            updateState { it.copy(files = it.files.copy(downloading = item.name, opStatus = null)) }
            try {
                val api = RetrofitClient.api(serverConfig.serverUrl)
                val created = RetrofitClient.safeCall {
                    api.createTransfer("Bearer $jwt", com.prata.remote.shared.model.CreateTransferRequest(deviceId, item.docId, item.name))
                }
                val transfer = when (created) {
                    is ApiResult.Ok -> created.value
                    is ApiResult.Err -> {
                        updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Gagal meminta unduhan: ${created.message}")) }
                        return@launch
                    }
                }
                // Poll status sampai Agent mengunggah blob (maks 60 detik).
                var ready = false
                repeat(30) {
                    delay(2_000L)
                    val st = RetrofitClient.safeCall { api.getTransfer("Bearer $jwt", transfer.transferId) }
                    if (st is ApiResult.Ok && st.value.transfer.status == "ready") {
                        ready = true
                        return@repeat
                    }
                    if (st is ApiResult.Ok && (st.value.transfer.status == "done" || st.value.transfer.status == "failed" || st.value.transfer.status == "expired")) {
                        return@repeat
                    }
                }
                if (!ready) {
                    updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Agent tidak mengunggah file (waktu habis).")) }
                    return@launch
                }
                val resp = api.downloadBlob("Bearer $jwt", transfer.transferId)
                if (!resp.isSuccessful || resp.body() == null) {
                    updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Gagal mengunduh blob (HTTP ${resp.code()}).")) }
                    return@launch
                }
                val app = getApplication<Application>()
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, item.name)
                    put(MediaStore.Downloads.MIME_TYPE, item.mimeType ?: "application/octet-stream")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        put(MediaStore.Downloads.RELATIVE_PATH, "Download")
                    }
                }
                val uri = app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: run {
                    updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Tidak bisa membuat file di Downloads.")) }
                    return@launch
                }
                resp.body()!!.byteStream().use { input ->
                    app.contentResolver.openOutputStream(uri)?.use { output ->
                        input.copyTo(output)
                    }
                }
                updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Terunduh ke Downloads: ${item.name}")) }
            } catch (e: Exception) {
                updateState { it.copy(files = it.files.copy(downloading = null, opStatus = "Gagal mengunduh: ${e.message}")) }
            }
        }
    }

    /** Kirim file dari HP Controller ke folder Agent saat ini. */
    fun uploadFile(uri: Uri, fileName: String, mimeType: String?) {
        viewModelScope.launch(Dispatchers.IO) {
            val jwt = tokenStore.jwt
            if (jwt.isNullOrBlank()) return@launch
            val app = getApplication<Application>()
            updateState { it.copy(files = it.files.copy(uploadStatus = "Mengunggah $fileName…")) }
            try {
                val input = app.contentResolver.openInputStream(uri) ?: run {
                    updateState { it.copy(files = it.files.copy(uploadStatus = "Tidak bisa membaca file yang dipilih.")) }
                    return@launch
                }
                val body = object : RequestBody() {
                    override fun contentType() = (mimeType ?: "application/octet-stream").toMediaType()
                    override fun writeTo(sink: BufferedSink) {
                        input.use { it.copyTo(sink.outputStream()) }
                    }
                }
                val result = RetrofitClient.safeCall {
                    RetrofitClient.api(serverConfig.serverUrl).uploadFile(
                        "Bearer $jwt",
                        deviceId,
                        fileName,
                        mimeType,
                        _uiState.value.files.currentDocId,
                        body,
                    )
                }
                when (result) {
                    is ApiResult.Ok -> updateState {
                        it.copy(files = it.files.copy(uploadStatus = "File dikirim — menunggu Agent menyimpannya…"))
                    }
                    is ApiResult.Err -> updateState {
                        it.copy(files = it.files.copy(uploadStatus = "Gagal mengunggah: ${result.message}"))
                    }
                }
            } catch (e: Exception) {
                updateState { it.copy(files = it.files.copy(uploadStatus = "Gagal mengunggah: ${e.message}")) }
            }
        }
    }

    // --- App Manager (FINAL, Bagian 3) ---

    fun requestAppList() {
        val requestId = UUID.randomUUID().toString()
        pendingAppListRequestId = requestId
        updateState { it.copy(apps = it.apps.copy(loading = true, error = null)) }
        signaling?.sendAppListRequest(requestId, deviceId)
    }

    fun sendAppCommand(command: String, packageName: String) {
        val requestId = UUID.randomUUID().toString()
        pendingAppCommandRequestId = requestId
        signaling?.sendAppCommand(requestId, deviceId, command, packageName)
    }

    fun setAppsSystemOnly(systemOnly: Boolean) {
        updateState { it.copy(apps = it.apps.copy(systemOnly = systemOnly)) }
    }

    /** Format waktu "HH:mm:ss" untuk MonitorPanel. */
    fun formatUpdatedAt(epochMs: Long?): String {
        if (epochMs == null) return "—"
        return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(epochMs))
    }

    fun formatBytes(bytes: Long?): String {
        if (bytes == null) return "—"
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "%.1f KB".format(bytes / 1024.0)
            bytes < 1024 * 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
            else -> "%.2f GB".format(bytes / (1024.0 * 1024.0 * 1024.0))
        }
    }

    fun retry() {
        val current = _uiState.value
        if (current.status != RemoteStatus.Failed && current.status != RemoteStatus.Ended) return
        pingJob?.cancel()
        eventsJob?.cancel()
        connectionJob?.cancel()
        disposeWebRtc()
        signaling?.disconnect()
        signaling = null
        sessionId = null
        lastSentText = null
        _eglContext.value = null
        connectAndRequest()
    }

    fun stopSession() {
        if (_uiState.value.status == RemoteStatus.Ended) return
        pingJob?.cancel()
        eventsJob?.cancel()
        connectionJob?.cancel()
        sessionId?.let { signaling?.endSession(it, "stopped-by-controller") }
        disposeWebRtc()
        signaling?.disconnect()
        sessionId = null
        updateState {
            it.copy(status = RemoteStatus.Ended, statusText = "Sesi berakhir.", remoteVideoTrack = null)
        }
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

    override fun onCleared() {
        stopSession()
        super.onCleared()
    }
}

class RemoteControlViewModelFactory(
    private val application: Application,
    private val deviceId: String,
    private val deviceName: String,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(RemoteControlViewModel::class.java)) {
            return RemoteControlViewModel(application, deviceId, deviceName) as T
        }
        throw IllegalArgumentException("ViewModel tidak dikenal: ${modelClass.name}")
    }
}
