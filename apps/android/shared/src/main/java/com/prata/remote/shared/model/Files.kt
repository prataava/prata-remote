package com.prata.remote.shared.model

// PRATA Remote — DTO file manager & transfer (Command 008, Phase 3)
// FileItemDto dipakai di WebSocket (file_list_request/response) maupun
// REST. docId = document ID SAF; root folder = docId null di request.
import org.json.JSONArray
import org.json.JSONObject

data class FileItemDto(
    val name: String,
    val isDirectory: Boolean,
    val size: Long?,
    val mimeType: String?,
    val lastModified: Long?,
    val docId: String,
) {
    fun toJson(): JSONObject {
        val obj = JSONObject()
        obj.put("name", name)
        obj.put("isDirectory", isDirectory)
        if (size != null) obj.put("size", size) else obj.put("size", JSONObject.NULL)
        if (mimeType != null) obj.put("mimeType", mimeType) else obj.put("mimeType", JSONObject.NULL)
        if (lastModified != null) obj.put("lastModified", lastModified) else obj.put("lastModified", JSONObject.NULL)
        obj.put("docId", docId)
        return obj
    }

    companion object {
        fun fromJson(obj: JSONObject?): FileItemDto? {
            if (obj == null) return null
            return try {
                FileItemDto(
                    name = obj.getString("name"),
                    isDirectory = obj.optBoolean("isDirectory"),
                    size = if (obj.isNull("size")) null else obj.optLong("size"),
                    mimeType = if (obj.isNull("mimeType")) null else obj.optString("mimeType").ifEmpty { null },
                    lastModified = if (obj.isNull("lastModified")) null else obj.optLong("lastModified"),
                    docId = obj.getString("docId"),
                )
            } catch (_: Exception) {
                null
            }
        }

        fun listFromJson(array: JSONArray?): List<FileItemDto> {
            if (array == null) return emptyList()
            val out = mutableListOf<FileItemDto>()
            for (i in 0 until array.length()) {
                fromJson(array.optJSONObject(i))?.let { out.add(it) }
            }
            return out
        }
    }
}

data class CreateTransferRequest(
    val deviceId: String,
    val docId: String,
    val fileName: String,
    val size: Long? = null,
    val mimeType: String? = null,
)

data class CreateTransferResponse(
    val transferId: String,
    val fileName: String,
    val status: String,
)

data class PutBlobResponse(
    val transferId: String,
    val status: String,
    val size: Long,
)

data class TransferStatusResponse(
    val transfer: TransferInfo,
)

data class TransferInfo(
    val transferId: String,
    val deviceId: String,
    val direction: String,
    val docId: String?,
    val fileName: String,
    val mimeType: String?,
    val size: Long?,
    val status: String,
    val error: String?,
)

data class UploadFileResponse(
    val transferId: String,
    val fileName: String,
    val size: Long,
    val status: String,
)
