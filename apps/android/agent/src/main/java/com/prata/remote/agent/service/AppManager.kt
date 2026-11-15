package com.prata.remote.agent.service

// PRATA Remote — App Manager Agent (FINAL, Bagian 3)
// Membaca aplikasi terpasang via PackageManager resmi. Mendukung:
//  - list: aplikasi non-sistem (isSystemApp = false) + sistem (ditandai)
//  - open: getLaunchIntentForPackage (null bila tidak bisa dibuka)
//  - settings: ACTION_APPLICATION_DETAILS_SETTINGS (layar info aplikasi)
//  - uninstall: ACTION_DELETE — memunculkan dialog konfirmasi RESMI OS
//    di Agent; TIDAK PERNAH silent uninstall.
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.provider.Settings
import android.util.Log
import com.prata.remote.shared.model.AppInfoDto

object AppManager {
    private const val TAG = "PRATA-APPS"

    fun listInstalledApps(context: Context): List<AppInfoDto> {
        val pm = context.packageManager
        val apps = pm.getInstalledApplications(0)
        return apps.map { info ->
            val label = try {
                pm.getApplicationLabel(info).toString()
            } catch (_: Exception) {
                info.packageName
            }
            val versionName = try {
                pm.getPackageInfo(info.packageName, 0).versionName
            } catch (_: Exception) {
                null
            }
            AppInfoDto(
                packageName = info.packageName,
                label = label,
                versionName = versionName,
                isSystemApp = (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0,
            )
        }.sortedWith(compareBy<AppInfoDto> { it.isSystemApp }.thenBy { it.label.lowercase() })
    }

    /** Buka aplikasi. False bila tidak ada launch intent. */
    fun openApp(context: Context, packageName: String): Boolean {
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: run {
            Log.w(TAG, "tidak ada launch intent: $packageName")
            return false
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "gagal membuka $packageName: ${e.message}")
            false
        }
    }

    /** Buka layar info aplikasi di Settings sistem. */
    fun openAppSettings(context: Context, packageName: String): Boolean {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "gagal membuka settings $packageName: ${e.message}")
            false
        }
    }

    /** Minta hapus aplikasi — dialog konfirmasi RESMI OS muncul di Agent. */
    fun uninstallApp(context: Context, packageName: String): Boolean {
        val intent = Intent(Intent.ACTION_DELETE).apply {
            data = Uri.fromParts("package", packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "gagal meminta uninstall $packageName: ${e.message}")
            false
        }
    }
}
