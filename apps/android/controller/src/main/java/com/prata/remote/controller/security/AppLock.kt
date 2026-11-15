package com.prata.remote.controller.security

// PRATA Remote — Kunci Aplikasi Controller (FINAL, Bagian 6)
// PIN aplikasi opsional (4–6 digit) agar aplikasi pusat kendali tidak
// bisa dibuka sembarangan. PIN disimpan sebagai hash SHA-256 + garam
// di EncryptedSharedPreferences (pola yang sama dengan TokenStore) —
// PIN mentah TIDAK PERNAH disimpan. Biometrik adalah jalur buka
// alternatif yang ditawarkan SESUDAH PIN benar sekali (ditangani
// LockScreen/MainActivity lewat BiometricPrompt).
import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.MessageDigest
import java.security.SecureRandom

object AppLock {
    private const val PREFS_NAME = "prata_remote_lock"
    private const val KEY_HASH = "pin_hash"
    private const val KEY_SALT = "pin_salt"
    private const val KEY_BIOMETRIC = "biometric_enabled"

    private fun prefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun isPinSet(context: Context): Boolean = prefs(context).contains(KEY_HASH)

    fun isBiometricEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_BIOMETRIC, false)

    fun setBiometricEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean(KEY_BIOMETRIC, enabled).apply()
    }

    /** PIN 4–6 digit angka. Gagal bila format salah. */
    fun setPin(context: Context, pin: String): Boolean {
        if (!isValidPin(pin)) return false
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val hash = hashPin(pin, salt)
        prefs(context).edit()
            .putString(KEY_SALT, salt.joinToString("") { "%02x".format(it) })
            .putString(KEY_HASH, hash)
            .apply()
        return true
    }

    fun verifyPin(context: Context, pin: String): Boolean {
        val p = prefs(context)
        val saltHex = p.getString(KEY_SALT, null) ?: return false
        val stored = p.getString(KEY_HASH, null) ?: return false
        val salt = saltHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val hash = hashPin(pin, salt)
        return MessageDigest.isEqual(hash.toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))
    }

    fun clearPin(context: Context) {
        prefs(context).edit()
            .remove(KEY_HASH)
            .remove(KEY_SALT)
            .putBoolean(KEY_BIOMETRIC, false)
            .apply()
    }

    fun isValidPin(pin: String): Boolean =
        pin.length in 4..6 && pin.all { it.isDigit() }

    private fun hashPin(pin: String, salt: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(salt)
        digest.update(pin.toByteArray(Charsets.UTF_8))
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
