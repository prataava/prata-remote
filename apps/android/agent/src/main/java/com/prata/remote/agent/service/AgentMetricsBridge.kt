package com.prata.remote.agent.service

// PRATA Remote — Jembatan metrik (Command 007). Foreground Service
// menjalankan loop 15 detik dan memanggil collectAndSend; ViewModel
// mendaftarkan pengirim (SignalingClient) hanya saat WS terhubung.
// Tanpa pengirim terdaftar, pengumpulan DIABAIKAN (tanpa antrean,
// tanpa memory leak). Loop hidup selama service hidup — tidak terikat
// Activity, jadi metrik tetap mengalir saat aplikasi di latar belakang.
import android.content.Context
import android.util.Log
import org.json.JSONObject

object AgentMetricsBridge {
    private var sender: ((JSONObject) -> Boolean)? = null

    fun registerSender(send: (JSONObject) -> Boolean) {
        sender = send
    }

    fun unregisterSender() {
        sender = null
    }

    fun collectAndSend(context: Context) {
        val send = sender ?: return
        try {
            val metrics = DeviceMetricsCollector(context).collect()
            send(metrics.toJson())
        } catch (e: Exception) {
            Log.w(TAG, "collectAndSend gagal: ${e.message}")
        }
    }

    private const val TAG = "PRATA-METRICS"
}
