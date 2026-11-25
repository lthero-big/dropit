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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.Space
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.CreatedInvite
import dev.dropit.app.data.account.PersonalInvitesResponse
import dev.dropit.app.data.account.SpaceInvite
import dev.dropit.app.data.account.SpaceInvitesResponse
import dev.dropit.app.data.account.SpaceMember
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

data class SpaceSharingUiState(
    val spaces: List<Space> = emptyList(),
    val selectedSpaceId: String? = null,
    val members: List<SpaceMember> = emptyList(),
    val spaceInvites: SpaceInvitesResponse? = null,
    val personalInvites: PersonalInvitesResponse? = null,
    val showPersonalInvitesSection: Boolean = false,
    val inviteRole: String = "viewer",
    val inviteMaxUses: Int = 1,
    val inviteExpiresInHours: Int = 168,
    val latestSpaceInviteUrl: String? = null,
    val latestPersonalInvite: CreatedInvite? = null,
    val isLoading: Boolean = false,
    val isMutating: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
) {
    val selectedSpace: Space?
        get() = spaces.firstOrNull { it.id == selectedSpaceId } ?: spaces.firstOrNull()
}

class SpaceSharingViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SpaceSharingUiState())
    val uiState: StateFlow<SpaceSharingUiState> = _uiState.asStateFlow()

    private var allowPersonalInvites = false

    fun load(spaces: List<Space>, currentUserId: String?, canManagePersonalInvites: Boolean) {
        allowPersonalInvites = canManagePersonalInvites
        val defaultSpace = _uiState.value.selectedSpaceId?.takeIf { id -> spaces.any { it.id == id } }
            ?: spaces.firstOrNull { currentUserId != null && it.isPersonalFor(currentUserId) }?.id
            ?: spaces.firstOrNull()?.id

        _uiState.update {
            it.copy(
                spaces = spaces,
                selectedSpaceId = defaultSpace,
                showPersonalInvitesSection = canManagePersonalInvites,
            )
        }
        refreshSelectedSpace()
    }

    fun selectSpace(spaceId: String) {
        _uiState.update {
            it.copy(
                selectedSpaceId = spaceId,
                latestSpaceInviteUrl = null,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
        refreshSelectedSpace()
    }

    fun refreshSelectedSpace() {
        val space = _uiState.value.selectedSpace ?: return
        _uiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                if (space.role == "owner") {
                    val members = withContext(ioDispatcher) { repository.listSpaceMembers(space.id) }
                    val invites = withContext(ioDispatcher) { repository.listSpaceInvites(space.id) }
                    val personal = if (allowPersonalInvites) {
                        runCatching { withContext(ioDispatcher) { repository.listPersonalInvites() } }.getOrNull()
                    } else {
                        null
                    }
                    _uiState.update {
                        it.copy(
                            members = members,
                            spaceInvites = invites,
                            personalInvites = personal ?: it.personalInvites,
                            isLoading = false,
                            requiresScopeUpgrade = false,
                        )
                    }
                } else {
                    val personal = if (allowPersonalInvites) {
                        runCatching { withContext(ioDispatcher) { repository.listPersonalInvites() } }.getOrNull()
                    } else {
                        null
                    }
                    _uiState.update {
                        it.copy(
                            members = emptyList(),
                            spaceInvites = null,
                            personalInvites = personal ?: it.personalInvites,
                            isLoading = false,
                            requiresScopeUpgrade = false,
                        )
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载空间成员与邀请失败",
                    )
                }
            }
        }
    }

    fun selectInviteRole(role: String) {
        _uiState.update { it.copy(inviteRole = role) }
    }

    fun selectInviteMaxUses(maxUses: Int) {
        _uiState.update { it.copy(inviteMaxUses = maxUses) }
    }

    fun selectInviteExpiresInHours(hours: Int) {
        _uiState.update { it.copy(inviteExpiresInHours = hours) }
    }

    fun toggleMemberRole(member: SpaceMember) {
        val space = _uiState.value.selectedSpace ?: return
        val nextRole = if (member.role == "editor") "viewer" else "editor"
        mutate("已调整 ${member.name.ifBlank { member.email }} 权限为${if (nextRole == "editor") "可编辑" else "只读"}") {
            val updated = repository.updateSpaceMemberRole(space.id, member.userId, nextRole)
            _uiState.update { it.copy(members = updated) }
        }
    }

    fun removeMember(member: SpaceMember) {
        val space = _uiState.value.selectedSpace ?: return
        mutate("已移除成员 ${member.name.ifBlank { member.email }}") {
            repository.removeSpaceMember(space.id, member.userId)
            _uiState.update { state -> state.copy(members = state.members.filterNot { it.userId == member.userId }) }
        }
    }

    fun leaveSelectedSpace(onLeft: () -> Unit) {
        val space = _uiState.value.selectedSpace ?: return
        mutate("已退出空间「${space.name}」") {
            repository.leaveSpace(space.id)
            _uiState.update { state ->
                val remaining = state.spaces.filterNot { it.id == space.id }
                state.copy(
                    spaces = remaining,
                    selectedSpaceId = remaining.firstOrNull()?.id,
                )
            }
            onLeft()
        }
    }

    fun createSpaceInvite() {
        val state = _uiState.value
        val space = state.selectedSpace ?: return
        mutate("已生成空间邀请链接，请及时复制") {
            val created = repository.createSpaceInvite(
                spaceId = space.id,
                role = state.inviteRole,
                maxUses = state.inviteMaxUses,
                expiresInHours = state.inviteExpiresInHours,
            )
            val refreshed = repository.listSpaceInvites(space.id)
            _uiState.update {
                it.copy(
                    spaceInvites = refreshed,
                    latestSpaceInviteUrl = created.url ?: created.token,
                )
            }
        }
    }

    fun revokeSpaceInvite(inviteId: String) {
        val space = _uiState.value.selectedSpace ?: return
        mutate("已撤销空间邀请链接") {
            repository.revokeSpaceInvite(space.id, inviteId)
            val refreshed = repository.listSpaceInvites(space.id)
            _uiState.update { it.copy(spaceInvites = refreshed) }
        }
    }

    fun createPersonalInvite(expiresInHours: Int = 168) {
        mutate("已生成个人注册邀请链接") {
            val created = repository.createPersonalInvite(expiresInHours)
            val refreshed = repository.listPersonalInvites()
            _uiState.update {
                it.copy(
                    personalInvites = refreshed,
                    latestPersonalInvite = created,
                )
            }
        }
    }

    fun revokePersonalInvite(id: String) {
        mutate("已撤销个人邀请码") {
            repository.revokePersonalInvite(id)
            val refreshed = repository.listPersonalInvites()
            _uiState.update { it.copy(personalInvites = refreshed) }
        }
    }

    private fun mutate(successMsg: String, block: suspend () -> Unit) {
        if (_uiState.value.isMutating) return
        _uiState.update { it.copy(isMutating = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { block() }
                _uiState.update { it.copy(isMutating = false, feedbackMessage = successMsg) }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isMutating = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isMutating = false,
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
            return SpaceSharingViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SpaceSharingSubPage(
    viewModel: SpaceSharingViewModel,
    spaces: List<Space>,
    currentUserId: String?,
    canManagePersonalInvites: Boolean,
    onSpacesChanged: () -> Unit,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    var pendingRemoveMember by remember { mutableStateOf<SpaceMember?>(null) }
    var confirmLeaveSpace by remember { mutableStateOf(false) }

    LaunchedEffect(spaces, currentUserId, canManagePersonalInvites) {
        viewModel.load(spaces, currentUserId, canManagePersonalInvites)
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.SPACE_SHARING.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = viewModel::refreshSelectedSpace,
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(onReauthenticate = onReauthenticate)
            return@SettingsSubPageScaffold
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        // Space selector chips
        if (state.spaces.size > 1) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                state.spaces.forEach { sp ->
                    val roleTag = when (sp.role) {
                        "owner" -> "我的"
                        "editor" -> "可编辑"
                        else -> "只读"
                    }
                    SettingsChoiceChip(
                        label = "${sp.name.ifBlank { "未命名空间" }}（$roleTag）",
                        selected = state.selectedSpace?.id == sp.id,
                        onClick = { viewModel.selectSpace(sp.id) },
                    )
                }
            }
        }

        val activeSpace = state.selectedSpace
        if (activeSpace == null) {
            SettingsSectionCard {
                Text("暂无可管理的空间。", style = MaterialTheme.typography.bodySmall, color = colors.fg3)
            }
        } else if (activeSpace.role == "owner") {
            // 1. Space Members
            SettingsSectionCard(
                title = "空间成员（${state.members.size}）",
                subtitle = "调整受邀成员对「${activeSpace.name.ifBlank { "我的空间" }}」的读写权限，或移出空间。",
            ) {
                if (state.members.isEmpty()) {
                    Text(
                        text = "当前还没有其他成员加入该空间。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.fg3,
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        state.members.forEachIndexed { index, member ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Column(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(2.dp),
                                ) {
                                    Text(
                                        text = member.name.ifBlank { member.email },
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium,
                                        color = colors.fg,
                                    )
                                    Text(
                                        text = member.email,
                                        style = MaterialTheme.typography.labelSmall,
                                        color = colors.fg3,
                                    )
                                }
                                SettingsStatusPill(
                                    text = if (member.role == "editor") "可编辑" else "只读",
                                    containerColor = if (member.role == "editor") colors.okSoft else colors.surface2,
                                    contentColor = if (member.role == "editor") colors.ok else colors.fg3,
                                )
                            }
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                TextButton(
                                    onClick = { viewModel.toggleMemberRole(member) },
                                    enabled = !state.isMutating,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                                ) {
                                    Text(if (member.role == "editor") "改为只读" else "改为可编辑")
                                }
                                TextButton(
                                    onClick = { pendingRemoveMember = member },
                                    enabled = !state.isMutating,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                ) {
                                    Icon(Icons.Rounded.DeleteOutline, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text("移除")
                                }
                            }
                            if (index < state.members.lastIndex) {
                                HorizontalDivider(thickness = 1.dp, color = colors.line1)
                            }
                        }
                    }
                }
            }

            // 2. Space Invites
            val invRes = state.spaceInvites
            SettingsSectionCard(
                title = "空间邀请链接",
                subtitle = if (invRes != null) {
                    val limitPart = invRes.limit?.let { "上限 $it 个，剩余 ${invRes.remaining ?: 0} 个" } ?: "无上限"
                    "已有账号可通过链接加入此空间（有效 ${invRes.active} 个 · $limitPart）。"
                } else {
                    "生成一次性或多次邀请链接，让已有账号加入此空间。"
                },
            ) {
                if (invRes?.enabled == false) {
                    Text(
                        text = "管理员已关闭空间邀请功能。",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.warn,
                    )
                } else {
                    Text("默认权限", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SettingsChoiceChip(
                            label = "只读",
                            selected = state.inviteRole == "viewer",
                            onClick = { viewModel.selectInviteRole("viewer") },
                        )
                        SettingsChoiceChip(
                            label = "可编辑",
                            selected = state.inviteRole == "editor",
                            onClick = { viewModel.selectInviteRole("editor") },
                        )
                    }

                    Text("可使用次数", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(1, 5, 10).forEach { count ->
                            SettingsChoiceChip(
                                label = "$count 次",
                                selected = state.inviteMaxUses == count,
                                onClick = { viewModel.selectInviteMaxUses(count) },
                            )
                        }
                    }

                    Text("有效期", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(24 to "1 天", 168 to "7 天", 720 to "30 天").forEach { (hours, label) ->
                            SettingsChoiceChip(
                                label = label,
                                selected = state.inviteExpiresInHours == hours,
                                onClick = { viewModel.selectInviteExpiresInHours(hours) },
                            )
                        }
                    }

                    Button(
                        onClick = viewModel::createSpaceInvite,
                        enabled = !state.isMutating,
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
                        Text("创建空间邀请链接", fontWeight = FontWeight.SemiBold)
                    }
                }

                state.latestSpaceInviteUrl?.let { url ->
                    SettingsCopyBox(
                        label = "新生成的空间邀请链接（仅显示一次）",
                        value = url,
                        highlightSuccess = true,
                        onCopy = { copySettingsText(context, "空间邀请链接", url) },
                        onShare = { shareSettingsText(context, url) },
                    )
                }

                val invites = invRes?.invites.orEmpty()
                if (invites.isNotEmpty()) {
                    HorizontalDivider(thickness = 1.dp, color = colors.line1)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        invites.forEach { invite ->
                            SpaceInviteRow(
                                invite = invite,
                                isMutating = state.isMutating,
                                onRevoke = { viewModel.revokeSpaceInvite(invite.id) },
                            )
                        }
                    }
                }
            }
        } else {
            // Invited non-owner space -> show role & Leave Space
            SettingsSectionCard(
                title = activeSpace.name.ifBlank { "受邀空间" },
                subtitle = "空间所有者：${activeSpace.ownerName ?: "其他成员"} · 你的权限：${if (activeSpace.isReadOnly) "只读" else "可编辑"}",
            ) {
                OutlinedButton(
                    onClick = { confirmLeaveSpace = true },
                    enabled = !state.isMutating,
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.destructive.copy(alpha = 0.5f)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
                ) {
                    Text("退出此空间", fontWeight = FontWeight.SemiBold)
                }
            }
        }

        // 3. Personal registration invites (visible when permitted / admin)
        if (state.showPersonalInvitesSection) {
            val personal = state.personalInvites
            SettingsSectionCard(
                title = "个人注册邀请码",
                subtitle = "用于邀请新用户注册本站账号（有效期 7 天，单次使用）。",
            ) {
                Button(
                    onClick = { viewModel.createPersonalInvite() },
                    enabled = !state.isMutating,
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = colors.fg,
                        contentColor = colors.bg,
                    ),
                ) {
                    Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("生成个人注册邀请码", fontWeight = FontWeight.SemiBold)
                }

                state.latestPersonalInvite?.let { created ->
                    SettingsCopyBox(
                        label = "新生成的注册邀请链接（仅显示一次）",
                        value = created.url,
                        hint = "邀请码：${created.token}",
                        highlightSuccess = true,
                        onCopy = { copySettingsText(context, "注册邀请链接", created.url) },
                        onShare = { shareSettingsText(context, created.url) },
                    )
                }

                val list = personal?.invites.orEmpty()
                if (list.isNotEmpty()) {
                    HorizontalDivider(thickness = 1.dp, color = colors.line1)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        list.forEach { inv ->
                            val isOpen = inv.status == "open" && inv.revoked == 0
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Column(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(2.dp),
                                ) {
                                    Text(
                                        text = "${inv.uses}/${inv.maxUses} 次 · ${inviteStatusLabel(inv.status)}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = colors.fg,
                                    )
                                    Text(
                                        text = "过期：${formatSettingsDateTime(inv.expiresAt)}",
                                        style = DropitMonoTypography.meta,
                                        color = colors.fg3,
                                    )
                                }
                                if (isOpen) {
                                    TextButton(
                                        onClick = { viewModel.revokePersonalInvite(inv.id) },
                                        enabled = !state.isMutating,
                                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                        colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                    ) {
                                        Text("撤销")
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pendingRemoveMember?.let { member ->
        SettingsConfirmDialog(
            title = "移出空间成员？",
            message = "移出后「${member.name.ifBlank { member.email }}」将无法再访问该空间的内容。",
            confirmLabel = "确认移出",
            onConfirm = {
                pendingRemoveMember = null
                viewModel.removeMember(member)
            },
            onDismiss = { pendingRemoveMember = null },
        )
    }

    if (confirmLeaveSpace) {
        SettingsConfirmDialog(
            title = "退出受邀空间？",
            message = "退出后该空间将从你的空间列表中移除，如需重新加入需要新的邀请链接。",
            confirmLabel = "确认退出",
            onConfirm = {
                confirmLeaveSpace = false
                viewModel.leaveSelectedSpace(onSpacesChanged)
            },
            onDismiss = { confirmLeaveSpace = false },
        )
    }
}

@Composable
private fun SpaceInviteRow(
    invite: SpaceInvite,
    isMutating: Boolean,
    onRevoke: () -> Unit,
) {
    val colors = DropitTheme.colors
    val isOpen = invite.status == "open" && invite.revoked == 0
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = DropitTheme.shapes.md,
        color = colors.surface0,
        border = BorderStroke(1.dp, colors.line1),
        tonalElevation = 0.dp,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    SettingsStatusPill(
                        text = inviteStatusLabel(invite.status),
                        containerColor = if (isOpen) colors.okSoft else colors.surface2,
                        contentColor = if (isOpen) colors.ok else colors.fg3,
                    )
                    Text(
                        text = "${if (invite.role == "editor") "可编辑" else "只读"} · ${invite.uses}/${invite.maxUses} 次",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.fg2,
                    )
                }
                Text(
                    text = "过期：${formatSettingsDateTime(invite.expiresAt)}",
                    style = DropitMonoTypography.meta,
                    color = colors.fg3,
                )
            }
            if (isOpen) {
                TextButton(
                    onClick = onRevoke,
                    enabled = !isMutating,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                ) {
                    Text("撤销")
                }
            }
        }
    }
}

internal fun inviteStatusLabel(status: String): String = when (status.lowercase()) {
    "open" -> "有效"
    "revoked" -> "已撤销"
    "expired" -> "已过期"
    "used" -> "已用完"
    else -> status
}
