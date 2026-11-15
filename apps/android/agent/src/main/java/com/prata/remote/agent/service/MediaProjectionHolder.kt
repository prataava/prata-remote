package com.prata.remote.agent.service

// PRATA Remote — Holder MediaProjection (Command 003, Tugas 2)
// Jembatan antara AgentForegroundService (yang menerima token izin dari
// sistem) dan AgentViewModel (yang membuat ScreenCapturerAndroid).
// MediaProjection hanya hidup selama satu sesi berbagi; holder di-nol-kan
// saat proyeksi berhenti (callback onStop atau stopStream).
import android.content.Intent
import android.media.projection.MediaProjection
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object MediaProjectionHolder {
    private val _projection = MutableStateFlow<MediaProjection?>(null)
    val projection: StateFlow<MediaProjection?> = _projection.asStateFlow()

    // Intent izin tangkap layar (hasil createScreenCaptureIntent).
    // ScreenCapturerAndroid (libwebrtc) menerima Intent ini, BUKAN
    // MediaProjection — konstruktor yang menerima MediaProjection tidak ada.
    private val _permissionIntent = MutableStateFlow<Intent?>(null)
    val permissionIntent: StateFlow<Intent?> = _permissionIntent.asStateFlow()

    fun set(projection: MediaProjection?, permissionIntent: Intent? = null) {
        _projection.value = projection
        _permissionIntent.value = permissionIntent
    }
}
