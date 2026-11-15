package com.prata.remote.shared.model

// PRATA Remote — Model API (Command 002, Tugas 2-3)
// Nama field mengikuti respons JSON backend (apps/backend/src/api/).
// Gson memetakan apa adanya; null = field tidak ada di respons.

data class LoginRequest(
    val email: String,
    val password: String,
)

data class UserDto(
    val id: String,
    val email: String,
    val name: String?,
    val role: String,
)

data class LoginResponse(
    val token: String,
    val expiresInSec: Int,
    val user: UserDto,
)

data class PairingInitRequest(
    val deviceName: String?,
    val deviceModel: String?,
    val manufacturer: String?,
    val androidVersion: String?,
    val agentVersion: String?,
)

data class PairingInitResponse(
    val pairingId: String,
    val pairingCode: String,
    val qrPayload: String,
    val expiresAt: String,
    val expiresInSec: Int,
)

data class PairingPollRequest(
    val pairingId: String,
    val pairingCode: String,
)

data class PairingPollResponse(
    val status: String,
    val deviceId: String?,
    val deviceName: String?,
    val agentToken: String?,
    val tokenAlreadyCollected: Boolean,
)

data class PairingConfirmRequest(
    val pairingId: String? = null,
    val pairingCode: String? = null,
    val qrPayload: String? = null,
    val deviceName: String? = null,
)

data class PairingConfirmResponse(
    val deviceId: String,
    val deviceName: String,
    val status: String,
    val message: String?,
)

data class DeviceDto(
    val id: String,
    val name: String,
    val model: String?,
    val manufacturer: String?,
    val androidVersion: String?,
    val agentVersion: String?,
    val status: String,
    val lastSeenAt: String?,
    val createdAt: String,
)

data class DevicesResponse(
    val devices: List<DeviceDto>,
)

data class DeviceDetailResponse(
    val device: DeviceDto,
)

data class ErrorDetail(
    val code: String,
    val message: String,
)

data class ApiErrorBody(
    val error: ErrorDetail?,
)
