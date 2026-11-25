package dev.dropit.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.OAuthLinkResult
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.LinkedIdentityInfo
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

data class SecurityUiState(
    val hasPassword: Boolean = false,
    val currentPasswordInput: String = "",
    val newPasswordInput: String = "",
    val confirmPasswordInput: String = "",
    val isChangingPassword: Boolean = false,
    val identities: List<LinkedIdentityInfo> = emptyList(),
    val availableProviders: List<String> = emptyList(),
    val pendingLinkLaunchUrl: String? = null,
    val isLoading: Boolean = false,
    val isMutatingOAuth: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
) {
    val totalLoginMethods: Int
        get() = (if (hasPassword) 1 else 0) + identities.size

    val canUnlinkAnyIdentity: Boolean
        get() = totalLoginMethods > 1
}

class SecurityViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SecurityUiState())
    val uiState: StateFlow<SecurityUiState> = _uiState.asStateFlow()

    fun load(hasPassword: Boolean) {
        _uiState.update { it.copy(hasPassword = hasPassword, isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val resp = withContext(ioDispatcher) { repository.listIdentities() }
                _uiState.update {
                    it.copy(
                        identities = resp.identities,
                        availableProviders = resp.available.map { p -> p.trim().lowercase() }.distinct(),
                        isLoading = false,
                        requiresScopeUpgrade = false,
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载登录方式失败",
                    )
                }
            }
        }
    }

    fun onCurrentPasswordChanged(value: String) {
        _uiState.update { it.copy(currentPasswordInput = value, errorMessage = null, feedbackMessage = null) }
    }

    fun onNewPasswordChanged(value: String) {
        _uiState.update { it.copy(newPasswordInput = value, errorMessage = null, feedbackMessage = null) }
    }

    fun onConfirmPasswordChanged(value: String) {
        _uiState.update { it.copy(confirmPasswordInput = value, errorMessage = null, feedbackMessage = null) }
    }

    fun submitChangePassword(onSuccess: () -> Unit = {}) {
        val state = _uiState.value
        if (state.isChangingPassword) return
        if (state.hasPassword && state.currentPasswordInput.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "请输入当前密码") }
            return
        }
        if (state.newPasswordInput.length < 8) {
            _uiState.update { it.copy(errorMessage = "新密码至少需要 8 位") }
            return
        }
        if (state.newPasswordInput != state.confirmPasswordInput) {
            _uiState.update { it.copy(errorMessage = "两次输入的新密码不一致") }
            return
        }

        _uiState.update { it.copy(isChangingPassword = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val res = withContext(ioDispatcher) {
                    repository.changePassword(
                        currentPassword = if (state.hasPassword) state.currentPasswordInput else null,
                        newPassword = state.newPasswordInput,
                    )
                }
                val suffix = if (res.revokedSessions > 0) "（已下线 ${res.revokedSessions} 个其他会话）" else ""
                _uiState.update {
                    it.copy(
                        hasPassword = res.hasPassword,
                        currentPasswordInput = "",
                        newPasswordInput = "",
                        confirmPasswordInput = "",
                        isChangingPassword = false,
                        requiresScopeUpgrade = false,
                        feedbackMessage = "密码已更新$suffix",
                    )
                }
                onSuccess()
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isChangingPassword = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isChangingPassword = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "修改密码失败",
                    )
                }
            }
        }
    }

    fun startOAuthLink(provider: String) {
        if (_uiState.value.isMutatingOAuth) return
        _uiState.update { it.copy(isMutatingOAuth = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val pending = withContext(ioDispatcher) { repository.startAppOAuthLink(provider) }
                _uiState.update {
                    it.copy(
                        isMutatingOAuth = false,
                        pendingLinkLaunchUrl = pending.launchUrl,
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isMutatingOAuth = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isMutatingOAuth = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "无法发起绑定",
                    )
                }
            }
        }
    }

    fun consumePendingLinkLaunchUrl() {
        _uiState.update { it.copy(pendingLinkLaunchUrl = null) }
    }

    fun onOAuthLinkResult(result: OAuthLinkResult) {
        when (result) {
            is OAuthLinkResult.Linked -> {
                val label = providerDisplayName(result.provider)
                _uiState.update {
                    it.copy(
                        feedbackMessage = if (result.alreadyLinked) {
                            "$label 已绑定到当前账号"
                        } else {
                            "已成功绑定 $label 登录方式"
                        },
                        errorMessage = null,
                    )
                }
                load(_uiState.value.hasPassword)
            }
            is OAuthLinkResult.Failed -> {
                _uiState.update {
                    it.copy(
                        errorMessage = result.error.userMessage,
                        feedbackMessage = null,
                    )
                }
            }
        }
    }

    fun unlinkIdentity(provider: String) {
        val state = _uiState.value
        if (state.isMutatingOAuth) return
        if (!state.canUnlinkAnyIdentity) {
            _uiState.update { it.copy(errorMessage = "至少需要保留一种登录方式，请先设置密码或绑定其他方式") }
            return
        }
        _uiState.update { it.copy(isMutatingOAuth = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { repository.unlinkIdentity(provider) }
                val refreshed = withContext(ioDispatcher) { repository.listIdentities() }
                _uiState.update {
                    it.copy(
                        identities = refreshed.identities,
                        availableProviders = refreshed.available.map { p -> p.trim().lowercase() }.distinct(),
                        isMutatingOAuth = false,
                        feedbackMessage = "已解绑 ${providerDisplayName(provider)}",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isMutatingOAuth = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isMutatingOAuth = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "解绑失败",
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
            return SecurityViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

internal fun providerDisplayName(provider: String): String = when (provider.trim().lowercase()) {
    "github" -> "GitHub"
    "google" -> "Google"
    else -> provider.replaceFirstChar { it.uppercase() }
}

@Composable
fun SecurityAndOAuthSubPage(
    viewModel: SecurityViewModel,
    hasPassword: Boolean,
    latestOAuthLinkResult: OAuthLinkResult?,
    onConsumeOAuthLinkResult: () -> Unit,
    onPasswordUpdated: () -> Unit,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    var showPasswords by remember { mutableStateOf(false) }
    var pendingUnlinkProvider by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(hasPassword) {
        viewModel.load(hasPassword)
    }

    LaunchedEffect(state.pendingLinkLaunchUrl) {
        val url = state.pendingLinkLaunchUrl ?: return@LaunchedEffect
        viewModel.consumePendingLinkLaunchUrl()
        openSettingsCustomTab(context, url)
    }

    LaunchedEffect(latestOAuthLinkResult) {
        val result = latestOAuthLinkResult ?: return@LaunchedEffect
        onConsumeOAuthLinkResult()
        viewModel.onOAuthLinkResult(result)
    }

    val visual = if (showPasswords) VisualTransformation.None else PasswordVisualTransformation()

    SettingsSubPageScaffold(
        title = SettingsSubPage.SECURITY_AND_OAUTH.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = { viewModel.load(state.hasPassword) },
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(onReauthenticate = onReauthenticate)
            return@SettingsSubPageScaffold
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        // 1. Change / Set Password Card
        SettingsSectionCard(
            title = if (state.hasPassword) "修改密码" else "设置登录密码",
            subtitle = if (state.hasPassword) {
                "修改当前账号的登录密码（新密码至少 8 位）。"
            } else {
                "当前账号仅绑定了第三方登录，可在此设置密码以便使用邮箱 + 密码登录。"
            },
        ) {
            if (state.hasPassword) {
                OutlinedTextField(
                    value = state.currentPasswordInput,
                    onValueChange = viewModel::onCurrentPasswordChanged,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.isChangingPassword,
                    singleLine = true,
                    label = { Text("当前密码") },
                    visualTransformation = visual,
                    trailingIcon = {
                        IconButton(
                            onClick = { showPasswords = !showPasswords },
                            modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(
                                imageVector = if (showPasswords) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showPasswords) "隐藏密码" else "显示密码",
                                tint = colors.fg3,
                            )
                        }
                    },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Next,
                    ),
                )
            }

            OutlinedTextField(
                value = state.newPasswordInput,
                onValueChange = viewModel::onNewPasswordChanged,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isChangingPassword,
                singleLine = true,
                label = { Text("新密码（至少 8 位）") },
                visualTransformation = visual,
                trailingIcon = if (!state.hasPassword) {
                    {
                        IconButton(
                            onClick = { showPasswords = !showPasswords },
                            modifier = Modifier.defaultMinSize(minWidth = 48.dp, minHeight = 48.dp),
                        ) {
                            Icon(
                                imageVector = if (showPasswords) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                contentDescription = if (showPasswords) "隐藏密码" else "显示密码",
                                tint = colors.fg3,
                            )
                        }
                    }
                } else {
                    null
                },
                shape = shapes.md,
                colors = paperTextFieldColors(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Next,
                ),
            )

            OutlinedTextField(
                value = state.confirmPasswordInput,
                onValueChange = viewModel::onConfirmPasswordChanged,
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isChangingPassword,
                singleLine = true,
                label = { Text("确认新密码") },
                visualTransformation = visual,
                shape = shapes.md,
                colors = paperTextFieldColors(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = ImeAction.Done,
                ),
            )

            Button(
                onClick = { viewModel.submitChangePassword(onPasswordUpdated) },
                enabled = !state.isChangingPassword,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                colors = ButtonDefaults.buttonColors(
                    containerColor = colors.brand,
                    contentColor = colors.brandFg,
                ),
            ) {
                Text(
                    text = if (state.isChangingPassword) "正在保存…" else if (state.hasPassword) "更新密码" else "设置密码",
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }

        // 2. OAuth Identities Card
        SettingsSectionCard(
            title = "第三方登录绑定（OAuth）",
            subtitle = "绑定 GitHub / Google 后可直接在登录页一键登录。为防止账号锁定，至少保留一种登录方式。",
        ) {
            val allProviders = remember(state.identities, state.availableProviders) {
                (state.availableProviders + state.identities.map { it.provider.lowercase() }).distinct()
            }
            if (allProviders.isEmpty()) {
                Text(
                    text = "当前服务器未启用 GitHub 或 Google OAuth 登录。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    allProviders.forEachIndexed { index, provider ->
                        val linked = state.identities.firstOrNull { it.provider.equals(provider, ignoreCase = true) }
                        val canLink = provider in state.availableProviders
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Text(
                                        text = providerDisplayName(provider),
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = colors.fg,
                                    )
                                    SettingsStatusPill(
                                        text = if (linked != null) "已绑定" else "未绑定",
                                        containerColor = if (linked != null) colors.okSoft else colors.surface2,
                                        contentColor = if (linked != null) colors.ok else colors.fg3,
                                    )
                                }
                                if (linked != null) {
                                    Text(
                                        text = listOfNotNull(
                                            linked.email?.takeIf { it.isNotBlank() },
                                            linked.linkedAt?.let { "绑定于 ${formatSettingsDateTime(it)}" },
                                        ).joinToString(" · ").ifBlank { "已绑定第三方身份" },
                                        style = DropitMonoTypography.meta,
                                        color = colors.fg3,
                                    )
                                }
                            }

                            if (linked != null) {
                                TextButton(
                                    onClick = { pendingUnlinkProvider = provider },
                                    enabled = !state.isMutatingOAuth && state.canUnlinkAnyIdentity,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                ) {
                                    Icon(Icons.Rounded.LinkOff, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text("解绑")
                                }
                            } else if (canLink) {
                                OutlinedButton(
                                    onClick = { viewModel.startOAuthLink(provider) },
                                    enabled = !state.isMutatingOAuth,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    shape = shapes.md,
                                    border = BorderStroke(1.dp, colors.line2),
                                ) {
                                    Icon(Icons.Rounded.Link, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text("去绑定")
                                }
                            }
                        }

                        if (linked != null && !state.canUnlinkAnyIdentity) {
                            Surface(
                                modifier = Modifier.fillMaxWidth(),
                                shape = shapes.sm,
                                color = colors.surface0,
                                border = BorderStroke(1.dp, colors.line1),
                                tonalElevation = 0.dp,
                            ) {
                                Text(
                                    text = "这是你唯一的登录方式，无法解绑。请先设置密码或绑定其他第三方登录。",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.fg3,
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                                )
                            }
                        }

                        if (index < allProviders.lastIndex) {
                            HorizontalDivider(thickness = 1.dp, color = colors.line1)
                        }
                    }
                }
            }
        }
    }

    pendingUnlinkProvider?.let { provider ->
        SettingsConfirmDialog(
            title = "解绑 ${providerDisplayName(provider)}？",
            message = "解绑后将无法再通过该 ${providerDisplayName(provider)} 账号直接登录。",
            confirmLabel = "确认解绑",
            onConfirm = {
                pendingUnlinkProvider = null
                viewModel.unlinkIdentity(provider)
            },
            onDismiss = { pendingUnlinkProvider = null },
        )
    }
}
