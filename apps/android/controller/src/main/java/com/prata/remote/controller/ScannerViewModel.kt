package com.prata.remote.controller

// PRATA Remote — ViewModel pemindai QR Controller (Command 002, Tugas 3)
// Alur: QR discan -> parse QrPayload (format prata://pair/<id>/<kode>) ->
// POST /api/devices/pairing/confirm dengan Bearer JWT -> sukses:
// result = nama perangkat; gagal: error = pesan server.
// Satu QR hanya diproses sekali (guard isProcessing + result).
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.prata.remote.shared.model.PairingConfirmRequest
import com.prata.remote.shared.network.ApiResult
import com.prata.remote.shared.network.RetrofitClient
import com.prata.remote.shared.security.TokenStore
import com.prata.remote.shared.util.QrPayload
import com.prata.remote.shared.util.ServerConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class ScannerUiState(
    val isProcessing: Boolean = false,
    val result: String? = null,
    val error: String? = null,
)

class ScannerViewModel(application: Application) : AndroidViewModel(application) {
    private val tokenStore = TokenStore(application)
    private val serverConfig = ServerConfig(application)

    private val _uiState = MutableStateFlow(ScannerUiState())
    val uiState: StateFlow<ScannerUiState> = _uiState.asStateFlow()

    fun onQrScanned(raw: String) {
        val parsed = QrPayload.parse(raw)
        if (parsed == null) {
            _uiState.value = _uiState.value.copy(error = "QR bukan kode pairing PRATA")
            return
        }
        if (_uiState.value.isProcessing || _uiState.value.result != null) return
        val jwt = tokenStore.jwt
        if (jwt.isNullOrBlank()) {
            _uiState.value = _uiState.value.copy(error = "Belum login. Masuk dulu sebelum scan.")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isProcessing = true, error = null)
            val result = RetrofitClient.safeCall {
                RetrofitClient.api(serverConfig.serverUrl)
                    .pairingConfirm("Bearer $jwt", PairingConfirmRequest(qrPayload = raw))
            }
            when (result) {
                is ApiResult.Ok -> {
                    _uiState.value = _uiState.value.copy(isProcessing = false, result = result.value.deviceName)
                }
                is ApiResult.Err -> {
                    _uiState.value = _uiState.value.copy(isProcessing = false, error = result.message)
                }
            }
        }
    }

    fun reset() {
        _uiState.value = ScannerUiState()
    }
}
