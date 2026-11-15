package com.prata.remote.controller.ui

// PRATA Remote — Panel App Manager Controller (FINAL, Bagian 3)
// Daftar aplikasi terpasang di Agent (PackageManager, lewat WS
// app_list_request/response). Buka / Info / Hapus: perintah dikirim ke
// Agent; "Hapus" memunculkan dialog konfirmasi resmi OS di Agent (bukan
// silent uninstall). Filter "hanya non-sistem" di atas daftar.
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
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.prata.remote.controller.AppsUiState

@Composable
fun AppsPanel(
    state: AppsUiState,
    onRefresh: () -> Unit,
    onCommand: (String, String) -> Unit,
    onSystemOnlyChanged: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val shown = if (state.systemOnly) state.apps.filter { !it.isSystemApp } else state.apps
    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "Aplikasi di Agent (${shown.size})",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            OutlinedButton(onClick = onRefresh) { Text("Muat Ulang") }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                checked = state.systemOnly,
                onCheckedChange = onSystemOnlyChanged,
            )
            Text("Hanya aplikasi non-sistem", style = MaterialTheme.typography.bodyMedium)
        }
        if (state.statusText != null) {
            Text(state.statusText, style = MaterialTheme.typography.bodySmall)
            Spacer(modifier = Modifier.height(4.dp))
        }
        if (state.loading) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.CenterHorizontally))
        } else if (state.error != null) {
            Text(state.error, color = MaterialTheme.colorScheme.error)
            Spacer(modifier = Modifier.height(8.dp))
            Button(onClick = onRefresh) { Text("Coba Lagi") }
        } else if (shown.isEmpty()) {
            Text("Tidak ada aplikasi.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(shown, key = { it.packageName }) { app ->
                    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(app.label, fontWeight = FontWeight.Medium)
                                Text(
                                    text = app.packageName + (if (app.versionName != null) " • v${app.versionName}" else ""),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                if (app.isSystemApp) {
                                    Text(
                                        "Aplikasi sistem",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                            }
                        }
                        Spacer(modifier = Modifier.height(6.dp))
                        Row {
                            TextButton(onClick = { onCommand("open", app.packageName) }) { Text("Buka") }
                            TextButton(onClick = { onCommand("settings", app.packageName) }) { Text("Info") }
                            Spacer(modifier = Modifier.width(8.dp))
                            TextButton(onClick = { onCommand("uninstall", app.packageName) }) { Text("Hapus") }
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}
