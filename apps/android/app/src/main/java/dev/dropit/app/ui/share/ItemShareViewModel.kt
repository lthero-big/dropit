package dev.dropit.app.ui.share

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.ItemShareRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class ShareLinkState(val label: String) {
    ACTIVE("有效"),
    REVOKED("已撤销"),
    EXPIRED("已过期"),
    EXHAUSTED("已用尽"),
}

data class ShareExpiryOption(
    val value: String,
    val label: String,
)

data class ShareViewsOption(
    val value: Int?,
    val label: String,
)

data class ItemShareUiState(
    val scope: TargetScope? = null,
    val item: ClipItem? = null,
    val selectedExpiresIn: String = "1d",
    val selectedMaxViews: Int? = 1,
    val isLoadingList: Boolean = false,
    val isCreating: Boolean = false,
    val revokingIds: Set<String> = emptySet(),
    val latestCreatedShare: ItemShare? = null,
    val shares: List<ItemShare> = emptyList(),
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
)

class ItemShareViewModel(
    private val itemShareRepository: ItemShareRepository,
    private val serverOriginProvider: () -> String,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(ItemShareUiState())
    val uiState: StateFlow<ItemShareUiState> = _uiState.asStateFlow()

    private var loadJob: Job? = null

    fun openForItem(scope: TargetScope, item: ClipItem) {
        loadJob?.cancel()
        _uiState.value = ItemShareUiState(
            scope = scope,
            item = item,
            isLoadingList = true,
        )
        loadJob = viewModelScope.launch {
            try {
                val shares = withContext(ioDispatcher) {
                    itemShareRepository.listShares(scope, item.id)
                }
                _uiState.update { current ->
                    if (current.item?.id != item.id) {
                        current
                    } else {
                        current.copy(
                            isLoadingList = false,
                            shares = shares,
                            errorMessage = null,
                        )
                    }
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isLoadingList = false,
                        errorMessage = e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isLoadingList = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载分享列表失败",
                    )
                }
            }
        }
    }

    fun close() {
        loadJob?.cancel()
        _uiState.value = ItemShareUiState()
    }

    fun selectExpiresIn(value: String) {
        _uiState.update { it.copy(selectedExpiresIn = value, errorMessage = null) }
    }

    fun selectMaxViews(value: Int?) {
        _uiState.update { it.copy(selectedMaxViews = value, errorMessage = null) }
    }

    fun createShare() {
        val current = _uiState.value
        val scope = current.scope ?: return
        val item = current.item ?: return
        if (current.isCreating) return

        _uiState.update { it.copy(isCreating = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val created = withContext(ioDispatcher) {
                    itemShareRepository.createShare(
                        scope = scope,
                        itemId = item.id,
                        expiresIn = current.selectedExpiresIn,
                        maxViews = current.selectedMaxViews,
                    )
                }
                _uiState.update { state ->
                    val merged = listOf(created) + state.shares.filterNot { it.id == created.id }
                    state.copy(
                        isCreating = false,
                        latestCreatedShare = created,
                        shares = merged,
                        feedbackMessage = "分享链接已生成，请及时复制",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        errorMessage = e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isCreating = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "创建分享链接失败",
                    )
                }
            }
        }
    }

    fun revokeShare(shareId: String) {
        val current = _uiState.value
        val scope = current.scope ?: return
        if (shareId in current.revokingIds) return

        _uiState.update {
            it.copy(
                revokingIds = it.revokingIds + shareId,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
        viewModelScope.launch {
            try {
                withContext(ioDispatcher) {
                    itemShareRepository.revokeShare(scope, shareId)
                }
                _uiState.update { state ->
                    state.copy(
                        revokingIds = state.revokingIds - shareId,
                        shares = state.shares.map { s -> if (s.id == shareId) s.copy(revoked = 1) else s },
                        latestCreatedShare = state.latestCreatedShare?.takeUnless { it.id == shareId },
                        feedbackMessage = "已撤销分享链接",
                    )
                }
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        revokingIds = it.revokingIds - shareId,
                        errorMessage = e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        revokingIds = it.revokingIds - shareId,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "撤销分享链接失败",
                    )
                }
            }
        }
    }

    fun clearFeedback() {
        _uiState.update { it.copy(feedbackMessage = null) }
    }

    fun resolveSharePageUrl(share: ItemShare): String? =
        resolveShareUrl(
            serverOrigin = serverOriginProvider(),
            rawUrl = share.url,
            fallbackPrefix = "/s/",
            token = share.token,
        )

    fun resolveDirectDownloadUrl(share: ItemShare): String? =
        resolveShareUrl(
            serverOrigin = serverOriginProvider(),
            rawUrl = share.directUrl,
            fallbackPrefix = "/d/",
            token = if (_uiState.value.item?.isFile == true) share.token else null,
        )

    fun sharePresetsSettingsUrl(): String =
        "${serverOriginProvider().trimEnd('/')}/settings?tab=share-presets"

    companion object {
        val EXPIRY_OPTIONS: List<ShareExpiryOption> = listOf(
            ShareExpiryOption("1h", "1 小时"),
            ShareExpiryOption("1d", "1 天"),
            ShareExpiryOption("3d", "3 天"),
            ShareExpiryOption("7d", "7 天"),
            ShareExpiryOption("never", "不过期"),
        )

        val MAX_VIEWS_OPTIONS: List<ShareViewsOption> = listOf(
            ShareViewsOption(1, "仅一次"),
            ShareViewsOption(5, "5 次"),
            ShareViewsOption(10, "10 次"),
            ShareViewsOption(null, "不限"),
        )

        fun resolveShareState(share: ItemShare, nowMs: Long = System.currentTimeMillis()): ShareLinkState = when {
            share.revoked != 0 -> ShareLinkState.REVOKED
            share.expiresAt != null && share.expiresAt <= nowMs -> ShareLinkState.EXPIRED
            share.maxViews != null && share.views >= share.maxViews -> ShareLinkState.EXHAUSTED
            else -> ShareLinkState.ACTIVE
        }

        fun resolveShareUrl(
            serverOrigin: String,
            rawUrl: String?,
            fallbackPrefix: String,
            token: String?,
        ): String? {
            val cleanOrigin = serverOrigin.trimEnd('/')
            val trimmed = rawUrl?.trim().orEmpty()
            if (trimmed.startsWith("https://", ignoreCase = true) || trimmed.startsWith("http://", ignoreCase = true)) {
                return trimmed
            }
            if (trimmed.startsWith("/")) {
                return if (cleanOrigin.isNotEmpty()) "$cleanOrigin$trimmed" else trimmed
            }
            val cleanToken = token?.trim().orEmpty()
            if (cleanToken.isNotEmpty()) {
                return if (cleanOrigin.isNotEmpty()) "$cleanOrigin$fallbackPrefix$cleanToken" else "$fallbackPrefix$cleanToken"
            }
            return null
        }
    }

    class Factory(
        private val itemShareRepository: ItemShareRepository,
        private val serverOriginProvider: () -> String,
        private val onSessionExpired: () -> Unit,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return ItemShareViewModel(
                itemShareRepository = itemShareRepository,
                serverOriginProvider = serverOriginProvider,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}
