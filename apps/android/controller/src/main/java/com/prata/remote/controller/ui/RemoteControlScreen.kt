package com.prata.remote.controller.ui

// PRATA Remote — Layar remote control Controller (Command 004 + 006 + 007 + FINAL)
// Merender video layar/kamera Agent lewat SurfaceViewRenderer dengan EGL
// context yang SAMA dari WebRtcClient (jangan buat EglBase kedua). Tap
// pada video dikirim sebagai koordinat ternormalisasi 0..1 terhadap AREA
// TAMPILAN — Agent memetakan 0..1 ke layarnya sendiri dan mengeksekusinya
// lewat AccessibilityService (Command 005/006).
// Tab: Video | Monitor | Files | Apps | Notifikasi. Bar navigasi cepat
// di bawah video: Back, Home, Recents, Lock, Screenshot, Volume,
// pemilih kualitas, indikator latensi, tombol Foto, dan Clipboard.
import android.net.Uri
import android.os.SystemClock
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Keyboard
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.prata.remote.controller.RemoteControlViewModel
import com.prata.remote.controller.RemoteStatus
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RemoteControlScreen(
    viewModel: RemoteControlViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val eglContext by viewModel.eglContext.collectAsState()
    var attachedTrack by remember { mutableStateOf<VideoTrack?>(null) }
    // Tab aktif: 0 Video, 1 Monitor, 2 Files, 3 Apps, 4 Notifikasi.
    var selectedTab by remember { mutableStateOf(0) }
    var keyboardText by remember { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    var dragStart by remember { mutableStateOf<Offset?>(null) }
    var dragEnd by remember { mutableStateOf<Offset?>(null) }
    var dragStartTime by remember { mutableLongStateOf(0L) }
    var showClipboardDialog by remember { mutableStateOf(false) }
    var clipboardInput by remember { mutableStateOf("") }
    val context = LocalContext.current

    val pickFileLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val name = context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (cursor.moveToFirst() && idx >= 0) cursor.getString(idx) else null
        } ?: "file-dari-controller"
        val mime = context.contentResolver.getType(uri)
        viewModel.uploadFile(uri, name, mime)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.deviceName) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Kembali")
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            TabRow(selectedTabIndex = selectedTab) {
                Tab(selected = selectedTab == 0, onClick = { selectedTab = 0 }, text = { Text("Video") })
                Tab(selected = selectedTab == 1, onClick = { selectedTab = 1 }, text = { Text("Monitor") })
                Tab(selected = selectedTab == 2, onClick = { selectedTab = 2 }, text = { Text("Files") })
                Tab(selected = selectedTab == 3, onClick = { selectedTab = 3 }, text = { Text("Apps") })
                Tab(selected = selectedTab == 4, onClick = { selectedTab = 4 }, text = { Text("Notif") })
            }
            when (selectedTab) {
                0 -> {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .pointerInput(state.status) {
                                detectTapGestures { offset ->
                                    if (state.status == RemoteStatus.Connected && size.width > 0 && size.height > 0) {
                                        viewModel.sendTap(
                                            offset.x / size.width.toFloat(),
                                            offset.y / size.height.toFloat(),
                                        )
                                    }
                                }
                            }
                            .pointerInput(state.status) {
                                detectDragGestures(
                                    onDragStart = { offset ->
                                        dragStart = offset
                                        dragEnd = offset
                                        dragStartTime = SystemClock.uptimeMillis()
                                    },
                                    onDragEnd = {
                                        val start = dragStart
                                        val end = dragEnd
                                        dragStart = null
                                        if (start != null && end != null &&
                                            state.status == RemoteStatus.Connected &&
                                            size.width > 0 && size.height > 0
                                        ) {
                                            val dx = end.x - start.x
                                            val dy = end.y - start.y
                                            val distance = sqrt(dx * dx + dy * dy)
                                            val threshold = max(50f, 0.05f * min(size.width, size.height).toFloat())
                                            if (distance >= threshold) {
                                                val duration = (SystemClock.uptimeMillis() - dragStartTime)
                                                    .coerceIn(100L, 1000L)
                                                viewModel.sendSwipe(
                                                    start.x / size.width.toFloat(),
                                                    start.y / size.height.toFloat(),
                                                    end.x / size.width.toFloat(),
                                                    end.y / size.height.toFloat(),
                                                    duration,
                                                )
                                            }
                                        }
                                    },
                                    onDragCancel = { dragStart = null },
                                    onDrag = { change, _ -> dragEnd = change.position },
                                )
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        if (eglContext != null) {
                            AndroidView(
                                factory = { ctx ->
                                    SurfaceViewRenderer(ctx).apply {
                                        init(eglContext, null)
                                        setEnableHardwareScaler(true)
                                        setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
                                    }
                                },
                                update = { renderer ->
                                    val track = state.remoteVideoTrack
                                    if (track != null && attachedTrack !== track) {
                                        attachedTrack?.removeSink(renderer)
                                        track.addSink(renderer)
                                        attachedTrack = track
                                    }
                                },
                                onRelease = { renderer ->
                                    attachedTrack?.removeSink(renderer)
                                    attachedTrack = null
                                    renderer.release()
                                },
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                        if (state.status != RemoteStatus.Connected) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                modifier = Modifier.padding(24.dp),
                            ) {
                                if (state.status != RemoteStatus.Failed) {
                                    CircularProgressIndicator()
                                    Spacer(modifier = Modifier.height(16.dp))
                                }
                                Text(state.statusText, style = MaterialTheme.typography.bodyMedium)
                                state.error?.let { error ->
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        error,
                                        color = MaterialTheme.colorScheme.error,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                }
                                if (state.status == RemoteStatus.Failed) {
                                    Spacer(modifier = Modifier.height(16.dp))
                                    Button(onClick = viewModel::retry) {
                                        Text("Coba lagi")
                                    }
                                }
                            }
                        }
                    }
                    // Bar navigasi cepat (FINAL Bagian 3): tombol aksi global
                    // + volume + kualitas + latensi + foto + clipboard.
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TextButton(onClick = { viewModel.sendGlobal("BACK") }) { Text("Back") }
                        TextButton(onClick = { viewModel.sendGlobal("HOME") }) { Text("Home") }
                        TextButton(onClick = { viewModel.sendGlobal("RECENTS") }) { Text("Recents") }
                        TextButton(onClick = { viewModel.sendGlobal("LOCK") }) { Text("Lock") }
                        TextButton(onClick = { viewModel.sendGlobal("SCREENSHOT") }) { Text("Shot") }
                        TextButton(onClick = { viewModel.sendVolume("DOWN") }) { Text("Vol -") }
                        TextButton(onClick = { viewModel.sendVolume("UP") }) { Text("Vol +") }
                        TextButton(onClick = { viewModel.sendVolume("MUTE") }) { Text("Mute") }
                        TextButton(onClick = { viewModel.sendPhoto() }) { Text("Foto") }
                        TextButton(onClick = {
                            clipboardInput = state.clipboardText ?: ""
                            showClipboardDialog = true
                        }) { Text("Clipboard") }
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Kualitas:", style = MaterialTheme.typography.bodySmall)
                        Spacer(modifier = Modifier.width(6.dp))
                        listOf("low", "medium", "high").forEach { preset ->
                            FilterChip(
                                selected = state.quality == preset,
                                onClick = { viewModel.sendQuality(preset) },
                                label = { Text(preset.replaceFirstChar { it.uppercase() }) },
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                        }
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = state.latencyMs?.let { "$it ms" } ?: "latensi —",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        TextButton(onClick = { viewModel.startCameraSession(false) }) { Text("Kamera Blk") }
                        TextButton(onClick = { viewModel.startCameraSession(true) }) { Text("Kamera Dpn") }
                        if (state.sessionKind != "screen") {
                            TextButton(onClick = { viewModel.startScreenSession() }) { Text("Layar") }
                        }
                    }
                    if (state.photoStatus != null) {
                        Text(
                            state.photoStatus!!,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
                        )
                    }
                }
                1 -> MonitorPanel(
                    metrics = state.metrics,
                    updatedAt = state.metricsUpdatedAt,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                2 -> FilesPanel(
                    state = state.files,
                    formatBytes = viewModel::formatBytes,
                    onNavigateUp = viewModel::navigateUp,
                    onFolderClick = viewModel::openFolder,
                    onFileClick = viewModel::downloadFile,
                    onUploadClick = { pickFileLauncher.launch("*/*") },
                    onRefresh = viewModel::refreshFiles,
                    onMkdir = viewModel::mkdirFolder,
                    onRename = viewModel::renameItem,
                    onDelete = viewModel::deleteItem,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                3 -> AppsPanel(
                    state = state.apps,
                    onRefresh = viewModel::requestAppList,
                    onCommand = viewModel::sendAppCommand,
                    onSystemOnlyChanged = viewModel::setAppsSystemOnly,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                4 -> NotificationsPanel(
                    notifications = state.notifications,
                    alerts = state.automationAlerts,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
            }
            // TextField tersembunyi untuk keyboard remote (Command 006).
            BasicTextField(
                value = keyboardText,
                onValueChange = { new ->
                    keyboardText = new
                    viewModel.sendText(new)
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { viewModel.sendKey("ENTER") }),
                modifier = Modifier
                    .size(1.dp)
                    .alpha(0.01f)
                    .focusRequester(focusRequester),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    state.statusText,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f),
                )
                Spacer(modifier = Modifier.width(8.dp))
                IconButton(onClick = {
                    focusRequester.requestFocus()
                    keyboardController?.show()
                }) {
                    Icon(Icons.Filled.Keyboard, contentDescription = "Keyboard")
                }
                OutlinedButton(
                    onClick = {
                        keyboardController?.hide()
                        viewModel.stopSession()
                        onBack()
                    },
                ) {
                    Text("Berhenti")
                }
            }
        }
    }

    if (showClipboardDialog) {
        AlertDialog(
            onDismissRequest = { showClipboardDialog = false },
            title = { Text("Clipboard Agent") },
            text = {
                Column {
                    Text(
                        "Isi saat ini: ${state.clipboardText ?: "—"}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedTextField(
                        value = clipboardInput,
                        onValueChange = { clipboardInput = it },
                        label = { Text("Teks baru untuk clipboard Agent") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.sendClipboardSet(clipboardInput)
                    showClipboardDialog = false
                }) { Text("Kirim ke Agent") }
            },
            dismissButton = {
                TextButton(onClick = {
                    viewModel.sendClipboardGet()
                    showClipboardDialog = false
                }) { Text("Ambil dari Agent") }
            },
        )
    }
}
