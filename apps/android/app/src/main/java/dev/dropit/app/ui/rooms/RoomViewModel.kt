package dev.dropit.app.ui.rooms

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.repository.RoomRepository
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

object RoomValidation {
    const val PIN_MIN_LENGTH = 4
    const val PIN_MAX_LENGTH = 32
    val CREATE_CODE_REGEX = Regex("^[A-Za-z0-9_-]{3,32}$")
    val CHANGE_CODE_REGEX = Regex("^[A-Za-z0-9]{6}$")

    fun validateCreateCode(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null // optional when creating
        if (!CREATE_CODE_REGEX.matches(trimmed)) {
            return "自定义房间码需为 3–32 位字母、数字、- 或 _"
        }
        return null
    }

    fun validateChangeCode(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return "请输入 6 位新房间码"
        if (!CHANGE_CODE_REGEX.matches(trimmed)) {
            return if (trimmed.length < 6) {
                "还差 ${6 - trimmed.length} 位：房间码需要正好 6 位字母或数字"
            } else {
                "修改后的房间码需为正好 6 位字母或数字（区分大小写）"
            }
        }
        return null
    }

    fun validatePin(raw: String, required: Boolean = false): String? {
        if (raw.isEmpty()) return if (required) "请输入房间 PIN" else null
        if (raw.length < PIN_MIN_LENGTH || raw.length > PIN_MAX_LENGTH) {
            return "PIN 长度需为 $PIN_MIN_LENGTH–$PIN_MAX_LENGTH 位"
        }
        if (raw.any { it.isISOControl() }) {
            return "PIN 不能包含控制字符"
        }
        return null
    }

    fun resolveRoomShareUrl(serverOrigin: String, room: RoomInfo): String {
        val cleanOrigin = serverOrigin.trimEnd('/')
        val rawUrl = room.url.trim()
        if (rawUrl.startsWith("https://", ignoreCase = true) || rawUrl.startsWith("http://", ignoreCase = true)) {
            return rawUrl
        }
        if (rawUrl.startsWith("/")) {
            return if (cleanOrigin.isNotEmpty()) "$cleanOrigin$rawUrl" else rawUrl
        }
        val code = room.code?.trim().orEmpty()
        if (code.isNotEmpty()) {
            return if (cleanOrigin.isNotEmpty()) "$cleanOrigin/r/$code" else "/r/$code"
        }
        return cleanOrigin
    }
}

data class RoomUiState(
    val activeRoom: RoomInfo? = null,
    val isOwner: Boolean = false,
    val isSubmitting: Boolean = false,
    val requiresPinForJoin: Boolean = false,
    val rateLimitRetryAfterSeconds: Long? = null,
    val errorMessage: String? = null,
    val successMessage: String? = null,
)

