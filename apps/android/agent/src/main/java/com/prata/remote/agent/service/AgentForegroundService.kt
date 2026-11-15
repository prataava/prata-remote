package com.prata.remote.agent.service

// PRATA Remote — Foreground Service Agent (Command 002 Tugas 2 + 003 Tugas 2)
// Tiga mode dalam satu service:
//  - dataSync (Phase 1): menjaga proses agen tetap hidup agar koneksi
//    signaling tidak dimatikan sistem saat aplikasi di latar belakang.
//  - mediaProjection (Phase 2): aktif HANYA sesudah user menyetujui
//    tangkap layar lewat dialog sistem (MediaProjectionManager intent).
//    Token izin berlaku satu sesi; tiap sesi baru wajib minta lagi —
//    tidak ada cara bypass, dan service TIDAK pernah memulai proyeksi
//    tanpa token hasil persetujuan user (aturan ketat Android 14+).
//    Berhenti berbagi -> kembali ke mode dataSync (koneksi tetap hidup).
//  - camera (FINAL, Bagian 5): aktif HANYA saat sesi kamera remote
//    berjalan — notifikasi MENCOLOK + tombol "Hentikan Kamera" di
//    notifikasi (tidak boleh diam-diam/tersembunyi). Berhenti -> dataSync.
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class AgentForegroundService : Service() {

    private var mediaProjection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null

    // Loop metrik perangkat (Command 007): tiap 15 detik kumpulkan +
    // kirim via AgentMetricsBridge. Bila tidak ada pengirim WS terdaftar,
    // pengumpulan diabaikan (tanpa antrean, tanpa leak).
    private val metricsScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var metricsJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startMetricsLoop()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startAsDataSync()
            ACTION_START_STREAM -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                @Suppress("DEPRECATION")
                val data: Intent? = intent.getParcelableExtra(EXTRA_RESULT_DATA)
                if (data != null) startStream(resultCode, data)
            }
            ACTION_STOP_STREAM -> stopStream()
            ACTION_START_CAMERA -> startCamera()
            ACTION_STOP_CAMERA -> stopCamera()
            ACTION_STOP -> {
                stopStreamInternal()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        metricsJob?.cancel()
        metricsScope.cancel()
        stopStreamInternal()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startAsDataSync() {
        val notification = buildNotification("Agent PRATA aktif — menjaga koneksi ke server.")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun startMetricsLoop() {
        if (metricsJob != null) return
        metricsJob = metricsScope.launch {
            while (isActive) {
                delay(METRICS_INTERVAL_MS)
                AgentMetricsBridge.collectAndSend(applicationContext)
            }
        }
    }

    private fun startStream(resultCode: Int, data: Intent) {
        stopStreamInternal()
        val manager = getSystemService(MediaProjectionManager::class.java)
        val projection = manager.getMediaProjection(resultCode, data)
        mediaProjection = projection
        val callback = object : MediaProjection.Callback() {
            override fun onStop() {
                MediaProjectionHolder.set(null)
            }
        }
        projectionCallback = callback
        projection.registerCallback(callback, Handler(Looper.getMainLooper()))
        MediaProjectionHolder.set(projection)
        val notification = buildNotification("Berbagi layar aktif — layar perangkat ini sedang dibagikan.")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** Berhenti berbagi layar, lalu kembali ke mode keepalive dataSync. */
    private fun stopStream() {
        stopStreamInternal()
        startAsDataSync()
    }

    /**
     * Mode kamera (FINAL, Bagian 5): notifikasi MENCOLOK + tombol
     * "Hentikan Kamera" di notifikasi. FGS tipe camera (Android 14+).
     */
    private fun startCamera() {
        val stopIntent = Intent(this, AgentForegroundService::class.java).setAction(ACTION_STOP_CAMERA)
        val stopPending = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PRATA Remote: Kamera sedang diakses dari jarak jauh")
            .setContentText("Kamera perangkat ini sedang dibagikan ke Controller.")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Hentikan Kamera", stopPending)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    /** Berhenti mode kamera, lalu kembali ke mode keepalive dataSync. */
    private fun stopCamera() {
        startAsDataSync()
    }

    /** Hentikan proyeksi (bila ada) dan nol-kan holder. Aman dipanggil berulang. */
    private fun stopStreamInternal() {
        val projection = mediaProjection
        mediaProjection = null
        val callback = projectionCallback
        projectionCallback = null
        if (projection != null) {
            try {
                if (callback != null) projection.unregisterCallback(callback)
            } catch (_: Exception) {
            }
            try {
                projection.stop()
            } catch (_: Exception) {
            }
        }
        MediaProjectionHolder.set(null)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Agent PRATA",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Menjaga agen PRATA tetap terhubung ke server."
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PRATA Remote Agent")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val ACTION_START = "com.prata.remote.agent.START"
        const val ACTION_STOP = "com.prata.remote.agent.STOP"
        const val ACTION_START_STREAM = "com.prata.remote.agent.START_STREAM"
        const val ACTION_STOP_STREAM = "com.prata.remote.agent.STOP_STREAM"
        const val ACTION_START_CAMERA = "com.prata.remote.agent.START_CAMERA"
        const val ACTION_STOP_CAMERA = "com.prata.remote.agent.STOP_CAMERA"
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_RESULT_DATA = "result_data"
        private const val CHANNEL_ID = "prata_agent"
        private const val NOTIFICATION_ID = 1001
        private const val METRICS_INTERVAL_MS = 15_000L

        fun start(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }

        /** Mulai berbagi layar dengan token izin hasil dialog sistem. */
        fun startStream(context: Context, resultCode: Int, data: Intent) {
            val intent = Intent(context, AgentForegroundService::class.java)
                .setAction(ACTION_START_STREAM)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, data)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopStream(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).setAction(ACTION_STOP_STREAM)
            context.startService(intent)
        }

        /** Masuk mode kamera (notifikasi mencolok + tombol Hentikan Kamera). */
        fun startCamera(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).setAction(ACTION_START_CAMERA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopCamera(context: Context) {
            val intent = Intent(context, AgentForegroundService::class.java).setAction(ACTION_STOP_CAMERA)
            context.startService(intent)
        }
    }
}
