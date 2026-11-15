package com.prata.remote.shared.signaling

// PRATA Remote — Klien signaling WebSocket (Command 001 + 002 + 003 + 007)
// Mengimplementasikan protokol pesan backend (apps/backend/src/signaling/):
// hello (auth) -> welcome (+ iceServers), heartbeat, watch, session-request/
// accept/reject, relay webrtc_offer/webrtc_answer/webrtc_ice_candidate
// (alias lama offer/answer/ice juga diterima), presence, device_metrics
// (Command 007: Agent kirim berkala -> controller pemilik menerima).
// Media TIDAK lewat sini (Phase 2 WebRTC peer-to-peer).
// Reconnect otomatis dengan backoff eksponensial (maks 5 percobaan) lalu
// menyerah dengan state Error — tidak berpura-pura terhubung.
import com.prata.remote.shared.model.AppInfoDto
import com.prata.remote.shared.model.DeviceMetrics
import com.prata.remote.shared.model.FileItemDto
import com.prata.remote.shared.model.IceCandidateDto
import com.prata.remote.shared.model.IceServerDto
import com.prata.remote.shared.model.SdpDto
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

sealed class ConnectionState {
    data object Disconnected : ConnectionState()
    data object Connecting : ConnectionState()
    data object Connected : ConnectionState()
    data class Error(val message: String) : ConnectionState()
}

sealed class SignalingEvent {
    data class Welcome(val peerId: String, val role: String, val iceServers: List<IceServerDto>) : SignalingEvent()
    data class Presence(val deviceId: String, val status: String, val lastSeenAt: String?) : SignalingEvent()
    data class SessionRequest(val sessionId: String, val from: String, val sessionType: String) : SignalingEvent()
    data class SessionAccepted(val sessionId: String, val deviceId: String) : SignalingEvent()
    data class SessionRejected(val sessionId: String, val deviceId: String, val reason: String?) : SignalingEvent()
    data class SessionEnded(val sessionId: String, val reason: String?) : SignalingEvent()
    data class Offer(val sessionId: String, val from: String, val payload: String) : SignalingEvent()
    data class Answer(val sessionId: String, val from: String, val payload: String) : SignalingEvent()
    data class Ice(val sessionId: String, val from: String, val payload: String) : SignalingEvent()
    // Command 007: metrik perangkat dari Agent (diteruskan server).
    data class DeviceMetricsReceived(val deviceId: String, val metrics: DeviceMetrics, val receivedAt: String?) : SignalingEvent()
    // Command 008: file browsing & transfer.
    data class FileListRequest(val requestId: String, val docId: String?) : SignalingEvent()
    data class FileListResponse(val requestId: String, val items: List<FileItemDto>, val error: String?) : SignalingEvent()
    data class FileDownloadRequest(val transferId: String, val docId: String, val fileName: String) : SignalingEvent()
    data class FileUploadReady(val transferId: String, val fileName: String, val size: Long, val mimeType: String?, val docId: String?) : SignalingEvent()
    data class FileTransferDone(val transferId: String, val ok: Boolean, val error: String?) : SignalingEvent()
    // FINAL: operasi direktori (server -> agen).
    data class FileMkdirRequest(val requestId: String, val parentDocId: String?, val name: String) : SignalingEvent()
    data class FileRenameRequest(val requestId: String, val docId: String, val newName: String) : SignalingEvent()
    data class FileDeleteRequest(val requestId: String, val docId: String) : SignalingEvent()
    // FINAL: jawaban operasi direktori (agen -> controller via server).
    data class FileOpResponse(val requestId: String, val ok: Boolean, val error: String?) : SignalingEvent()
    // FINAL: App Manager.
    data class AppListRequest(val requestId: String) : SignalingEvent()
    data class AppCommandRequest(val requestId: String, val command: String, val packageName: String) : SignalingEvent()
    data class AppListResponse(val requestId: String, val apps: List<AppInfoDto>, val error: String?) : SignalingEvent()
    data class AppCommandResponse(val requestId: String, val ok: Boolean, val error: String?) : SignalingEvent()
    // FINAL: notifikasi perangkat + alert otomatisasi (server -> controller).
    data class DeviceNotificationReceived(val deviceId: String, val packageName: String, val appName: String, val title: String?, val text: String?, val at: String?) : SignalingEvent()
    data class AutomationAlertReceived(val ruleId: String, val ruleName: String, val deviceId: String, val message: String, val at: String?) : SignalingEvent()
    data class Error(val code: String, val message: String) : SignalingEvent()
    data object Disconnected : SignalingEvent()
}

