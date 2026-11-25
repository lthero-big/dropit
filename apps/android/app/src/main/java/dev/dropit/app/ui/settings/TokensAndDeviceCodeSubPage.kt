package dev.dropit.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.network.AccessTokenInfo
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.CreatedAccessToken
import dev.dropit.app.data.account.DeviceCodeLookup
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

enum class TokensSubTab(val label: String) {
    PAT("个人访问令牌"),
    DEVICE_CODE("设备码批准"),
}

data class TokensUiState(
    val selectedTab: TokensSubTab = TokensSubTab.PAT,
    val tokens: List<AccessTokenInfo> = emptyList(),
    val newTokenName: String = "",
    val includeReadScope: Boolean = true,
    val includeWriteScope: Boolean = true,
    val selectedExpiresInDays: Int? = 90,
    val createdToken: CreatedAccessToken? = null,
    // Device code confirmation
    val userCodeInput: String = "",
    val lookedUpDevice: DeviceCodeLookup? = null,
    val lookedUpUserCode: String? = null,
    val isLoading: Boolean = false,
    val isBusy: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
)

class TokensViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TokensUiState())
    val uiState: StateFlow<TokensUiState> = _uiState.asStateFlow()

    fun selectTab(tab: TokensSubTab) {
        _uiState.update { it.copy(selectedTab = tab, errorMessage = null, feedbackMessage = null) }
    }

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val list = withContext(ioDispatcher) { repository.listTokens() }
                val needsUpgrade = repository.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings
                _uiState.update {
                    it.copy(
                        tokens = list,
                        isLoading = false,
                        requiresScopeUpgrade = needsUpgrade,
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载令牌失败",
                    )
                }
            }
        }
    }

    fun onNewTokenNameChanged(value: String) {
        _uiState.update { it.copy(newTokenName = value, errorMessage = null) }
    }

    fun toggleWriteScope() {
        _uiState.update { it.copy(includeWriteScope = !it.includeWriteScope) }
    }

    fun selectExpiresInDays(days: Int?) {
        _uiState.update { it.copy(selectedExpiresInDays = days) }
    }

    fun createToken() {
        val state = _uiState.value
        val name = state.newTokenName.trim()
        if (name.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "请输入令牌名称") }
            return
        }
        val scopes = buildList {
            if (state.includeReadScope) add("read")
            if (state.includeWriteScope) add("write")
        }.ifEmpty { listOf("read") }

        runBusy("个人访问令牌已创建，请立即复制保存") {
            val created = repository.createToken(
                name = name,
                scopes = scopes,
                expiresInDays = state.selectedExpiresInDays,
            )
            val refreshed = repository.listTokens()
            _uiState.update {
                it.copy(
                    tokens = refreshed,
                    newTokenName = "",
                    createdToken = created,
                )
            }
        }
    }

    fun renameToken(id: String, newName: String) {
        val clean = newName.trim()
        if (clean.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "令牌名称不能为空") }
            return
        }
        runBusy("令牌名称已更新") {
            repository.updateToken(id, clean)
            val refreshed = repository.listTokens()
            _uiState.update { it.copy(tokens = refreshed) }
        }
    }

    fun revokeToken(id: String, purge: Boolean) {
        runBusy(if (purge) "已彻底删除令牌记录" else "已吊销访问令牌") {
            repository.revokeToken(id, purge = purge)
            val refreshed = repository.listTokens()
            _uiState.update { it.copy(tokens = refreshed) }
        }
    }

    fun onUserCodeChanged(raw: String) {
        val cleaned = raw.uppercase().filter { it.isLetterOrDigit() || it == '-' }.take(9)
        _uiState.update {
            it.copy(
                userCodeInput = cleaned,
                lookedUpDevice = null,
                lookedUpUserCode = null,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
    }

    fun lookupDeviceCode() {
        val code = _uiState.value.userCodeInput.trim()
        if (code.replace("-", "").length < 8) {
            _uiState.update { it.copy(errorMessage = "请输入完整的 8 位设备确认码（如 ABCD-1234）") }
            return
        }
        runBusy(null) {
            val info = repository.lookupDeviceCode(userCode = code)
            _uiState.update {
                it.copy(
                    lookedUpDevice = info,
                    lookedUpUserCode = code,
                )
            }
        }
    }

    fun approveDeviceCode() {
        val code = _uiState.value.lookedUpUserCode ?: _uiState.value.userCodeInput.trim()
        if (code.isEmpty()) return
        runBusy("已批准该设备登录") {
            repository.approveDeviceCode(userCode = code)
            val refreshed = runCatching { repository.listTokens() }.getOrNull()
            _uiState.update {
                it.copy(
                    userCodeInput = "",
                    lookedUpDevice = null,
                    lookedUpUserCode = null,
                    tokens = refreshed ?: it.tokens,
                )
            }
        }
    }

    fun denyDeviceCode() {
        val code = _uiState.value.lookedUpUserCode ?: _uiState.value.userCodeInput.trim()
        if (code.isEmpty()) return
        runBusy("已拒绝该设备登录请求") {
            repository.denyDeviceCode(userCode = code)
            _uiState.update {
                it.copy(
                    userCodeInput = "",
                    lookedUpDevice = null,
                    lookedUpUserCode = null,
                )
            }
        }
    }

    private fun runBusy(successMsg: String?, block: suspend () -> Unit) {
        if (_uiState.value.isBusy) return
        _uiState.update { it.copy(isBusy = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { block() }
                _uiState.update { it.copy(isBusy = false, feedbackMessage = successMsg) }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isBusy = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isBusy = false,
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
            return TokensViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TokensAndDeviceCodeSubPage(
    viewModel: TokensViewModel,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    var renamingToken by remember { mutableStateOf<AccessTokenInfo?>(null) }
    var renameDraft by remember { mutableStateOf("") }
    var pendingRevoke by remember { mutableStateOf<Pair<AccessTokenInfo, Boolean>?>(null) }

    LaunchedEffect(Unit) {
        viewModel.load()
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.TOKENS_AND_DEVICE_CODE.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = viewModel::load,
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(
                message = "创建/管理个人访问令牌及批准设备码登录需要重新登录（邮箱密码或 GitHub / Google）以解锁账户权限。",
                onReauthenticate = onReauthenticate,
            )
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TokensSubTab.entries.forEach { tab ->
                SettingsChoiceChip(
                    label = tab.label,
                    selected = state.selectedTab == tab,
                    onClick = { viewModel.selectTab(tab) },
                )
            }
        }

        when (state.selectedTab) {
            TokensSubTab.PAT -> {
                // Create PAT Card
                SettingsSectionCard(
                    title = "新建个人访问令牌（PAT）",
                    subtitle = "用于 dropit CLI 或脚本调用。新令牌明文仅展示一次。",
                ) {
                    OutlinedTextField(
                        value = state.newTokenName,
                        onValueChange = viewModel::onNewTokenNameChanged,
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !state.isBusy && !state.requiresScopeUpgrade,
                        singleLine = true,
                        label = { Text("令牌名称") },
                        placeholder = { Text("例如 MacBook CLI", color = colors.fg4) },
                        shape = shapes.md,
                        colors = paperTextFieldColors(),
                    )

                    Text("权限范围", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SettingsChoiceChip(
                            label = "仅读取（read）",
                            selected = !state.includeWriteScope,
                            enabled = !state.isBusy && !state.requiresScopeUpgrade,
                            onClick = { if (state.includeWriteScope) viewModel.toggleWriteScope() },
                        )
                        SettingsChoiceChip(
                            label = "读写（read + write）",
                            selected = state.includeWriteScope,
                            enabled = !state.isBusy && !state.requiresScopeUpgrade,
                            onClick = { if (!state.includeWriteScope) viewModel.toggleWriteScope() },
                        )
                    }

                    Text("有效期", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(30 to "30 天", 90 to "90 天", 365 to "365 天", null to "永不过期").forEach { (days, label) ->
                            SettingsChoiceChip(
                                label = label,
                                selected = state.selectedExpiresInDays == days,
                                enabled = !state.isBusy && !state.requiresScopeUpgrade,
                                onClick = { viewModel.selectExpiresInDays(days) },
                            )
                        }
                    }

                    Button(
                        onClick = viewModel::createToken,
                        enabled = !state.isBusy && !state.requiresScopeUpgrade && state.newTokenName.isNotBlank(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.brand,
                            contentColor = colors.brandFg,
                        ),
                    ) {
                        Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("生成令牌", fontWeight = FontWeight.SemiBold)
                    }

                    state.createdToken?.let { created ->
                        SettingsCopyBox(
                            label = "新令牌明文（仅显示一次，请立即保存）",
                            value = created.token,
                            hint = "名称：${created.name} · 权限：${created.scopes.joinToString(", ")}",
                            highlightSuccess = true,
                            onCopy = { copySettingsText(context, "dropit PAT", created.token) },
                        )
                    }
                }

                // Existing Tokens List
                SettingsSectionCard(
                    title = "已有令牌（${state.tokens.size}）",
                    subtitle = "包含 CLI、脚本与已授权移动设备令牌。吊销后立即失效。",
                ) {
                    if (state.tokens.isEmpty()) {
                        Text("暂无访问令牌。", style = MaterialTheme.typography.bodySmall, color = colors.fg3)
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            state.tokens.forEachIndexed { index, tok ->
                                val isRevoked = tok.revoked != 0
                                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Text(
                                            text = tok.name.ifBlank { tok.id },
                                            style = MaterialTheme.typography.bodyMedium,
                                            fontWeight = FontWeight.Medium,
                                            color = colors.fg,
                                            modifier = Modifier.weight(1f),
                                        )
                                        SettingsStatusPill(
                                            text = if (isRevoked) "已吊销" else "有效",
                                            containerColor = if (isRevoked) colors.surface2 else colors.okSoft,
                                            contentColor = if (isRevoked) colors.fg3 else colors.ok,
                                        )
                                    }
                                    Text(
                                        text = "权限：${tok.scopes.joinToString(" ")} · 最近使用：${formatSettingsDateTime(tok.lastUsedAt)} · 过期：${if (tok.expiresAt == null) "永不" else formatSettingsDateTime(tok.expiresAt)}",
                                        style = DropitMonoTypography.meta,
                                        color = colors.fg3,
                                    )
                                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        if (!isRevoked) {
                                            TextButton(
                                                onClick = {
                                                    renamingToken = tok
                                                    renameDraft = tok.name
                                                },
                                                enabled = !state.isBusy && !state.requiresScopeUpgrade,
                                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                                            ) {
                                                Icon(Icons.Rounded.Edit, contentDescription = null, modifier = Modifier.size(16.dp))
                                                Spacer(Modifier.width(4.dp))
                                                Text("重命名")
                                            }
                                            TextButton(
                                                onClick = { pendingRevoke = tok to false },
                                                enabled = !state.isBusy,
                                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                            ) {
                                                Text("吊销")
                                            }
                                        } else {
                                            TextButton(
                                                onClick = { pendingRevoke = tok to true },
                                                enabled = !state.isBusy && !state.requiresScopeUpgrade,
                                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                            ) {
                                                Icon(Icons.Rounded.DeleteOutline, contentDescription = null, modifier = Modifier.size(16.dp))
                                                Spacer(Modifier.width(4.dp))
                                                Text("删除记录")
                                            }
                                        }
                                    }
                                }
                                if (index < state.tokens.lastIndex) {
                                    HorizontalDivider(thickness = 1.dp, color = colors.line1)
                                }
                            }
                        }
                    }
                }
            }

            TokensSubTab.DEVICE_CODE -> {
                SettingsSectionCard(
                    title = "批准其他设备登录",
                    subtitle = "输入另一台设备（CLI / 手机）屏幕上显示的 8 位确认码，核对信息后批准或拒绝。",
                ) {
                    OutlinedTextField(
                        value = state.userCodeInput,
                        onValueChange = viewModel::onUserCodeChanged,
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !state.isBusy && !state.requiresScopeUpgrade,
                        singleLine = true,
                        label = { Text("8 位设备确认码") },
                        placeholder = { Text("例如 ABCD-1234", color = colors.fg4) },
                        textStyle = DropitMonoTypography.url.copy(color = colors.fg),
                        shape = shapes.md,
                        colors = paperTextFieldColors(),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                    )

                    Button(
                        onClick = viewModel::lookupDeviceCode,
                        enabled = !state.isBusy && !state.requiresScopeUpgrade && state.userCodeInput.isNotBlank(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = colors.fg,
                            contentColor = colors.bg,
                        ),
                    ) {
                        Text("查询设备请求", fontWeight = FontWeight.SemiBold)
                    }

                    state.lookedUpDevice?.let { device ->
                        Surface(
                            modifier = Modifier.fillMaxWidth(),
                            shape = shapes.md,
                            color = colors.surface0,
                            border = BorderStroke(1.dp, colors.line2),
                            tonalElevation = 0.dp,
                        ) {
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(14.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    text = "待批准设备：${device.name}",
                                    style = MaterialTheme.typography.titleSmall,
                                    color = colors.fg,
                                )
                                Text(
                                    text = "来源 IP：${device.ipSummary.ifBlank { "未知" }} · 申请权限：${device.scopes.joinToString(", ")}",
                                    style = DropitMonoTypography.meta,
                                    color = colors.fg2,
                                )
                                Text(
                                    text = "请求过期时间：${formatSettingsDateTime(device.expiresAt)}",
                                    style = DropitMonoTypography.meta,
                                    color = colors.fg3,
                                )
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Button(
                                        onClick = viewModel::approveDeviceCode,
                                        enabled = !state.isBusy,
                                        modifier = Modifier
                                            .weight(1f)
                                            .defaultMinSize(minHeight = 48.dp),
                                        shape = shapes.md,
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = colors.brand,
                                            contentColor = colors.brandFg,
                                        ),
                                    ) {
                                        Icon(Icons.Rounded.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("批准登录")
                                    }
                                    OutlinedButton(
                                        onClick = viewModel::denyDeviceCode,
                                        enabled = !state.isBusy,
                                        modifier = Modifier
                                            .weight(1f)
                                            .defaultMinSize(minHeight = 48.dp),
                                        shape = shapes.md,
                                        border = BorderStroke(1.dp, colors.line2),
                                        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
                                    ) {
                                        Icon(Icons.Rounded.Close, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("拒绝")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    renamingToken?.let { tok ->
        AlertDialog(
            onDismissRequest = { renamingToken = null },
            shape = shapes.lg,
            containerColor = colors.surface1,
            titleContentColor = colors.fg,
            textContentColor = colors.fg2,
            tonalElevation = 0.dp,
            title = { Text("重命名令牌", style = MaterialTheme.typography.titleMedium) },
            text = {
                OutlinedTextField(
                    value = renameDraft,
                    onValueChange = { renameDraft = it },
                    singleLine = true,
                    label = { Text("令牌名称") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val targetId = tok.id
                        val nextName = renameDraft
                        renamingToken = null
                        viewModel.renameToken(targetId, nextName)
                    },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                ) {
                    Text("保存", fontWeight = FontWeight.SemiBold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { renamingToken = null },
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                ) {
                    Text("取消")
                }
            },
        )
    }

    pendingRevoke?.let { (tok, purge) ->
        SettingsConfirmDialog(
            title = if (purge) "删除已吊销令牌记录？" else "吊销访问令牌？",
            message = if (purge) {
                "将永久删除「${tok.name}」的历史记录。"
            } else {
                "吊销「${tok.name}」后，使用该令牌的 CLI 或设备将立即失效。"
            },
            confirmLabel = if (purge) "确认删除" else "确认吊销",
            onConfirm = {
                pendingRevoke = null
                viewModel.revokeToken(tok.id, purge = purge)
            },
            onDismiss = { pendingRevoke = null },
        )
    }
}
