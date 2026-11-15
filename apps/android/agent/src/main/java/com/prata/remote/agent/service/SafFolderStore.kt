package com.prata.remote.agent.service

// PRATA Remote — Penyimpanan folder SAF Agent (FINAL, Bagian 2)
// Menyimpan tree URI yang dipilih user lewat picker sistem
// (Intent.ACTION_OPEN_DOCUMENT_TREE). URI BUKAN kredensial, jadi
// SharedPreferences biasa cukup (bukan EncryptedSharedPreferences).
// Izin persistable (takePersistableUriPermission) diambil ViewModel saat
// user memilih folder.
import android.content.Context
import android.net.Uri

class SafFolderStore(context: Context) {
    private val prefs = context.getSharedPreferences("prata_remote_saf", Context.MODE_PRIVATE)

    var treeUri: Uri?
        get() = prefs.getString(KEY_TREE_URI, null)?.let { Uri.parse(it) }
        set(value) {
            if (value == null) prefs.edit().remove(KEY_TREE_URI).apply()
            else prefs.edit().putString(KEY_TREE_URI, value.toString()).apply()
        }

    fun hasFolder(): Boolean = treeUri != null

    fun clear() {
        prefs.edit().remove(KEY_TREE_URI).apply()
    }

    companion object {
        private const val KEY_TREE_URI = "tree_uri"
    }
}
