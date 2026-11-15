package com.prata.remote.agent.service

// PRATA Remote — Manajer file SAF Agent (FINAL, Bagian 2)
// SEMUA akses file lewat Storage Access Framework (DocumentFile +
// ContentResolver). DILARANG MANAGE_EXTERNAL_STORAGE / akses /sdcard
// langsung. Folder root = tree URI yang dipilih user; bila belum dipilih,
// semua operasi melempar IllegalStateException("saf-folder-not-granted")
// agar server membalas error jujur ke Controller.
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import com.prata.remote.shared.model.FileItemDto
import java.io.InputStream

object FileBrowser {
    private const val TAG = "PRATA-SAF"

    fun resolveDir(context: Context, treeUri: Uri, docId: String?): DocumentFile? {
        return if (docId == null) {
            DocumentFile.fromTreeUri(context, treeUri)
        } else {
            val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
            DocumentFile.fromSingleUri(context, docUri)
        }
    }

    fun resolveFile(context: Context, treeUri: Uri, docId: String): DocumentFile? {
        val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
        return DocumentFile.fromSingleUri(context, docUri)
    }

    /** Daftar isi folder (root bila docId null). Folder dulu, lalu nama. */
    fun listFolder(context: Context, treeUri: Uri, docId: String?): List<FileItemDto> {
        val dir = resolveDir(context, treeUri, docId)
            ?: throw IllegalStateException("folder-tidak-ditemukan")
        if (!dir.isDirectory) throw IllegalStateException("bukan-folder")
        val files = dir.listFiles()
        return files.map { file ->
            FileItemDto(
                name = file.name ?: "tanpa-nama",
                isDirectory = file.isDirectory,
                size = if (file.isDirectory) null else file.length(),
                mimeType = file.type,
                lastModified = file.lastModified().takeIf { it > 0 },
                docId = DocumentsContract.getDocumentId(file.uri),
            )
        }.sortedWith(compareByDescending<FileItemDto> { it.isDirectory }.thenBy { it.name.lowercase() })
    }

    /** Buka InputStream untuk mengunggah file yang diminta Controller. */
    fun openInputStream(context: Context, treeUri: Uri, docId: String): InputStream? {
        val file = resolveFile(context, treeUri, docId) ?: return null
        if (!file.isFile) return null
        return context.contentResolver.openInputStream(file.uri)
    }

    /** Simpan file kiriman Controller ke folder tujuan (root bila null).
     *  Kembalikan nama akhir file yang dibuat (unik bila nama sudah ada). */
    fun saveIncomingFile(
        context: Context,
        treeUri: Uri,
        folderDocId: String?,
        fileName: String,
        mimeType: String?,
        input: InputStream,
    ): String {
        val folder = resolveDir(context, treeUri, folderDocId)
            ?: throw IllegalStateException("folder-tujuan-tidak-ditemukan")
        if (!folder.isDirectory) throw IllegalStateException("tujuan-bukan-folder")
        val finalName = uniqueName(folder, sanitizeName(fileName))
        val created = folder.createFile(mimeType ?: "application/octet-stream", finalName)
            ?: throw IllegalStateException("gagal-membuat-file")
        val output = context.contentResolver.openOutputStream(created.uri)
            ?: throw IllegalStateException("gagal-membuka-output")
        output.use { out ->
            input.copyTo(out, 8192)
        }
        Log.i(TAG, "file tersimpan: $finalName")
        return finalName
    }

    /** Buat sub-folder di dalam folder tujuan (root bila null). */
    fun mkdir(context: Context, treeUri: Uri, parentDocId: String?, name: String): String {
        val parent = resolveDir(context, treeUri, parentDocId)
            ?: throw IllegalStateException("folder-induk-tidak-ditemukan")
        if (!parent.isDirectory) throw IllegalStateException("induk-bukan-folder")
        val clean = sanitizeName(name)
        if (clean.isBlank()) throw IllegalStateException("nama-folder-kosong")
        val existing = parent.findFile(clean)
        if (existing != null) throw IllegalStateException("folder-sudah-ada")
        val created = parent.createDirectory(clean)
            ?: throw IllegalStateException("gagal-membuat-folder")
        return DocumentsContract.getDocumentId(created.uri)
    }

    /** Ganti nama file/folder. */
    fun rename(context: Context, treeUri: Uri, docId: String, newName: String): String {
        val file = resolveFile(context, treeUri, docId)
            ?: throw IllegalStateException("file-tidak-ditemukan")
        val clean = sanitizeName(newName)
        if (clean.isBlank()) throw IllegalStateException("nama-baru-kosong")
        if (!file.renameTo(clean)) throw IllegalStateException("gagal-mengubah-nama")
        return DocumentsContract.getDocumentId(file.uri)
    }

    /** Hapus file/folder (rekursif untuk folder, sesuai DocumentFile). */
    fun delete(context: Context, treeUri: Uri, docId: String) {
        val file = resolveFile(context, treeUri, docId)
            ?: throw IllegalStateException("file-tidak-ditemukan")
        if (!file.delete()) throw IllegalStateException("gagal-menghapus")
    }

    private fun sanitizeName(name: String): String {
        // Buang pemisah path + karakter kontrol; batasi 200 karakter.
        val clean = name.replace(Regex("[/\\\\:*?\"<>|\\x00-\\x1F]"), "_").trim().take(200)
        return clean.ifEmpty { "file" }
    }

    private fun uniqueName(folder: DocumentFile, base: String): String {
        if (folder.findFile(base) == null) return base
        val dot = base.lastIndexOf('.')
        val stem = if (dot > 0) base.substring(0, dot) else base
        val ext = if (dot > 0) base.substring(dot) else ""
        var i = 1
        while (true) {
            val candidate = "$stem ($i)$ext"
            if (folder.findFile(candidate) == null) return candidate
            i++
        }
    }
}
