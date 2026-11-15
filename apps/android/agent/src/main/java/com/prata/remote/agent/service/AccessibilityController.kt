package com.prata.remote.agent.service

// PRATA Remote — Jembatan ringan antara WebRtcClient (yang menerima JSON
// dari DataChannel) dan PrataAccessibilityService (yang mengeksekusi
// gesture). Singleton object: service mendaftarkan dirinya saat
// onServiceConnected dan mencabut saat onDestroy. Bila service belum
// aktif, performTap mengembalikan false — tidak ada antrean diam-diam,
// tidak ada klaim sukses palsu.
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object AccessibilityController {
    private val _isEnabled = MutableStateFlow(false)
    val isEnabled: StateFlow<Boolean> = _isEnabled.asStateFlow()

    private var service: PrataAccessibilityService? = null

    fun onServiceConnected(service: PrataAccessibilityService) {
        this.service = service
        _isEnabled.value = true
    }

    fun onServiceDisconnected(service: PrataAccessibilityService) {
        if (this.service === service) {
            this.service = null
            _isEnabled.value = false
        }
    }

    fun performTap(xNorm: Float, yNorm: Float): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Tap ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.dispatchTap(xNorm, yNorm)
    }

    fun performSwipe(
        startXNorm: Float,
        startYNorm: Float,
        endXNorm: Float,
        endYNorm: Float,
        durationMs: Long,
    ): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Swipe ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.dispatchSwipe(startXNorm, startYNorm, endXNorm, endYNorm, durationMs)
    }

    fun setText(text: String): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Isi teks ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.setTextOnFocusedNode(text)
    }

    fun pressEnter(): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Enter ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.pressEnterOnFocusedNode()
    }

    /** Aksi global OS (FINAL, Bagian 3): HOME/BACK/RECENTS/LOCK/SCREENSHOT. */
    fun performGlobal(name: String): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Aksi global ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.performGlobalAction(name)
    }

    /** Isi clipboard perangkat (hanya saat Controller meminta eksplisit). */
    fun setClipboard(text: String): Boolean {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Clipboard ditolak: layanan aksesibilitas belum aktif.")
            return false
        }
        return svc.setClipboardText(text)
    }

    /** Baca clipboard perangkat (null bila kosong / layanan belum aktif). */
    fun getClipboard(): String? {
        val svc = service
        if (svc == null) {
            Log.w(TAG, "Baca clipboard ditolak: layanan aksesibilitas belum aktif.")
            return null
        }
        return svc.getClipboardText()
    }

    private const val TAG = "PRATA-A11Y"
}
