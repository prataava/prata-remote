package com.prata.remote.controller.ui

// PRATA Remote — Panel Notifikasi Controller (FINAL, Bagian 4)
// Notifikasi perangkat Agent yang diteruskan lewat WebSocket
// (device_notification) + alert otomatisasi terbaru di atas daftar.
// Filter per aplikasi memakai chip dari packageName yang sudah masuk.
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.prata.remote.shared.signaling.SignalingEvent
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun NotificationsPanel(
    notifications: List<SignalingEvent.DeviceNotificationReceived>,
    alerts: List<SignalingEvent.AutomationAlertReceived>,
    modifier: Modifier = Modifier,
) {
    var selectedPackage by remember { mutableStateOf<String?>(null) }
    val packages = notifications.map { it.packageName }.distinct()
    val shown = if (selectedPackage == null) notifications else notifications.filter { it.packageName == selectedPackage }

    Column(modifier = modifier.fillMaxSize().padding(16.dp)) {
        if (alerts.isNotEmpty()) {
            Text("Alert Otomatisasi", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(8.dp))
            alerts.forEach { alert ->
                Text(
                    text = "• ${alert.message}",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
        }
        Text("Notifikasi dari Agent (${shown.size})", style = MaterialTheme.typography.titleSmall)
        Spacer(modifier = Modifier.height(8.dp))
        if (packages.size > 1) {
            Row(modifier = Modifier.fillMaxWidth()) {
                FilterChip(
                    selected = selectedPackage == null,
                    onClick = { selectedPackage = null },
                    label = { Text("Semua") },
                )
                packages.forEach { pkg ->
                    FilterChip(
                        selected = selectedPackage == pkg,
                        onClick = { selectedPackage = pkg },
                        label = { Text(pkg.substringAfterLast('.').take(14)) },
                    )
                }
            }
            Spacer(modifier = Modifier.height(8.dp))
        }
        if (shown.isEmpty()) {
            Text(
                "Belum ada notifikasi masuk. Notifikasi perangkat Agent akan muncul di sini saat tiba.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            LazyColumn(modifier = Modifier.fillMaxSize()) {
                items(shown, key = { it.at + it.packageName + (it.title ?: "") }) { notif ->
                    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                        Text(notif.appName, fontWeight = FontWeight.Medium)
                        if (!notif.title.isNullOrBlank()) {
                            Text(notif.title, style = MaterialTheme.typography.bodyMedium)
                        }
                        if (!notif.text.isNullOrBlank()) {
                            Text(
                                notif.text,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Text(
                            formatNotifTime(notif.at),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

private fun formatNotifTime(iso: String): String {
    return try {
        val parsed = java.time.Instant.parse(iso)
        SimpleDateFormat("dd MMM HH:mm:ss", Locale.getDefault())
            .format(Date.from(parsed))
    } catch (_: Exception) {
        iso
    }
}
