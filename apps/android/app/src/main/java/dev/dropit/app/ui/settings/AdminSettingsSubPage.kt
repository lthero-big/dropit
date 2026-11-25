package dev.dropit.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.data.account.AdminRoom
import dev.dropit.app.data.account.AdminUser
import dev.dropit.app.data.account.LimitField
import dev.dropit.app.data.account.OAuthProviderConfig
import dev.dropit.app.ui.theme.DropitMonoTypography
import dev.dropit.app.ui.theme.DropitTheme

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AdminSettingsSubPage(
    viewModel: AdminSettingsViewModel,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        viewModel.loadTab(state.selectedTab)
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.ADMIN.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = viewModel::refreshCurrentTab,
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(
                message = "管理员设置需要具备 admin 权限的登录令牌，请使用管理员账号的邮箱密码或 GitHub / Google 重新登录。",
                onReauthenticate = onReauthenticate,
            )
            return@SettingsSubPageScaffold
        }

        // Scrollable top tab bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AdminTab.entries.forEach { tab ->
                SettingsChoiceChip(
                    label = tab.label,
                    selected = state.selectedTab == tab,
                    onClick = { viewModel.selectTab(tab) },
                )
            }
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        state.oneTimePasswordNotice?.let { (email, tempPassword) ->
            SettingsCopyBox(
                label = "一次性临时密码（$email）",
                value = tempPassword,
                hint = "仅显示一次，请发送给对方；对方首次登录后会被强制修改密码。",
                highlightSuccess = true,
                onCopy = { copySettingsText(context, "临时密码", tempPassword) },
            )
            TextButton(
                onClick = viewModel::dismissOneTimePasswordNotice,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg3),
            ) {
                Text("我已保存，关闭临时密码提示")
            }
        }

        when (state.selectedTab) {
            AdminTab.USERS -> AdminUsersTabContent(state = state, viewModel = viewModel)
            AdminTab.INVITES -> AdminInvitesTabContent(state = state, viewModel = viewModel)
            AdminTab.LIMITS -> AdminLimitsTabContent(state = state, viewModel = viewModel)
            AdminTab.ROOMS -> AdminRoomsTabContent(state = state, viewModel = viewModel)
            AdminTab.SITE_OAUTH -> AdminSiteOAuthTabContent(state = state, viewModel = viewModel)
        }
    }

    // 409 ORIGIN_CONFIRM_REQUIRED native dialog
    state.pendingOriginConfirm?.let { pending ->
        SettingsConfirmDialog(
            title = "确认修改站点地址？",
            message = "保存后服务端将使用「${pending.targetOrigin.ifBlank { "默认地址" }}」校验跨站请求并生成 OAuth / 分享 / 邀请链接。旧地址的浏览器请求可能会被拒绝，请确认新地址可正常访问。",
            confirmLabel = "确认保存",
            isDestructive = true,
            onConfirm = { viewModel.updateSiteOrigin(pending.origin, confirm = true) },
            onDismiss = viewModel::dismissOriginConfirm,
        )
    }
}

