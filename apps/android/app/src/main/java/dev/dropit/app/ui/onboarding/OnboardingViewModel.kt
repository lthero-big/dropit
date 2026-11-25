package dev.dropit.app.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.auth.OAuthCallbackBus
import dev.dropit.app.core.auth.OAuthCallbackPayload
import dev.dropit.app.core.auth.OAuthLoginResult
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.AuthProvidersInfo
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.ServerUrlException
import dev.dropit.app.core.network.VerifiedServer
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class OnboardingStep {
    SERVER_CONFIG,
    DEVICE_AUTH,
}

data class NativeGoogleSignInRequest(
    val requestId: Long,
    val clientId: String,
)

data class OnboardingUiState(
    val step: OnboardingStep = OnboardingStep.SERVER_CONFIG,
    val serverUrlInput: String = "",
    val configuredServerOrigin: String? = null,
    val verifiedServer: VerifiedServer? = null,
    val isVerifyingServer: Boolean = false,
    val serverError: String? = null,
    val isServerOffline: Boolean = false,
    val sessionExpiredNotice: Boolean = false,
    // Dynamic auth providers (GitHub / Google / Email+Password)
    val providersInfo: AuthProvidersInfo? = null,
    val isLoadingProviders: Boolean = false,
    val providersError: String? = null,
    // Email + password form
    val emailInput: String = "",
    val passwordInput: String = "",
    val inviteCodeInput: String = "",
    val showInviteInput: Boolean = false,
    val isPasswordLoginInProgress: Boolean = false,
    // OAuth login state (native Google Credential Manager + Custom Tabs fallback)
    val activeOAuthProvider: String? = null,
    val isNativeGoogleSignInInProgress: Boolean = false,
    val pendingNativeGoogleRequest: NativeGoogleSignInRequest? = null,
    val oauthFallbackNotice: String? = null,
    val isExchangingOAuthCode: Boolean = false,
    val pendingOAuthLaunchUrl: String? = null,
    // Unified auth error banner
    val authError: String? = null,
    val isAuthOffline: Boolean = false,
    // Collapsible secondary Device Code fallback
    val isDeviceCodeExpanded: Boolean = false,
    val deviceAuthState: DeviceAuthState = DeviceAuthState.Idle,
    val initialPollIntervalSeconds: Int? = null,
    val browserOpened: Boolean = false,
) {
    val enabledOAuthProviders: List<String>
        get() = providersInfo?.providers
            .orEmpty()
            .map { it.trim().lowercase() }
            .filter { it == "github" || it == "google" }
            .distinct()

    val isPasswordEnabled: Boolean
        get() = providersInfo?.password ?: true

    val googleClientId: String?
        get() = providersInfo?.googleClientId?.trim()?.takeIf { it.isNotEmpty() }

    val isBusySigningIn: Boolean
        get() = isPasswordLoginInProgress || isExchangingOAuthCode || isNativeGoogleSignInInProgress

    val isSlowedDown: Boolean
        get() {
            val waiting = deviceAuthState as? DeviceAuthState.WaitingForApproval ?: return false
            val base = initialPollIntervalSeconds ?: return false
            return waiting.pollIntervalSeconds > base
        }
}

