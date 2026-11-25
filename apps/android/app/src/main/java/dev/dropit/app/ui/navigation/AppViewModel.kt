package dev.dropit.app.ui.navigation

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

sealed class AppRoute {
    data object Initializing : AppRoute()
    data class Onboarding(
        val serverOrigin: String?,
        val sessionExpired: Boolean,
    ) : AppRoute()

    data class Main(val serverOrigin: String) : AppRoute()
}

data class AppRootUiState(
    val route: AppRoute = AppRoute.Initializing,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val activeTransferCount: Int = 0,
    val failedTransferCount: Int = 0,
    val transferTasks: List<TransferTask> = emptyList(),
    val isLoggingOut: Boolean = false,
)

class AppViewModel(
    private val container: AppContainer,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    autoInitialize: Boolean = true,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AppRootUiState())
    val uiState: StateFlow<AppRootUiState> = _uiState.asStateFlow()

    private var initialized = false
    private var sessionExpiredNotice = false

    init {
        observeSettings()
        observeSession()
        observeTransfers()
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

    private fun observeGlobalUnauthorized() {
        viewModelScope.launch(ioDispatcher) {
            container.apiClient.sessionExpiredEvents.collect {
                markSessionExpired()
            }
        }
    }

    fun markSessionExpired() {
        viewModelScope.launch(ioDispatcher) {
            sessionExpiredNotice = true
            container.realtimeClient.disconnect(clearState = false)
            container.authRepository.logout(clearServer = false)
            val origin = container.settingsStore.getServerOrigin()
            updateRouteFromSession(origin, isSignedIn = false)
        }
    }

    fun setThemeMode(mode: ThemeMode) {
        viewModelScope.launch(ioDispatcher) {
            container.settingsStore.setThemeMode(mode)
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
                _uiState.update { it.copy(isLoggingOut = false) }
                val session = container.authRepository.sessionState.value
                updateRouteFromSession(session.serverOrigin, session.isSignedIn)
            }
        }
    }

    private fun updateRouteFromSession(serverOrigin: String?, isSignedIn: Boolean) {
        val nextRoute = when {
            isSignedIn && !serverOrigin.isNullOrBlank() -> AppRoute.Main(serverOrigin)
            else -> AppRoute.Onboarding(
                serverOrigin = serverOrigin?.takeIf { it.isNotBlank() },
                sessionExpired = sessionExpiredNotice && !serverOrigin.isNullOrBlank(),
            )
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
