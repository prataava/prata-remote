package com.prata.remote.agent

// PRATA Remote — MainActivity Agent (Command 002 Tugas 2 + Command 003 Tugas 2)
// Satu layar yang beralih Unpaired (QR) <-> Paired (dashboard) mengikuti
// state ViewModel. Meminta izin notifikasi (Android 13+) untuk notifikasi
// persistent Foreground Service. Izin tangkap layar diminta lewat
// MediaProjectionManager — dialog sistem, user HARUS tap "Start Now".
import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.prata.remote.agent.ui.PairedScreen
import com.prata.remote.agent.ui.PrataTheme
import com.prata.remote.agent.ui.UnpairedScreen

class MainActivity : ComponentActivity() {
    private val viewModel: AgentViewModel by viewModels()

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* hasil izin tidak mengubah alur; notifikasi FGS tetap dibuat sistem */ }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            viewModel.onScreenCaptureResult(result.resultCode, result.data)
        } else {
            viewModel.onScreenCaptureDenied()
        }
    }

    // Pemilih folder SAF (Command 008 / FINAL Bagian 2): folder yang dipilih
    // disimpan persisten agar Agent bisa melayani File Manager Controller.
    private val safFolderLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri != null) viewModel.onSafFolderPicked(uri)
    }

    private val cameraPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        viewModel.onCameraPermissionResult(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (!granted) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            PrataTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val state by viewModel.uiState.collectAsState()
                    val serverUrl by viewModel.serverUrl.collectAsState()
                    when (val current = state) {
                        is AgentUiState.Loading -> UnpairedScreen(
                            pairingCode = "",
                            qrPayload = "",
                            secondsLeft = 0,
                            isPolling = false,
                            error = null,
                            serverUrl = serverUrl,
                            onServerUrlChanged = viewModel::onServerUrlChanged,
                            onSaveServerUrl = viewModel::saveServerUrl,
                            onRefreshPairing = viewModel::refreshPairing,
                        )
                        is AgentUiState.Unpaired -> UnpairedScreen(
                            pairingCode = current.pairingCode,
                            qrPayload = current.qrPayload,
                            secondsLeft = current.secondsLeft,
                            isPolling = current.isPolling,
                            error = current.error,
                            serverUrl = serverUrl,
                            onServerUrlChanged = viewModel::onServerUrlChanged,
                            onSaveServerUrl = viewModel::saveServerUrl,
                            onRefreshPairing = viewModel::refreshPairing,
                        )
                        is AgentUiState.Paired -> PairedScreen(
                            deviceId = current.deviceId,
                            wsState = current.wsState,
                            running = current.running,
                            error = current.error,
                            serverUrl = serverUrl,
                            sharing = current.sharing,
                            iceText = current.iceText,
                            a11yEnabled = current.a11yEnabled,
                            safFolderName = current.safFolderName,
                            notifEnabled = current.notifEnabled,
                            camera = current.camera,
                            cameraFacing = current.cameraFacing,
                            onStart = viewModel::startAgent,
                            onStop = viewModel::stopAgent,
                            onStartSharing = {
                                val manager = getSystemService(MediaProjectionManager::class.java)
                                screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
                            },
                            onStopSharing = viewModel::stopScreenShare,
                            onOpenAccessibilitySettings = viewModel::openAccessibilitySettings,
                            onPickSafFolder = { safFolderLauncher.launch(null) },
                            onOpenNotificationSettings = viewModel::openNotificationSettings,
                            onRequestCameraPermission = {
                                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                            },
                            onStopCamera = viewModel::stopCameraSession,
                        )
                    }
                }
            }
        }
    }
}