// ---------------------------------------------------------------------------
// Tab 1: Users
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminUsersTabContent(
    state: AdminSettingsUiState,
    viewModel: AdminSettingsViewModel,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var showCreateDialog by remember { mutableStateOf(false) }
    var editingUser by remember { mutableStateOf<AdminUser?>(null) }
    var pendingResetUser by remember { mutableStateOf<AdminUser?>(null) }
    var pendingLogoutUser by remember { mutableStateOf<AdminUser?>(null) }

    Button(
        onClick = { showCreateDialog = true },
        enabled = !state.isBusy,
        modifier = Modifier
            .fillMaxWidth()
            .defaultMinSize(minHeight = 48.dp),
        shape = shapes.md,
        colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.brandFg),
    ) {
        Icon(Icons.Rounded.PersonAdd, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(6.dp))
        Text("新建用户", fontWeight = FontWeight.SemiBold)
    }

    if (state.users.isEmpty() && !state.isLoading) {
        SettingsSectionCard {
            Text("暂无用户记录。", style = MaterialTheme.typography.bodySmall, color = colors.fg3)
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            state.users.forEach { user ->
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
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(
                                    text = user.name.ifBlank { user.email },
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    color = colors.fg,
                                )
                                Text(
                                    text = user.email,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.fg3,
                                )
                            }
                            SettingsStatusPill(
                                text = if (user.isAdmin) "管理员" else "普通用户",
                                containerColor = if (user.isAdmin) colors.brandSoft else colors.surface2,
                                contentColor = if (user.isAdmin) colors.brand else colors.fg3,
                            )
                        }

                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (user.isDisabled) {
                                SettingsStatusPill("已停用", colors.brandSoft, colors.destructive)
                            }
                            if (user.isPending) {
                                SettingsStatusPill("待激活", colors.warnSoft, colors.warn)
                            }
                            if (user.mustChangePassword) {
                                SettingsStatusPill("需改密", colors.warnSoft, colors.warn)
                            }
                            user.providers.forEach { p ->
                                SettingsStatusPill(providerDisplayName(p), colors.surface0, colors.fg2)
                            }
                        }

                        Text(
                            text = "配额：${ServerUrl.formatSize(user.usedBytes)} / ${ServerUrl.formatSize(user.quotaBytes)}" +
                                (user.quotaOverride?.let { "（自定义）" } ?: "（默认）") +
                                " · 活跃空间邀请：${user.activeSpaceInvites}",
                            style = DropitMonoTypography.meta,
                            color = colors.fg3,
                        )

                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(
                                onClick = { editingUser = user },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                            ) { Text("编辑配额/角色") }
                            TextButton(
                                onClick = {
                                    viewModel.updateUser(
                                        userId = user.id,
                                        disabled = OptionalField.Present(!user.isDisabled),
                                    )
                                },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(
                                    contentColor = if (user.isDisabled) colors.ok else colors.destructive,
                                ),
                            ) { Text(if (user.isDisabled) "启用" else "停用") }
                            TextButton(
                                onClick = { pendingResetUser = user },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
                            ) { Text("重置密码") }
                            TextButton(
                                onClick = { pendingLogoutUser = user },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                            ) { Text("强制下线") }
                        }
                    }
                }
            }
        }
    }

    if (showCreateDialog) {
        CreateAdminUserDialog(
            onCreate = { email, name, role, quotaBytes, tempPw ->
                showCreateDialog = false
                viewModel.createUser(email, name, role, quotaBytes, tempPw)
            },
            onDismiss = { showCreateDialog = false },
        )
    }

    editingUser?.let { target ->
        EditAdminUserDialog(
            user = target,
            onSave = { role, quotaField, inviteLimitField ->
                editingUser = null
                viewModel.updateUser(
                    userId = target.id,
                    role = role,
                    quotaBytes = quotaField,
                    inviteLimit = inviteLimitField,
                )
            },
            onDismiss = { editingUser = null },
        )
    }

    pendingResetUser?.let { user ->
        SettingsConfirmDialog(
            title = "重置 ${user.email} 的密码？",
            message = "将生成新的随机临时密码并强制对方下次登录时修改密码。",
            confirmLabel = "确认重置",
            onConfirm = {
                pendingResetUser = null
                viewModel.resetUserPassword(user)
            },
            onDismiss = { pendingResetUser = null },
        )
    }

    pendingLogoutUser?.let { user ->
        SettingsConfirmDialog(
            title = "强制下线 ${user.email}？",
            message = "将吊销该用户的全部登录会话，对方需要重新登录。",
            confirmLabel = "强制下线",
            onConfirm = {
                pendingLogoutUser = null
                viewModel.logoutUser(user)
            },
            onDismiss = { pendingLogoutUser = null },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CreateAdminUserDialog(
    onCreate: (email: String, name: String?, role: String, quotaBytes: Long?, tempPassword: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var email by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("user") }
    var quotaMb by remember { mutableStateOf("") }
    var tempPassword by remember { mutableStateOf(true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = { Text("新建用户", style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    singleLine = true,
                    label = { Text("邮箱（必填）") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    label = { Text("显示名称（可选）") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Text("角色", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsChoiceChip("普通用户", role == "user", onClick = { role = "user" })
                    SettingsChoiceChip("管理员", role == "admin", onClick = { role = "admin" })
                }
                OutlinedTextField(
                    value = quotaMb,
                    onValueChange = { quotaMb = it },
                    singleLine = true,
                    label = { Text("自定义配额 MB（留空用默认）") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text("生成一次性临时密码", style = MaterialTheme.typography.bodySmall, color = colors.fg)
                    Switch(checked = tempPassword, onCheckedChange = { tempPassword = it })
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val parsedQuota = quotaMb.trim().toLongOrNull()?.takeIf { it > 0 }?.times(1024L * 1024L)
                    onCreate(email, name.ifBlank { null }, role, parsedQuota, tempPassword)
                },
                enabled = email.isNotBlank(),
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) { Text("创建", fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) { Text("取消") }
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditAdminUserDialog(
    user: AdminUser,
    onSave: (
        role: OptionalField<String>,
        quotaBytes: OptionalField<Long?>,
        inviteLimit: OptionalField<Int?>,
    ) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var role by remember(user.id) { mutableStateOf(user.role) }
    var quotaMb by remember(user.id) {
        mutableStateOf(user.quotaOverride?.let { (it / (1024L * 1024L)).toString() }.orEmpty())
    }
    var inviteLimitText by remember(user.id) {
        mutableStateOf(user.inviteLimit?.toString().orEmpty())
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        shape = shapes.lg,
        containerColor = colors.surface1,
        titleContentColor = colors.fg,
        textContentColor = colors.fg2,
        tonalElevation = 0.dp,
        title = { Text("编辑用户 · ${user.email}", style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("角色", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsChoiceChip("普通用户", role == "user", onClick = { role = "user" })
                    SettingsChoiceChip("管理员", role == "admin", onClick = { role = "admin" })
                }
                OutlinedTextField(
                    value = quotaMb,
                    onValueChange = { quotaMb = it },
                    singleLine = true,
                    label = { Text("配额覆盖（MB，留空恢复默认）") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = inviteLimitText,
                    onValueChange = { inviteLimitText = it },
                    singleLine = true,
                    label = { Text("空间邀请上限（留空恢复默认，0 表示禁止）") },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val roleField = if (role != user.role) OptionalField.Present(role) else OptionalField.Absent
                    val quotaVal = quotaMb.trim().takeIf { it.isNotEmpty() }?.toLongOrNull()?.times(1024L * 1024L)
                    val quotaField = if (quotaVal != user.quotaOverride) OptionalField.Present(quotaVal) else OptionalField.Absent
                    val limitVal = inviteLimitText.trim().takeIf { it.isNotEmpty() }?.toIntOrNull()
                    val limitField = if (limitVal != user.inviteLimit) OptionalField.Present(limitVal) else OptionalField.Absent
                    onSave(roleField, quotaField, limitField)
                },
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
            ) { Text("保存", fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = {
            TextButton(
                onClick = onDismiss,
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                colors = ButtonDefaults.textButtonColors(contentColor = colors.fg2),
            ) { Text("取消") }
        },
    )
}

// ---------------------------------------------------------------------------
// Tab 2: Registration Policy & Admin Invites
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminInvitesTabContent(
    state: AdminSettingsUiState,
    viewModel: AdminSettingsViewModel,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    val policyInfo = state.registrationPolicy
    var draftPolicy by remember(policyInfo?.policy) { mutableStateOf(policyInfo?.policy ?: "invite") }
    var maxUses by remember { mutableStateOf(1) }
    var expiresHours by remember { mutableStateOf(168) }

    SettingsSectionCard(
        title = "注册策略",
        subtitle = "决定新用户能否注册本站账号，修改后立即生效。",
    ) {
        val choices = listOf(
            Triple("invite", "仅邀请（默认）", "只有拿到邀请链接或管理员预建账号的人才能加入。"),
            Triple("closed", "关闭注册", "暂停所有新用户注册，已有账号不受影响。"),
            Triple("open", "开放注册", "任何人可用邮箱密码或 OAuth 注册（公网站点慎用）。"),
        )
        choices.forEach { (value, label, desc) ->
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = shapes.md,
                color = colors.surface0,
                border = BorderStroke(1.dp, if (draftPolicy == value) colors.fg else colors.line1),
                tonalElevation = 0.dp,
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    RadioButton(
                        selected = draftPolicy == value,
                        onClick = { draftPolicy = value },
                    )
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, color = colors.fg)
                        Text(desc, style = MaterialTheme.typography.labelSmall, color = colors.fg3)
                    }
                }
            }
        }
        Button(
            onClick = { viewModel.updateRegistrationPolicy(draftPolicy) },
            enabled = !state.isBusy && policyInfo != null && draftPolicy != policyInfo.policy,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp),
            shape = shapes.md,
            colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.brandFg),
        ) {
            Text("保存注册策略", fontWeight = FontWeight.SemiBold)
        }
    }

    SettingsSectionCard(
        title = "注册邀请码（${state.adminInvites.size}）",
        subtitle = "创建与撤销全站注册邀请链接。",
    ) {
        Text("可使用次数", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(1, 5, 10).forEach { count ->
                SettingsChoiceChip("$count 次", maxUses == count, onClick = { maxUses = count })
            }
        }
        Text("有效期", style = MaterialTheme.typography.labelMedium, color = colors.fg2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(24 to "1 天", 168 to "7 天", 720 to "30 天").forEach { (h, label) ->
                SettingsChoiceChip(label, expiresHours == h, onClick = { expiresHours = h })
            }
        }
        Button(
            onClick = { viewModel.createAdminInvite(maxUses = maxUses, expiresInHours = expiresHours) },
            enabled = !state.isBusy,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp),
            shape = shapes.md,
            colors = ButtonDefaults.buttonColors(containerColor = colors.fg, contentColor = colors.bg),
        ) {
            Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text("生成注册邀请链接", fontWeight = FontWeight.SemiBold)
        }

        state.latestAdminInvite?.let { created ->
            SettingsCopyBox(
                label = "新生成的注册邀请链接（仅显示一次）",
                value = created.url,
                hint = "邀请码：${created.token}",
                highlightSuccess = true,
                onCopy = { copySettingsText(context, "注册邀请链接", created.url) },
                onShare = { shareSettingsText(context, created.url) },
            )
        }

        if (state.adminInvites.isNotEmpty()) {
            HorizontalDivider(thickness = 1.dp, color = colors.line1)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                state.adminInvites.forEach { invite ->
                    val isOpen = invite.status == "open" && invite.revoked == 0
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
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
                                    text = "${if (invite.kind == "space") "空间" else "注册"} · ${invite.uses}/${invite.maxUses} 次",
                                    style = MaterialTheme.typography.labelMedium,
                                    color = colors.fg,
                                )
                            }
                            Text(
                                text = "创建者：${invite.createdByEmail ?: invite.createdBy} · 过期：${formatSettingsDateTime(invite.expiresAt)}",
                                style = DropitMonoTypography.meta,
                                color = colors.fg3,
                            )
                        }
                        if (isOpen) {
                            TextButton(
                                onClick = { viewModel.revokeAdminInvite(invite.id) },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                            ) { Text("撤销") }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tab 3: Runtime Limits & Audit
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminLimitsTabContent(
    state: AdminSettingsUiState,
    viewModel: AdminSettingsViewModel,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var selectedSub by remember { mutableStateOf("CAPACITY") }

    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        RuntimeLimitGroup.entries.forEach { group ->
            SettingsChoiceChip(group.label, selectedSub == group.name, onClick = { selectedSub = group.name })
        }
        SettingsChoiceChip(
            label = "审计日志（${state.limitAuditEntries.size}）",
            selected = selectedSub == "AUDIT",
            onClick = { selectedSub = "AUDIT" },
        )
    }

    if (selectedSub == "AUDIT") {
        SettingsSectionCard(
            title = "限额变更审计日志",
            subtitle = "记录管理员修改运行时限额的历史明细。",
        ) {
            if (state.limitAuditEntries.isEmpty()) {
                Text("暂无变更记录。", style = MaterialTheme.typography.bodySmall, color = colors.fg3)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    state.limitAuditEntries.forEachIndexed { idx, entry ->
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                text = "${RuntimeLimitsCatalog.labelFor(entry.key)}：${RuntimeLimitsCatalog.formatLimit(entry.key, entry.oldValue)} → ${RuntimeLimitsCatalog.formatLimit(entry.key, entry.newValue)}",
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.Medium,
                                color = colors.fg,
                            )
                            Text(
                                text = "${entry.actorEmail.ifBlank { entry.actorId }} · ${formatSettingsDateTime(entry.createdAt)}",
                                style = DropitMonoTypography.meta,
                                color = colors.fg3,
                            )
                        }
                        if (idx < state.limitAuditEntries.lastIndex) {
                            HorizontalDivider(thickness = 1.dp, color = colors.line1)
                        }
                    }
                }
            }

            if (state.limitAuditNextCursor != null) {
                OutlinedButton(
                    onClick = viewModel::loadMoreLimitAudit,
                    enabled = !state.isLoadingMoreAudit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.line2),
                ) {
                    Text(if (state.isLoadingMoreAudit) "加载中…" else "加载更早记录")
                }
            }
        }
    } else {
        val group = RuntimeLimitGroup.valueOf(selectedSub)
        val specs = remember(group) { RuntimeLimitsCatalog.SPECS.filter { it.group == group } }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            specs.forEach { spec ->
                val field = state.limits[spec.key] ?: return@forEach
                RuntimeLimitEditorCard(
                    spec = spec,
                    field = field,
                    allLimits = state.limits,
                    isBusy = state.isBusy,
                    onSave = { value -> viewModel.updateLimit(spec.key, value) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RuntimeLimitEditorCard(
    spec: RuntimeLimitSpec,
    field: LimitField,
    allLimits: Map<String, LimitField>,
    isBusy: Boolean,
    onSave: (Long?) -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val units = remember(spec.key) { RuntimeLimitsCatalog.unitsFor(spec.key) }
    var unit by remember(spec.key, field.value) { mutableStateOf(RuntimeLimitsCatalog.defaultUnit(spec.key, field.value)) }
    var raw by remember(spec.key, field.value) { mutableStateOf(RuntimeLimitsCatalog.toInput(field.value, unit)) }
    var localError by remember(spec.key, field.value) { mutableStateOf<String?>(null) }

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
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(spec.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, color = colors.fg)
                SettingsStatusPill(
                    text = if (field.overridden) "已覆盖" else "默认",
                    containerColor = if (field.overridden) colors.brandSoft else colors.surface2,
                    contentColor = if (field.overridden) colors.brand else colors.fg3,
                )
            }
            Text(
                text = "当前 ${RuntimeLimitsCatalog.formatLimit(spec.key, field.value)} · 默认 ${RuntimeLimitsCatalog.formatLimit(spec.key, field.defaultValue)}",
                style = DropitMonoTypography.meta,
                color = colors.fg3,
            )
            spec.hint?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.fg3)
            }

            if (units.size > 1) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    units.forEach { candidate ->
                        SettingsChoiceChip(
                            label = candidate.label,
                            selected = unit == candidate,
                            onClick = {
                                val parsed = RuntimeLimitsCatalog.toCanonical(raw, unit)
                                unit = candidate
                                if (parsed != null) raw = RuntimeLimitsCatalog.toInput(parsed, candidate)
                                localError = null
                            },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = raw,
                onValueChange = {
                    raw = it
                    localError = null
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !isBusy,
                singleLine = true,
                label = { Text(if (unit == RuntimeLimitUnit.COUNT) "数值" else "数值（${unit.label}）") },
                shape = shapes.md,
                colors = paperTextFieldColors(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = if (unit == RuntimeLimitUnit.COUNT) KeyboardType.Number else KeyboardType.Decimal,
                ),
            )

            localError?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = colors.destructive)
            }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val canonical = RuntimeLimitsCatalog.toCanonical(raw, unit)
                Button(
                    onClick = {
                        if (canonical == null) {
                            localError = if (unit == RuntimeLimitUnit.COUNT) "请输入大于 0 的整数" else "请输入大于 0 的数字"
                            return@Button
                        }
                        val err = RuntimeLimitsCatalog.localLimitError(spec.key, canonical, allLimits)
                        if (err != null) {
                            localError = err
                            return@Button
                        }
                        onSave(canonical)
                    },
                    enabled = !isBusy && canonical != field.value,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.brandFg),
                ) { Text("保存") }

                OutlinedButton(
                    onClick = {
                        val err = RuntimeLimitsCatalog.localLimitError(spec.key, field.defaultValue, allLimits)
                        if (err != null) {
                            localError = "$err，请先调整关联项"
                            return@OutlinedButton
                        }
                        onSave(null)
                    },
                    enabled = !isBusy && field.overridden,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.line2),
                ) { Text("恢复默认") }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tab 4: Temporary Rooms
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminRoomsTabContent(
    state: AdminSettingsUiState,
    viewModel: AdminSettingsViewModel,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    var pendingDeleteRoom by remember { mutableStateOf<AdminRoom?>(null) }

    if (state.adminRooms.isEmpty() && !state.isLoading) {
        SettingsSectionCard {
            Text("当前没有活跃的临时房间。", style = MaterialTheme.typography.bodySmall, color = colors.fg3)
        }
    } else {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            state.adminRooms.forEach { room ->
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
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = room.code?.let { "房间码 $it" } ?: "匿名房间 ${room.id.take(8)}",
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = colors.fg,
                                modifier = Modifier.weight(1f),
                            )
                            SettingsStatusPill(
                                text = if (room.closed) "已关闭" else "开放中",
                                containerColor = if (room.closed) colors.surface2 else colors.okSoft,
                                contentColor = if (room.closed) colors.fg3 else colors.ok,
                            )
                        }

                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (room.hasPin) SettingsStatusPill("有 PIN", colors.surface0, colors.fg2)
                            if (room.lockedFor != null && room.lockedFor > 0) {
                                SettingsStatusPill("已锁定 ${room.lockedFor}s", colors.warnSoft, colors.warn)
                            }
                            SettingsStatusPill("${room.itemCount} 条 · ${ServerUrl.formatSize(room.bytes)}", colors.surface0, colors.fg2)
                        }

                        Text(
                            text = "创建者：${room.owner ?: if (room.anonymous) "匿名访客" else "—"} · 过期：${formatSettingsDateTime(room.expiresAt)}",
                            style = DropitMonoTypography.meta,
                            color = colors.fg3,
                        )

                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (room.lockedFor != null && room.lockedFor > 0) {
                                TextButton(
                                    onClick = { viewModel.unlockRoom(room.id) },
                                    enabled = !state.isBusy,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                                ) {
                                    Icon(Icons.Rounded.LockOpen, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text("解锁")
                                }
                            }
                            if (room.closed) {
                                TextButton(
                                    onClick = { viewModel.reopenRoom(room.id) },
                                    enabled = !state.isBusy,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.ok),
                                ) { Text("重开") }
                            } else {
                                TextButton(
                                    onClick = { viewModel.closeRoom(room.id) },
                                    enabled = !state.isBusy,
                                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                    colors = ButtonDefaults.textButtonColors(contentColor = colors.warn),
                                ) { Text("关闭") }
                            }
                            TextButton(
                                onClick = { pendingDeleteRoom = room },
                                enabled = !state.isBusy,
                                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                            ) {
                                Icon(Icons.Rounded.DeleteOutline, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(4.dp))
                                Text("删除")
                            }
                        }
                    }
                }
            }
        }
    }

    pendingDeleteRoom?.let { room ->
        SettingsConfirmDialog(
            title = "删除临时房间？",
            message = "删除后房间「${room.code ?: room.id.take(8)}」内的全部文件与文本将立即清除，不可恢复。",
            confirmLabel = "确认删除",
            onConfirm = {
                pendingDeleteRoom = null
                viewModel.deleteRoom(room.id)
            },
            onDismiss = { pendingDeleteRoom = null },
        )
    }
}

