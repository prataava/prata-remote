package com.prata.remote.controller.ui

// PRATA Remote — Panel Monitor perangkat (Command 007, Phase 3)
// Menampilkan metrik terbaru dari Agent: baterai, penyimpanan, RAM.
// Nilai null = tidak bisa dibaca di perangkat itu — ditampilkan sebagai
// "Tidak diketahui", BUKAN angka hardcode.
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.prata.remote.shared.model.DeviceMetrics
import java.util.Locale

@Composable
fun MonitorPanel(
    metrics: DeviceMetrics?,
    updatedAt: Long?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "Monitor Perangkat",
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.height(8.dp))
        if (metrics == null) {
            Text(
                text = "Menunggu metrik pertama dari Agent…",
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            CircularProgressIndicator()
        } else {
            val battery = metrics.batteryPct
            MetricCard(
                title = "Baterai",
                fraction = battery?.let { it / 100f },
                headline = if (battery != null) {
                    "$battery%" + if (metrics.charging == true) " • Mengisi daya" else ""
                } else {
                    "Tidak diketahui"
                },
                detail = "Diperbarui tiap 15 detik dari Agent.",
            )
            Spacer(modifier = Modifier.height(16.dp))
            val storageTotal = metrics.storageTotalBytes
            val storageFree = metrics.storageFreeBytes
            val storageUsed = if (storageTotal != null && storageFree != null) {
                (storageTotal - storageFree).coerceAtLeast(0)
            } else {
                null
            }
            MetricCard(
                title = "Penyimpanan",
                fraction = if (storageTotal != null && storageTotal > 0 && storageUsed != null) {
                    storageUsed.toFloat() / storageTotal.toFloat()
                } else {
                    null
                },
                headline = if (storageFree != null) {
                    "${formatBytes(storageFree)} bebas"
                } else {
                    "Tidak diketahui"
                },
                detail = "dari ${formatBytes(storageTotal)} total.",
            )
            Spacer(modifier = Modifier.height(16.dp))
            val ramTotal = metrics.ramTotalBytes
            val ramAvail = metrics.ramAvailBytes
            val ramUsed = if (ramTotal != null && ramAvail != null) {
                (ramTotal - ramAvail).coerceAtLeast(0)
            } else {
                null
            }
            MetricCard(
                title = "RAM",
                fraction = if (ramTotal != null && ramTotal > 0 && ramUsed != null) {
                    ramUsed.toFloat() / ramTotal.toFloat()
                } else {
                    null
                },
                headline = if (ramAvail != null) {
                    "${formatBytes(ramAvail)} tersedia"
                } else {
                    "Tidak diketahui"
                },
                detail = "dari ${formatBytes(ramTotal)} total.",
            )
            if (updatedAt != null) {
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = "Terakhir diperbarui ${android.text.format.DateFormat.format("HH:mm:ss", updatedAt)}",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MetricCard(
    title: String,
    fraction: Float?,
    headline: String,
    detail: String,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(modifier = Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (fraction != null) {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.size(64.dp)) {
                    CircularProgressIndicator(progress = { fraction }, modifier = Modifier.size(64.dp))
                    Text(
                        text = "${(fraction * 100).toInt()}%",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                    )
                }
            } else {
                Box(contentAlignment = Alignment.Center, modifier = Modifier.size(64.dp)) {
                    Text(text = "?", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                }
            }
            Spacer(modifier = Modifier.width(16.dp))
            Column {
                Text(text = title, fontWeight = FontWeight.Bold)
                Text(text = headline, fontSize = 18.sp)
                Text(text = detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun formatBytes(bytes: Long?): String {
    if (bytes == null) return "Tidak diketahui"
    if (bytes < 1024) return "$bytes B"
    val units = arrayOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit++
    }
    return String.format(Locale.US, "%.1f %s", value, units[unit])
}
