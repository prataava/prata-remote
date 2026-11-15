package com.prata.remote.agent.service

// PRATA Remote — Pembaca metrik perangkat (Command 007, Phase 3)
// Baterai: BatteryManager BATTERY_PROPERTY_CAPACITY (fallback level/scale
// dari sticky ACTION_BATTERY_CHANGED) + status charging. Penyimpanan:
// StatFs pada Environment.getDataDirectory(). RAM: ActivityManager.MemoryInfo.
// Semua pembacaan dibungkus try/catch — gagal = null (jujur), bukan angka
// palsu. Sticky intent baterai tidak butuh receiver permanen (hemat daya).
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import android.util.Log
import com.prata.remote.shared.model.DeviceMetrics

class DeviceMetricsCollector(private val context: Context) {

    fun collect(): DeviceMetrics {
        val (batteryPct, charging) = readBattery()
        val (storageTotal, storageFree) = readStorage()
        val (ramTotal, ramAvail) = readRam()
        if (batteryPct == null) Log.w(TAG, "Baterai tidak bisa dibaca.")
        if (storageTotal == null) Log.w(TAG, "Penyimpanan tidak bisa dibaca.")
        if (ramTotal == null) Log.w(TAG, "RAM tidak bisa dibaca (dibatasi OS/vendor).")
        return DeviceMetrics(
            batteryPct = batteryPct,
            charging = charging,
            storageTotalBytes = storageTotal,
            storageFreeBytes = storageFree,
            ramTotalBytes = ramTotal,
            ramAvailBytes = ramAvail,
        )
    }

    private fun readBattery(): Pair<Int?, Boolean?> {
        return try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val capacity = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                .takeIf { it in 0..100 }
            val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val pct = capacity ?: if (level >= 0 && scale > 0) (level * 100 / scale) else null
            val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val charging = if (status == -1) {
                null
            } else {
                status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL
            }
            pct to charging
        } catch (e: Exception) {
            Log.w(TAG, "readBattery gagal: ${e.message}")
            null to null
        }
    }

    private fun readStorage(): Pair<Long?, Long?> {
        return try {
            val stat = StatFs(Environment.getDataDirectory().path)
            val total = stat.totalBytes.takeIf { it > 0 }
            val free = stat.availableBytes.takeIf { it >= 0 }
            total to free
        } catch (e: Exception) {
            Log.w(TAG, "readStorage gagal: ${e.message}")
            null to null
        }
    }

    private fun readRam(): Pair<Long?, Long?> {
        return try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val info = ActivityManager.MemoryInfo()
            am.getMemoryInfo(info)
            val total = info.totalMem.takeIf { it > 0 }
            val avail = info.availMem.takeIf { it > 0 }
            total to avail
        } catch (e: Exception) {
            Log.w(TAG, "readRam gagal: ${e.message}")
            null to null
        }
    }

    companion object {
        private const val TAG = "PRATA-METRICS"
    }
}
