package com.prata.remote.agent.ui

// PRATA Remote — Layar Paired Agent (Command 002 Tugas 2 + Command 003 Tugas 2 + Command 005)
// Dashboard status: terhubung/tidak, id perangkat, alamat server, dan
// tombol mulai/berhenti yang benar-benar mengendalikan Foreground Service
// + koneksi WebSocket. Kartu "Berbagi Layar": mulai/berhenti berbagi layar
// secara nyata — mulai SELALU lewat dialog persetujuan sistem Android.
// Kartu "Kontrol Jarak Jauh": status AccessibilityService + tombol ke
// Pengaturan (aktivasi manual, tidak bisa di-bypass).
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.prata.remote.agent.SharingState
import com.prata.remote.shared.signaling.ConnectionState

@Composable
fun PairedScreen(
    deviceId: String,
    wsState: ConnectionState,
    running: Boolean,
    error: String?,
    serverUrl: String,
    sharing: SharingState,
    iceText: String?,
    a11yEnabled: Boolean,
    safFolderName: String?,
    notifEnabled: Boolean,
    camera: SharingState,
    cameraFacing: String,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onStartSharing: () -> Unit,
    onStopSharing: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onPickSafFolder: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    onRequestCameraPermission: () -> Unit,
    onStopCamera: () -> Unit,
) {
    val statusText = when (wsState) {
        is ConnectionState.Connected -> "Agent Aktif & Terhubung"
        is ConnectionState.Connecting -> "Menghubungkan ke server…"
        is ConnectionState.Error -> "Gagal terhubung: ${wsState.message}"
        is ConnectionState.Disconnected -> "Terputus dari server"
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        Text(
            text = "PRATA Remote Agent",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.height(24.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = statusText, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(12.dp))
                Text(text = "ID perangkat:", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(text = deviceId)
                Spacer(modifier = Modifier.height(8.dp))
                Text(text = "Server:", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(text = serverUrl)
            }
        }
        Spacer(modifier = Modifier.height(24.dp))
        if (running) {
            Button(onClick = onStop, modifier = Modifier.fillMaxWidth()) {
                Text("Berhenti")
            }
        } else {
            Button(onClick = onStart, modifier = Modifier.fillMaxWidth()) {
                Text("Mulai Lagi")
            }
        }
        if (error != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(text = error, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
        Spacer(modifier = Modifier.height(24.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = "Berbagi Layar", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(8.dp))
                val sharingText = when (sharing) {
                    is SharingState.Off -> "Berbagi layar mati"
                    is SharingState.WaitingProjection -> "Menunggu izin tangkap layar…"
                    is SharingState.On -> "Berbagi layar AKTIF"
                    is SharingState.Failed -> "Gagal: ${sharing.message}"
                }
                Text(text = sharingText)
                if (iceText != null) {
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(text = iceText, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Spacer(modifier = Modifier.height(12.dp))
                if (sharing is SharingState.On || sharing is SharingState.WaitingProjection) {
                    Button(onClick = onStopSharing, modifier = Modifier.fillMaxWidth()) {
                        Text("Berhenti Berbagi")
                    }
                } else {
                    Button(onClick = onStartSharing, modifier = Modifier.fillMaxWidth()) {
                        Text("Mulai Berbagi Layar")
                    }
                }
            }
        }
        Spacer(modifier = Modifier.height(24.dp))
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = "Kontrol Jarak Jauh", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = if (a11yEnabled) {
                        "Aksesibilitas: Aktif — Controller bisa mengetuk layar ini."
                    } else {
                        "Aksesibilitas: Tidak Aktif — Controller hanya bisa melihat layar."
                    },
                )
                if (!a11yEnabled) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(onClick = onOpenAccessibilitySettings, modifier = Modifier.fillMaxWidth()) {
                        Text("Buka Pengaturan Aksesibilitas")
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Android tidak mengizinkan aplikasi mengaktifkan layanan ini sendiri. Aktifkan \"PRATA Remote — Kontrol Jarak Jauh\" secara manual di Pengaturan > Aksesibilitas.",
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Berbagi layar meminta persetujuanmu setiap kali: ketuk \"Mulai Berbagi Layar\", lalu ketuk \"Start Now\" di dialog sistem Android. Berhenti kapan saja dari tombol di atas.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(24.dp))
        // FINAL (Bagian 2): kartu izin Folder Akses File (SAF). Tanpa folder
        // ini Controller tidak bisa melihat atau mengirim file ke perangkat.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = "Folder Akses File", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = if (safFolderName != null) {
                        "Folder terpilih: $safFolderName — Controller bisa menjelajahi dan mengirim file ke folder ini."
                    } else {
                        "Belum ada folder yang dipilih — File Manager Controller belum bisa dipakai."
                    },
                )
                Spacer(modifier = Modifier.height(12.dp))
                Button(onClick = onPickSafFolder, modifier = Modifier.fillMaxWidth()) {
                    Text(if (safFolderName != null) "Ganti Folder yang Diizinkan" else "Pilih Folder yang Diizinkan")
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Folder dipilih lewat pemilih dokumen sistem (Storage Access Framework). PRATA Remote tidak mengakses file di luar folder yang kamu pilih.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(modifier = Modifier.height(24.dp))
        // FINAL (Bagian 4): kartu status akses notifikasi.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = "Notifikasi Perangkat", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = if (notifEnabled) {
                        "Akses notifikasi: Aktif — notifikasi perangkat diteruskan ke Controller."
                    } else {
                        "Akses notifikasi: Tidak Aktif — Controller tidak menerima notifikasi dari perangkat ini."
                    },
                )
                if (!notifEnabled) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Button(onClick = onOpenNotificationSettings, modifier = Modifier.fillMaxWidth()) {
                        Text("Buka Pengaturan Notifikasi")
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Aktifkan \"PRATA Remote — Notifikasi\" secara manual di Pengaturan > Akses Notifikasi.",
                        textAlign = TextAlign.Center,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(24.dp))
        // FINAL (Bagian 5): kartu kamera — izin + status sesi kamera remote.
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        ) {
            Column(modifier = Modifier.padding(20.dp)) {
                Text(text = "Kamera", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(8.dp))
                val cameraText = when (camera) {
                    is SharingState.Off -> "Kamera tidak sedang diakses dari jarak jauh."
                    is SharingState.WaitingProjection -> "Menunggu kamera…"
                    is SharingState.On -> "Kamera ${if (cameraFacing == "front") "depan" else "belakang"} SEDANG DIAKSES dari jarak jauh."
                    is SharingState.Failed -> "Kamera: ${camera.message}"
                }
                Text(text = cameraText)
                Spacer(modifier = Modifier.height(12.dp))
                if (camera is SharingState.On) {
                    Button(onClick = onStopCamera, modifier = Modifier.fillMaxWidth()) {
                        Text("Hentikan Kamera")
                    }
                } else {
                    Button(onClick = onRequestCameraPermission, modifier = Modifier.fillMaxWidth()) {
                        Text("Izinkan Akses Kamera")
                    }
                }
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "Sesi kamera hanya dimulai dari Controller dan selalu disertai notifikasi mencolok di HP ini. Hentikan kapan saja dari tombol di atas.",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
