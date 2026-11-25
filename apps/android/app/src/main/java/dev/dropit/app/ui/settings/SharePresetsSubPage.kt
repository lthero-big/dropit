package dev.dropit.app.ui.settings

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.auth.AccountCapabilityState
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.data.account.AccountSettingsRepository
import dev.dropit.app.data.account.SharePresets
import dev.dropit.app.ui.share.ShareExpiryUnit
import dev.dropit.app.ui.share.SharePresetHelpers
import dev.dropit.app.ui.theme.DropitTheme
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class SharePresetsUiState(
    val presets: SharePresets = SharePresets(),
    val durationInput: String = "",
    val selectedUnit: ShareExpiryUnit = ShareExpiryUnit.DAYS,
    val viewsInput: String = "",
    val isLoading: Boolean = false,
    val isLoaded: Boolean = false,
    val isSaving: Boolean = false,
    val isDirty: Boolean = false,
    val requiresScopeUpgrade: Boolean = false,
    val errorMessage: String? = null,
    val feedbackMessage: String? = null,
)

class SharePresetsViewModel(
    private val repository: AccountSettingsRepository,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(SharePresetsUiState())
    val uiState: StateFlow<SharePresetsUiState> = _uiState.asStateFlow()

    fun load() {
        _uiState.update { it.copy(isLoading = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val loaded = withContext(ioDispatcher) { repository.getSharePresets() }
                val needsUpgrade = repository.accountCapability.value is AccountCapabilityState.InsufficientScopeForAccountSettings
                _uiState.update {
                    it.copy(
                        presets = loaded,
                        isLoading = false,
                        isLoaded = true,
                        isDirty = false,
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
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加载分享预设失败",
                    )
                }
            }
        }
    }

    fun onDurationInputChanged(value: String) {
        _uiState.update { it.copy(durationInput = value, errorMessage = null, feedbackMessage = null) }
    }

    fun onUnitSelected(unit: ShareExpiryUnit) {
        _uiState.update { it.copy(selectedUnit = unit, errorMessage = null, feedbackMessage = null) }
    }

    fun onViewsInputChanged(value: String) {
        _uiState.update { it.copy(viewsInput = value, errorMessage = null, feedbackMessage = null) }
    }

    fun addExpiry() {
        val state = _uiState.value
        val raw = state.durationInput.trim()
        val unit = state.selectedUnit
        val value = raw.toIntOrNull()
        if (value == null || !raw.all { it.isDigit() } || value < 1 || value > unit.max) {
            _uiState.update { it.copy(errorMessage = "有效期须为 1 到 ${unit.max} 的整数（${unit.label}）") }
            return
        }
        if (SharePresetHelpers.isDuplicateExpiry(state.presets, unit, value)) {
            _uiState.update { it.copy(errorMessage = "已有相同的有效期选项") }
            return
        }
        if (SharePresetHelpers.customExpiries(state.presets).size >= SharePresetHelpers.MAX_CUSTOM_ITEMS) {
            _uiState.update { it.copy(errorMessage = "自定义有效期最多添加 ${SharePresetHelpers.MAX_CUSTOM_ITEMS} 个") }
            return
        }
        val updated = when (unit) {
            ShareExpiryUnit.HOURS -> state.presets.copy(hours = (state.presets.hours + value).distinct().sorted())
            ShareExpiryUnit.DAYS -> state.presets.copy(days = (state.presets.days + value).distinct().sorted())
            ShareExpiryUnit.MONTHS -> state.presets.copy(months = (state.presets.months + value).distinct().sorted())
        }
        _uiState.update {
            it.copy(
                presets = updated,
                durationInput = "",
                isDirty = true,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
    }

    fun removeExpiry(unit: ShareExpiryUnit, value: Int) {
        val state = _uiState.value
        val updated = when (unit) {
            ShareExpiryUnit.HOURS -> state.presets.copy(hours = state.presets.hours.filterNot { it == value })
            ShareExpiryUnit.DAYS -> state.presets.copy(days = state.presets.days.filterNot { it == value })
            ShareExpiryUnit.MONTHS -> state.presets.copy(months = state.presets.months.filterNot { it == value })
        }
        _uiState.update {
            it.copy(
                presets = updated,
                isDirty = true,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
    }

    fun addViews() {
        val state = _uiState.value
        val raw = state.viewsInput.trim()
        val value = raw.toIntOrNull()
        if (value == null || !raw.all { it.isDigit() } || value < 1 || value > SharePresetHelpers.MAX_CUSTOM_VIEWS) {
            _uiState.update { it.copy(errorMessage = "访问次数须为 1 到 ${SharePresetHelpers.MAX_CUSTOM_VIEWS} 的整数") }
            return
        }
        if (SharePresetHelpers.isDuplicateViews(state.presets, value)) {
            _uiState.update { it.copy(errorMessage = "已有相同的访问次数选项") }
            return
        }
        if (state.presets.views.size >= SharePresetHelpers.MAX_CUSTOM_ITEMS) {
            _uiState.update { it.copy(errorMessage = "自定义访问次数最多添加 ${SharePresetHelpers.MAX_CUSTOM_ITEMS} 个") }
            return
        }
        val updated = state.presets.copy(views = (state.presets.views + value).distinct().sorted())
        _uiState.update {
            it.copy(
                presets = updated,
                viewsInput = "",
                isDirty = true,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
    }

    fun removeViews(value: Int) {
        _uiState.update { state ->
            state.copy(
                presets = state.presets.copy(views = state.presets.views.filterNot { it == value }),
                isDirty = true,
                errorMessage = null,
                feedbackMessage = null,
            )
        }
    }

    fun save(onSaved: (SharePresets) -> Unit = {}) {
        val state = _uiState.value
        if (state.isSaving || !state.isLoaded) return
        _uiState.update { it.copy(isSaving = true, errorMessage = null, feedbackMessage = null) }
        viewModelScope.launch {
            try {
                val saved = withContext(ioDispatcher) {
                    repository.saveSharePresets(
                        days = state.presets.days,
                        views = state.presets.views,
                        hours = state.presets.hours,
                        months = state.presets.months,
                    )
                }
                _uiState.update {
                    it.copy(
                        presets = saved,
                        isSaving = false,
                        isDirty = false,
                        requiresScopeUpgrade = false,
                        feedbackMessage = "分享选项已保存并全局同步至 PC / Web",
                    )
                }
                onSaved(saved)
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        requiresScopeUpgrade = e.isInsufficientScope,
                        errorMessage = if (e.isInsufficientScope) null else e.userMessage,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "保存分享选项失败",
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
            return SharePresetsViewModel(
                repository = repository,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SharePresetsSubPage(
    viewModel: SharePresetsViewModel,
    onBack: () -> Unit,
    onReauthenticate: () -> Unit,
    onPresetsSaved: (SharePresets) -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes

    LaunchedEffect(Unit) {
        viewModel.load()
    }

    SettingsSubPageScaffold(
        title = SettingsSubPage.SHARE_PRESETS.title,
        onBack = onBack,
        isLoading = state.isLoading,
        onRefresh = viewModel::load,
    ) {
        if (state.requiresScopeUpgrade) {
            InsufficientScopeUpgradeCard(
                message = "当前登录令牌仅支持读取，保存自定义分享选项需要重新登录（邮箱密码或 GitHub / Google）以升级账户权限。",
                onReauthenticate = onReauthenticate,
            )
        }

        state.feedbackMessage?.let { SettingsBanner(message = it, isError = false) }
        state.errorMessage?.let { SettingsBanner(message = it, isError = true) }

        val customExpiries = SharePresetHelpers.customExpiries(state.presets)

        SettingsSectionCard(
            title = "自定义有效期",
            subtitle = "内置：1 小时、1 天、3 天、7 天、不过期。自定义最多 20 个（最长 3650 天；1 个月按 30 天计算）。",
        ) {
            if (customExpiries.isEmpty()) {
                Text(
                    text = "暂未添加自定义有效期，例如可添加「2 天」。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            } else {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    customExpiries.forEach { item ->
                        RemovablePresetChip(
                            label = item.label,
                            enabled = !state.isSaving && !state.requiresScopeUpgrade,
                            onRemove = { viewModel.removeExpiry(item.unit, item.value) },
                        )
                    }
                }
            }

            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                ShareExpiryUnit.entries.forEach { unit ->
                    SettingsChoiceChip(
                        label = unit.label,
                        selected = state.selectedUnit == unit,
                        enabled = !state.isSaving && !state.requiresScopeUpgrade,
                        onClick = { viewModel.onUnitSelected(unit) },
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.durationInput,
                    onValueChange = viewModel::onDurationInputChanged,
                    modifier = Modifier.weight(1f),
                    enabled = state.isLoaded && !state.isSaving && !state.requiresScopeUpgrade,
                    singleLine = true,
                    label = { Text("数值（${state.selectedUnit.label}）") },
                    placeholder = { Text("例如 2", color = colors.fg4) },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                OutlinedButton(
                    onClick = viewModel::addExpiry,
                    enabled = state.isLoaded && !state.isSaving && !state.requiresScopeUpgrade && state.durationInput.isNotBlank(),
                    modifier = Modifier.defaultMinSize(minHeight = 52.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.line2),
                ) {
                    Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("添加")
                }
            }
        }

        SettingsSectionCard(
            title = "自定义访问次数",
            subtitle = "内置：仅一次、5 次、10 次、不限。自定义 1–1000000 次，最多 20 个。",
        ) {
            if (state.presets.views.isEmpty()) {
                Text(
                    text = "暂未添加自定义访问次数。",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            } else {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.presets.views.forEach { count ->
                        RemovablePresetChip(
                            label = "$count 次",
                            enabled = !state.isSaving && !state.requiresScopeUpgrade,
                            onRemove = { viewModel.removeViews(count) },
                        )
                    }
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = state.viewsInput,
                    onValueChange = viewModel::onViewsInputChanged,
                    modifier = Modifier.weight(1f),
                    enabled = state.isLoaded && !state.isSaving && !state.requiresScopeUpgrade,
                    singleLine = true,
                    label = { Text("次数") },
                    placeholder = { Text("例如 20", color = colors.fg4) },
                    shape = shapes.md,
                    colors = paperTextFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                OutlinedButton(
                    onClick = viewModel::addViews,
                    enabled = state.isLoaded && !state.isSaving && !state.requiresScopeUpgrade && state.viewsInput.isNotBlank(),
                    modifier = Modifier.defaultMinSize(minHeight = 52.dp),
                    shape = shapes.md,
                    border = BorderStroke(1.dp, colors.line2),
                ) {
                    Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("添加")
                }
            }
        }

        Button(
            onClick = { viewModel.save(onPresetsSaved) },
            enabled = state.isLoaded && state.isDirty && !state.isSaving && !state.requiresScopeUpgrade,
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 48.dp),
            shape = shapes.md,
            colors = ButtonDefaults.buttonColors(
                containerColor = colors.brand,
                contentColor = colors.brandFg,
            ),
        ) {
            if (state.isSaving) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = colors.brandFg,
                )
                Spacer(Modifier.width(8.dp))
                Text("正在保存…", fontWeight = FontWeight.SemiBold)
            } else {
                Text(
                    text = if (state.isDirty) "保存并全局同步" else "已是最新配置",
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun RemovablePresetChip(
    label: String,
    enabled: Boolean,
    onRemove: () -> Unit,
) {
    val colors = DropitTheme.colors
    val shapes = DropitTheme.shapes
    Box(
        modifier = Modifier
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .clip(shapes.pill)
            .clickable(enabled = enabled, onClick = onRemove)
            .semantics { contentDescription = "移除 $label" },
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = shapes.pill,
            color = colors.surface0,
            border = BorderStroke(1.dp, colors.line2),
            tonalElevation = 0.dp,
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.fg,
                )
                Icon(
                    imageVector = Icons.Rounded.Close,
                    contentDescription = null,
                    tint = colors.fg3,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}