class RoomViewModel(
    private val roomRepository: RoomRepository,
    private val serverOriginProvider: () -> String,
    private val onSessionExpired: () -> Unit = {},
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val _uiState = MutableStateFlow(RoomUiState())
    val uiState: StateFlow<RoomUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            roomRepository.activeRoom.collect { room ->
                _uiState.update { current ->
                    current.copy(
                        activeRoom = room,
                        isOwner = if (room == null) false else current.isOwner,
                    )
                }
            }
        }
    }

    fun clearDialogFeedback() {
        _uiState.update {
            it.copy(
                errorMessage = null,
                successMessage = null,
                requiresPinForJoin = false,
                rateLimitRetryAfterSeconds = null,
            )
        }
    }

    fun createOrReuseRoom(
        customCode: String? = null,
        pin: String? = null,
        onEntered: (RoomInfo) -> Unit = {},
    ) {
        if (_uiState.value.isSubmitting) return
        val cleanCode = customCode?.trim()?.takeIf { it.isNotEmpty() }
        val cleanPin = pin?.takeIf { it.isNotEmpty() }

        cleanCode?.let { code ->
            RoomValidation.validateCreateCode(code)?.let { err ->
                _uiState.update { it.copy(errorMessage = err) }
                return
            }
        }
        cleanPin?.let { p ->
            RoomValidation.validatePin(p, required = false)?.let { err ->
                _uiState.update { it.copy(errorMessage = err) }
                return
            }
        }

        _uiState.update {
            it.copy(
                isSubmitting = true,
                errorMessage = null,
                successMessage = null,
                rateLimitRetryAfterSeconds = null,
            )
        }
        viewModelScope.launch {
            try {
                val room = withContext(ioDispatcher) {
                    roomRepository.createOrReuseRoom(code = cleanCode, pin = cleanPin)
                }
                _uiState.update {
                    it.copy(
                        activeRoom = room,
                        isOwner = true,
                        isSubmitting = false,
                        errorMessage = null,
                        successMessage = if (room.reused) "已回到你的临时房间" else "已创建临时房间",
                    )
                }
                onEntered(room)
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isSubmitting = false,
                        rateLimitRetryAfterSeconds = e.retryAfterSeconds,
                        errorMessage = mapRoomApiError(e),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSubmitting = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "创建临时房间失败，请重试",
                    )
                }
            }
        }
    }

    fun enterRoom(
        rawCode: String,
        rawPin: String? = null,
        onEntered: (RoomInfo) -> Unit = {},
    ) {
        if (_uiState.value.isSubmitting) return
        val code = rawCode.trim()
        if (code.isEmpty()) {
            _uiState.update { it.copy(errorMessage = "请输入房间码") }
            return
        }
        val pin = rawPin?.takeIf { it.isNotEmpty() }
        if (_uiState.value.requiresPinForJoin && pin == null) {
            _uiState.update { it.copy(errorMessage = "该房间需要输入 PIN") }
            return
        }

        _uiState.update {
            it.copy(
                isSubmitting = true,
                errorMessage = null,
                successMessage = null,
                rateLimitRetryAfterSeconds = null,
            )
        }
        viewModelScope.launch {
            try {
                val room = withContext(ioDispatcher) {
                    roomRepository.enterRoom(code = code, pin = pin)
                }
                _uiState.update {
                    it.copy(
                        activeRoom = room,
                        isOwner = false,
                        isSubmitting = false,
                        requiresPinForJoin = false,
                        errorMessage = null,
                        successMessage = "已加入临时房间",
                    )
                }
                onEntered(room)
            } catch (e: ApiError) {
                val needsPin = e.errorCode == ApiErrorCode.PIN_REQUIRED || e.errorCode == ApiErrorCode.PIN_INVALID
                if (e.isUnauthorized && !needsPin) {
                    onSessionExpired()
                }
                _uiState.update { current ->
                    current.copy(
                        isSubmitting = false,
                        requiresPinForJoin = if (needsPin) true else current.requiresPinForJoin,
                        rateLimitRetryAfterSeconds = e.retryAfterSeconds,
                        errorMessage = mapRoomApiError(e),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSubmitting = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "加入临时房间失败",
                    )
                }
            }
        }
    }

    fun updateCustomCode(
        newCode: String,
        onUpdated: (RoomInfo) -> Unit = {},
    ) {
        val room = _uiState.value.activeRoom ?: return
        if (_uiState.value.isSubmitting) return
        val trimmed = newCode.trim()
        val validationError = RoomValidation.validateChangeCode(trimmed)
        if (validationError != null) {
            _uiState.update { it.copy(errorMessage = validationError) }
            return
        }
        performUpdateRoomCode(
            roomToken = room.token,
            code = OptionalField.Present(trimmed),
            pin = OptionalField.Absent,
            successMsg = "房间码已更新，旧房间码和旧链接已失效",
            onUpdated = onUpdated,
        )
    }

    fun randomizeCode(onUpdated: (RoomInfo) -> Unit = {}) {
        val room = _uiState.value.activeRoom ?: return
        if (_uiState.value.isSubmitting) return
        performUpdateRoomCode(
            roomToken = room.token,
            code = OptionalField.Present(null),
            pin = OptionalField.Absent,
            successMsg = "已生成新的随机房间码，旧房间码已失效",
            onUpdated = onUpdated,
        )
    }

    fun updatePin(
        newPin: String,
        onUpdated: (RoomInfo) -> Unit = {},
    ) {
        val room = _uiState.value.activeRoom ?: return
        if (_uiState.value.isSubmitting) return
        val validationError = RoomValidation.validatePin(newPin, required = true)
        if (validationError != null) {
            _uiState.update { it.copy(errorMessage = validationError) }
            return
        }
        performUpdateRoomCode(
            roomToken = room.token,
            code = OptionalField.Absent,
            pin = OptionalField.Present(newPin),
            successMsg = if (room.hasPin) "房间 PIN 已更新" else "房间 PIN 已设置",
            onUpdated = onUpdated,
        )
    }

    fun removePin(onUpdated: (RoomInfo) -> Unit = {}) {
        val room = _uiState.value.activeRoom ?: return
        if (_uiState.value.isSubmitting) return
        performUpdateRoomCode(
            roomToken = room.token,
            code = OptionalField.Absent,
            pin = OptionalField.Present(null),
            successMsg = "已移除房间 PIN",
            onUpdated = onUpdated,
        )
    }

    fun leaveRoom(onLeft: () -> Unit = {}) {
        viewModelScope.launch {
            withContext(ioDispatcher) {
                roomRepository.leaveCurrentRoom()
            }
            _uiState.update {
                it.copy(
                    activeRoom = null,
                    isOwner = false,
                    errorMessage = null,
                    successMessage = null,
                )
            }
            onLeft()
        }
    }

    fun shareUrlFor(room: RoomInfo): String =
        RoomValidation.resolveRoomShareUrl(serverOriginProvider(), room)

    private fun performUpdateRoomCode(
        roomToken: String,
        code: OptionalField<String?>,
        pin: OptionalField<String?>,
        successMsg: String,
        onUpdated: (RoomInfo) -> Unit,
    ) {
        _uiState.update {
            it.copy(
                isSubmitting = true,
                errorMessage = null,
                successMessage = null,
            )
        }
        viewModelScope.launch {
            try {
                val updated = withContext(ioDispatcher) {
                    roomRepository.updateRoomCode(roomToken = roomToken, code = code, pin = pin)
                }
                _uiState.update {
                    it.copy(
                        activeRoom = updated,
                        isSubmitting = false,
                        errorMessage = null,
                        successMessage = successMsg,
                    )
                }
                onUpdated(updated)
            } catch (e: ApiError) {
                if (e.isUnauthorized) onSessionExpired()
                _uiState.update {
                    it.copy(
                        isSubmitting = false,
                        errorMessage = mapRoomApiError(e),
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isSubmitting = false,
                        errorMessage = e.message?.takeIf { m -> m.isNotBlank() } ?: "修改房间设置失败",
                    )
                }
            }
        }
    }

    private fun mapRoomApiError(error: ApiError): String = when (error.errorCode) {
        ApiErrorCode.PIN_REQUIRED -> "该房间已设置 PIN，请输入 PIN 后进入"
        ApiErrorCode.PIN_INVALID -> "房间 PIN 不正确，请重新输入"
        ApiErrorCode.NOT_FOUND -> "房间不存在或已过期（注意房间码区分大小写）"
        ApiErrorCode.CODE_TAKEN -> "这个房间码已被占用，请换一个"
        ApiErrorCode.INVALID_CODE -> "房间码格式不正确"
        ApiErrorCode.INVALID_PIN -> "PIN 长度需为 4–32 位"
        ApiErrorCode.RATE_LIMITED -> {
            val sec = error.retryAfterSeconds
            if (sec != null && sec > 0L) "操作过于频繁，请 $sec 秒后再试" else "操作过于频繁，请稍后再试"
        }
        else -> error.userMessage
    }

    class Factory(
        private val roomRepository: RoomRepository,
        private val serverOriginProvider: () -> String,
        private val onSessionExpired: () -> Unit,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            return RoomViewModel(
                roomRepository = roomRepository,
                serverOriginProvider = serverOriginProvider,
                onSessionExpired = onSessionExpired,
            ) as T
        }
    }
}
