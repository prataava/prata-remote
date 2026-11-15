package com.prata.remote.agent.ui

// PRATA Remote — Layar Unpaired Agent (Command 002, Tugas 2)
// Menampilkan QR pairing + kode + hitung mundur kedaluwarsa, dan terus
// polling sampai controller memindai. Alamat server bisa diubah di sini.
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.prata.remote.agent.util.QrBitmap

@Composable
fun UnpairedScreen(
    pairingCode: String,
    qrPayload: String,
    secondsLeft: Int,
    isPolling: Boolean,
    error: String?,
    serverUrl: String,
    onServerUrlChanged: (String) -> Unit,
    onSaveServerUrl: () -> Unit,
    onRefreshPairing: () -> Unit,
) {
    val qrBitmap = remember(qrPayload) {
        if (qrPayload.isBlank()) null else QrBitmap.encode(qrPayload)
    }
    val minutes = secondsLeft / 60
    val seconds = secondsLeft % 60
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
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Perangkat ini belum terdaftar. Minta controller memindai QR di bawah.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(24.dp))
        OutlinedTextField(
            value = serverUrl,
            onValueChange = onServerUrlChanged,
            label = { Text("Alamat server") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(8.dp))
        Button(onClick = onSaveServerUrl, modifier = Modifier.fillMaxWidth()) {
            Text("Simpan alamat server")
        }
        Spacer(modifier = Modifier.height(24.dp))
        if (qrPayload.isBlank() && error == null) {
            CircularProgressIndicator()
            Spacer(modifier = Modifier.height(12.dp))
            Text("Meminta kode pairing…")
        } else if (qrBitmap != null) {
            Image(
                bitmap = qrBitmap.asImageBitmap(),
                contentDescription = "QR pairing",
                modifier = Modifier.size(280.dp),
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = pairingCode,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                letterSpacing = 8.sp,
            )
            Spacer(modifier = Modifier.height(8.dp))
            if (secondsLeft > 0) {
                Text("Kode berlaku ${"%02d:%02d".format(minutes, seconds)}")
            }
            Spacer(modifier = Modifier.height(16.dp))
            if (isPolling) {
                CircularProgressIndicator()
                Spacer(modifier = Modifier.height(8.dp))
                Text("Menunggu scan…")
            }
        }
        if (error != null) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(text = error, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            Spacer(modifier = Modifier.height(12.dp))
            Button(onClick = onRefreshPairing, modifier = Modifier.fillMaxWidth()) {
                Text("Coba lagi")
            }
        } else if (qrPayload.isNotBlank()) {
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onRefreshPairing, modifier = Modifier.fillMaxWidth()) {
                Text("Minta kode baru")
            }
        }
    }
}