// ---------------------------------------------------------------------------
// Tab 5: Site Origin & OAuth Configuration
// ---------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminSiteOAuthTabContent(
    state: AdminSettingsUiState,
    viewModel: AdminSettingsViewModel,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current

    val site = state.siteSettings
    var originInput by remember(site?.adminOrigin) { mutableStateOf(site?.adminOrigin.orEmpty()) }

    SettingsSectionCard(
        title = "站点域名（APP_ORIGIN）",
        subtitle = "决定 OAuth 回调地址、分享链接、邀请链接和跨站校验。修改后立即生效。",
    ) {
        if (site != null) {
            Text(
                text = "当前生效：${site.effectiveOrigin.ifBlank { "—" }}\n来源：${site.source} · 环境变量：${site.envOrigin ?: "未设置"}",
                style = DropitMonoTypography.meta,
                color = colors.fg2,
            )

            OutlinedTextField(
                value = originInput,
                onValueChange = { originInput = it },
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.isBusy,
                singleLine = true,
                label = { Text("自定义站点地址（不含路径）") },
                placeholder = { Text(site.envOrigin ?: "https://dropit.example.com", color = colors.fg4) },
                shape = shapes.md,
                colors = paperTextFieldColors(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )

            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { viewModel.updateSiteOrigin(originInput, confirm = false) },
                    enabled = !state.isBusy && originInput.isNotBlank(),
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    shape = shapes.md,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.brandFg),
                ) { Text("保存站点地址", fontWeight = FontWeight.SemiBold) }

                if (!site.adminOrigin.isNullOrBlank()) {
                    OutlinedButton(
                        onClick = { viewModel.updateSiteOrigin(null, confirm = false) },
                        enabled = !state.isBusy,
                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                        shape = shapes.md,
                        border = BorderStroke(1.dp, colors.line2),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.destructive),
                    ) { Text("清除覆盖") }
                }
            }

            if (site.callbacks.isNotEmpty()) {
                HorizontalDivider(thickness = 1.dp, color = colors.line1)
                site.callbacks.forEach { cb ->
                    SettingsCopyBox(
                        label = "${cb.label} 回调地址",
                        value = cb.url,
                        onCopy = { copySettingsText(context, "${cb.label} 回调地址", cb.url) },
                    )
                }
            }
        }
    }

    val providers = state.oauthSettings?.providers.orEmpty()
    providers.forEach { provider ->
        AdminOAuthProviderCard(
            config = provider,
            isBusy = state.isBusy,
            onSave = { cid, secret, enabled ->
                viewModel.updateOAuthProvider(provider.provider, cid, secret, enabled)
            },
            onVerify = { viewModel.verifyOAuthProvider(provider.provider) },
            onDelete = { viewModel.deleteOAuthProvider(provider.provider) },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminOAuthProviderCard(
    config: OAuthProviderConfig,
    isBusy: Boolean,
    onSave: (clientId: String, clientSecret: String?, enabled: Boolean) -> Unit,
    onVerify: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    var clientId by remember(config.provider, config.clientId) { mutableStateOf(config.clientId) }
    var clientSecret by remember(config.provider) { mutableStateOf("") }
    var enabled by remember(config.provider, config.enabled, config.source) {
        mutableStateOf(config.enabled || config.source == "none")
    }
    var confirmDelete by remember { mutableStateOf(false) }

    val label = config.label.ifBlank { providerDisplayName(config.provider) }
    val statusText = when {
        config.source == "none" -> "未配置"
        !config.enabled -> "已停用"
        config.check != null && !config.check.ok -> "验证失败"
        config.check?.ok == true -> "已验证"
        else -> "已配置（未验证）"
    }

    SettingsSectionCard(
        title = "$label OAuth 配置",
        subtitle = "来源：${config.source} · 状态：$statusText · ${if (config.active) "登录页已显示" else "登录页未显示"}",
    ) {
        if (config.callbackUrl.isNotBlank()) {
            SettingsCopyBox(
                label = "回调地址（Callback / Redirect URI）",
                value = config.callbackUrl,
                onCopy = { copySettingsText(context, "$label 回调地址", config.callbackUrl) },
            )
        }

        OutlinedTextField(
            value = clientId,
            onValueChange = { clientId = it },
            modifier = Modifier.fillMaxWidth(),
            enabled = !isBusy,
            singleLine = true,
            label = { Text("Client ID") },
            shape = shapes.md,
            colors = paperTextFieldColors(),
        )

        OutlinedTextField(
            value = clientSecret,
            onValueChange = { clientSecret = it },
            modifier = Modifier.fillMaxWidth(),
            enabled = !isBusy,
            singleLine = true,
            label = { Text("Client Secret") },
            placeholder = {
                Text(
                    text = if (config.secretSet) "已保存 ${config.secretHint.orEmpty()}，留空则不修改" else "粘贴 Client Secret",
                    color = colors.fg4,
                )
            },
            visualTransformation = PasswordVisualTransformation(),
            shape = shapes.md,
            colors = paperTextFieldColors(),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("在登录页启用 $label", style = MaterialTheme.typography.bodySmall, color = colors.fg)
            Switch(checked = enabled, onCheckedChange = { enabled = it }, enabled = !isBusy)
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onSave(clientId, clientSecret.takeIf { it.isNotBlank() }, enabled) },
                enabled = !isBusy && clientId.isNotBlank() && (config.secretSet || clientSecret.isNotBlank()),
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                colors = ButtonDefaults.buttonColors(containerColor = colors.brand, contentColor = colors.brandFg),
            ) { Text("保存") }

            OutlinedButton(
                onClick = onVerify,
                enabled = !isBusy && config.source != "none",
                modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.line2),
            ) { Text("验证凭据") }

            if (config.source == "database") {
                TextButton(
                    onClick = { confirmDelete = true },
                    enabled = !isBusy,
                    modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                ) { Text("删除配置") }
            }
        }
    }

    if (confirmDelete) {
        SettingsConfirmDialog(
            title = "删除 $label 页面配置？",
            message = if (config.envConfigured) {
                "删除后将回退使用服务端环境变量中的 $label 凭据。"
            } else {
                "删除后登录页将不再显示 $label 登录入口。"
            },
            confirmLabel = "确认删除",
            onConfirm = {
                confirmDelete = false
                onDelete()
            },
            onDismiss = { confirmDelete = false },
        )
    }
}
