package com.prata.remote.controller.ui

// PRATA Remote — Panel File Manager Controller (FINAL, Bagian 2)
// Menjelajahi folder SAF di Agent lewat WebSocket (file_list_request /
// file_list_response), membuat folder, mengganti nama, menghapus (dialog
// konfirmasi Compose — bukan window.confirm), mengunduh file ke Downloads
// HP Controller, dan mengirim file dari HP ini ke Agent (GetContent).
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.prata.remote.controller.FilesUiState
import com.prata.remote.shared.model.FileItemDto
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun FilesPanel(
    state: FilesUiState,
    formatBytes: (Long?) -> String,
    onNavigateUp: () -> Unit,
    onFolderClick: (FileItemDto) -> Unit,
    onFileClick: (FileItemDto) -> Unit,
    onUploadClick: () -> Unit,
    onRefresh: () -> Unit,
    onMkdir: (String) -> Unit,
    onRename: (FileItemDto, String) -> Unit,
    onDelete: (FileItemDto) -> Unit,
    modifier: Modifier = Modifier,
) {
    var showMkdirDialog by remember { mutableStateOf(false) }
    var mkdirName by remember { mutableStateOf("") }
    var renameTarget by remember { mutableStateOf<FileItemDto?>(null) }
    var renameName by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<FileItemDto?>(null) }

    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.path.isNotEmpty()) {
                OutlinedButton(onClick = onNavigateUp) { Text("Atas") }
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(
                text = if (state.path.isEmpty()) "Folder Akses Agent" else state.path.joinToString(" / ") { it.second },
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            Spacer(modifier = Modifier.width(8.dp))
            Button(onClick = onUploadClick) { Text("Kirim File") }
        }
        Spacer(modifier = Modifier.height(8.dp))
        Row(modifier = Modifier.fillMaxWidth()) {
            OutlinedButton(onClick = { showMkdirDialog = true }) { Text("Folder Baru") }
            Spacer(modifier = Modifier.width(8.dp))
            OutlinedButton(onClick = onRefresh) { Text("Muat Ulang") }
        }
        if (state.opStatus != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(state.opStatus, style = MaterialTheme.typography.bodySmall)
        }
        if (state.uploadStatus != null) {
            Spacer(modifier = Modifier.height(4.dp))
            Text(state.uploadStatus, style = MaterialTheme.typography.bodySmall)
        }
        if (state.downloading != null) {
            Spacer(modifier = Modifier.height(4.dp))
            Text("Mengunduh ${state.downloading}…", style = MaterialTheme.typography.bodySmall)
        }
        Spacer(modifier = Modifier.height(8.dp))
        if (state.loading) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
        } else if (state.error != null) {
            Text(state.error, color = MaterialTheme.colorScheme.error)
            Spacer(modifier = Modifier.height(8.dp))
            Button(onClick = onRefresh) { Text("Coba Lagi") }
        } else if (state.items.isEmpty()) {
            Text("Folder kosong.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(state.items, key = { it.docId }) { item ->
                    FileRow(
                        item = item,
                        formatBytes = formatBytes,
                        onClick = { if (item.isDirectory) onFolderClick(item) else onFileClick(item) },
                        onRename = {
                            renameTarget = item
                            renameName = item.name
                        },
                        onDelete = { deleteTarget = item },
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    if (showMkdirDialog) {
        AlertDialog(
            onDismissRequest = { showMkdirDialog = false },
            title = { Text("Folder Baru") },
            text = {
                OutlinedTextField(
                    value = mkdirName,
                    onValueChange = { mkdirName = it },
                    label = { Text("Nama folder") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    onMkdir(mkdirName)
                    mkdirName = ""
                    showMkdirDialog = false
                }) { Text("Buat") }
            },
            dismissButton = {
                TextButton(onClick = { showMkdirDialog = false }) { Text("Batal") }
            },
        )
    }
    val renameItem = renameTarget
    if (renameItem != null) {
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("Ganti Nama") },
            text = {
                OutlinedTextField(
                    value = renameName,
                    onValueChange = { renameName = it },
                    label = { Text("Nama baru") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    onRename(renameItem, renameName)
                    renameTarget = null
                }) { Text("Simpan") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("Batal") }
            },
        )
    }
    val deleteItem = deleteTarget
    if (deleteItem != null) {
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Hapus File?") },
            text = { Text("Hapus \"${deleteItem.name}\" dari Agent? Tindakan ini tidak bisa dibatalkan.") },
            confirmButton = {
                TextButton(onClick = {
                    onDelete(deleteItem)
                    deleteTarget = null
                }) { Text("Hapus") }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Batal") }
            },
        )
    }
}

@Composable
private fun FileRow(
    item: FileItemDto,
    formatBytes: (Long?) -> String,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (item.isDirectory) "[DIR]" else "[FILE]",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.width(48.dp),
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(item.name, fontWeight = FontWeight.Medium)
            Text(
                text = if (item.isDirectory) {
                    "Folder"
                } else {
                    "${formatBytes(item.size)} • ${formatDate(item.lastModified)}"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(onClick = onRename) { Text("Rename") }
        TextButton(onClick = onDelete) { Text("Hapus") }
    }
}

private fun formatDate(epochMs: Long?): String {
    if (epochMs == null) return "—"
    return SimpleDateFormat("dd MMM yyyy HH:mm", Locale.getDefault()).format(Date(epochMs))
}
