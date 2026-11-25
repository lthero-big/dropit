package dev.dropit.app.core.auth

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.AppAuthTokenResponse
import dev.dropit.app.core.network.AuthProvidersInfo
import dev.dropit.app.core.network.DeviceAuthorizeResponse
import dev.dropit.app.core.network.DeviceTokenResponse
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.VerifiedServer
import dev.dropit.app.core.network.parseScopeString
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.security.MessageDigest
import java.security.SecureRandom
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

/**
 * Capability status of the current token for native in-app account & admin settings.
 * Users upgraded from legacy device-code tokens lack the `account` scope and see
 * [InsufficientScopeForAccountSettings] so UI can guide one-tap re-authentication.
 */
sealed class AccountCapabilityState {
    data object SignedOut : AccountCapabilityState()
    data class Ready(val hasAdminScope: Boolean) : AccountCapabilityState()
    data class InsufficientScopeForAccountSettings(
        val requiredScope: String = AuthRepository.SCOPE_ACCOUNT,
        val message: String = DEFAULT_MESSAGE,
    ) : AccountCapabilityState()

    companion object {
        const val DEFAULT_MESSAGE = "当前登录令牌缺少应用内设置权限，请使用邮箱密码或 GitHub / Google 重新登录以升级权限"
    }
}

data class PendingOAuthLogin(
    val provider: String,
    val serverOrigin: String,
    val state: String,
    val launchUrl: String,
)

data class PendingOAuthLink(
    val provider: String,
    val state: String,
    val ticket: String,
    val path: String,
    val launchUrl: String,
    val expiresIn: Int = 60,
)

sealed class OAuthLoginResult {
    data class Success(val response: AppAuthTokenResponse) : OAuthLoginResult()
    data class Failed(val error: ApiError) : OAuthLoginResult()
}

sealed class OAuthLinkResult {
    data class Linked(val provider: String, val alreadyLinked: Boolean) : OAuthLinkResult()
    data class Failed(val error: ApiError) : OAuthLinkResult()
}

data class AuthSessionState(
    val serverOrigin: String? = null,
    val isSignedIn: Boolean = false,
    val tokenScopes: Set<String> = emptySet(),
    val mustChangePassword: Boolean = false,
) {
    val hasAccountScope: Boolean
        get() = AuthRepository.SCOPE_ACCOUNT in tokenScopes

    val hasAdminScope: Boolean
        get() = AuthRepository.SCOPE_ADMIN in tokenScopes
}

interface AuthRepository {
    val sessionState: StateFlow<AuthSessionState>
    val deviceAuthState: StateFlow<DeviceAuthState>

    val accountCapability: StateFlow<AccountCapabilityState>
        get() = MutableStateFlow(AccountCapabilityState.SignedOut)

    val oauthLinkEvents: SharedFlow<OAuthLinkResult>
        get() = MutableSharedFlow()

    val hasAccountScope: Boolean
        get() = sessionState.value.hasAccountScope

    val hasAdminScope: Boolean
        get() = sessionState.value.hasAdminScope

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

    suspend fun completeAuthorizationWithMetadata(
        serverOrigin: String,
        token: String,
        scopes: Set<String> = emptySet(),
        mustChangePassword: Boolean = false,
    ) {
        completeAuthorization(serverOrigin, token)
    }

    suspend fun getAuthProviders(serverOrigin: String? = null): AuthProvidersInfo =
        throw UnsupportedOperationException("getAuthProviders not implemented")

    suspend fun loginWithPassword(
        serverOrigin: String,
        email: String,
        password: String,
        invite: String? = null,
    ): AppAuthTokenResponse =
        throw UnsupportedOperationException("loginWithPassword not implemented")

    suspend fun startAppOAuthLogin(
        serverOrigin: String,
        provider: String,
        invite: String? = null,
    ): PendingOAuthLogin =
        throw UnsupportedOperationException("startAppOAuthLogin not implemented")

