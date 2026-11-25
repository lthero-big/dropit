package dev.dropit.app.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.AuthRepository
import dev.dropit.app.core.auth.DeviceAuthState
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
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

data class OnboardingUiState(
    val step: OnboardingStep = OnboardingStep.SERVER_CONFIG,
    val serverUrlInput: String = "",
    val configuredServerOrigin: String? = null,
    val verifiedServer: VerifiedServer? = null,
    val isVerifyingServer: Boolean = false,
    val serverError: String? = null,
    val isServerOffline: Boolean = false,
    val sessionExpiredNotice: Boolean = false,
    val deviceAuthState: DeviceAuthState = DeviceAuthState.Idle,
    val initialPollIntervalSeconds: Int? = null,
    val browserOpened: Boolean = false,
) {
    val isSlowedDown: Boolean
        get() {
            val waiting = deviceAuthState as? DeviceAuthState.WaitingForApproval ?: return false
            val base = initialPollIntervalSeconds ?: return false
            return waiting.pollIntervalSeconds > base
        }
}

class OnboardingViewModel(
    private val authRepository: AuthRepository,
    initialServerOrigin: String? = null,
    initialSessionExpired: Boolean = false,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val pollDelayMillis: suspend (Long) -> Unit = { delay(it) },
    private val autoStartDeviceAuth: Boolean = true,
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        OnboardingUiState(
            step = if (!initialServerOrigin.isNullOrBlank()) OnboardingStep.DEVICE_AUTH else OnboardingStep.SERVER_CONFIG,
            serverUrlInput = initialServerOrigin.orEmpty(),
            configuredServerOrigin = initialServerOrigin?.takeIf { it.isNotBlank() },
            sessionExpiredNotice = initialSessionExpired,
        ),
    )
    val uiState: StateFlow<OnboardingUiState> = _uiState.asStateFlow()

    private var authJob: Job? = null

    init {
        if (autoStartDeviceAuth && !initialServerOrigin.isNullOrBlank()) {
            startDeviceAuth(initialServerOrigin)
        }
    }

    fun syncEntry(serverOrigin: String?, sessionExpired: Boolean) {
        val cleaned = serverOrigin?.trim()?.takeIf { it.isNotEmpty() }
        val current = _uiState.value
        if (cleaned == null) {
            if (current.step != OnboardingStep.SERVER_CONFIG || current.configuredServerOrigin != null) {
                authJob?.cancel()
                authJob = null
                authRepository.resetDeviceAuthState()
                _uiState.update {
                    it.copy(
                        step = OnboardingStep.SERVER_CONFIG,
                        configuredServerOrigin = null,
                        verifiedServer = null,
                        sessionExpiredNotice = false,
                        deviceAuthState = DeviceAuthState.Idle,
                        initialPollIntervalSeconds = null,
                        browserOpened = false,
                    )
                }
            }
            return
        }

        // If submitServerUrl() is currently verifying this exact server, let it finish and
        // start device auth once with its VerifiedServer metadata intact.
        if (current.isVerifyingServer && current.serverUrlInput == cleaned) {
            return
        }

        val isAuthInProgress = current.deviceAuthState is DeviceAuthState.RequestingCode ||
            current.deviceAuthState is DeviceAuthState.WaitingForApproval
        val sameServerAlreadyActive = current.configuredServerOrigin == cleaned &&
            current.step == OnboardingStep.DEVICE_AUTH &&
            isAuthInProgress

        if (sameServerAlreadyActive) {
            if (sessionExpired && !current.sessionExpiredNotice) {
                _uiState.update { it.copy(sessionExpiredNotice = true) }
            }
            return
        }

        val serverChanged = current.configuredServerOrigin != cleaned
        _uiState.update {
            it.copy(
                step = OnboardingStep.DEVICE_AUTH,
                serverUrlInput = if (serverChanged || it.serverUrlInput.isBlank()) cleaned else it.serverUrlInput,
                configuredServerOrigin = cleaned,
                verifiedServer = if (serverChanged) null else it.verifiedServer,
                sessionExpiredNotice = sessionExpired,
            )
        }
        startDeviceAuth(cleaned)
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
                    )
                }
                startDeviceAuth(verified.serverOrigin)
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

    fun startDeviceAuth(serverOrigin: String? = _uiState.value.configuredServerOrigin) {
        val origin = serverOrigin?.trim()?.takeIf { it.isNotEmpty() } ?: return
        authJob?.cancel()
        _uiState.update {
            it.copy(
                step = OnboardingStep.DEVICE_AUTH,
                configuredServerOrigin = origin,
                deviceAuthState = DeviceAuthState.RequestingCode,
                initialPollIntervalSeconds = null,
                browserOpened = false,
            )
        }

        authJob = viewModelScope.launch {
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
        authJob?.cancel()
        authJob = null
        authRepository.resetDeviceAuthState()
        _uiState.update {
            it.copy(
                step = OnboardingStep.SERVER_CONFIG,
                serverUrlInput = it.configuredServerOrigin ?: it.serverUrlInput,
                serverError = null,
                isServerOffline = false,
                sessionExpiredNotice = false,
                deviceAuthState = DeviceAuthState.Idle,
                initialPollIntervalSeconds = null,
                browserOpened = false,
            )
        }
    }

    override fun onCleared() {
        authJob?.cancel()
        super.onCleared()
    }

    class Factory(
        private val authRepository: AuthRepository,
        private val initialServerOrigin: String?,
        private val initialSessionExpired: Boolean,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return OnboardingViewModel(
                authRepository = authRepository,
                initialServerOrigin = initialServerOrigin,
                initialSessionExpired = initialSessionExpired,
            ) as T
        }
    }
}
