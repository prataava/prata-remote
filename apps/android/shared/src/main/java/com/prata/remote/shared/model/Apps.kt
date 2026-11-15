package com.prata.remote.shared.model

// PRATA Remote — DTO aplikasi terpasang (FINAL, Bagian 3 — App Manager)
// Dikirim Agent lewat WS app_list_response; dipakai Controller + Web.
import org.json.JSONArray
import org.json.JSONObject

data class AppInfoDto(
    val packageName: String,
    val label: String,
    val versionName: String?,
    val isSystemApp: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("packageName", packageName)
        .put("label", label)
        .put("versionName", if (versionName != null) versionName else JSONObject.NULL)
        .put("isSystemApp", isSystemApp)

    companion object {
        fun fromJson(obj: JSONObject?): AppInfoDto? {
            if (obj == null) return null
            return try {
                AppInfoDto(
                    packageName = obj.optString("packageName"),
                    label = obj.optString("label"),
                    versionName = if (obj.isNull("versionName")) null else obj.optString("versionName").ifEmpty { null },
                    isSystemApp = obj.optBoolean("isSystemApp", false),
                ).takeIf { it.packageName.isNotBlank() }
            } catch (_: Exception) {
                null
            }
        }

        fun listFromJson(array: JSONArray?): List<AppInfoDto> {
            if (array == null) return emptyList()
            val out = mutableListOf<AppInfoDto>()
            for (i in 0 until array.length()) {
                fromJson(array.optJSONObject(i))?.let { out.add(it) }
            }
            return out
        }
    }
}
