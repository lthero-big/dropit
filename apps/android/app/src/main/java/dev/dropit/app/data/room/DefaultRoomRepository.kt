package dev.dropit.app.data.room

import dev.dropit.app.core.auth.SettingsStore
import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.RoomInfo
import dev.dropit.app.core.network.ScopeDetails
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.RoomRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Concrete implementation of [RoomRepository] backed by dropit's temporary room APIs:
 * - `POST /api/rooms` (create or reuse the live room bound to this server-scoped `deviceKey`)
 * - `POST /api/rooms/enter` (enter by room code + optional PIN without triggering 401 logout on `PIN_REQUIRED`)
 * - `PUT /api/rooms/:room/code` (owner-only code / PIN update, preserving existing `token` & `expiresAt`)
 */
class DefaultRoomRepository(
    private val apiClient: DropitApiClient,
    private val roomKeyStore: RoomKeyStore,
    private val settingsStore: SettingsStore,
) : RoomRepository {

    @Serializable
    private data class UpdateRoomCodeResponse(
        val code: String? = null,
        val hasPin: Boolean = false,
        val url: String? = null,
    )

    private val _activeRoom = MutableStateFlow<RoomInfo?>(null)
    override val activeRoom: StateFlow<RoomInfo?> = _activeRoom.asStateFlow()

    override suspend fun createOrReuseRoom(code: String?, pin: String?): RoomInfo {
        val url = apiClient.buildUrl(PATH_ROOMS)
        val origin = extractOriginFromUrl(url)
        val deviceKey = roomKeyStore.getOrCreateDeviceKey(origin)

        val payload = buildJsonObject {
            put("deviceKey", JsonPrimitive(deviceKey))
            val trimmedCode = code?.trim()
            if (!trimmedCode.isNullOrEmpty()) {
                put("code", JsonPrimitive(trimmedCode))
            }
            if (!pin.isNullOrEmpty()) {
                put("pin", JsonPrimitive(pin))
            }
        }

        val request = buildJsonRequest(
            url = url,
            method = "POST",
            payload = payload,
        )

        val response = try {
            apiClient.executeJson(
                request = request,
                authenticated = true,
                deserializer = RoomInfo.serializer(),
            )
        } catch (e: ApiError) {
            throw mapRoomError(e, isCodeUpdate = false)
        }

        val normalized = normalizeRoomInfo(origin, response)
        if (normalized.token.isNotBlank()) {
            roomKeyStore.saveOwnedRoomToken(origin, normalized.token)
            if (!normalized.code.isNullOrBlank()) {
                roomKeyStore.rememberRoomAccess(origin, normalized.code, normalized.token)
            }
        }
        _activeRoom.value = normalized
        return normalized
    }

    override suspend fun enterRoom(code: String, pin: String?): RoomInfo {
        val trimmedCode = code.trim()
        if (trimmedCode.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_CODE,
                rawCode = "INVALID_CODE",
                httpStatus = 400,
                userMessage = "请输入房间码",
            )
        }

        val url = apiClient.buildUrl(PATH_ROOMS_ENTER)
        val origin = extractOriginFromUrl(url)

        val payload = buildJsonObject {
            put("code", JsonPrimitive(trimmedCode))
            if (!pin.isNullOrEmpty()) {
                put("pin", JsonPrimitive(pin))
            }
        }

        val request = buildJsonRequest(
            url = url,
            method = "POST",
            payload = payload,
        )

        // Execute with authenticated = false in DropitApiClient so HTTP 401 PIN_REQUIRED
        // does NOT emit global session expiration. If the server actually returned 401
        // UNAUTHENTICATED (revoked Bearer token), emit sessionExpiredEvents explicitly below.
        val response = try {
            apiClient.executeJson(
                request = request,
                authenticated = false,
                deserializer = RoomInfo.serializer(),
            )
        } catch (e: ApiError) {
            if (e.httpStatus == 401 && e.errorCode != ApiErrorCode.PIN_REQUIRED) {
                apiClient.emitSessionExpiredIf401(401, origin, PATH_ROOMS_ENTER)
                throw e
            }
            throw mapRoomError(e, isCodeUpdate = false)
        }

        val normalized = normalizeRoomInfo(origin, response)
        if (normalized.token.isNotBlank() && !normalized.code.isNullOrBlank()) {
            roomKeyStore.rememberRoomAccess(origin, normalized.code, normalized.token)
        }
        _activeRoom.value = normalized
        return normalized
    }

    override suspend fun updateRoomCode(
        roomToken: String,
        code: OptionalField<String?>,
        pin: OptionalField<String?>,
    ): RoomInfo {
        val trimmedToken = roomToken.trim()
        if (trimmedToken.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "房间令牌无效",
            )
        }
        if (code is OptionalField.Absent && pin is OptionalField.Absent) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "请至少修改房间码或 PIN",
            )
        }

        val path = "/api/rooms/${ServerUrl.encodeURIComponent(trimmedToken)}/code"
        val url = apiClient.buildUrl(path)
        val origin = extractOriginFromUrl(url)
        val deviceKey = roomKeyStore.getOrCreateDeviceKey(origin)

        val payload = buildJsonObject {
            put("deviceKey", JsonPrimitive(deviceKey))
            if (code is OptionalField.Present) {
                val cleanedCode = code.value?.trim()
                if (cleanedCode.isNullOrEmpty()) {
                    put("code", JsonNull)
                } else {
                    put("code", JsonPrimitive(cleanedCode))
                }
            }
            if (pin is OptionalField.Present) {
                val rawPin = pin.value
                if (rawPin.isNullOrEmpty()) {
                    put("pin", JsonNull)
                } else {
                    put("pin", JsonPrimitive(rawPin))
                }
            }
        }

        val request = buildJsonRequest(
            url = url,
            method = "PUT",
            payload = payload,
        )

        val updated = try {
            apiClient.executeJson(
                request = request,
                authenticated = true,
                deserializer = UpdateRoomCodeResponse.serializer(),
            )
        } catch (e: ApiError) {
            throw mapRoomError(e, isCodeUpdate = true)
        }

        val previous = _activeRoom.value?.takeIf { it.token == trimmedToken }
        val previousCode = previous?.code
        val merged = RoomInfo(
            token = trimmedToken,
            code = updated.code ?: previousCode,
            hasPin = updated.hasPin,
            expiresAt = previous?.expiresAt ?: 0L,
            url = resolveRoomUrl(origin, updated.url, updated.code ?: previousCode),
            reused = previous?.reused ?: false,
        )

        if (!previousCode.isNullOrBlank() && previousCode != merged.code) {
            roomKeyStore.forgetRoomAccess(origin, previousCode)
        }
        if (!merged.code.isNullOrBlank()) {
            roomKeyStore.rememberRoomAccess(origin, merged.code, trimmedToken)
        }
        if (_activeRoom.value == null || _activeRoom.value?.token == trimmedToken) {
            _activeRoom.value = merged
        }
        return merged
    }

    override suspend fun leaveCurrentRoom() {
        _activeRoom.value = null
    }

    override suspend fun clearRoomState() {
        _activeRoom.value = null
        roomKeyStore.clearAll()
    }

    /**
     * Fetches live metadata (`GET /api/rooms/:room`) for an active room token and maps
     * expiration / closed errors clearly.
     */
    suspend fun fetchRoomDetails(roomToken: String): ScopeDetails {
        return try {
            apiClient.getScopeDetails(TargetScope.RoomScope(roomToken))
        } catch (e: ApiError) {
            throw mapRoomError(e, isCodeUpdate = false)
        }
    }

    /**
     * Returns whether this device created/reused [roomToken] on the currently configured server.
     */
    suspend fun isOwnedRoom(roomToken: String): Boolean {
        val origin = settingsStore.getServerOrigin()?.takeIf { it.isNotBlank() } ?: return false
        return roomKeyStore.getOwnedRoomToken(origin) == roomToken
    }

    /**
     * Convenience scope helper for switching board/transfer/realtime seamlessly onto `/api/rooms/:room/...`.
     */
    fun activeRoomScope(): TargetScope.RoomScope? =
        _activeRoom.value?.token?.takeIf { it.isNotBlank() }?.let { TargetScope.RoomScope(it) }

    private suspend fun buildJsonRequest(
        url: String,
        method: String,
        payload: JsonObject,
    ): Request {
        val bodyStr = apiClient.json.encodeToString(JsonObject.serializer(), payload)
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .method(method, bodyStr.toRequestBody(JSON_MEDIA_TYPE))

        for ((k, v) in apiClient.currentHeaders(authenticated = true)) {
            builder.header(k, v)
        }
        return builder.build()
    }

    private fun extractOriginFromUrl(url: String): String {
        val schemeIdx = url.indexOf("://")
        if (schemeIdx < 0) return url.trimEnd('/')
        val pathIdx = url.indexOf('/', startIndex = schemeIdx + 3)
        return if (pathIdx < 0) url else url.substring(0, pathIdx)
    }

    private fun normalizeRoomInfo(origin: String, room: RoomInfo): RoomInfo =
        room.copy(url = resolveRoomUrl(origin, room.url, room.code))

    companion object {
        private const val PATH_ROOMS = "/api/rooms"
        private const val PATH_ROOMS_ENTER = "/api/rooms/enter"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /**
         * Resolves a room URL returned by the server into an absolute URL against [origin].
         * Handles absolute URLs (`https://...`), relative paths (`/r/<code>`), or missing URLs.
         */
        fun resolveRoomUrl(origin: String, rawUrl: String?, code: String?): String {
            val cleanOrigin = origin.trimEnd('/')
            val trimmedUrl = rawUrl?.trim().orEmpty()
            return when {
                trimmedUrl.startsWith("https://", ignoreCase = true) ||
                    trimmedUrl.startsWith("http://", ignoreCase = true) -> trimmedUrl
                trimmedUrl.startsWith("/") -> "$cleanOrigin$trimmedUrl"
                trimmedUrl.isNotEmpty() -> "$cleanOrigin/$trimmedUrl"
                !code.isNullOrBlank() -> "$cleanOrigin/r/${ServerUrl.encodeURIComponent(code.trim())}"
                else -> ""
            }
        }

        /**
         * Maps temporary room HTTP/API errors into clear, actionable room messages while preserving
         * [ApiError.errorCode], [ApiError.rawCode], [ApiError.httpStatus], and [ApiError.retryAfterSeconds].
         */
        fun mapRoomError(error: ApiError, isCodeUpdate: Boolean): ApiError {
            val message = when (error.errorCode) {
                ApiErrorCode.PIN_REQUIRED -> "该房间已设 PIN，请输入房间 PIN"
                ApiErrorCode.PIN_INVALID -> "房间 PIN 不正确，请重新输入"
                ApiErrorCode.NOT_FOUND -> "临时房间不存在、已过期或已关闭"
                ApiErrorCode.FORBIDDEN -> if (isCodeUpdate) {
                    "仅房间创建设备可修改房间码或 PIN"
                } else {
                    error.userMessage
                }
                ApiErrorCode.CODE_TAKEN -> "该房间码已被占用，请更换其他房间码"
                ApiErrorCode.INVALID_CODE -> if (isCodeUpdate) {
                    "修改房间码需为 6 位字母或数字（区分大小写）"
                } else {
                    "房间码格式不正确（支持 3–32 位字母、数字、- 或 _）"
                }
                ApiErrorCode.INVALID_PIN -> "PIN 长度需为 4–32 位，且不能包含控制字符"
                ApiErrorCode.RATE_LIMITED -> {
                    val wait = error.retryAfterSeconds
                    if (wait != null && wait > 0L) {
                        "尝试次数过多，房间已临时锁定，请 ${wait} 秒后再试"
                    } else {
                        "尝试次数过多，房间已临时锁定，请稍后再试"
                    }
                }
                else -> return error
            }
            return ApiError(
                errorCode = error.errorCode,
                rawCode = error.rawCode,
                httpStatus = error.httpStatus,
                userMessage = message,
                retryAfterSeconds = error.retryAfterSeconds,
                details = error.details,
                cause = error.cause,
            )
        }
    }
}
