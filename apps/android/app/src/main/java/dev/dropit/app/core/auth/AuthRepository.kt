package dev.dropit.app.core.auth

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.DeviceTokenResponse
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.VerifiedServer
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.math.max

sealed class DevicePollOutcome {
    data class Token(
        val accessToken: String,
        val scope: String = "",
        val expiresIn: Long? = null,
    ) : DevicePollOutcome()

    data object Pending : DevicePollOutcome()
    data object SlowDown : DevicePollOutcome()
    data object Denied : DevicePollOutcome()
    data object Expired : DevicePollOutcome()
    data class Error(val code: String, val httpStatus: Int, val apiError: ApiError) : DevicePollOutcome()
}

sealed class DeviceAuthState {
    data object Idle : DeviceAuthState()
    data object RequestingCode : DeviceAuthState()
    data class WaitingForApproval(
        val authorization: DeviceAuthorizeResponse,
        val pollIntervalSeconds: Int,
    ) : DeviceAuthState()

    data class Approved(
        val serverOrigin: String,
        val scope: String,
    ) : DeviceAuthState()

    data object Denied : DeviceAuthState()
    data object Expired : DeviceAuthState()
    data class Failed(val error: ApiError) : DeviceAuthState()
}

data class AuthSessionState(
    val serverOrigin: String? = null,
    val isSignedIn: Boolean = false,
)

interface AuthRepository {
    val sessionState: StateFlow<AuthSessionState>
    val deviceAuthState: StateFlow<DeviceAuthState>

    suspend fun refreshSessionState(): AuthSessionState
    suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer
    suspend fun startDeviceAuthorization(
        serverOrigin: String,
        scopes: List<String> = DEFAULT_SCOPES,
    ): DeviceAuthorizeResponse

    suspend fun pollDeviceTokenOnce(serverOrigin: String, deviceCode: String): DevicePollOutcome

    fun pollDeviceAuthorization(
        serverOrigin: String,
        authorization: DeviceAuthorizeResponse,
        delayMillis: suspend (Long) -> Unit = { delay(it) },
    ): Flow<DeviceAuthState>

    suspend fun completeAuthorization(serverOrigin: String, token: String)
    suspend fun logout(clearServer: Boolean = false)
    fun resetDeviceAuthState()

    companion object {
        val DEFAULT_SCOPES: List<String> = listOf("read", "write")
        val EXTENDED_WEB_SCOPES: List<String> = listOf("read", "write", "web")
    }
}