    suspend fun exchangeAppOAuthCode(
        serverOrigin: String,
        code: String,
    ): AppAuthTokenResponse =
        throw UnsupportedOperationException("exchangeAppOAuthCode not implemented")

    suspend fun handleOAuthLoginCallback(payload: OAuthCallbackPayload): OAuthLoginResult =
        throw UnsupportedOperationException("handleOAuthLoginCallback not implemented")

    suspend fun startAppOAuthLink(provider: String): PendingOAuthLink =
        throw UnsupportedOperationException("startAppOAuthLink not implemented")

    suspend fun handleOAuthLinkCallback(payload: OAuthCallbackPayload): OAuthLinkResult =
        throw UnsupportedOperationException("handleOAuthLinkCallback not implemented")

    suspend fun clearPendingOAuthFlow() = Unit

    suspend fun markPasswordChanged() = Unit

    suspend fun reportInsufficientScope(requiredScope: String = SCOPE_ACCOUNT) = Unit

    suspend fun clearLocalSession(clearServer: Boolean = false)
    suspend fun logout(clearServer: Boolean = false)
    fun resetDeviceAuthState()

    companion object {
        const val SCOPE_READ = "read"
        const val SCOPE_WRITE = "write"
        const val SCOPE_WEB = "web"
        const val SCOPE_ACCOUNT = "account"
        const val SCOPE_ADMIN = "admin"

        val DEFAULT_SCOPES: List<String> = listOf(SCOPE_READ, SCOPE_WRITE)
        val EXTENDED_WEB_SCOPES: List<String> = listOf(SCOPE_READ, SCOPE_WRITE, SCOPE_WEB)
    }
}

