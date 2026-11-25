package dev.dropit.app.ui.navigation

import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.ThemeMode
import dev.dropit.app.core.repository.TransferStatus
import dev.dropit.app.core.repository.TransferTask
import dev.dropit.app.di.AppContainer
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Pure guard for incoming Android share intents in [dev.dropit.app.MainActivity].
 * Ignores intents replayed from Android Recents (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`)
 * and non-share actions so re-opening the app never re-triggers a duplicate share.
 */
object ShareIntentGuard {
    fun shouldCapture(intent: Intent?): Boolean {
        if (intent == null) return false
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        return shouldCapture(action = intent.action, flags = intent.flags)
    }

    fun shouldCapture(action: String?, flags: Int): Boolean {
        if ((flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        return action == Intent.ACTION_SEND || action == Intent.ACTION_SEND_MULTIPLE
    }
}

sealed class AppRoute {
    data object Initializing : AppRoute()
    data class Onboarding(
        val serverOrigin: String?,
        val sessionExpired: Boolean,
    ) : AppRoute()

    data class Main(
        val serverOrigin: String,
        val sessionGeneration: Long,
    ) : AppRoute()
}

data class AppRootUiState(
    val route: AppRoute = AppRoute.Initializing,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val activeTransferCount: Int = 0,
    val failedTransferCount: Int = 0,
    val transferTasks: List<TransferTask> = emptyList(),
    val hasPendingShare: Boolean = false,
    val isLoggingOut: Boolean = false,
)

class AppViewModel(
    private val container: AppContainer,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    autoInitialize: Boolean = true,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AppRootUiState())
    val uiState: StateFlow<AppRootUiState> = _uiState.asStateFlow()

    private val sessionExpiredMutex = Mutex()
    private var initialized = false
    private var sessionExpiredNotice = false
    private var sessionGeneration = 0L
    private var activeMainOrigin: String? = null
    private var handledGenerationFor401: Long = -1L

    init {
        observeSettings()
        observeSession()
        observeTransfers()
        observePendingShare()
        observeGlobalUnauthorized()
        if (autoInitialize) {
            initialize()
        }
    }

    fun initialize() {
        viewModelScope.launch(ioDispatcher) {
            container.initialize()
            initialized = true
            val session = container.authRepository.sessionState.value
            updateRouteFromSession(session.serverOrigin, session.isSignedIn)
        }
    }

    private fun observeSettings() {
        viewModelScope.launch {
            container.settingsStore.settings.collect { settings ->
                _uiState.update { it.copy(themeMode = settings.themeMode) }
            }
        }
    }

    private fun observeSession() {
        viewModelScope.launch {
            container.authRepository.sessionState.collect { session ->
                if (!initialized) return@collect
                if (session.isSignedIn) {
                    sessionExpiredNotice = false
                }
                updateRouteFromSession(session.serverOrigin, session.isSignedIn)
            }
        }
    }

    private fun observeTransfers() {
        viewModelScope.launch {
            container.transferManager.activeCount.collect { count ->
                _uiState.update { it.copy(activeTransferCount = count) }
            }
        }
        viewModelScope.launch {
            container.transferManager.tasks.collect { tasks ->
                val failed = tasks.count { it.status == TransferStatus.FAILED }
                _uiState.update {
                    it.copy(
                        transferTasks = tasks,
                        failedTransferCount = failed,
                    )
                }
            }
        }
    }

    private fun observePendingShare() {
        viewModelScope.launch {
            container.shareInbox.pendingShare.collect { pending ->
                _uiState.update { it.copy(hasPendingShare = pending != null && !pending.isEmpty) }
            }
        }
    }

    private fun observeGlobalUnauthorized() {
        viewModelScope.launch(ioDispatcher) {
            container.apiClient.sessionExpiredEvents.collect {
                markSessionExpired()
            }
        }
    }

    /**
     * Single owner for global 401 session expiration handling.
     * Deduplicated per active session generation so concurrent 401 responses never trigger
     * duplicate clears while still handling future 401s after re-authentication.
     *
     * Never calls `POST /api/auth/logout` remotely on passive 401 so a transient or
     * endpoint-specific 401 cannot revoke a still-valid device token.
     */
    fun markSessionExpired() {
        viewModelScope.launch(ioDispatcher) {
            sessionExpiredMutex.withLock {
                val currentGen = sessionGeneration
                if (activeMainOrigin == null && handledGenerationFor401 == currentGen) {
                    return@withLock
                }
                if (handledGenerationFor401 == currentGen && currentGen > 0L) {
                    return@withLock
                }
                handledGenerationFor401 = currentGen
                sessionExpiredNotice = true
                container.realtimeClient.disconnect(clearState = false)
                container.authRepository.clearLocalSession(clearServer = false)
                val origin = container.settingsStore.getServerOrigin()
                updateRouteFromSession(origin, isSignedIn = false)
            }
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        viewModelScope.launch(ioDispatcher) {
            container.settingsStore.setThemeMode(mode)
        }
    }

    /**
     * Explicit user-initiated account switch on the same server.
     * Revokes the current device token remotely and wipes account-scoped local state
     * (temporary room state, transfer queue, pending share, media caches) while preserving
     * `serverOrigin` so the user can sign in with another account directly.
     */
    fun switchAccount() {
        if (_uiState.value.isLoggingOut) return
        _uiState.update { it.copy(isLoggingOut = true) }
        viewModelScope.launch(ioDispatcher) {
            try {
                sessionExpiredNotice = false
                container.realtimeClient.disconnect(clearState = true)
                container.roomRepository.clearRoomState()
                container.transferManager.clearAllForScopeSwitch()
                container.shareInbox.discardPendingShare()
                container.mediaRepository.clearCaches()
                container.authRepository.logout(clearServer = false)
            } finally {
                sessionExpiredNotice = false
                _uiState.update { it.copy(isLoggingOut = false) }
                val session = container.authRepository.sessionState.value
                updateRouteFromSession(session.serverOrigin, session.isSignedIn)
            }
        }
    }

    fun logoutAndSwitchServer() {
        if (_uiState.value.isLoggingOut) return
        _uiState.update { it.copy(isLoggingOut = true) }
        viewModelScope.launch(ioDispatcher) {
            try {
                sessionExpiredNotice = false
                container.resetForServerSwitch()
            } finally {
                sessionExpiredNotice = false
                _uiState.update { it.copy(isLoggingOut = false) }
                val session = container.authRepository.sessionState.value
                updateRouteFromSession(session.serverOrigin, session.isSignedIn)
            }
        }
    }

    private fun updateRouteFromSession(serverOrigin: String?, isSignedIn: Boolean) {
        val cleanedOrigin = serverOrigin?.takeIf { it.isNotBlank() }
        val nextRoute = when {
            isSignedIn && cleanedOrigin != null -> {
                if (activeMainOrigin != cleanedOrigin) {
                    sessionGeneration += 1L
                    activeMainOrigin = cleanedOrigin
                }
                AppRoute.Main(
                    serverOrigin = cleanedOrigin,
                    sessionGeneration = sessionGeneration,
                )
            }
            else -> {
                activeMainOrigin = null
                AppRoute.Onboarding(
                    serverOrigin = cleanedOrigin,
                    sessionExpired = sessionExpiredNotice && cleanedOrigin != null,
                )
            }
        }
        _uiState.update { it.copy(route = nextRoute) }
    }

    class Factory(
        private val container: AppContainer,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return AppViewModel(container = container) as T
        }
    }
}
