package com.prata.remote.shared.network

// PRATA Remote — Klien REST (Command 002, Tugas 2-3 + 007 + 008)
// Retrofit di atas OkHttp. Base URL berasal dari ServerConfig (bisa diubah
// dari UI aplikasi — default emulator 10.0.2.2; di HP fisik isi IP/host
// server backend, mis. http://192.168.1.10:8080).
import com.google.gson.GsonBuilder
import com.prata.remote.shared.model.ApiErrorBody
import com.prata.remote.shared.model.CreateTransferRequest
import com.prata.remote.shared.model.CreateTransferResponse
import com.prata.remote.shared.model.DeviceDetailResponse
import com.prata.remote.shared.model.DevicesResponse
import com.prata.remote.shared.model.LoginRequest
import com.prata.remote.shared.model.LoginResponse
import com.prata.remote.shared.model.PairingConfirmRequest
import com.prata.remote.shared.model.PairingConfirmResponse
import com.prata.remote.shared.model.PairingInitRequest
import com.prata.remote.shared.model.PairingInitResponse
import com.prata.remote.shared.model.PairingPollRequest
import com.prata.remote.shared.model.PairingPollResponse
import com.prata.remote.shared.model.PutBlobResponse
import com.prata.remote.shared.model.TransferStatusResponse
import com.prata.remote.shared.model.UploadFileResponse
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.HttpException
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Streaming
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed class ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>()
    data class Err(val code: String, val message: String, val httpCode: Int) : ApiResult<Nothing>()
}

interface PrataApi {
    @POST("api/auth/login")
    suspend fun login(@Body req: LoginRequest): LoginResponse

    @POST("api/devices/pairing/init")
    suspend fun pairingInit(@Body req: PairingInitRequest): PairingInitResponse

    @POST("api/devices/pairing/poll")
    suspend fun pairingPoll(@Body req: PairingPollRequest): PairingPollResponse

    @POST("api/devices/pairing/confirm")
    suspend fun pairingConfirm(
        @Header("Authorization") auth: String,
        @Body req: PairingConfirmRequest,
    ): PairingConfirmResponse

    @GET("api/devices")
    suspend fun listDevices(@Header("Authorization") auth: String): DevicesResponse

    @GET("api/devices/{id}")
    suspend fun getDevice(
        @Header("Authorization") auth: String,
        @Path("id") id: String,
    ): DeviceDetailResponse

    // --- Transfer file (Command 008) ---
    @POST("api/transfers")
    suspend fun createTransfer(
        @Header("Authorization") auth: String,
        @Body req: CreateTransferRequest,
    ): CreateTransferResponse

    @GET("api/transfers/{id}")
    suspend fun getTransfer(
        @Header("Authorization") auth: String,
        @Path("id") id: String,
    ): TransferStatusResponse

    @PUT("api/transfers/{id}/blob")
    suspend fun uploadBlob(
        @Header("Authorization") auth: String,
        @Path("id") id: String,
        @Body body: RequestBody,
    ): PutBlobResponse

    @GET("api/transfers/{id}/blob")
    @Streaming
    suspend fun downloadBlob(
        @Header("Authorization") auth: String,
        @Path("id") id: String,
    ): Response<ResponseBody>

    @POST("api/devices/{id}/files/upload")
    suspend fun uploadFile(
        @Header("Authorization") auth: String,
        @Path("id") id: String,
        @Header("X-File-Name") fileName: String,
        @Header("X-File-Mime") mimeType: String?,
        @Header("X-Folder-DocId") folderDocId: String?,
        @Body body: RequestBody,
    ): UploadFileResponse
}

object RetrofitClient {
    private val gson = GsonBuilder().create()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val apis = mutableMapOf<String, PrataApi>()

    fun api(serverUrl: String): PrataApi {
        val normalized = serverUrl.trim().trimEnd('/')
        return apis.getOrPut(normalized) {
            Retrofit.Builder()
                .baseUrl("$normalized/")
                .client(httpClient)
                .addConverterFactory(GsonConverterFactory.create(gson))
                .build()
                .create(PrataApi::class.java)
        }
    }

    /** Jalankan panggilan Retrofit dan ubah semua kegagalan jadi ApiResult.Err. */
    suspend fun <T> safeCall(block: suspend () -> T): ApiResult<T> {
        return try {
            ApiResult.Ok(block())
        } catch (e: HttpException) {
            val parsed = try {
                e.response()?.errorBody()?.string()?.let { gson.fromJson(it, ApiErrorBody::class.java) }
            } catch (_: Exception) {
                null
            }
            val detail = parsed?.error
            ApiResult.Err(
                code = detail?.code ?: "http-${e.code()}",
                message = detail?.message ?: "Server mengembalikan HTTP ${e.code()}.",
                httpCode = e.code(),
            )
        } catch (e: IOException) {
            ApiResult.Err(
                code = "network-error",
                message = "Tidak bisa terhubung ke server. Periksa alamat server & jaringan. (${e.message})",
                httpCode = 0,
            )
        } catch (e: Exception) {
            ApiResult.Err(code = "unexpected", message = e.message ?: "Kesalahan tak terduga.", httpCode = 0)
        }
    }
}
