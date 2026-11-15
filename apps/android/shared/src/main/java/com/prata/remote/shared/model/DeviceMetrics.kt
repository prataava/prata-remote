package com.prata.remote.shared.model

// PRATA Remote — Metrik perangkat (Command 007, Phase 3)
// Semua field nullable: null = tidak bisa dibaca di perangkat itu
// (jujur, bukan hardcode). Satuan: persen 0..100, byte.
import org.json.JSONObject

data class DeviceMetrics(
    val batteryPct: Int? = null,
    val charging: Boolean? = null,
    val storageTotalBytes: Long? = null,
    val storageFreeBytes: Long? = null,
    val ramTotalBytes: Long? = null,
    val ramAvailBytes: Long? = null,
) {
    fun toJson(): JSONObject {
        val obj = JSONObject()
        putOrNull(obj, "batteryPct", batteryPct)
        putOrNull(obj, "charging", charging)
        putOrNull(obj, "storageTotalBytes", storageTotalBytes)
        putOrNull(obj, "storageFreeBytes", storageFreeBytes)
        putOrNull(obj, "ramTotalBytes", ramTotalBytes)
        putOrNull(obj, "ramAvailBytes", ramAvailBytes)
        return obj
    }

    companion object {
        private fun putOrNull(obj: JSONObject, key: String, value: Any?) {
            if (value == null) obj.put(key, JSONObject.NULL) else obj.put(key, value)
        }

        fun fromJson(obj: JSONObject?): DeviceMetrics? {
            if (obj == null) return null
            return DeviceMetrics(
                batteryPct = if (obj.isNull("batteryPct")) null else obj.optInt("batteryPct").takeIf { it in 0..100 },
                charging = if (obj.isNull("charging")) null else obj.optBoolean("charging"),
                storageTotalBytes = if (obj.isNull("storageTotalBytes")) null else obj.optLong("storageTotalBytes").takeIf { it > 0 },
                storageFreeBytes = if (obj.isNull("storageFreeBytes")) null else obj.optLong("storageFreeBytes").takeIf { it >= 0 },
                ramTotalBytes = if (obj.isNull("ramTotalBytes")) null else obj.optLong("ramTotalBytes").takeIf { it > 0 },
                ramAvailBytes = if (obj.isNull("ramAvailBytes")) null else obj.optLong("ramAvailBytes").takeIf { it > 0 },
            )
        }

        fun fromJsonString(json: String): DeviceMetrics? {
            return try {
                fromJson(JSONObject(json))
            } catch (_: Exception) {
                null
            }
        }
    }
}
