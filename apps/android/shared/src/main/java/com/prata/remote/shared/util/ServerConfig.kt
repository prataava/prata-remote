package com.prata.remote.shared.util

// PRATA Remote — Konfigurasi alamat server (Command 002, Tugas 2-3)
// Alamat backend disimpan di SharedPreferences biasa (bukan rahasia) dan
// bisa diubah dari UI aplikasi. Default 10.0.2.2 = localhost host dari
// emulator Android. Di HP fisik isi IP/host server, mis. http://192.168.1.10:8080.
import android.content.Context

class ServerConfig(context: Context) {
    private val prefs = context.getSharedPreferences("prata_remote_config", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) {
            prefs.edit().putString(KEY_SERVER_URL, value.trim().trimEnd('/')).apply()
        }

    /** Turunan alamat WebSocket dari alamat HTTP: http->ws, https->wss. */
    fun wsBaseUrl(): String {
        val http = serverUrl
        return when {
            http.startsWith("https://") -> "wss://" + http.removePrefix("https://")
            http.startsWith("http://") -> "ws://" + http.removePrefix("http://")
            else -> http
        }
    }

    private companion object {
        const val KEY_SERVER_URL = "server_url"
        const val DEFAULT_SERVER_URL = "http://10.0.2.2:8080"
    }
}
