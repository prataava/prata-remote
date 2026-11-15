package com.prata.remote.controller.ui

// PRATA Remote — Layar Kunci PIN Controller (FINAL, Bagian 6)
// Keypad PIN Compose: 4–6 digit, titik indikator, tombol hapus.
// Dipanggil saat aplikasi dibuka bila PIN sudah diatur. Biometrik
// (bila diaktifkan) tampil sebagai tombol alternatif; pemindaian
// biometrik dijalankan MainActivity lewat BiometricPrompt.
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun LockScreen(
    onPinEntered: (String) -> Boolean,
    biometricAvailable: Boolean,
    onBiometricClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "PRATA Remote",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Masukkan PIN aplikasi untuk membuka Controller.",
            textAlign = TextAlign.Center,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(32.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            repeat(6) { i ->
                Surface(
                    shape = CircleShape,
                    color = if (i < pin.length) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.size(16.dp),
                ) {}
            }
        }
        error?.let {
            Spacer(modifier = Modifier.height(16.dp))
            Text(it, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
        }
        Spacer(modifier = Modifier.height(32.dp))
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫")
        keys.chunked(3).forEach { row ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                row.forEach { key ->
                    if (key.isEmpty()) {
                        Spacer(modifier = Modifier.weight(1f))
                    } else {
                        OutlinedButton(
                            onClick = {
                                when (key) {
                                    "⌫" -> pin = pin.dropLast(1)
                                    else -> {
                                        if (pin.length < 6) {
                                            pin += key
                                            if (pin.length >= 4) {
                                                // Verifikasi saat 4–6 digit; bila
                                                // salah di 4 digit pertama user
                                                // bisa lanjut mengetik sampai 6.
                                                if (onPinEntered(pin)) {
                                                    pin = ""
                                                } else if (pin.length == 6) {
                                                    error = "PIN salah. Coba lagi."
                                                    pin = ""
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            modifier = Modifier.weight(1f).height(56.dp),
                        ) {
                            Text(key, fontSize = 20.sp)
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
        }
        if (biometricAvailable) {
            Spacer(modifier = Modifier.height(16.dp))
            Button(onClick = onBiometricClick, modifier = Modifier.fillMaxWidth()) {
                Text("Buka dengan Biometrik")
            }
        }
    }
}
