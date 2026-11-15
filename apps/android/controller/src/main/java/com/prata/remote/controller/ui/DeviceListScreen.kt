package com.prata.remote.controller.ui

// PRATA Remote — Layar daftar perangkat Controller (Command 002, Tugas 3)
// Memuat GET /api/devices lewat DevicesViewModel. Chip status: online
// hijau, connecting kuning, offline abu-abu. Refresh dan keluar benar-benar
// memanggil ViewModel; FAB membuka pemindai QR.
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.prata.remote.controller.DevicesViewModel
import com.prata.remote.controller.security.AppLock
import com.prata.remote.shared.model.DeviceDto

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceListScreen(
    viewModel: DevicesViewModel,
    onScanClick: () -> Unit,
    onNavigateToLogin: () -> Unit,
    onDeviceClick: (DeviceDto) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current
    var showLockDialog by remember { mutableStateOf(false) }

    LaunchedEffect(state.isLoggedIn) {
        if (!state.isLoggedIn) onNavigateToLogin()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Perangkat Saya") },
                actions = {
                    // FINAL (Bagian 6): pengaturan kunci aplikasi (PIN).
                    IconButton(onClick = { showLockDialog = true }) {
                        Icon(Icons.Filled.Lock, contentDescription = "Kunci Aplikasi")
                    }
                    IconButton(onClick = viewModel::loadDevices) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Muat ulang")
                    }
                    IconButton(onClick = viewModel::logout) {
                        Icon(Icons.Filled.ExitToApp, contentDescription = "Keluar")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = onScanClick) {
                Text("Scan QR")
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp),
        ) {
            if (state.isLoading && state.devices.isEmpty()) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
            state.error?.let { error ->
                Text(error, color = MaterialTheme.colorScheme.error)
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(onClick = viewModel::loadDevices) {
                    Text("Coba lagi")
                }
                Spacer(modifier = Modifier.height(8.dp))
            }
            if (!state.isLoading && state.devices.isEmpty() && state.error == null) {
                Text("Belum ada perangkat. Ketuk tombol scan untuk pairing.")
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.devices, key = { it.id }) { device ->
                    DeviceCard(device, onDeviceClick)
                }
            }
        }
    }

    if (showLockDialog) {
        AppLockDialog(
            pinSet = AppLock.isPinSet(context),
            biometricEnabled = AppLock.isBiometricEnabled(context),
            onSetPin = { pin -> AppLock.setPin(context, pin) },
            onVerifyPin = { pin -> AppLock.verifyPin(context, pin) },
            onClearPin = { AppLock.clearPin(context) },
            onBiometricChanged = { enabled -> AppLock.setBiometricEnabled(context, enabled) },
            onDismiss = { showLockDialog = false },
        )
    }
}

@Composable
private fun AppLockDialog(
    pinSet: Boolean,
    biometricEnabled: Boolean,
    onSetPin: (String) -> Boolean,
    onVerifyPin: (String) -> Boolean,
    onClearPin: () -> Unit,
    onBiometricChanged: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var oldPin by remember { mutableStateOf("") }
    var newPin by remember { mutableStateOf("") }
    var confirmPin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var bioEnabled by remember { mutableStateOf(biometricEnabled) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Kunci Aplikasi") },
        text = {
            Column {
                Text(
                    if (pinSet) "PIN sudah aktif. Aplikasi meminta PIN setiap dibuka."
                    else "Atur PIN 4–6 digit agar aplikasi meminta PIN setiap dibuka.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(modifier = Modifier.height(12.dp))
                if (pinSet) {
                    OutlinedTextField(
                        value = oldPin,
                        onValueChange = { oldPin = it.filter { c -> c.isDigit() }.take(6) },
                        label = { Text("PIN lama") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }
                OutlinedTextField(
                    value = newPin,
                    onValueChange = { newPin = it.filter { c -> c.isDigit() }.take(6) },
                    label = { Text(if (pinSet) "PIN baru" else "PIN baru (4–6 digit)") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedTextField(
                    value = confirmPin,
                    onValueChange = { confirmPin = it.filter { c -> c.isDigit() }.take(6) },
                    label = { Text("Ulangi PIN baru") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (pinSet) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = bioEnabled,
                            onCheckedChange = {
                                bioEnabled = it
                                onBiometricChanged(it)
                            },
                        )
                        Text("Izinkan buka dengan biometrik", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                message?.let {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (pinSet && !onVerifyPin(oldPin)) {
                    message = "PIN lama salah."
                    return@TextButton
                }
                if (!AppLock.isValidPin(newPin)) {
                    message = "PIN harus 4–6 digit angka."
                    return@TextButton
                }
                if (newPin != confirmPin) {
                    message = "PIN baru tidak cocok dengan ulangan."
                    return@TextButton
                }
                if (onSetPin(newPin)) onDismiss() else message = "Gagal menyimpan PIN."
            }) { Text("Simpan PIN") }
        },
        dismissButton = {
            Row {
                if (pinSet) {
                    TextButton(onClick = {
                        if (!onVerifyPin(oldPin)) {
                            message = "PIN lama salah."
                            return@TextButton
                        }
                        onClearPin()
                        onDismiss()
                    }) { Text("Matikan Kunci") }
                }
                TextButton(onClick = onDismiss) { Text("Tutup") }
            }
        },
    )
}

@Composable
private fun DeviceCard(device: DeviceDto, onClick: (DeviceDto) -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable { onClick(device) },
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    device.name,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                StatusChip(device.status)
            }
            device.model?.let { model ->
                Spacer(modifier = Modifier.height(4.dp))
                Text(model, style = MaterialTheme.typography.bodyMedium)
            }
            device.manufacturer?.let { manufacturer ->
                Text(manufacturer, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                "Terakhir terlihat: ${device.lastSeenAt ?: "belum pernah"}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun StatusChip(status: String) {
    val (label, color) = when (status.lowercase()) {
        "online" -> "Online" to Color(0xFF43A047)
        "connecting" -> "Menghubungkan" to Color(0xFFFFC107)
        else -> "Offline" to Color(0xFF8A94A6)
    }
    Surface(
        color = color.copy(alpha = 0.15f),
        shape = RoundedCornerShape(12.dp),
    ) {
        Text(
            label,
            color = color,
            style = MaterialTheme.typography.labelMedium,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}
