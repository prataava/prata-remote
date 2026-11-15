package com.prata.remote.controller

// PRATA Remote — ViewModel login Controller (Command 002, Tugas 3)
// Alur: validasi input -> POST /api/auth/login -> simpan JWT ke
// TokenStore (EncryptedSharedPreferences) -> callback sukses.
// Alamat server bisa diubah dari layar login dan disimpan ke ServerConfig.
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.prata.remote.shared.model.LoginRequest
import com.prata.remote.shared.network.ApiResult
import com.prata.remote.shared.network.RetrofitClient
import com.prata.remote.shared.security.TokenStore
import com.prata.remote.shared.util.ServerConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class LoginUiState(
    val serverUrl: String = "",
    val serverMessage: String? = null,
    val email: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null,
    val isLoggedIn: Boolean = false,
)

class LoginViewModel(application: Application) : AndroidViewModel(application) {
    private val tokenStore = TokenStore(application)
    private val serverConfig = ServerConfig(application)

    private val _uiState = MutableStateFlow(
        LoginUiState(
            serverUrl = serverConfig.serverUrl,
            isLoggedIn = tokenStore.hasJwt,
        ),
    )
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    fun onServerUrlChanged(value: String) {
        _uiState.value = _uiState.value.copy(serverUrl = value, serverMessage = null)
    }

    fun onEmailChanged(value: String) {
        _uiState.value = _uiState.value.copy(email = value, error = null)
    }

    fun onPasswordChanged(value: String) {
        _uiState.value = _uiState.value.copy(password = value, error = null)
    }

    fun saveServerUrl() {
        val url = _uiState.value.serverUrl.trim().trimEnd('/')
        if (url.isBlank()) {
            _uiState.value = _uiState.value.copy(error = "Alamat server tidak boleh kosong.")
            return
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            _uiState.value = _uiState.value.copy(error = "Alamat server harus diawali http:// atau https://.")
            return
        }
        serverConfig.serverUrl = url
        _uiState.value = _uiState.value.copy(serverUrl = url, serverMessage = "Alamat server disimpan.")
    }

    fun login(onSuccess: () -> Unit) {
        val state = _uiState.value
        if (state.isLoading) return
        if (state.email.isBlank() || state.password.isBlank()) {
            _uiState.value = state.copy(error = "Email dan kata sandi wajib diisi.")
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val result = RetrofitClient.safeCall {
                RetrofitClient.api(serverConfig.serverUrl)
                    .login(LoginRequest(state.email.trim(), state.password))
            }
            when (result) {
                is ApiResult.Ok -> {
                    tokenStore.jwt = result.value.token
                    _uiState.value = _uiState.value.copy(isLoading = false, isLoggedIn = true)
                    onSuccess()
                }
                is ApiResult.Err -> {
                    _uiState.value = _uiState.value.copy(isLoading = false, error = result.message)
                }
            }
        }
    }
}
