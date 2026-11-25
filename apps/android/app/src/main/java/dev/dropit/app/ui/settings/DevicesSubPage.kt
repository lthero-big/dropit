package dev.dropit.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.BrowserSessionInfo
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class DevicesUiState(
    val sessions: List<BrowserSessionInfo> = emptyList(),
    val isLoading: Boolean = false,
    val busyIds: Set<String> = emptySet(),
    val isRevokingOthers: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
)

class DevicesViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(DevicesUiState())
    val uiState: StateFlow<DevicesUiState> = _uiState.asStateFlow()

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val list = withContext(ioDispatcher) { repository.listSessions() }
                _uiState.update {
                    it.copy(
                        sessions = list,
                        isLoading = false,
                        requiresScopeUpgrade = false,
                        errorMessage = null,
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载登录设备失败",
                    )
                }
            }
        }
    }

    fun revokeSession(id: String) {
        if (id in _uiState.value.busyIds) return
        _uiState.update { it.copy(busyIds = it.busyIds + id, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { repository.revokeSession(id) }
                _uiState.update { state ->
                    state.copy(
                        busyIds = state.busyIds - id,
                        sessions = state.sessions.filterNot { it.id == id },
                        feedbackMessage = "已将该设备下线",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - id,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - id,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "下线设备失败",
                    )
                }
            }
        }
    }

    fun revokeOtherSessions() {
        if (_uiState.value.isRevokingOthers) return
        _uiState.update { it.copy(isRevokingOthers = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val revoked = withContext(ioDispatcher) { repository.revokeOtherSessions() }
                val refreshed = withContext(ioDispatcher) { repository.listSessions() }
                _uiState.update {
                    it.copy(
                        isRevokingOthers = false,
                        sessions = refreshed,
                        feedbackMessage = "已踢出 $revoked 个其他设备会话",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isRevokingOthers = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isRevokingOthers = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "操作失败",
                    )
                }
            }
        }
    }

    class Factory(
        private val repository: AccountSettingsRepository,
        private val onSessionExpired: () -> Unit,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return DevicesViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DevicesSubPage(
    viewModel: DevicesViewModel,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var confirmRevokeOthers by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        viewModel.load()
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.DEVICES.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = viewModel::load,
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(onReauthenticate = onReauthenticate)
            return@SettingsSubPageScaffold
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        if (state.sessions.isNotEmpty()) {
            OutlinedButton(
                onClick = { confirmRevokeOthers = true },
                enabled = !state.isRevokingOthers,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.5f)),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
            ) {
                Text(
                    text = if (state.isRevokingOthers) "正在踢出其他设备…" else "一键踢出其他全部浏览器会话",
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        if (!state.isLoading && state.sessions.isEmpty()) {
            SettingsSectionCard {
                Text(
                    text = "当前没有活跃的浏览器登录会话。移动 App 与 CLI 的访问令牌请在「访问令牌与设备码」中管理。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                state.sessions.forEach { session ->
                    val title = session.device?.name?.takeIf { it.isNotBlank() }
                        ?: listOf(session.os, session.browser).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { "浏览器会话" }
                    val isBusy = session.id in state.busyIds
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = shapes.lg,
                        color = colors.surface1,
                        border = BorderStroke(1.dp, colors.line1),
                        tonalElevation = 0.dp,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(14.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = title,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.fg,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = { viewModel.revokeSession(session.id) },
                                    enabled = !isBusy,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                ) {
                                    Text("下线")
                                }
                            }

                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                SettingsStatusPill(
                                    text = if (session.online) "在线" else "离线",
                                    containerColor = if (session.online) colors.okSoft else colors.surface2,
                                    contentColor = if (session.online) colors.ok else colors.fg3,
                                )
                                if (session.current) {
                                    SettingsStatusPill(
                                        text = "当前会话",
                                        containerColor = colors.brandSoft,
                                        contentColor = colors.brand,
                                    )
                                }
                                session.ipSummary?.takeIf { it.isNotBlank() }?.let { ip ->
                                    SettingsStatusPill(
                                        text = ip,
                                        containerColor = colors.surface0,
                                        contentColor = colors.fg2,
                                    )
                                }
                            }

                            Text(
                                text = "最近活跃：${formatSettingsDateTime(session.lastSeenAt ?: session.createdAt)} · 过期：${formatSettingsDateTime(session.expiresAt)}",
                                style = DropitMonoTypography.meta,
                                color = colors.fg3,
                            )
                        }
                    }
                }
            }
        }
    }

    if (confirmRevokeOthers) {
        SettingsConfirmDialog(
            title = "踢出其他全部设备？",
            message = "将立即吊销其他全部浏览器会话，对方需要重新登录。",
            confirmLabel = "确认踢出",
            onConfirm = {
                confirmRevokeOthers = false
                viewModel.revokeOtherSessions()
            },
            onDismiss = { confirmRevokeOthers = false },
        )
    }
}
