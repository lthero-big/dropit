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
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.LinkOff
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.ManagedShare
import dev.dropit.app.data.account.ManagedShareLink
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

enum class ShareLinksFilter(val label: String) {
    ALL("全部"),
    ACTIVE("有效"),
    REVOKED("已撤销"),
    EXPIRED("已过期"),
    EXHAUSTED("已用尽"),
}

data class ShareLinksUiState(
    val shares: List<ManagedShare> = emptyList(),
    val nextCursor: String? = null,
    val selectedFilter: ShareLinksFilter = ShareLinksFilter.ALL,
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val busyIds: Set<String> = emptySet(),
    val copiedLinkPreview: Pair<String, ManagedShareLink>? = null,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
) {
    val filteredShares: List<ManagedShare>
        get() = when (selectedFilter) {
            ShareLinksFilter.ALL -> shares
            ShareLinksFilter.ACTIVE -> shares.filter { resolveManagedShareFilter(it) == ShareLinksFilter.ACTIVE }
            ShareLinksFilter.REVOKED -> shares.filter { resolveManagedShareFilter(it) == ShareLinksFilter.REVOKED }
            ShareLinksFilter.EXPIRED -> shares.filter { resolveManagedShareFilter(it) == ShareLinksFilter.EXPIRED }
            ShareLinksFilter.EXHAUSTED -> shares.filter { resolveManagedShareFilter(it) == ShareLinksFilter.EXHAUSTED }
        }
}

internal fun resolveManagedShareFilter(share: ManagedShare, nowMs: Long = System.currentTimeMillis()): ShareLinksFilter {
    return when (share.state.lowercase()) {
        "revoked" -> ShareLinksFilter.REVOKED
        "expired" -> ShareLinksFilter.EXPIRED
        "exhausted" -> ShareLinksFilter.EXHAUSTED
        "active" -> when {
            share.revoked != 0 -> ShareLinksFilter.REVOKED
            share.expiresAt != null && share.expiresAt <= nowMs -> ShareLinksFilter.EXPIRED
            share.maxViews != null && share.views >= share.maxViews -> ShareLinksFilter.EXHAUSTED
            else -> ShareLinksFilter.ACTIVE
        }
        else -> when {
            share.revoked != 0 -> ShareLinksFilter.REVOKED
            share.expiresAt != null && share.expiresAt <= nowMs -> ShareLinksFilter.EXPIRED
            share.maxViews != null && share.views >= share.maxViews -> ShareLinksFilter.EXHAUSTED
            else -> ShareLinksFilter.ACTIVE
        }
    }
}

class ShareLinksViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ShareLinksUiState())
    val uiState: StateFlow<ShareLinksUiState> = _uiState.asStateFlow()

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val page = withContext(ioDispatcher) { repository.listManagedShares(cursor = null) }
                _uiState.update {
                    it.copy(
                        shares = page.shares,
                        nextCursor = page.nextCursor,
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载分享记录失败",
                    )
                }
            }
        }
    }

    fun loadMore() {
        val cursor = _uiState.value.nextCursor ?: return
        if (_uiState.value.isLoadingMore) return
        _uiState.update { it.copy(isLoadingMore = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val page = withContext(ioDispatcher) { repository.listManagedShares(cursor = cursor) }
                _uiState.update { state ->
                    val existingIds = state.shares.map { it.id }.toSet()
                    state.copy(
                        shares = state.shares + page.shares.filterNot { it.id in existingIds },
                        nextCursor = page.nextCursor,
                        isLoadingMore = false,
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isLoadingMore = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingMore = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载更多失败",
                    )
                }
            }
        }
    }

    fun selectFilter(filter: ShareLinksFilter) {
        _uiState.update { it.copy(selectedFilter = filter) }
    }

    fun fetchLink(shareId: String, onResolved: (ManagedShareLink) -> Unit) {
        if (shareId in _uiState.value.busyIds) return
        _uiState.update { it.copy(busyIds = it.busyIds + shareId, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val link = withContext(ioDispatcher) { repository.getManagedShareLink(shareId) }
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        copiedLinkPreview = shareId to link,
                        feedbackMessage = "已获取分享短链",
                    )
                }
                onResolved(link)
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "获取短链失败",
                    )
                }
            }
        }
    }

    fun revoke(shareId: String) {
        if (shareId in _uiState.value.busyIds) return
        _uiState.update { it.copy(busyIds = it.busyIds + shareId, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { repository.revokeManagedShare(shareId) }
                _uiState.update { state ->
                    state.copy(
                        busyIds = state.busyIds - shareId,
                        shares = state.shares.map { s ->
                            if (s.id == shareId) s.copy(revoked = 1, state = "revoked") else s
                        },
                        copiedLinkPreview = state.copiedLinkPreview?.takeUnless { it.first == shareId },
                        feedbackMessage = "已撤销分享链接",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "撤销失败",
                    )
                }
            }
        }
    }

    fun delete(shareId: String) {
        if (shareId in _uiState.value.busyIds) return
        _uiState.update { it.copy(busyIds = it.busyIds + shareId, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) { repository.deleteManagedShare(shareId) }
                _uiState.update { state ->
                    state.copy(
                        busyIds = state.busyIds - shareId,
                        shares = state.shares.filterNot { it.id == shareId },
                        copiedLinkPreview = state.copiedLinkPreview?.takeUnless { it.first == shareId },
                        feedbackMessage = "已删除分享记录",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        busyIds = it.busyIds - shareId,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "删除失败",
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
            return ShareLinksViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ShareLinksSubPage(
    viewModel: ShareLinksViewModel,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    val context = LocalContext.current
    var pendingDeleteId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        viewModel.load()
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.SHARE_LINKS.title,
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

        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            ShareLinksFilter.entries.forEach { filter ->
                SettingsChoiceChip(
                    label = filter.label,
                    selected = state.selectedFilter == filter,
                    onClick = { viewModel.selectFilter(filter) },
                )
            }
        }

        state.copiedLinkPreview?.let { (_, link) ->
            SettingsCopyBox(
                label = "最近提取的分享短链",
                value = link.url,
                hint = link.directUrl?.let { "直链：$it" },
                highlightSuccess = true,
                onCopy = { copySettingsText(context, "分享短链", link.url) },
                onShare = { shareSettingsText(context, link.url) },
            )
        }

        val visibleShares = state.filteredShares
        if (!state.isLoading && visibleShares.isEmpty()) {
            SettingsSectionCard {
                Text(
                    text = if (state.shares.isEmpty()) "暂无历史分享记录。" else "当前筛选状态下没有分享记录。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            }
        } else {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                visibleShares.forEach { share ->
                    val status = resolveManagedShareFilter(share)
                    val isActive = status == ShareLinksFilter.ACTIVE
                    val isBusy = share.id in state.busyIds
                    val title = share.sourceName?.takeIf { it.isNotBlank() }
                        ?: if (share.sourceKind == "text") "文本条目" else "文件条目"
                    val viewsText = if (share.maxViews != null) {
                        "${share.views} / ${share.maxViews} 次"
                    } else {
                        "${share.views} 次 · 不限"
                    }
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
                                SettingsStatusPill(
                                    text = status.label,
                                    containerColor = if (isActive) colors.okSoft else colors.surface2,
                                    contentColor = if (isActive) colors.ok else colors.fg3,
                                )
                                Text(
                                    text = title,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = colors.fg,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                            }

                            Text(
                                text = buildString {
                                    share.spaceName?.takeIf { it.isNotBlank() }?.let { append("$it · ") }
                                    append(viewsText)
                                    append(" · 创建于 ${formatSettingsDateTime(share.createdAt)}")
                                    share.expiresAt?.let { append(" · 过期 ${formatSettingsDateTime(it)}") }
                                },
                                style = DropitMonoTypography.meta,
                                color = colors.fg3,
                            )

                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                if (isActive && share.copyStatus != "unavailable") {
                                    TextButton(
                                        onClick = {
                                            viewModel.fetchLink(share.id) { link ->
                                                copySettingsText(context, "分享短链", link.url)
                                            }
                                        },
                                        enabled = !isBusy,
                                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                        colors = ButtonDefaults.textButtonColors(contentColor = colors.brand),
                                    ) {
                                        Icon(Icons.Rounded.ContentCopy, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("复制短链", fontWeight = FontWeight.SemiBold)
                                    }
                                }
                                if (isActive) {
                                    TextButton(
                                        onClick = { viewModel.revoke(share.id) },
                                        enabled = !isBusy,
                                        modifier = Modifier.defaultMinSize(minHeight = 48.dp),
                                        colors = ButtonDefaults.textButtonColors(contentColor = colors.destructive),
                                    ) {
                                        Icon(Icons.Rounded.LinkOff, contentDescription = null, modifier = Modifier.size(16.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("撤销")
                                    }
                                } else {
                                    TextButton(
                                        onClick = { pendingDeleteId = share.id },
                                        enabled = !isBusy,
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
                    }
                }
            }
        }

        if (state.nextCursor != null) {
            OutlinedButton(
                onClick = viewModel::loadMore,
                enabled = !state.isLoadingMore,
                modifier = Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = 48.dp),
                shape = shapes.md,
                border = BorderStroke(1.dp, colors.line2),
            ) {
                if (state.isLoadingMore) {
                    CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = colors.brand)
                    Spacer(Modifier.width(8.dp))
                    Text("加载中…")
                } else {
                    Text("加载更多记录")
                }
            }
        }
    }

    pendingDeleteId?.let { id ->
        SettingsConfirmDialog(
            title = "删除分享记录？",
            message = "删除后此历史分享记录将从列表彻底移除，不可恢复。",
            confirmLabel = "确认删除",
            onConfirm = {
                pendingDeleteId = null
                viewModel.delete(id)
            },
            onDismiss = { pendingDeleteId = null },
        )
    }
}
