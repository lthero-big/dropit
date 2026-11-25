package dev.dropit.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.AdminInvite
import dev.dropit.app.data.account.AdminRoom
import dev.dropit.app.data.account.AdminUser
import dev.dropit.app.data.account.CreatedInvite
import dev.dropit.app.data.account.LimitAuditEntry
import dev.dropit.app.data.account.LimitField
import dev.dropit.app.data.account.OAuthSettingsInfo
import dev.dropit.app.data.account.OAuthVerifyResult
import dev.dropit.app.data.account.RegistrationPolicyInfo
import dev.dropit.app.data.account.SiteSettingsInfo
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class AdminTab(val label: String) {
    USERS("用户"),
    INVITES("注册与邀请"),
    LIMITS("运行时限额"),
    ROOMS("临时房间"),
    SITE_OAUTH("站点与 OAuth"),
}

data class PendingSiteOriginConfirm(
    val origin: String?,
    val targetOrigin: String,
)

data class AdminSettingsUiState(
    val selectedTab: AdminTab = AdminTab.USERS,
    val isLoading: Boolean = false,
    val isBusy: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
    // 1. Users
    val users: List<AdminUser> = emptyList(),
    val oneTimePasswordNotice: Pair<String, String>? = null, // email -> temp password
    // 2. Invites & Registration
    val registrationPolicy: RegistrationPolicyInfo? = null,
    val adminInvites: List<AdminInvite> = emptyList(),
    val latestAdminInvite: CreatedInvite? = null,
    // 3. Limits & Audit
    val limits: Map<String, LimitField> = emptyMap(),
    val limitAuditEntries: List<LimitAuditEntry> = emptyList(),
    val limitAuditNextCursor: Long? = null,
    val isLoadingMoreAudit: Boolean = false,
    // 4. Temporary Rooms
    val adminRooms: List<AdminRoom> = emptyList(),
    // 5. Site Origin & OAuth
    val siteSettings: SiteSettingsInfo? = null,
    val pendingOriginConfirm: PendingSiteOriginConfirm? = null,
    val oauthSettings: OAuthSettingsInfo? = null,
    val lastOAuthVerifyResult: Pair<String, OAuthVerifyResult>? = null,
)

class AdminSettingsViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(AdminSettingsUiState())
    val uiState: StateFlow<AdminSettingsUiState> = _uiState.asStateFlow()

    fun selectTab(tab: AdminTab) {
        _uiState.update { it.copy(selectedTab = tab, errorMessage = null, feedbackMessage = null) }
        loadTab(tab)
    }

    fun refreshCurrentTab() {
        loadTab(_uiState.value.selectedTab)
    }

    fun loadTab(tab: AdminTab = _uiState.value.selectedTab) {
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                when (tab) {
                    AdminTab.USERS -> {
                        val users = withContext(ioDispatcher) { repository.listUsers() }
                        _uiState.update { it.copy(users = users, isLoading = false, requiresScopeUpgrade = false) }
                    }
                    AdminTab.INVITES -> {
                        val policy = withContext(ioDispatcher) { repository.getRegistrationPolicy() }
                        val invites = withContext(ioDispatcher) { repository.listAdminInvites() }
                        _uiState.update {
                            it.copy(
                                registrationPolicy = policy,
                                adminInvites = invites,
                                isLoading = false,
                                requiresScopeUpgrade = false,
                            )
                        }
                    }
                    AdminTab.LIMITS -> {
                        val limits = withContext(ioDispatcher) { repository.getLimits() }
                        val audit = withContext(ioDispatcher) { repository.getLimitsAudit(limit = 50, cursor = null) }
                        _uiState.update {
                            it.copy(
                                limits = limits,
                                limitAuditEntries = audit.entries,
                                limitAuditNextCursor = audit.nextCursor,
                                isLoading = false,
                                requiresScopeUpgrade = false,
                            )
                        }
                    }
                    AdminTab.ROOMS -> {
                        val rooms = withContext(ioDispatcher) { repository.listAdminRooms() }
                        _uiState.update { it.copy(adminRooms = rooms, isLoading = false, requiresScopeUpgrade = false) }
                    }
                    AdminTab.SITE_OAUTH -> {
                        val site = withContext(ioDispatcher) { repository.getSiteSettings() }
                        val oauth = withContext(ioDispatcher) { repository.getOAuthSettings() }
                        _uiState.update {
                            it.copy(
                                siteSettings = site,
                                oauthSettings = oauth,
                                isLoading = false,
                                requiresScopeUpgrade = false,
                            )
                        }
                    }
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载管理员数据失败",
                    )
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 1. Users
    // -----------------------------------------------------------------------

    fun createUser(
        email: String,
        name: String?,
        role: String,
        quotaBytes: Long?,
        temporaryPassword: Boolean,
    ) {
        val cleanEmail = email.trim()
        if (cleanEmail.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "请输入用户邮箱") }
            return
        }
        runMutation("已创建用户 $cleanEmail") {
            val created = repository.createUser(
                email = cleanEmail,
                name = name?.trim()?.takeIf { it.isNotEmpty() },
                role = role,
                quotaBytes = quotaBytes,
                temporaryPassword = temporaryPassword,
            )
            val refreshed = repository.listUsers()
            _uiState.update {
                it.copy(
                    users = refreshed,
                    oneTimePasswordNotice = created.temporaryPassword?.let { pw -> created.email to pw },
                )
            }
        }
    }

    fun updateUser(
        userId: String,
        name: OptionalField<String> = OptionalField.Absent,
        role: OptionalField<String> = OptionalField.Absent,
        disabled: OptionalField<Boolean> = OptionalField.Absent,
        quotaBytes: OptionalField<Long?> = OptionalField.Absent,
        inviteLimit: OptionalField<Int?> = OptionalField.Absent,
    ) {
        runMutation("用户配置已更新") {
            repository.updateUser(
                userId = userId,
                name = name,
                role = role,
                disabled = disabled,
                quotaBytes = quotaBytes,
                inviteLimit = inviteLimit,
            )
            val refreshed = repository.listUsers()
            _uiState.update { it.copy(users = refreshed) }
        }
    }

    fun resetUserPassword(user: AdminUser) {
        runMutation("已为 ${user.email} 生成新临时密码") {
            val result = repository.resetUserPassword(user.id)
            val refreshed = repository.listUsers()
            _uiState.update {
                it.copy(
                    users = refreshed,
                    oneTimePasswordNotice = user.email to result.temporaryPassword,
                )
            }
        }
    }

    fun dismissOneTimePasswordNotice() {
        _uiState.update { it.copy(oneTimePasswordNotice = null) }
    }

    fun logoutUser(user: AdminUser) {
        runMutation("已强制下线 ${user.email} 的全部会话") {
            repository.logoutUser(user.id)
        }
    }

    // -----------------------------------------------------------------------
    // 2. Registration Policy & Invites
    // -----------------------------------------------------------------------

    fun updateRegistrationPolicy(policy: String) {
        runMutation("注册策略已保存并生效") {
            val updated = repository.updateRegistrationPolicy(policy)
            _uiState.update { it.copy(registrationPolicy = updated) }
        }
    }

    fun createAdminInvite(maxUses: Int, expiresInHours: Int) {
        runMutation("已创建管理员注册邀请码") {
            val created = repository.createAdminInvite(
                kind = "registration",
                maxUses = maxUses,
                expiresInHours = expiresInHours,
            )
            val refreshed = repository.listAdminInvites()
            _uiState.update {
                it.copy(
                    adminInvites = refreshed,
                    latestAdminInvite = created,
                )
            }
        }
    }

    fun revokeAdminInvite(inviteId: String) {
        runMutation("已撤销邀请码") {
            repository.revokeAdminInvite(inviteId)
            val refreshed = repository.listAdminInvites()
            _uiState.update { it.copy(adminInvites = refreshed) }
        }
    }

    // -----------------------------------------------------------------------
    // 3. Runtime Limits & Audit
    // -----------------------------------------------------------------------

    fun updateLimit(key: String, value: Long?) {
        val label = RuntimeLimitsCatalog.labelFor(key)
        val msg = if (value == null) "$label 已恢复默认值，立即生效" else "$label 已保存，立即生效"
        runMutation(msg) {
            val nextLimits = repository.updateLimits(mapOf(key to value))
            val nextAudit = repository.getLimitsAudit(limit = 50, cursor = null)
            _uiState.update {
                it.copy(
                    limits = nextLimits,
                    limitAuditEntries = nextAudit.entries,
                    limitAuditNextCursor = nextAudit.nextCursor,
                )
            }
        }
    }

    fun loadMoreLimitAudit() {
        val cursor = _uiState.value.limitAuditNextCursor ?: return
        if (_uiState.value.isLoadingMoreAudit) return
        _uiState.update { it.copy(isLoadingMoreAudit = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val page = withContext(ioDispatcher) { repository.getLimitsAudit(limit = 50, cursor = cursor) }
                _uiState.update { state ->
                    val existingIds = state.limitAuditEntries.map { it.id }.toSet()
                    state.copy(
                        limitAuditEntries = state.limitAuditEntries + page.entries.filterNot { it.id in existingIds },
                        limitAuditNextCursor = page.nextCursor,
                        isLoadingMoreAudit = false,
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isLoadingMoreAudit = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingMoreAudit = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载审计日志失败",
                    )
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // 4. Temporary Rooms
    // -----------------------------------------------------------------------

    fun unlockRoom(roomId: String) = roomAction(roomId, "已解锁房间") { repository.unlockRoom(it) }
    fun closeRoom(roomId: String) = roomAction(roomId, "已关闭房间") { repository.closeRoom(it) }
    fun reopenRoom(roomId: String) = roomAction(roomId, "已重新开放房间") { repository.reopenRoom(it) }
    fun deleteRoom(roomId: String) = roomAction(roomId, "已删除临时房间") { repository.deleteRoom(it) }

    private fun roomAction(roomId: String, msg: String, op: suspend (String) -> Unit) {
        runMutation(msg) {
            op(roomId)
            val refreshed = repository.listAdminRooms()
            _uiState.update { it.copy(adminRooms = refreshed) }
        }
    }

    // -----------------------------------------------------------------------
    // 5. Site Origin & OAuth Providers
    // -----------------------------------------------------------------------

    fun updateSiteOrigin(origin: String?, confirm: Boolean = false) {
        if (_uiState.value.isBusy) return
        val cleaned = origin?.trim()?.takeIf { it.isNotEmpty() }
        _uiState.update { it.copy(isBusy = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val updated = withContext(ioDispatcher) {
                    repository.updateSiteSettings(origin = cleaned, confirm = confirm)
                }
                val refreshedOAuth = runCatching { withContext(ioDispatcher) { repository.getOAuthSettings() } }.getOrNull()
                _uiState.update {
                    it.copy(
                        isBusy = false,
                        siteSettings = updated,
                        oauthSettings = refreshedOAuth ?: it.oauthSettings,
                        pendingOriginConfirm = null,
                        feedbackMessage = if (cleaned != null) "站点地址已保存并立即生效" else "已清除页面覆盖，恢复默认站点地址",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                if (e.isOriginConfirmRequired) {
                    val target = e.details["origin"]?.takeIf { it.isNotBlank() } ?: cleaned.orEmpty()
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            pendingOriginConfirm = PendingSiteOriginConfirm(origin = cleaned, targetOrigin = target),
                            errorMessage = null,
                        )
                    }
                } else {
                    _uiState.update {
                        it.copy(
                            isBusy = false,
                            requiresScopeUpgrade = e.isInsufficientScope,
                            errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                        )
                    }
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isBusy = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "保存站点地址失败",
                    )
                }
            }
        }
    }

    fun dismissOriginConfirm() {
        _uiState.update { it.copy(pendingOriginConfirm = null) }
    }

    fun updateOAuthProvider(provider: String, clientId: String, clientSecret: String?, enabled: Boolean) {
        runMutation("${providerDisplayName(provider)} 配置已保存，建议点击「验证」") {
            val updated = repository.updateOAuthProvider(
                provider = provider,
                clientId = clientId.trim(),
                clientSecret = clientSecret?.trim()?.takeIf { it.isNotEmpty() },
                enabled = enabled,
            )
            _uiState.update { it.copy(oauthSettings = updated, lastOAuthVerifyResult = null) }
        }
    }

    fun deleteOAuthProvider(provider: String) {
        runMutation("已删除 ${providerDisplayName(provider)} 页面配置") {
            val updated = repository.deleteOAuthProvider(provider)
            _uiState.update { it.copy(oauthSettings = updated, lastOAuthVerifyResult = null) }
        }
    }

    fun verifyOAuthProvider(provider: String) {
        if (_uiState.value.isBusy) return
        _uiState.update { it.copy(isBusy = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val res = withContext(ioDispatcher) { repository.verifyOAuthProvider(provider) }
                val label = RuntimeLimitsCatalog.OAUTH_CHECK_LABELS[res.code] ?: res.code
                val pName = providerDisplayName(provider)
                _uiState.update { state ->
                    state.copy(
                        isBusy = false,
                        oauthSettings = if (res.providers.isNotEmpty()) {
                            OAuthSettingsInfo(origin = res.origin.ifBlank { state.oauthSettings?.origin.orEmpty() }, providers = res.providers)
                        } else {
                            state.oauthSettings
                        },
                        lastOAuthVerifyResult = provider to res,
                        feedbackMessage = if (res.ok) "$pName：$label" else null,
                        errorMessage = if (!res.ok) "$pName 验证失败：$label" else null,
                    )
                }
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "验证 OAuth 配置失败",
                    )
                }
            }
        }
    }

    private fun runMutation(successMessage: String, block: suspend () -> Unit) {
        if (_uiState.value.isBusy) return
        _uiState.update { it.copy(isBusy = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { block() }
                _uiState.update { it.copy(isBusy = false, feedbackMessage = successMessage) }
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
            return AdminSettingsViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}