class DefaultAuthRepository(
    private val apiClient: DropitApiClient,
    private val settingsStore: SettingsStore,
    private val tokenVault: TokenVault,
    private val deviceNameProvider: () -> String,
    private val json: Json = DropitApiClient.defaultJson(),
) : AuthRepository {

    private val _sessionState = MutableStateFlow(AuthSessionState())
    override val sessionState: StateFlow<AuthSessionState> = _sessionState.asStateFlow()

    private val _deviceAuthState = MutableStateFlow<DeviceAuthState>(DeviceAuthState.Idle)
    override val deviceAuthState: StateFlow<DeviceAuthState> = _deviceAuthState.asStateFlow()

    override suspend fun refreshSessionState(): AuthSessionState {
        val origin = settingsStore.getServerOrigin()
        val hasToken = tokenVault.hasToken()
        val next = AuthSessionState(serverOrigin = origin, isSignedIn = !origin.isNullOrBlank() && hasToken)
        _sessionState.value = next
        return next
    }

    override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer {
        val verified = apiClient.verifyServer(rawUrl)
        settingsStore.setServerOrigin(verified.serverOrigin)
        refreshSessionState()
        return verified
    }

    override suspend fun startDeviceAuthorization(
        serverOrigin: String,
        scopes: List<String>,
    ): DeviceAuthorizeResponse {
        _deviceAuthState.value = DeviceAuthState.RequestingCode
        val name = deviceNameProvider()
        val response = try {
            apiClient.requestDeviceAuthorization(
                serverOrigin = serverOrigin,
                deviceName = name,
                scopes = scopes,
                expiresInDays = 365,
            )
        } catch (e: ApiError) {
            // Backward compatibility: if server rejects an extended scope (e.g. "web") with 400, retry with read+write.
            if (e.httpStatus == 400 && scopes != AuthRepository.DEFAULT_SCOPES) {
                apiClient.requestDeviceAuthorization(
                    serverOrigin = serverOrigin,
                    deviceName = name,
                    scopes = AuthRepository.DEFAULT_SCOPES,
                    expiresInDays = 365,
                )
            } else {
                _deviceAuthState.value = DeviceAuthState.Failed(e)
                throw e
            }
        }
        val interval = max(1, response.interval)
        _deviceAuthState.value = DeviceAuthState.WaitingForApproval(response, interval)
        return response
    }

    override suspend fun pollDeviceTokenOnce(serverOrigin: String, deviceCode: String): DevicePollOutcome {
        val raw = apiClient.pollDeviceToken(serverOrigin, deviceCode)
        return parseDevicePollOutcome(raw.statusCode, raw.body, raw.retryAfterHeader, json)
    }

    override fun pollDeviceAuthorization(
        serverOrigin: String,
        authorization: DeviceAuthorizeResponse,
        delayMillis: suspend (Long) -> Unit,
    ): Flow<DeviceAuthState> = flow {
        var intervalSeconds = max(1, authorization.interval)
        val initial = DeviceAuthState.WaitingForApproval(authorization, intervalSeconds)
        _deviceAuthState.value = initial
        emit(initial)

        while (true) {
            delayMillis(intervalSeconds * 1000L)
            val outcome = try {
                pollDeviceTokenOnce(serverOrigin, authorization.deviceCode)
            } catch (e: ApiError) {
                val failed = DeviceAuthState.Failed(e)
                _deviceAuthState.value = failed
                emit(failed)
                return@flow
            }

            when (outcome) {
                DevicePollOutcome.Pending -> {
                    // Keep waiting at the current polling interval.
                }
                DevicePollOutcome.SlowDown -> {
                    intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS
                    val slowed = DeviceAuthState.WaitingForApproval(authorization, intervalSeconds)
                    _deviceAuthState.value = slowed
                    emit(slowed)
                }
                is DevicePollOutcome.Token -> {
                    completeAuthorization(serverOrigin, outcome.accessToken)
                    val approved = DeviceAuthState.Approved(serverOrigin = serverOrigin, scope = outcome.scope)
                    _deviceAuthState.value = approved
                    emit(approved)
                    return@flow
                }
                DevicePollOutcome.Denied -> {
                    _deviceAuthState.value = DeviceAuthState.Denied
                    emit(DeviceAuthState.Denied)
                    return@flow
                }
                DevicePollOutcome.Expired -> {
                    _deviceAuthState.value = DeviceAuthState.Expired
                    emit(DeviceAuthState.Expired)
                    return@flow
                }
                is DevicePollOutcome.Error -> {
                    val failed = DeviceAuthState.Failed(outcome.apiError)
                    _deviceAuthState.value = failed
                    emit(failed)
                    return@flow
                }
            }
        }
    }

    override suspend fun completeAuthorization(serverOrigin: String, token: String) {
        settingsStore.setServerOrigin(serverOrigin)
        tokenVault.saveToken(token)
        refreshSessionState()
    }

    override suspend fun logout(clearServer: Boolean) {
        // Best-effort remote token revocation; always clear local credentials even if offline or 401.
        if (tokenVault.hasToken() && !settingsStore.getServerOrigin().isNullOrBlank()) {
            runCatching { apiClient.logout() }
        }
        tokenVault.clearToken()
        if (clearServer) {
            settingsStore.clearServerConfig()
        }
        _deviceAuthState.value = DeviceAuthState.Idle
        refreshSessionState()
    }

    override fun resetDeviceAuthState() {
        _deviceAuthState.value = DeviceAuthState.Idle
    }

    companion object {
        const val SLOW_DOWN_INCREMENT_SECONDS = 5

        /**
         * Pure interpretation of POST /api/auth/device/token response, aligned with mobile/www/core.js.
         */
        fun parseDevicePollOutcome(
            statusCode: Int,
            rawBody: String,
            retryAfterHeader: String? = null,
            json: Json = DropitApiClient.defaultJson(),
        ): DevicePollOutcome {
            if (statusCode == 200) {
                val parsed = runCatching { json.decodeFromString(DeviceTokenResponse.serializer(), rawBody) }.getOrNull()
                if (parsed != null && parsed.accessToken.isNotBlank()) {
                    return DevicePollOutcome.Token(
                        accessToken = parsed.accessToken,
                        scope = parsed.scope,
                        expiresIn = parsed.expiresIn,
                    )
                }
            }
            val code = extractErrorCode(rawBody, json)
            return when (code?.lowercase()) {
                "authorization_pending" -> DevicePollOutcome.Pending
                "slow_down" -> DevicePollOutcome.SlowDown
                "access_denied" -> DevicePollOutcome.Denied
                "expired_token" -> DevicePollOutcome.Expired
                else -> {
                    val error = ApiError.fromResponse(statusCode, rawBody, retryAfterHeader)
                    DevicePollOutcome.Error(
                        code = code ?: statusCode.toString(),
                        httpStatus = statusCode,
                        apiError = if (error.errorCode == ApiErrorCode.UNKNOWN && !code.isNullOrBlank()) {
                            ApiError(
                                errorCode = ApiErrorCode.UNKNOWN,
                                rawCode = code,
                                httpStatus = statusCode,
                                userMessage = "登录失败（$code）",
                            )
                        } else {
                            error
                        },
                    )
                }
            }
        }

        private fun extractErrorCode(rawBody: String, json: Json): String? {
            if (rawBody.isBlank()) return null
            val obj = runCatching { json.parseToJsonElement(rawBody) as? JsonObject }.getOrNull() ?: return null
            val err = obj["error"] ?: return null
            return when (err) {
                is JsonPrimitive -> err.contentOrNull
                is JsonObject -> (err["code"] as? JsonPrimitive)?.contentOrNull
                else -> null
            }
        }
    }
}
