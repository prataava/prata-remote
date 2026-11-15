package com.prata.remote.agent.service

// PRATA Remote — AccessibilityService untuk eksekusi sentuhan remote
// (Command 005). Satu-satunya cara resmi OS untuk mengeksekusi gesture
// (mulai Android 7.0+): dispatchGesture. TIDAK ada ROOT/ADB di sini.
// Service ini TIDAK membaca konten layar dan TIDAK mengklik apa pun
// sendiri — ia hanya menjalankan gesture yang dikirim Controller lewat
// DataChannel saat sesi berbagi layar aktif.
// Android TIDAK mengizinkan aplikasi mengaktifkan service ini secara
// programatik — user HARUS mengaktifkannya manual di Pengaturan >
// Aksesibilitas. Tanpa itu, tap ditolak dengan jujur (return false).
// FINAL (Bagian 3): + aksi global (HOME/BACK/RECENTS/LOCK/SCREENSHOT)
// lewat performGlobalAction + clipboard get/set lewat ClipboardManager.
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class PrataAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        AccessibilityController.onServiceConnected(this)
        Log.i(TAG, "PrataAccessibilityService terhubung.")
    }

    // Kami tidak butuh event aksesibilitas — hanya eksekusi gesture.
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        AccessibilityController.onServiceDisconnected(this)
        super.onDestroy()
    }

    /**
     * Tap di koordinat proporsional 0..1 (terhadap layar Agent).
     * Kembalikan false bila gesture tidak bisa didispatch.
     */
    fun dispatchTap(xNorm: Float, yNorm: Float): Boolean {
        val metrics = resources.displayMetrics
        val px = xNorm.coerceIn(0f, 1f) * metrics.widthPixels
        val py = yNorm.coerceIn(0f, 1f) * metrics.heightPixels
        val path = Path().apply { moveTo(px, py) }
        val stroke = GestureDescription.StrokeDescription(path, 0, TAP_DURATION_MS)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    Log.i(TAG, "Tap selesai di ($px, $py).")
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    Log.w(TAG, "Tap dibatalkan di ($px, $py).")
                }
            },
            null,
        )
    }

    /** Swipe dari titik awal ke titik akhir (koordinat proporsional 0..1). */
    fun dispatchSwipe(
        startXNorm: Float,
        startYNorm: Float,
        endXNorm: Float,
        endYNorm: Float,
        durationMs: Long,
    ): Boolean {
        val metrics = resources.displayMetrics
        val startX = startXNorm.coerceIn(0f, 1f) * metrics.widthPixels
        val startY = startYNorm.coerceIn(0f, 1f) * metrics.heightPixels
        val endX = endXNorm.coerceIn(0f, 1f) * metrics.widthPixels
        val endY = endYNorm.coerceIn(0f, 1f) * metrics.heightPixels
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val stroke = GestureDescription.StrokeDescription(
            path,
            0,
            durationMs.coerceIn(50L, 2000L),
        )
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    Log.i(TAG, "Swipe selesai ($startX,$startY)->($endX,$endY) ${durationMs}ms.")
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    Log.w(TAG, "Swipe dibatalkan ($startX,$startY)->($endX,$endY).")
                }
            },
            null,
        )
    }

    /**
     * Isi teks ke node input yang sedang fokus lewat ACTION_SET_TEXT.
     * Kembalikan false (tanpa crash) bila tidak ada jendela aktif, tidak
     * ada node fokus, node tidak bisa diedit, atau aksi gagal. Batas jujur:
     * UI yang memblokir Accessibility tidak bisa diisi — perintah
     * diabaikan aman dan dicatat di Logcat.
     */
    fun setTextOnFocusedNode(text: String): Boolean {
        val root = rootInActiveWindow
        if (root == null) {
            Log.w(TAG, "Isi teks ditolak: tidak ada jendela aktif.")
            return false
        }
        try {
            val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (node == null) {
                Log.w(TAG, "Isi teks ditolak: tidak ada node input yang sedang fokus.")
                return false
            }
            try {
                if (!node.isEditable) {
                    Log.w(TAG, "Isi teks ditolak: node fokus tidak bisa diedit.")
                    return false
                }
                val args = Bundle().apply {
                    putCharSequence(
                        AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                        text,
                    )
                }
                val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
                Log.i(TAG, "ACTION_SET_TEXT -> $ok (teks ${text.length} karakter).")
                return ok
            } finally {
                node.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    /** Tekan Enter pada node input yang sedang fokus (ACTION_IME_ENTER). */
    fun pressEnterOnFocusedNode(): Boolean {
        val root = rootInActiveWindow
        if (root == null) {
            Log.w(TAG, "Enter ditolak: tidak ada jendela aktif.")
            return false
        }
        try {
            val node = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (node == null) {
                Log.w(TAG, "Enter ditolak: tidak ada node input yang sedang fokus.")
                return false
            }
            try {
                val ok = node.performAction(AccessibilityNodeInfo.ACTION_IME_ENTER)
                Log.i(TAG, "ACTION_IME_ENTER -> $ok.")
                return ok
            } finally {
                node.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    /**
     * Aksi global OS (FINAL, Bagian 3): HOME/BACK/RECENTS selalu;
     * LOCK & SCREENSHOT hanya Android 9+ (API 28). False bila nama tidak
     * dikenal, API terlalu lama, atau OS menolak.
     */
    fun performGlobalAction(name: String): Boolean {
        val action = when (name) {
            "HOME" -> GLOBAL_ACTION_HOME
            "BACK" -> GLOBAL_ACTION_BACK
            "RECENTS" -> GLOBAL_ACTION_RECENTS
            "LOCK" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                    Log.w(TAG, "LOCK butuh Android 9+.")
                    return false
                }
                GLOBAL_ACTION_LOCK_SCREEN
            }
            "SCREENSHOT" -> {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
                    Log.w(TAG, "SCREENSHOT butuh Android 9+.")
                    return false
                }
                GLOBAL_ACTION_TAKE_SCREENSHOT
            }
            else -> {
                Log.w(TAG, "Aksi global tidak dikenal: $name")
                return false
            }
        }
        val ok = performGlobalAction(action)
        Log.i(TAG, "Global action $name -> $ok.")
        return ok
    }

    /** Isi clipboard perangkat dengan teks (hanya saat Controller meminta). */
    fun setClipboardText(text: String): Boolean {
        return try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return false
            cm.setPrimaryClip(ClipData.newPlainText("PRATA Remote", text))
            Log.i(TAG, "Clipboard diisi (${text.length} karakter).")
            true
        } catch (e: Exception) {
            Log.w(TAG, "Gagal mengisi clipboard: ${e.message}")
            false
        }
    }

    /** Baca isi clipboard perangkat (teks saja, null bila kosong). */
    fun getClipboardText(): String? {
        return try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
            val clip = cm.primaryClip ?: return null
            if (clip.itemCount == 0) return null
            clip.getItemAt(0).coerceToText(this)?.toString()
        } catch (e: Exception) {
            Log.w(TAG, "Gagal membaca clipboard: ${e.message}")
            null
        }
    }

    companion object {
        private const val TAG = "PRATA-A11Y"
        const val TAP_DURATION_MS = 80L
    }
}
