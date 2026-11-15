package com.prata.remote.controller

// PRATA Remote — ViewModel daftar perangkat Controller (Command 002, Tugas 3)
// Alur: GET /api/devices dengan Bearer JWT -> isi daftar. Bila server
// menjawab 401, token dianggap kedaluwarsa: JWT dihapus dan isLoggedIn
// jadi false agar UI mengarahkan kembali ke layar login.
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.prata.remote.shared.model.DeviceDto
import com.prata.remote.shared.network.ApiResult
import com.prata.remote.shared.network.RetrofitClient
import com.prata.remote.shared.security.TokenStore
import com.prata.remote.shared.util.ServerConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class DevicesUiState(
    val devices: List<DeviceDto> = emptyList(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val isLoggedIn: Boolean = false,
)

class DevicesViewModel(application: Application) : AndroidViewModel(application) {
    private val tokenStore = TokenStore(application)
    private val serverConfig = ServerConfig(application)

    private val _uiState = MutableStateFlow(DevicesUiState(isLoggedIn = tokenStore.hasJwt))
    val uiState: StateFlow<DevicesUiState> = _uiState.asStateFlow()

    init {
        if (tokenStore.hasJwt) loadDevices()
    }

    fun loadDevices() {
        val jwt = tokenStore.jwt
        if (jwt.isNullOrBlank()) {
            _uiState.value = _uiState.value.copy(isLoggedIn = false)
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val result = RetrofitClient.safeCall {
                RetrofitClient.api(serverConfig.serverUrl).listDevices("Bearer $jwt")
            }
            when (result) {
                is ApiResult.Ok -> {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        devices = result.value.devices,
                    )
                }
                is ApiResult.Err -> {
                    if (result.httpCode == 401) {
                        tokenStore.jwt = null
                        _uiState.value = _uiState.value.copy(
                            isLoading = false,
                            isLoggedIn = false,
                            devices = emptyList(),
                        )
                    } else {
                        _uiState.value = _uiState.value.copy(isLoading = false, error = result.message)
                    }
                }
            }
        }
    }

    fun logout() {
        tokenStore.clearAuth()
        _uiState.value = DevicesUiState(isLoggedIn = false)
    }
}