class DefaultAuthRepository(
    private val apiClient: DropitApiClient,
    private val settingsStore: SettingsStore,
    private val tokenVault: TokenVault,
    private val deviceNameProvider: () -> String,
    private val json: Json = DropitApiClient.defaultJson(),
    private val stateGenerator: () -> String = { generateAppState() },
) : AuthRepository {

    private val _sessionState = MutableStateFlow(AuthSessionState())
    override val sessionState: StateFlow<AuthSessionState> = _sessionState.asStateFlow()

    private val _deviceAuthState = MutableStateFlow<DeviceAuthState>(DeviceAuthState.Idle)
    override val deviceAuthState: StateFlow<DeviceAuthState> = _deviceAuthState.asStateFlow()

    private val _accountCapability = MutableStateFlow<AccountCapabilityState>(AccountCapabilityState.SignedOut)
    override val accountCapability: StateFlow<AccountCapabilityState> = _accountCapability.asStateFlow()

    private val _oauthLinkEvents = MutableSharedFlow<OAuthLinkResult>(extraBufferCapacity = 8)
    override val oauthLinkEvents: SharedFlow<OAuthLinkResult> = _oauthLinkEvents.asSharedFlow()

    override suspend fun refreshSessionState(): AuthSessionState {
        val settings = settingsStore.current()
        val origin = settings.serverOrigin
        val hasToken = tokenVault.hasToken()
        val signedIn = !origin.isNullOrBlank() && hasToken
        val scopes = if (signedIn) settings.tokenScopes else emptySet()
        val mustChange = if (signedIn) settings.mustChangePassword else false
        val next = AuthSessionState(
            serverOrigin = origin,
            isSignedIn = signedIn,
            tokenScopes = scopes,
            mustChangePassword = mustChange,
        )
        _sessionState.value = next
        _accountCapability.value = computeCapability(next)
        return next
    }

    override suspend fun verifyAndSaveServer(rawUrl: String): VerifiedServer {
        val verified = apiClient.verifyServer(rawUrl)
        settingsStore.setServerOrigin(verified.serverOrigin)
        refreshSessionState()
        return verified
    }

    override suspend fun getAuthProviders(serverOrigin: String?): AuthProvidersInfo =
        apiClient.getAuthProviders(serverOrigin)

    override suspend fun loginWithPassword(
        serverOrigin: String,
        email: String,
        password: String,
        invite: String?,
    ): AppAuthTokenResponse {
        val cleanEmail = email.trim()
        if (cleanEmail.isEmpty() || password.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "请输入邮箱和密码",
            )
        }
        val response = apiClient.appPasswordLogin(
            serverOrigin = serverOrigin,
            email = cleanEmail,
            password = password,
            deviceName = deviceNameProvider(),
            invite = invite,
        )
        completeAuthorizationWithMetadata(
            serverOrigin = serverOrigin,
            token = response.accessToken,
            scopes = response.parsedScopes,
            mustChangePassword = response.mustChangePassword,
        )
        return response
    }

    override suspend fun startAppOAuthLogin(
        serverOrigin: String,
        provider: String,
        invite: String?,
    ): PendingOAuthLogin {
        val cleanProvider = provider.trim().lowercase()
        if (cleanProvider.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "登录方式不能为空",
            )
        }
        val state = stateGenerator()
        require(APP_STATE_REGEX.matches(state)) { "Generated app_state does not match server pattern" }
        val launchUrl = apiClient.buildAppOAuthLoginUrl(
            serverOrigin = serverOrigin,
            provider = cleanProvider,
            appState = state,
            deviceName = deviceNameProvider(),
            invite = invite,
        )
        val normalizedOrigin = launchUrl.substringBefore("/api/auth/")
        settingsStore.setPendingOAuthFlow(
            PendingOAuthFlowRecord(
                mode = PendingOAuthFlowMode.LOGIN,
                provider = cleanProvider,
                serverOrigin = normalizedOrigin,
                state = state,
            ),
        )
        return PendingOAuthLogin(
            provider = cleanProvider,
            serverOrigin = normalizedOrigin,
            state = state,
            launchUrl = launchUrl,
        )
    }

    override suspend fun exchangeAppOAuthCode(
        serverOrigin: String,
        code: String,
    ): AppAuthTokenResponse {
        val cleanCode = code.trim()
        if (cleanCode.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.OAUTH_CODE_INVALID,
                rawCode = "OAUTH_CODE_INVALID",
                httpStatus = 400,
                userMessage = ApiErrorCode.OAUTH_CODE_INVALID.defaultMessage,
            )
        }
        val response = apiClient.exchangeAppOAuthCode(
            serverOrigin = serverOrigin,
            code = cleanCode,
            deviceName = deviceNameProvider(),
        )
        completeAuthorizationWithMetadata(
            serverOrigin = serverOrigin,
            token = response.accessToken,
            scopes = response.parsedScopes,
            mustChangePassword = response.mustChangePassword,
        )
        return response
    }

    override suspend fun handleOAuthLoginCallback(payload: OAuthCallbackPayload): OAuthLoginResult {
        val pending = settingsStore.getPendingOAuthFlow()
        if (pending == null ||
            pending.mode != PendingOAuthFlowMode.LOGIN ||
            !constantTimeEquals(pending.state, payload.state)
        ) {
            return OAuthLoginResult.Failed(
                ApiError(
                    errorCode = ApiErrorCode.OAUTH_STATE_INVALID,
                    rawCode = "OAUTH_STATE_INVALID",
                    httpStatus = 400,
                    userMessage = ApiErrorCode.OAUTH_STATE_INVALID.defaultMessage,
                ),
            )
        }
        settingsStore.setPendingOAuthFlow(null)

        return when (payload) {
            is OAuthCallbackPayload.Error -> {
                OAuthLoginResult.Failed(ApiError.fromOAuthErrorCode(payload.errorCode))
            }
            is OAuthCallbackPayload.LoginCode -> {
                try {
                    val tokenResponse = exchangeAppOAuthCode(
                        serverOrigin = pending.serverOrigin,
                        code = payload.code,
                    )
                    OAuthLoginResult.Success(tokenResponse)
                } catch (e: ApiError) {
                    OAuthLoginResult.Failed(e)
                } catch (e: Exception) {
                    OAuthLoginResult.Failed(ApiError.network(e))
                }
            }
            is OAuthCallbackPayload.Linked -> {
                OAuthLoginResult.Failed(
                    ApiError(
                        errorCode = ApiErrorCode.OAUTH_STATE_INVALID,
                        rawCode = "OAUTH_STATE_INVALID",
                        httpStatus = 400,
                        userMessage = ApiErrorCode.OAUTH_STATE_INVALID.defaultMessage,
                    ),
                )
            }
        }
    }

    override suspend fun startAppOAuthLink(provider: String): PendingOAuthLink {
        val cleanProvider = provider.trim().lowercase()
        val state = stateGenerator()
        require(APP_STATE_REGEX.matches(state)) { "Generated app_state does not match server pattern" }
        val response = try {
            apiClient.requestAppOAuthLink(provider = cleanProvider, appState = state)
        } catch (e: ApiError) {
            if (e.isInsufficientScope) {
                reportInsufficientScope(AuthRepository.SCOPE_ACCOUNT)
            }
            throw e
        }
        val origin = settingsStore.getServerOrigin()?.trimEnd('/').orEmpty()
        val launchUrl = when {
            response.url.startsWith("https://", ignoreCase = true) ||
                response.url.startsWith("http://", ignoreCase = true) -> response.url
            response.path.startsWith("/") && origin.isNotEmpty() -> "$origin${response.path}"
            else -> response.url.ifBlank { response.path }
        }
        val effectiveState = response.state.ifBlank { state }
        settingsStore.setPendingOAuthFlow(
            PendingOAuthFlowRecord(
                mode = PendingOAuthFlowMode.LINK,
                provider = cleanProvider,
                serverOrigin = origin.ifBlank { launchUrl.substringBefore("/api/auth/") },
                state = effectiveState,
            ),
        )
        return PendingOAuthLink(
            provider = cleanProvider,
            state = effectiveState,
            ticket = response.ticket,
            path = response.path,
            launchUrl = launchUrl,
            expiresIn = response.expiresIn,
        )
    }

    override suspend fun handleOAuthLinkCallback(payload: OAuthCallbackPayload): OAuthLinkResult {
        val pending = settingsStore.getPendingOAuthFlow()
        if (pending == null ||
            pending.mode != PendingOAuthFlowMode.LINK ||
            !constantTimeEquals(pending.state, payload.state)
        ) {
            val failed = OAuthLinkResult.Failed(
                ApiError(
                    errorCode = ApiErrorCode.OAUTH_STATE_INVALID,
                    rawCode = "OAUTH_STATE_INVALID",
                    httpStatus = 400,
                    userMessage = ApiErrorCode.OAUTH_STATE_INVALID.defaultMessage,
                ),
            )
            _oauthLinkEvents.tryEmit(failed)
            return failed
        }
        settingsStore.setPendingOAuthFlow(null)

        val result = when (payload) {
            is OAuthCallbackPayload.Linked -> OAuthLinkResult.Linked(
                provider = payload.provider,
                alreadyLinked = payload.alreadyLinked,
            )
            is OAuthCallbackPayload.Error -> OAuthLinkResult.Failed(
                ApiError.fromOAuthErrorCode(payload.errorCode),
            )
            is OAuthCallbackPayload.LoginCode -> OAuthLinkResult.Failed(
                ApiError(
                    errorCode = ApiErrorCode.OAUTH_STATE_INVALID,
                    rawCode = "OAUTH_STATE_INVALID",
                    httpStatus = 400,
                    userMessage = ApiErrorCode.OAUTH_STATE_INVALID.defaultMessage,
                ),
            )
        }
        _oauthLinkEvents.tryEmit(result)
        return result
    }

    override suspend fun clearPendingOAuthFlow() {
        settingsStore.setPendingOAuthFlow(null)
    }

    override suspend fun markPasswordChanged() {
        settingsStore.setMustChangePassword(false)
        refreshSessionState()
    }

    override suspend fun reportInsufficientScope(requiredScope: String) {
        val currentScopes = settingsStore.getTokenScopes()
        val updatedScopes = when (requiredScope) {
            AuthRepository.SCOPE_ACCOUNT -> currentScopes - AuthRepository.SCOPE_ACCOUNT - AuthRepository.SCOPE_ADMIN
            AuthRepository.SCOPE_ADMIN -> currentScopes - AuthRepository.SCOPE_ADMIN
            else -> currentScopes - requiredScope
        }
        if (updatedScopes != currentScopes) {
            settingsStore.setTokenScopes(updatedScopes)
        }
        refreshSessionState()
        if (requiredScope == AuthRepository.SCOPE_ACCOUNT) {
            _accountCapability.value = AccountCapabilityState.InsufficientScopeForAccountSettings(
                requiredScope = AuthRepository.SCOPE_ACCOUNT,
            )
        }
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
                    completeAuthorizationWithMetadata(
                        serverOrigin = serverOrigin,
                        token = outcome.accessToken,
                        scopes = parseScopeString(outcome.scope),
                        mustChangePassword = false,
                    )
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
        completeAuthorizationWithMetadata(
            serverOrigin = serverOrigin,
            token = token,
            scopes = emptySet(),
            mustChangePassword = false,
        )
    }

    override suspend fun completeAuthorizationWithMetadata(
        serverOrigin: String,
        token: String,
        scopes: Set<String>,
        mustChangePassword: Boolean,
    ) {
        settingsStore.setServerOrigin(serverOrigin)
        settingsStore.setTokenScopes(scopes)
        settingsStore.setMustChangePassword(mustChangePassword)
        settingsStore.setPendingOAuthFlow(null)
        tokenVault.saveToken(token)
        refreshSessionState()
    }

    override suspend fun clearLocalSession(clearServer: Boolean) {
        tokenVault.clearToken()
        settingsStore.clearAuthMetadata()
        if (clearServer) {
            settingsStore.clearServerConfig()
        }
        _deviceAuthState.value = DeviceAuthState.Idle
        refreshSessionState()
    }

    override suspend fun logout(clearServer: Boolean) {
        // Best-effort remote token revocation for explicit user sign-out; always clear local credentials.
        if (tokenVault.hasToken() && !settingsStore.getServerOrigin().isNullOrBlank()) {
            runCatching { apiClient.logout() }
        }
        clearLocalSession(clearServer = clearServer)
    }

    override fun resetDeviceAuthState() {
        _deviceAuthState.value = DeviceAuthState.Idle
    }

    private fun computeCapability(session: AuthSessionState): AccountCapabilityState = when {
        !session.isSignedIn -> AccountCapabilityState.SignedOut
        session.hasAccountScope -> AccountCapabilityState.Ready(hasAdminScope = session.hasAdminScope)
        else -> AccountCapabilityState.InsufficientScopeForAccountSettings(
            requiredScope = AuthRepository.SCOPE_ACCOUNT,
        )
    }

    companion object {
        const val SLOW_DOWN_INCREMENT_SECONDS = 5
        private val APP_STATE_REGEX = Regex("^[A-Za-z0-9._~-]{8,128}$")
        private const val STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        private val SECURE_RANDOM = SecureRandom()

        fun generateAppState(length: Int = 32): String {
            require(length in 8..128) { "app_state length must be in 8..128" }
            val sb = StringBuilder(length)
            repeat(length) {
                sb.append(STATE_ALPHABET[SECURE_RANDOM.nextInt(STATE_ALPHABET.length)])
            }
            return sb.toString()
        }

        private fun constantTimeEquals(a: String, b: String): Boolean =
            MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

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
