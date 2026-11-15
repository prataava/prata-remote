package com.prata.remote.agent.service

// PRATA Remote — Notification Listener Agent (FINAL, Bagian 4)
// Meneruskan notifikasi perangkat ke Controller lewat WebSocket
// (device_notification). Aturan kejujuran:
//  - Hanya aktif bila user mengaktifkan "Notification access" di Settings
//    sistem (tidak ada bypass programatik).
//  - Notifikasi dengan visibilitas SECRET (VISIBILITY_SECRET) TIDAK PERNAH
//    diteruskan — hanya dicatat ke Logcat.
//  - Hanya mengirim saat WS terhubung (bridge null = diam, tanpa antrean).
//  - Judul/teks diambil dari extras standar (EXTRA_TITLE / EXTRA_TEXT).
import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject

class PrataNotificationListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        super.onListenerConnected()
        isEnabledFlow.value = true
        Log.i(TAG, "notification listener terhubung")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        isEnabledFlow.value = false
        Log.i(TAG, "notification listener terputus")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val notification = sbn.notification
        if (notification.visibility == Notification.VISIBILITY_SECRET) {
            Log.i(TAG, "notifikasi SECRET dari ${sbn.packageName} diabaikan")
            return
        }
        val sender = NotificationBridge.sender ?: return // WS tidak terhubung -> diam.
        val extras = notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
        val appName = try {
            packageManager.getApplicationLabel(
                packageManager.getApplicationInfo(sbn.packageName, 0),
            ).toString()
        } catch (_: Exception) {
            sbn.packageName
        }
        val ok = sender(
            JSONObject()
                .put("packageName", sbn.packageName)
                .put("appName", appName)
                .put("title", title ?: JSONObject.NULL)
                .put("text", text ?: JSONObject.NULL)
                .put("at", java.time.Instant.ofEpochMilli(sbn.postTime).toString()),
        )
        if (!ok) Log.w(TAG, "gagal mengirim notifikasi ${sbn.packageName}")
    }

    companion object {
        const val TAG = "PRATA-NOTIF"
        private val isEnabledFlow = MutableStateFlow(false)
        val isEnabled: StateFlow<Boolean> = isEnabledFlow.asStateFlow()
    }
}

/** Jembatan pengirim notifikasi (mirip AgentMetricsBridge): didaftarkan
 *  ViewModel saat WS terhubung; null bila offline (tanpa antrean/leak). */
object NotificationBridge {
    /** (payload JSONObject) -> Boolean terkirim. */
    var sender: ((JSONObject) -> Boolean)? = null
}
