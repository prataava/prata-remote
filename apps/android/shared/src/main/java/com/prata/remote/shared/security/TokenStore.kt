package com.prata.remote.shared.security

// PRATA Remote — Penyimpanan token terenkripsi (Command 002, Tugas 2-3)
// EncryptedSharedPreferences (AES256-GCM): JWT controller, token agen,
// dan id perangkat. Kunci dienkripsi di Android Keystore — token tidak
// pernah tersimpan sebagai teks biasa di perangkat.
import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TokenStore(context: Context) {
    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "prata_remote_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var jwt: String?
        get() = prefs.getString(KEY_JWT, null)
        set(value) = prefs.edit().putString(KEY_JWT, value).apply()

    var agentToken: String?
        get() = prefs.getString(KEY_AGENT_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_AGENT_TOKEN, value).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    val hasAgentToken: Boolean
        get() = !agentToken.isNullOrBlank() && !deviceId.isNullOrBlank()

    val hasJwt: Boolean
        get() = !jwt.isNullOrBlank()

    fun clearAuth() {
        prefs.edit().remove(KEY_JWT).remove(KEY_AGENT_TOKEN).remove(KEY_DEVICE_ID).apply()
    }

    private companion object {
        const val KEY_JWT = "jwt"
        const val KEY_AGENT_TOKEN = "agent_token"
        const val KEY_DEVICE_ID = "device_id"
    }
}