class OnboardingViewModel(
    private val authRepository: AuthRepository,
    private val oauthCallbackBus: OAuthCallbackBus? = null,
    initialServerOrigin: String? = null,
    initialSessionExpired: Boolean = false,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val pollDelayMillis: suspend (Long) -> Unit = { delay(it) },
    private val autoStartDeviceAuth: Boolean = false,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        OnboardingUiState(
            step = if (!initialServerOrigin.isNullOrBlank()) OnboardingStep.DEVICE_AUTH else OnboardingStep.SERVER_CONFIG,
            serverUrlInput = initialServerOrigin.orEmpty(),
            configuredServerOrigin = initialServerOrigin?.takeIf { it.isNotBlank() },
            sessionExpiredNotice = initialSessionExpired,
            isDeviceCodeExpanded = autoStartDeviceAuth && !initialServerOrigin.isNullOrBlank(),
        ),
    )
    val uiState: StateFlow<OnboardingUiState> = _uiState.asStateFlow()

    private var providersJob: Job? = null
    private var deviceAuthJob: Job? = null
    private var lastLoadedProvidersOrigin: String? = null
    private var nextNativeGoogleRequestId: Long = 0L
    private var activeNativeGoogleRequestId: Long? = null

    init {
        observeOAuthCallbacks()
        val initialOrigin = initialServerOrigin?.trim()?.takeIf { it.isNotEmpty() }
        if (initialOrigin != null) {
            loadProviders(initialOrigin)
            if (autoStartDeviceAuth) {
                startDeviceAuth(initialOrigin)
            }
        }
    }

    private fun observeOAuthCallbacks() {
        val bus = oauthCallbackBus ?: return
        viewModelScope.launch {
            // Check sticky pending callback first (cold activity recreation after Custom Tabs return).
            val sticky = bus.pendingCallback.value
            if (sticky != null && sticky !is OAuthCallbackPayload.Linked && !authRepository.sessionState.value.isSignedIn) {
                val consumed = bus.consumePendingCallback()
                if (consumed != null) {
                    handleOAuthCallback(consumed)
                }
            }
            bus.events.collect { payload ->
                if (payload is OAuthCallbackPayload.Linked) return@collect
                if (authRepository.sessionState.value.isSignedIn) return@collect
                if (bus.pendingCallback.value == payload) {
                    bus.consumePendingCallback()
                }
                handleOAuthCallback(payload)
            }
        }
    }

    fun syncEntry(serverOrigin: String?, sessionExpired: Boolean) {
        val cleaned = serverOrigin?.trim()?.takeIf { it.isNotEmpty() }
        val current = _uiState.value
        if (cleaned == null) {
            if (current.step != OnboardingStep.SERVER_CONFIG || current.configuredServerOrigin != null) {
                cancelBackgroundAuthJobs()
                authRepository.resetDeviceAuthState()
                lastLoadedProvidersOrigin = null
                _uiState.update {
                    it.copy(
                        step = OnboardingStep.SERVER_CONFIG,
                        configuredServerOrigin = null,
                        verifiedServer = null,
                        sessionExpiredNotice = false,
                        providersInfo = null,
                        isLoadingProviders = false,
                        providersError = null,
                        passwordInput = "",
                        inviteCodeInput = "",
                        showInviteInput = false,
                        isPasswordLoginInProgress = false,
                        activeOAuthProvider = null,
                        isNativeGoogleSignInInProgress = false,
                        pendingNativeGoogleRequest = null,
                        oauthFallbackNotice = null,
                        isExchangingOAuthCode = false,
                        pendingOAuthLaunchUrl = null,
                        authError = null,
                        isAuthOffline = false,
                        isDeviceCodeExpanded = false,
                        deviceAuthState = DeviceAuthState.Idle,
                        initialPollIntervalSeconds = null,
                        browserOpened = false,
                    )
                }
            }
            return
        }

        // If submitServerUrl() is currently verifying this exact server, let it finish cleanly.
        if (current.isVerifyingServer && current.serverUrlInput == cleaned) {
            return
        }

        val serverChanged = current.configuredServerOrigin != cleaned
        val reenteringAfterSignedOut = current.step != OnboardingStep.DEVICE_AUTH ||
            current.deviceAuthState is DeviceAuthState.Approved

        if (!serverChanged && !reenteringAfterSignedOut) {
            if (sessionExpired && !current.sessionExpiredNotice) {
                _uiState.update { it.copy(sessionExpiredNotice = true) }
            }
            if (current.providersInfo == null && !current.isLoadingProviders && lastLoadedProvidersOrigin != cleaned) {
                loadProviders(cleaned)
            }
            return
        }

        cancelBackgroundAuthJobs()
        authRepository.resetDeviceAuthState()
        _uiState.update {
            it.copy(
                step = OnboardingStep.DEVICE_AUTH,
                serverUrlInput = if (serverChanged || it.serverUrlInput.isBlank()) cleaned else it.serverUrlInput,
                configuredServerOrigin = cleaned,
                verifiedServer = if (serverChanged) null else it.verifiedServer,
                sessionExpiredNotice = sessionExpired,
                providersInfo = if (serverChanged) null else it.providersInfo,
                providersError = null,
                passwordInput = "",
                inviteCodeInput = if (serverChanged) "" else it.inviteCodeInput,
                showInviteInput = if (serverChanged) false else it.showInviteInput,
                isPasswordLoginInProgress = false,
                activeOAuthProvider = null,
                isNativeGoogleSignInInProgress = false,
                pendingNativeGoogleRequest = null,
                oauthFallbackNotice = null,
                isExchangingOAuthCode = false,
                pendingOAuthLaunchUrl = null,
                authError = null,
                isAuthOffline = false,
                isDeviceCodeExpanded = autoStartDeviceAuth,
                deviceAuthState = DeviceAuthState.Idle,
                initialPollIntervalSeconds = null,
                browserOpened = false,
            )
        }
        loadProviders(cleaned, force = serverChanged)
        if (autoStartDeviceAuth) {
            startDeviceAuth(cleaned)
        }
    }

    fun onServerUrlChanged(value: String) {
        _uiState.update {
            it.copy(
                serverUrlInput = value,
                serverError = null,
                isServerOffline = false,
            )
        }
    }

    fun submitServerUrl() {
        val raw = _uiState.value.serverUrlInput
        val normalized = try {
            ServerUrl.normalizeServerUrl(raw)
        } catch (e: ServerUrlException) {
            _uiState.update {
                it.copy(
                    serverError = e.message ?: "请输入合法的 https:// 服务器地址",
                    isServerOffline = false,
                )
            }
            return
        }

        _uiState.update {
            it.copy(
                serverUrlInput = normalized,
                isVerifyingServer = true,
                serverError = null,
                isServerOffline = false,
            )
        }

        viewModelScope.launch {
            try {
                val verified = withContext(ioDispatcher) {
                    authRepository.verifyAndSaveServer(normalized)
                }
                _uiState.update {
                    it.copy(
                        isVerifyingServer = false,
                        verifiedServer = verified,
                        configuredServerOrigin = verified.serverOrigin,
                        serverUrlInput = verified.serverOrigin,
                        step = OnboardingStep.DEVICE_AUTH,
                        serverError = null,
                        isServerOffline = false,
                        sessionExpiredNotice = false,
                        authError = null,
                        isAuthOffline = false,
                        passwordInput = "",
                        activeOAuthProvider = null,
                        isExchangingOAuthCode = false,
                        isDeviceCodeExpanded = autoStartDeviceAuth,
                        deviceAuthState = DeviceAuthState.Idle,
                    )
                }
                loadProviders(verified.serverOrigin, force = true)
                if (autoStartDeviceAuth) {
                    startDeviceAuth(verified.serverOrigin)
                }
            } catch (e: ApiError) {
                val offline = e.errorCode == ApiErrorCode.NETWORK_ERROR
                _uiState.update {
                    it.copy(
                        isVerifyingServer = false,
                        serverError = if (offline) {
                            "当前处于离线状态或无法连接到服务器，请检查网络后重试"
                        } else {
                            e.userMessage
                        },
                        isServerOffline = offline,
                    )
                }
            } catch (e: ServerUrlException) {
                _uiState.update {
                    it.copy(
                        isVerifyingServer = false,
                        serverError = e.message ?: "地址格式不正确",
                        isServerOffline = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isVerifyingServer = false,
                        serverError = e.message?.takeIf { msg -> msg.isNotBlank() } ?: "无法验证服务器地址，请重试",
                        isServerOffline = false,
                    )
                }
            }
        }
    }

    fun loadProviders(serverOrigin: String? = _uiState.value.configuredServerOrigin, force: Boolean = false) {
        val origin = serverOrigin?.trim()?.takeIf { it.isNotEmpty() } ?: return
        if (!force && lastLoadedProvidersOrigin == origin && _uiState.value.providersInfo != null) {
            return
        }
        providersJob?.cancel()
        lastLoadedProvidersOrigin = origin
        _uiState.update {
            it.copy(
                isLoadingProviders = true,
                providersError = null,
            )
        }
        providersJob = viewModelScope.launch {
            try {
                val info = withContext(ioDispatcher) {
                    authRepository.getAuthProviders(origin)
                }
                _uiState.update { current ->
                    if (current.configuredServerOrigin != origin) {
                        current
                    } else {
                        current.copy(
                            providersInfo = info,
                            isLoadingProviders = false,
                            providersError = null,
                        )
                    }
                }
            } catch (e: UnsupportedOperationException) {
                // Fallback for minimal test doubles without providers override.
                _uiState.update {
                    it.copy(
                        providersInfo = AuthProvidersInfo(providers = emptyList(), password = true),
                        isLoadingProviders = false,
                        providersError = null,
                    )
                }
            } catch (e: ApiError) {
                _uiState.update {
                    it.copy(
                        isLoadingProviders = false,
                        providersError = e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingProviders = false,
                        providersError = e.message?.takeIf { m -> m.isNotBlank() } ?: "获取登录方式失败",
                    )
                }
            }
        }
    }

    fun onEmailChanged(value: String) {
        _uiState.update { it.copy(emailInput = value, authError = null, isAuthOffline = false) }
    }

    fun onPasswordChanged(value: String) {
        _uiState.update { it.copy(passwordInput = value, authError = null, isAuthOffline = false) }
    }

    fun onInviteCodeChanged(value: String) {
        _uiState.update { it.copy(inviteCodeInput = value, authError = null, isAuthOffline = false) }
    }

    fun toggleInviteInput() {
        _uiState.update { it.copy(showInviteInput = !it.showInviteInput) }
    }

    fun submitPasswordLogin() {
        val current = _uiState.value
        val origin = current.configuredServerOrigin ?: return
        if (current.isBusySigningIn) return

        val email = current.emailInput.trim()
        val password = current.passwordInput
        val invite = current.inviteCodeInput.trim().takeIf { it.isNotEmpty() }
        if (email.isEmpty() || password.isEmpty()) {
            _uiState.update { it.copy(authError = "请输入邮箱和密码", isAuthOffline = false) }
            return
        }

        _uiState.update {
            it.copy(
                isPasswordLoginInProgress = true,
                authError = null,
                isAuthOffline = false,
            )
        }

        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    authRepository.loginWithPassword(
                        serverOrigin = origin,
                        email = email,
                        password = password,
                        invite = invite,
                    )
                }
                _uiState.update {
                    it.copy(
                        isPasswordLoginInProgress = false,
                        passwordInput = "",
                        inviteCodeInput = "",
                        showInviteInput = false,
                        sessionExpiredNotice = false,
                        authError = null,
                        isAuthOffline = false,
                    )
                }
            } catch (e: ApiError) {
                val offline = e.errorCode == ApiErrorCode.NETWORK_ERROR
                val needsInvite = e.errorCode == ApiErrorCode.INVITATION_REQUIRED ||
                    e.errorCode == ApiErrorCode.INVITE_INVALID
                _uiState.update {
                    it.copy(
                        isPasswordLoginInProgress = false,
                        authError = e.userMessage,
                        isAuthOffline = offline,
                        showInviteInput = it.showInviteInput || needsInvite,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isPasswordLoginInProgress = false,
                        authError = e.message?.takeIf { m -> m.isNotBlank() } ?: "登录失败，请重试",
                        isAuthOffline = false,
                    )
                }
            }
        }
    }

    fun startOAuthLogin(provider: String) {
        val current = _uiState.value
        val origin = current.configuredServerOrigin ?: return
        if (current.isBusySigningIn) return

        val normalizedProvider = provider.trim().lowercase()
        val invite = current.inviteCodeInput.trim().takeIf { it.isNotEmpty() }

        // Prefer Android native Google Credential Manager when server publishes googleClientId.
        val googleClientId = current.googleClientId
        if (normalizedProvider == "google" && googleClientId != null) {
            val requestId = ++nextNativeGoogleRequestId
            activeNativeGoogleRequestId = requestId
            _uiState.update {
                it.copy(
                    activeOAuthProvider = "google",
                    isNativeGoogleSignInInProgress = true,
                    pendingNativeGoogleRequest = NativeGoogleSignInRequest(
                        requestId = requestId,
                        clientId = googleClientId,
                    ),
                    oauthFallbackNotice = null,
                    authError = null,
                    isAuthOffline = false,
                    pendingOAuthLaunchUrl = null,
                )
            }
            return
        }

        launchBrowserOAuth(
            origin = origin,
            normalizedProvider = normalizedProvider,
            invite = invite,
            fallbackNotice = null,
        )
    }

    fun consumePendingNativeGoogleRequest(requestId: Long? = null) {
        _uiState.update { current ->
            val pending = current.pendingNativeGoogleRequest
            if (pending != null && (requestId == null || pending.requestId == requestId)) {
                current.copy(pendingNativeGoogleRequest = null)
            } else {
                current
            }
        }
    }

    fun onNativeGoogleIdTokenResult(
        result: GoogleIdTokenFetchResult,
        requestId: Long? = null,
    ) {
        val currentActiveId = activeNativeGoogleRequestId
        if (requestId != null && (currentActiveId == null || requestId != currentActiveId)) {
            return
        }
        activeNativeGoogleRequestId = null

        val current = _uiState.value
        val origin = current.configuredServerOrigin
        val invite = current.inviteCodeInput.trim().takeIf { it.isNotEmpty() }

        when (result) {
            GoogleIdTokenFetchResult.Cancelled -> {
                // User dismissed the system Google account picker or composition was cancelled:
                // silently restore idle button state so UI can never get stuck.
                _uiState.update {
                    it.copy(
                        activeOAuthProvider = null,
                        isNativeGoogleSignInInProgress = false,
                        pendingNativeGoogleRequest = null,
                        oauthFallbackNotice = null,
                    )
                }
            }

            is GoogleIdTokenFetchResult.FallbackToBrowser -> {
                if (origin == null) {
                    _uiState.update {
                        it.copy(
                            activeOAuthProvider = null,
                            isNativeGoogleSignInInProgress = false,
                            pendingNativeGoogleRequest = null,
                        )
                    }
                    return
                }
                launchBrowserOAuth(
                    origin = origin,
                    normalizedProvider = "google",
                    invite = invite,
                    fallbackNotice = "已自动切换浏览器完成 Google 登录",
                )
            }

            is GoogleIdTokenFetchResult.Success -> {
                if (origin == null) {
                    _uiState.update {
                        it.copy(
                            activeOAuthProvider = null,
                            isNativeGoogleSignInInProgress = false,
                            pendingNativeGoogleRequest = null,
                        )
                    }
                    return
                }
                _uiState.update {
                    it.copy(
                        activeOAuthProvider = "google",
                        isNativeGoogleSignInInProgress = false,
                        pendingNativeGoogleRequest = null,
                        oauthFallbackNotice = null,
                        isExchangingOAuthCode = true,
                        authError = null,
                        isAuthOffline = false,
                    )
                }
                viewModelScope.launch {
                    try {
                        withContext(ioDispatcher) {
                            authRepository.loginWithGoogleIdToken(
                                serverOrigin = origin,
                                idToken = result.idToken,
                                invite = invite,
                            )
                        }
                        _uiState.update {
                            it.copy(
                                activeOAuthProvider = null,
                                isNativeGoogleSignInInProgress = false,
                                isExchangingOAuthCode = false,
                                pendingOAuthLaunchUrl = null,
                                oauthFallbackNotice = null,
                                inviteCodeInput = "",
                                showInviteInput = false,
                                sessionExpiredNotice = false,
                                authError = null,
                                isAuthOffline = false,
                            )
                        }
                    } catch (e: ApiError) {
                        val offline = e.errorCode == ApiErrorCode.NETWORK_ERROR
                        val needsInvite = e.errorCode == ApiErrorCode.INVITATION_REQUIRED ||
                            e.errorCode == ApiErrorCode.INVITE_INVALID
                        _uiState.update {
                            it.copy(
                                activeOAuthProvider = null,
                                isNativeGoogleSignInInProgress = false,
                                isExchangingOAuthCode = false,
                                authError = e.userMessage,
                                isAuthOffline = offline,
                                showInviteInput = it.showInviteInput || needsInvite,
                            )
                        }
                    } catch (e: Exception) {
                        _uiState.update {
                            it.copy(
                                activeOAuthProvider = null,
                                isNativeGoogleSignInInProgress = false,
                                isExchangingOAuthCode = false,
                                authError = e.message?.takeIf { m -> m.isNotBlank() } ?: "Google 登录失败，请重试",
                                isAuthOffline = false,
                            )
                        }
                    }
                }
            }
        }
    }

    private fun launchBrowserOAuth(
        origin: String,
        normalizedProvider: String,
        invite: String?,
        fallbackNotice: String?,
    ) {
        activeNativeGoogleRequestId = null
        _uiState.update {
            it.copy(
                activeOAuthProvider = normalizedProvider,
                isNativeGoogleSignInInProgress = false,
                pendingNativeGoogleRequest = null,
                oauthFallbackNotice = fallbackNotice,
                authError = null,
                isAuthOffline = false,
                pendingOAuthLaunchUrl = null,
            )
        }

        viewModelScope.launch {
            try {
                val pending = withContext(ioDispatcher) {
                    authRepository.startAppOAuthLogin(
                        serverOrigin = origin,
                        provider = normalizedProvider,
                        invite = invite,
                    )
                }
                _uiState.update {
                    it.copy(
                        activeOAuthProvider = normalizedProvider,
                        pendingOAuthLaunchUrl = pending.launchUrl,
                    )
                }
            } catch (e: ApiError) {
                _uiState.update {
                    it.copy(
                        activeOAuthProvider = null,
                        oauthFallbackNotice = null,
                        authError = e.userMessage,
                        isAuthOffline = e.errorCode == ApiErrorCode.NETWORK_ERROR,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        activeOAuthProvider = null,
                        oauthFallbackNotice = null,
                        authError = e.message?.takeIf { m -> m.isNotBlank() } ?: "无法拉起第三方登录",
                        isAuthOffline = false,
                    )
                }
            }
        }
    }

    fun consumePendingOAuthLaunchUrl() {
        _uiState.update { it.copy(pendingOAuthLaunchUrl = null) }
    }

    fun cancelOAuthLogin() {
        activeNativeGoogleRequestId = null
        viewModelScope.launch {
            runCatching {
                withContext(ioDispatcher) { authRepository.clearPendingOAuthFlow() }
            }
            _uiState.update {
                it.copy(
                    activeOAuthProvider = null,
                    isNativeGoogleSignInInProgress = false,
                    pendingNativeGoogleRequest = null,
                    oauthFallbackNotice = null,
                    isExchangingOAuthCode = false,
                    pendingOAuthLaunchUrl = null,
                )
            }
        }
    }

    fun handleOAuthCallback(payload: OAuthCallbackPayload) {
        if (payload is OAuthCallbackPayload.Linked) return
        activeNativeGoogleRequestId = null
        _uiState.update {
            it.copy(
                isNativeGoogleSignInInProgress = false,
                pendingNativeGoogleRequest = null,
                isExchangingOAuthCode = true,
                authError = null,
                isAuthOffline = false,
            )
        }
        viewModelScope.launch {
            val result = try {
                withContext(ioDispatcher) {
                    authRepository.handleOAuthLoginCallback(payload)
                }
            } catch (e: ApiError) {
                OAuthLoginResult.Failed(e)
            } catch (e: Exception) {
                OAuthLoginResult.Failed(ApiError.network(e))
            }

            when (result) {
                is OAuthLoginResult.Success -> {
                    _uiState.update {
                        it.copy(
                            activeOAuthProvider = null,
                            isNativeGoogleSignInInProgress = false,
                            isExchangingOAuthCode = false,
                            pendingOAuthLaunchUrl = null,
                            oauthFallbackNotice = null,
                            inviteCodeInput = "",
                            showInviteInput = false,
                            sessionExpiredNotice = false,
                            authError = null,
                            isAuthOffline = false,
                        )
                    }
                }
                is OAuthLoginResult.Failed -> {
                    val needsInvite = result.error.errorCode == ApiErrorCode.INVITATION_REQUIRED ||
                        result.error.errorCode == ApiErrorCode.INVITE_INVALID
                    _uiState.update {
                        it.copy(
                            activeOAuthProvider = null,
                            isNativeGoogleSignInInProgress = false,
                            isExchangingOAuthCode = false,
                            pendingOAuthLaunchUrl = null,
                            oauthFallbackNotice = null,
                            authError = result.error.userMessage,
                            isAuthOffline = result.error.errorCode == ApiErrorCode.NETWORK_ERROR,
                            showInviteInput = it.showInviteInput || needsInvite,
                        )
                    }
                }
            }
        }
    }

    fun toggleDeviceCodeSection() {
        val nextExpanded = !_uiState.value.isDeviceCodeExpanded
        if (nextExpanded) {
            _uiState.update { it.copy(isDeviceCodeExpanded = true) }
            val currentDeviceState = _uiState.value.deviceAuthState
            if (currentDeviceState is DeviceAuthState.Idle ||
                currentDeviceState is DeviceAuthState.Expired ||
                currentDeviceState is DeviceAuthState.Denied ||
                currentDeviceState is DeviceAuthState.Failed
            ) {
                startDeviceAuth()
            }
        } else {
            deviceAuthJob?.cancel()
            deviceAuthJob = null
            authRepository.resetDeviceAuthState()
            _uiState.update {
                it.copy(
                    isDeviceCodeExpanded = false,
                    deviceAuthState = DeviceAuthState.Idle,
                    initialPollIntervalSeconds = null,
                    browserOpened = false,
                )
            }
        }
    }

    fun startDeviceAuth(serverOrigin: String? = _uiState.value.configuredServerOrigin) {
        val origin = serverOrigin?.trim()?.takeIf { it.isNotEmpty() } ?: return
        deviceAuthJob?.cancel()
        _uiState.update {
            it.copy(
                step = OnboardingStep.DEVICE_AUTH,
                configuredServerOrigin = origin,
                isDeviceCodeExpanded = true,
                deviceAuthState = DeviceAuthState.RequestingCode,
                initialPollIntervalSeconds = null,
                browserOpened = false,
            )
        }

        deviceAuthJob = viewModelScope.launch {
            try {
                val authorization = withContext(ioDispatcher) {
                    authRepository.startDeviceAuthorization(origin)
                }
                _uiState.update {
                    it.copy(
                        initialPollIntervalSeconds = authorization.interval.coerceAtLeast(1),
                        deviceAuthState = DeviceAuthState.WaitingForApproval(
                            authorization = authorization,
                            pollIntervalSeconds = authorization.interval.coerceAtLeast(1),
                        ),
                    )
                }
                withContext(ioDispatcher) {
                    authRepository.pollDeviceAuthorization(
                        serverOrigin = origin,
                        authorization = authorization,
                        delayMillis = pollDelayMillis,
                    ).collect { state ->
                        _uiState.update { current ->
                            current.copy(
                                deviceAuthState = state,
                                sessionExpiredNotice = if (state is DeviceAuthState.Approved) false else current.sessionExpiredNotice,
                            )
                        }
                    }
                }
            } catch (e: ApiError) {
                _uiState.update { it.copy(deviceAuthState = DeviceAuthState.Failed(e)) }
            } catch (e: Exception) {
                val wrapped = ApiError(
                    errorCode = ApiErrorCode.NETWORK_ERROR,
                    rawCode = "DEVICE_AUTH_ERROR",
                    httpStatus = 0,
                    userMessage = e.message?.takeIf { it.isNotBlank() } ?: ApiErrorCode.NETWORK_ERROR.defaultMessage,
                    cause = e,
                )
                _uiState.update { it.copy(deviceAuthState = DeviceAuthState.Failed(wrapped)) }
            }
        }
    }

    fun onBrowserApprovalLaunched() {
        _uiState.update { it.copy(browserOpened = true) }
    }

    fun switchServer() {
        cancelBackgroundAuthJobs()
        authRepository.resetDeviceAuthState()
        lastLoadedProvidersOrigin = null
        viewModelScope.launch(ioDispatcher) {
            runCatching { authRepository.clearPendingOAuthFlow() }
        }
        _uiState.update {
            it.copy(
                step = OnboardingStep.SERVER_CONFIG,
                serverUrlInput = it.configuredServerOrigin ?: it.serverUrlInput,
                serverError = null,
                isServerOffline = false,
                sessionExpiredNotice = false,
                providersInfo = null,
                isLoadingProviders = false,
                providersError = null,
                passwordInput = "",
                inviteCodeInput = "",
                showInviteInput = false,
                isPasswordLoginInProgress = false,
                activeOAuthProvider = null,
                isNativeGoogleSignInInProgress = false,
                pendingNativeGoogleRequest = null,
                oauthFallbackNotice = null,
                isExchangingOAuthCode = false,
                pendingOAuthLaunchUrl = null,
                authError = null,
                isAuthOffline = false,
                isDeviceCodeExpanded = false,
                deviceAuthState = DeviceAuthState.Idle,
                initialPollIntervalSeconds = null,
                browserOpened = false,
            )
        }
    }

    private fun cancelBackgroundAuthJobs() {
        activeNativeGoogleRequestId = null
        providersJob?.cancel()
        providersJob = null
        deviceAuthJob?.cancel()
        deviceAuthJob = null
    }

    override fun onCleared() {
        cancelBackgroundAuthJobs()
        super.onCleared()
    }

    class Factory(
        private val authRepository: AuthRepository,
        private val oauthCallbackBus: OAuthCallbackBus? = null,
        private val initialServerOrigin: String?,
        private val initialSessionExpired: Boolean,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return OnboardingViewModel(
                authRepository = authRepository,
                oauthCallbackBus = oauthCallbackBus,
                initialServerOrigin = initialServerOrigin,
                initialSessionExpired = initialSessionExpired,
            ) as T
        }
    }
}