class SignalingClient(
    private val wsUrl: String,
    private val okHttp: OkHttpClient = defaultClient(),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO),
) {
    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _events = MutableSharedFlow<SignalingEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<SignalingEvent> = _events.asSharedFlow()

    private var socket: WebSocket? = null
    private var helloJson: String? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var wantConnected = false
    private var reconnectAttempts = 0

    fun connectAsAgent(deviceId: String, token: String) {
        helloJson = JSONObject()
            .put("type", "hello")
            .put("role", "agent")
            .put("deviceId", deviceId)
            .put("token", token)
            .toString()
        wantConnected = true
        reconnectAttempts = 0
        connect()
    }

    fun connectAsController(token: String) {
        helloJson = JSONObject()
            .put("type", "hello")
            .put("role", "controller")
            .put("token", token)
            .toString()
        wantConnected = true
        reconnectAttempts = 0
        connect()
    }

    fun disconnect() {
        wantConnected = false
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        socket?.close(1000, "bye")
        socket = null
        _connectionState.value = ConnectionState.Disconnected
    }

    fun watch(deviceId: String) = sendJson(JSONObject().put("type", "watch").put("deviceId", deviceId))

    fun requestSession(deviceId: String, sessionType: String = "screen") {
        sendJson(
            JSONObject()
                .put("type", "session-request")
                .put("deviceId", deviceId)
                .put("sessionType", sessionType),
        )
    }

    fun acceptSession(sessionId: String) =
        sendJson(JSONObject().put("type", "session-accept").put("sessionId", sessionId))

    fun rejectSession(sessionId: String, reason: String? = null) {
        val obj = JSONObject().put("type", "session-reject").put("sessionId", sessionId)
        if (reason != null) obj.put("reason", reason)
        sendJson(obj)
    }

    fun sendOffer(sessionId: String, sdp: SdpDto) {
        val payload = JSONObject().put("type", sdp.type).put("sdp", sdp.sdp)
        sendJson(JSONObject().put("type", "webrtc_offer").put("sessionId", sessionId).put("payload", payload))
    }

    fun sendAnswer(sessionId: String, sdp: SdpDto) {
        val payload = JSONObject().put("type", sdp.type).put("sdp", sdp.sdp)
        sendJson(JSONObject().put("type", "webrtc_answer").put("sessionId", sessionId).put("payload", payload))
    }

    fun sendIce(sessionId: String, candidate: IceCandidateDto) {
        val payload = JSONObject()
            .put("sdpMid", candidate.sdpMid)
            .put("sdpMLineIndex", candidate.sdpMLineIndex)
            .put("candidate", candidate.candidate)
        sendJson(JSONObject().put("type", "webrtc_ice_candidate").put("sessionId", sessionId).put("payload", payload))
    }

    fun endSession(sessionId: String, reason: String? = null) {
        val obj = JSONObject().put("type", "session-end").put("sessionId", sessionId)
        if (reason != null) obj.put("reason", reason)
        sendJson(obj)
    }

    /** Kirim metrik perangkat (Command 007). False bila WS tidak terhubung. */
    fun sendDeviceMetrics(metrics: JSONObject): Boolean {
        val socket = socket ?: return false
        if (_connectionState.value != ConnectionState.Connected) return false
        return socket.send(
            JSONObject().put("type", "device_metrics").put("metrics", metrics).toString(),
        )
    }

    /** Minta daftar file ke Agen (Command 008). docId null = folder root SAF. */
    fun sendFileListRequest(requestId: String, deviceId: String, docId: String?) {
        val obj = JSONObject()
            .put("type", "file_list_request")
            .put("requestId", requestId)
            .put("deviceId", deviceId)
        if (docId != null) obj.put("docId", docId) else obj.put("docId", JSONObject.NULL)
        sendJson(obj)
    }

    /** Jawab permintaan daftar file (Agen -> Controller via server). */
    fun sendFileListResponse(requestId: String, items: List<FileItemDto>, error: String? = null) {
        val array = org.json.JSONArray()
        for (item in items) array.put(item.toJson())
        val obj = JSONObject()
            .put("type", "file_list_response")
            .put("requestId", requestId)
            .put("items", array)
        if (error != null) obj.put("error", error)
        sendJson(obj)
    }

    /** Ack Agen sesudah menyimpan file kiriman Controller (Command 008). */
    fun sendFileTransferDone(transferId: String, ok: Boolean, error: String? = null) {
        val obj = JSONObject()
            .put("type", "file_transfer_done")
            .put("transferId", transferId)
            .put("ok", ok)
        if (error != null) obj.put("error", error)
        sendJson(obj)
    }

    // --- FINAL: operasi direktori (Controller -> Agen via server) ---
    fun sendFileMkdirRequest(requestId: String, deviceId: String, parentDocId: String?, name: String) {
        val obj = JSONObject()
            .put("type", "file_mkdir_request")
            .put("requestId", requestId)
            .put("deviceId", deviceId)
            .put("name", name)
        if (parentDocId != null) obj.put("parentDocId", parentDocId) else obj.put("parentDocId", JSONObject.NULL)
        sendJson(obj)
    }

    fun sendFileRenameRequest(requestId: String, deviceId: String, docId: String, newName: String) {
        sendJson(
            JSONObject()
                .put("type", "file_rename_request")
                .put("requestId", requestId)
                .put("deviceId", deviceId)
                .put("docId", docId)
                .put("newName", newName),
        )
    }

    fun sendFileDeleteRequest(requestId: String, deviceId: String, docId: String) {
        sendJson(
            JSONObject()
                .put("type", "file_delete_request")
                .put("requestId", requestId)
                .put("deviceId", deviceId)
                .put("docId", docId),
        )
    }

    /** Jawab operasi direktori (Agen -> Controller via server). */
    fun sendFileOpResponse(requestId: String, ok: Boolean, error: String? = null) {
        val obj = JSONObject()
            .put("type", "file_op_response")
            .put("requestId", requestId)
            .put("ok", ok)
        if (error != null) obj.put("error", error)
        sendJson(obj)
    }

    // --- FINAL: App Manager ---
    fun sendAppListRequest(requestId: String, deviceId: String) {
        sendJson(
            JSONObject()
                .put("type", "app_list_request")
                .put("requestId", requestId)
                .put("deviceId", deviceId),
        )
    }

    /** Jawab daftar aplikasi (Agen -> Controller via server). */
    fun sendAppListResponse(requestId: String, apps: List<AppInfoDto>, error: String? = null) {
        val array = org.json.JSONArray()
        for (app in apps) array.put(app.toJson())
        val obj = JSONObject()
            .put("type", "app_list_response")
            .put("requestId", requestId)
            .put("apps", array)
        if (error != null) obj.put("error", error)
        sendJson(obj)
    }

    fun sendAppCommand(requestId: String, deviceId: String, command: String, packageName: String) {
        sendJson(
            JSONObject()
                .put("type", "app_command")
                .put("requestId", requestId)
                .put("deviceId", deviceId)
                .put("command", command)
                .put("packageName", packageName),
        )
    }

    /** Jawab perintah aplikasi (Agen -> Controller via server). */
    fun sendAppCommandResponse(requestId: String, ok: Boolean, error: String? = null) {
        val obj = JSONObject()
            .put("type", "app_command_response")
            .put("requestId", requestId)
            .put("ok", ok)
        if (error != null) obj.put("error", error)
        sendJson(obj)
    }

    /** Teruskan satu notifikasi perangkat ke server (Agen -> Controller). */
    fun sendDeviceNotification(packageName: String, appName: String, title: String?, text: String?, at: String): Boolean {
        val socket = socket ?: return false
        if (_connectionState.value != ConnectionState.Connected) return false
        val obj = JSONObject()
            .put("type", "device_notification")
            .put("packageName", packageName)
            .put("appName", appName)
            .put("at", at)
        if (title != null) obj.put("title", title) else obj.put("title", JSONObject.NULL)
        if (text != null) obj.put("text", text) else obj.put("text", JSONObject.NULL)
        return socket.send(obj.toString())
    }

    /** Laporkan status izin fitur Agent ke server (Agen -> server). */
    fun sendPermissionReport(permissions: List<Pair<String, Boolean>>) {
        val array = org.json.JSONArray()
        for ((feature, granted) in permissions) {
            array.put(JSONObject().put("feature", feature).put("granted", granted))
        }
        sendJson(JSONObject().put("type", "permission_report").put("permissions", array))
    }

    private fun sendJson(obj: JSONObject) {
        socket?.send(obj.toString())
    }

    private fun parseIceServers(json: JSONObject): List<IceServerDto> {
        val array = json.optJSONArray("iceServers") ?: return emptyList()
        val out = mutableListOf<IceServerDto>()
        for (i in 0 until array.length()) {
            val entry = array.optJSONObject(i) ?: continue
            val urls = mutableListOf<String>()
            val rawUrls = entry.opt("urls")
            when (rawUrls) {
                is String -> urls.add(rawUrls)
                is org.json.JSONArray -> for (j in 0 until rawUrls.length()) {
                    rawUrls.optString(j).takeIf { it.isNotBlank() }?.let { urls.add(it) }
                }
            }
            if (urls.isEmpty()) continue
            out.add(
                IceServerDto(
                    urls = urls,
                    username = entry.optString("username").ifEmpty { null },
                    credential = entry.optString("credential").ifEmpty { null },
                ),
            )
        }
        return out
    }

    private fun connect() {
        val hello = helloJson ?: return
        _connectionState.value = ConnectionState.Connecting
        val request = Request.Builder().url(wsUrl).build()
        socket = okHttp.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempts = 0
                webSocket.send(hello)
                startHeartbeat()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onSocketGone("Koneksi WebSocket ditutup ($code).")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onSocketGone(t.message ?: "Koneksi WebSocket gagal.")
            }
        })
    }

    private fun onSocketGone(message: String) {
        heartbeatJob?.cancel()
        socket = null
        scope.launch { _events.emit(SignalingEvent.Disconnected) }
        if (!wantConnected) {
            _connectionState.value = ConnectionState.Disconnected
            return
        }
        if (reconnectAttempts >= 5) {
            _connectionState.value = ConnectionState.Error("Tidak bisa terhubung ke server: $message")
            return
        }
        reconnectAttempts += 1
        val waitMs = 1000L shl (reconnectAttempts - 1) // 1 dtk, 2 dtk, 4 dtk, 8 dtk, 16 dtk
        _connectionState.value = ConnectionState.Connecting
        reconnectJob = scope.launch {
            delay(waitMs)
            if (wantConnected) connect()
        }
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (true) {
                delay(15_000)
                sendJson(JSONObject().put("type", "heartbeat"))
            }
        }
    }

    private fun handleMessage(text: String) {
        val json = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        val event: SignalingEvent? = when (json.optString("type")) {
            "welcome" -> SignalingEvent.Welcome(
                json.optString("peerId"),
                json.optString("role"),
                parseIceServers(json),
            )
            "presence" -> SignalingEvent.Presence(
                json.optString("deviceId"),
                json.optString("status"),
                json.optString("lastSeenAt").ifEmpty { null },
            )
            "session-request" -> SignalingEvent.SessionRequest(
                json.optString("sessionId"),
                json.optString("from"),
                json.optString("sessionType"),
            )
            "session-accepted" -> SignalingEvent.SessionAccepted(json.optString("sessionId"), json.optString("deviceId"))
            "session-rejected" -> SignalingEvent.SessionRejected(
                json.optString("sessionId"),
                json.optString("deviceId"),
                json.optString("reason").ifEmpty { null },
            )
            "session-ended" -> SignalingEvent.SessionEnded(
                json.optString("sessionId"),
                json.optString("reason").ifEmpty { null },
            )
            "offer", "webrtc_offer" -> SignalingEvent.Offer(json.optString("sessionId"), json.optString("from"), json.optJSONObject("payload")?.toString() ?: "{}")
            "answer", "webrtc_answer" -> SignalingEvent.Answer(json.optString("sessionId"), json.optString("from"), json.optJSONObject("payload")?.toString() ?: "{}")
            "ice", "webrtc_ice_candidate" -> SignalingEvent.Ice(json.optString("sessionId"), json.optString("from"), json.optJSONObject("payload")?.toString() ?: "{}")
            "device_metrics" -> {
                val metrics = DeviceMetrics.fromJson(json.optJSONObject("metrics"))
                if (metrics == null) {
                    null
                } else {
                    SignalingEvent.DeviceMetricsReceived(
                        json.optString("deviceId"),
                        metrics,
                        json.optString("at").ifEmpty { null },
                    )
                }
            }
            "file_list_request" -> SignalingEvent.FileListRequest(
                json.optString("requestId"),
                if (json.isNull("docId")) null else json.optString("docId").ifEmpty { null },
            )
            "file_list_response" -> SignalingEvent.FileListResponse(
                json.optString("requestId"),
                FileItemDto.listFromJson(json.optJSONArray("items")),
                if (json.isNull("error")) null else json.optString("error").ifEmpty { null },
            )
            "file_download_request", "file_upload_requested" -> SignalingEvent.FileDownloadRequest(
                json.optString("transferId"),
                json.optString("docId"),
                json.optString("fileName"),
            )
            "file_upload_ready", "file_download_ready" -> SignalingEvent.FileUploadReady(
                json.optString("transferId"),
                json.optString("fileName"),
                json.optLong("size"),
                if (json.isNull("mimeType")) null else json.optString("mimeType").ifEmpty { null },
                if (json.isNull("docId")) null else json.optString("docId").ifEmpty { null },
            )
            "file_transfer_done" -> SignalingEvent.FileTransferDone(
                json.optString("transferId"),
                json.optBoolean("ok"),
                if (json.isNull("error")) null else json.optString("error").ifEmpty { null },
            )
            "file_mkdir_request" -> SignalingEvent.FileMkdirRequest(
                json.optString("requestId"),
                if (json.isNull("parentDocId")) null else json.optString("parentDocId").ifEmpty { null },
                json.optString("name"),
            )
            "file_rename_request" -> SignalingEvent.FileRenameRequest(
                json.optString("requestId"),
                json.optString("docId"),
                json.optString("newName"),
            )
            "file_delete_request" -> SignalingEvent.FileDeleteRequest(
                json.optString("requestId"),
                json.optString("docId"),
            )
            "file_op_response" -> SignalingEvent.FileOpResponse(
                json.optString("requestId"),
                json.optBoolean("ok"),
                if (json.isNull("error")) null else json.optString("error").ifEmpty { null },
            )
            "app_list_request" -> SignalingEvent.AppListRequest(json.optString("requestId"))
            "app_command" -> SignalingEvent.AppCommandRequest(
                json.optString("requestId"),
                json.optString("command"),
                json.optString("packageName"),
            )
            "app_list_response" -> SignalingEvent.AppListResponse(
                json.optString("requestId"),
                AppInfoDto.listFromJson(json.optJSONArray("apps")),
                if (json.isNull("error")) null else json.optString("error").ifEmpty { null },
            )
            "app_command_response" -> SignalingEvent.AppCommandResponse(
                json.optString("requestId"),
                json.optBoolean("ok"),
                if (json.isNull("error")) null else json.optString("error").ifEmpty { null },
            )
            "device_notification" -> SignalingEvent.DeviceNotificationReceived(
                json.optString("deviceId"),
                json.optString("packageName"),
                json.optString("appName"),
                if (json.isNull("title")) null else json.optString("title").ifEmpty { null },
                if (json.isNull("text")) null else json.optString("text").ifEmpty { null },
                json.optString("at").ifEmpty { null },
            )
            "automation_alert" -> SignalingEvent.AutomationAlertReceived(
                json.optString("ruleId"),
                json.optString("ruleName"),
                json.optString("deviceId"),
                json.optString("message"),
                json.optString("at").ifEmpty { null },
            )
            "error" -> SignalingEvent.Error(json.optString("code"), json.optString("message"))
            else -> null
        }
        if (event is SignalingEvent.Welcome) _connectionState.value = ConnectionState.Connected
        if (event != null) scope.launch { _events.emit(event) }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS) // WebSocket: tanpa batas baca
            .build()
    }
}
