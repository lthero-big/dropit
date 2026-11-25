package dev.dropit.app.core.network

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

interface SessionCredentialsProvider {
    suspend fun serverOrigin(): String?
    suspend fun accessToken(): String?
    suspend fun deviceId(): String
    fun deviceName(): String
}

data class SessionExpiredEvent(
    val serverOrigin: String,
    val path: String,
    val timestampMs: Long = System.currentTimeMillis(),
)

/**
 * Core HTTP client for all dropit server APIs.
 * - Enforces https:// server origins (with opt-in test flag for local MockWebServer).
 * - Automatically attaches Authorization: Bearer and X-Dropit-Device* headers.
 * - Maps server error payloads into [ApiError] and emits [sessionExpiredEvents] on HTTP 401.
 */
class DropitApiClient(
    val okHttpClient: OkHttpClient,
    val json: Json = defaultJson(),
    private val credentialsProvider: SessionCredentialsProvider,
    private val allowInsecureHttpForTest: Boolean = false,
) {
    private val _sessionExpiredEvents = MutableSharedFlow<SessionExpiredEvent>(extraBufferCapacity = 8)
    val sessionExpiredEvents: SharedFlow<SessionExpiredEvent> = _sessionExpiredEvents.asSharedFlow()

    suspend fun verifyServer(rawUrl: String): VerifiedServer {
        val normalized = if (allowInsecureHttpForTest && rawUrl.startsWith("http://")) {
            rawUrl.trimEnd('/')
        } else {
            ServerUrl.normalizeServerUrl(rawUrl)
        }
        val versionInfo = getVersion(normalized)
        return VerifiedServer(serverOrigin = normalized, versionInfo = versionInfo)
    }

    suspend fun getVersion(serverOrigin: String): VersionInfo {
        val origin = validateOrigin(serverOrigin)
        val request = buildRequest(
            origin = origin,
            path = "/api/version",
            method = "GET",
            authenticated = false,
        )
        val raw = executeRaw(request, authenticated = false, origin = origin, path = "/api/version")
        if (raw.statusCode != 200) {
            throw ApiError.invalidServer()
        }
        val element = runCatching { json.parseToJsonElement(raw.body) }.getOrNull()
        if (!ServerUrl.isDropitVersionJson(element)) {
            throw ApiError.invalidServer()
        }
        val info = runCatching { json.decodeFromJsonElement<VersionInfo>(element!!) }.getOrNull()
            ?: throw ApiError.invalidServer()
        if (!ServerUrl.isDropitVersion(info)) {
            throw ApiError.invalidServer()
        }
        return info
    }

    suspend fun requestDeviceAuthorization(
        serverOrigin: String,
        deviceName: String,
        scopes: List<String>,
        expiresInDays: Int? = 365,
    ): DeviceAuthorizeResponse {
        val origin = validateOrigin(serverOrigin)
        val body = json.encodeToString(DeviceAuthorizeRequest(name = deviceName, scopes = scopes, expiresInDays = expiresInDays))
        val request = buildRequest(
            origin = origin,
            path = "/api/auth/device/authorize",
            method = "POST",
            jsonBody = body,
            authenticated = false,
        )
        return executeJson(request, authenticated = false, origin = origin, path = "/api/auth/device/authorize", deserializer = DeviceAuthorizeResponse.serializer())
    }

    suspend fun pollDeviceToken(serverOrigin: String, deviceCode: String): RawHttpResponse {
        val origin = validateOrigin(serverOrigin)
        val body = json.encodeToString(DeviceTokenRequest(deviceCode = deviceCode))
        val request = buildRequest(
            origin = origin,
            path = "/api/auth/device/token",
            method = "POST",
            jsonBody = body,
            authenticated = false,
        )
        return executeRaw(request, authenticated = false, origin = origin, path = "/api/auth/device/token")
    }

    suspend fun logout() {
        val origin = requireConfiguredOrigin()
        val request = buildRequest(
            origin = origin,
            path = "/api/auth/logout",
            method = "POST",
            jsonBody = null,
            emptyPostBody = true,
            authenticated = true,
        )
        executeNoContent(request, authenticated = true, origin = origin, path = "/api/auth/logout")
    }

    suspend fun getMe(): MeResponse {
        val origin = requireConfiguredOrigin()
        val request = buildRequest(origin = origin, path = "/api/me", method = "GET", authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = "/api/me", deserializer = MeResponse.serializer())
    }

    suspend fun getSpaces(): List<Space> {
        val origin = requireConfiguredOrigin()
        val request = buildRequest(origin = origin, path = "/api/spaces", method = "GET", authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = "/api/spaces", deserializer = SpacesResponse.serializer()).spaces
    }

    suspend fun getScopeDetails(scope: TargetScope): ScopeDetails {
        val origin = requireConfiguredOrigin()
        val path = scope.apiBasePath
        val request = buildRequest(origin = origin, path = path, method = "GET", authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = ScopeDetails.serializer())
    }

    suspend fun getSnapshot(scope: TargetScope): WsEvent.Snapshot {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/items"
        val request = buildRequest(origin = origin, path = path, method = "GET", authenticated = true)
        val raw = executeRaw(request, authenticated = true, origin = origin, path = path)
        if (raw.statusCode !in 200..299) {
            throw handleHttpError(raw, authenticated = true, origin = origin, path = path)
        }
        val parsed = WsEventParser.parse(raw.body, json)
        return parsed as? WsEvent.Snapshot
            ?: throw ApiError.fromResponse(raw.statusCode, raw.body, raw.retryAfterHeader)
    }

    suspend fun createTextItem(scope: TargetScope, text: String, group: String? = null): ClipItem {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/items/text"
        val payload = buildJsonObject {
            put("text", JsonPrimitive(text))
            if (group != null) put("group", JsonPrimitive(group))
        }
        val request = buildRequest(
            origin = origin,
            path = path,
            method = "POST",
            jsonBody = json.encodeToString(JsonObject.serializer(), payload),
            authenticated = true,
        )
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = ItemResponse.serializer()).item
    }

    suspend fun editTextItem(scope: TargetScope, itemId: String, text: String): ClipItem {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(itemId)}"
        val payload = json.encodeToString(EditTextRequest(text = text))
        val request = buildRequest(
            origin = origin,
            path = path,
            method = "PATCH",
            jsonBody = payload,
            authenticated = true,
        )
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = ItemResponse.serializer()).item
    }

    suspend fun updateItemLabels(
        scope: TargetScope,
        itemId: String,
        pinned: Boolean? = null,
        tags: List<String>? = null,
        group: OptionalField<String?> = OptionalField.Absent,
    ): ClipItem {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(itemId)}/labels"
        val payload = buildJsonObject {
            if (pinned != null) put("pinned", JsonPrimitive(pinned))
            if (tags != null) put("tags", JsonArray(tags.map { JsonPrimitive(it) }))
            if (group is OptionalField.Present) {
                put("group", group.value?.let { JsonPrimitive(it) } ?: JsonNull)
            }
        }
        val request = buildRequest(
            origin = origin,
            path = path,
            method = "PATCH",
            jsonBody = json.encodeToString(JsonObject.serializer(), payload),
            authenticated = true,
        )
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = ItemResponse.serializer()).item
    }

    suspend fun retractItem(scope: TargetScope, itemId: String) {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(itemId)}"
        val request = buildRequest(origin = origin, path = path, method = "DELETE", authenticated = true)
        executeNoContent(request, authenticated = true, origin = origin, path = path)
    }

    suspend fun getGroups(scope: TargetScope): List<String> {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/groups"
        val request = buildRequest(origin = origin, path = path, method = "GET", authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = GroupsResponse.serializer()).groups
    }

    suspend fun createGroup(scope: TargetScope, name: String): List<String> {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/groups"
        val body = json.encodeToString(GroupNameRequest(name = name))
        val request = buildRequest(origin = origin, path = path, method = "POST", jsonBody = body, authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = GroupsResponse.serializer()).groups
    }

    suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/groups/${ServerUrl.encodeURIComponent(oldName)}"
        val body = json.encodeToString(GroupNameRequest(name = newName))
        val request = buildRequest(origin = origin, path = path, method = "PATCH", jsonBody = body, authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = GroupsResponse.serializer()).groups
    }

    suspend fun deleteGroup(scope: TargetScope, name: String): List<String> {
        val origin = requireConfiguredOrigin()
        val path = "${scope.apiBasePath}/groups/${ServerUrl.encodeURIComponent(name)}"
        val request = buildRequest(origin = origin, path = path, method = "DELETE", authenticated = true)
        return executeJson(request, authenticated = true, origin = origin, path = path, deserializer = GroupsResponse.serializer()).groups
    }

    /**
     * Builds an absolute URL against the currently configured server origin (or an explicit override).
     * Exposed for Stage 2A/3A repositories sharing this client.
     */
    suspend fun buildUrl(path: String, serverOriginOverride: String? = null): String {
        val origin = if (serverOriginOverride != null) validateOrigin(serverOriginOverride) else requireConfiguredOrigin()
        val normalizedPath = if (path.startsWith('/')) path else "/$path"
        return "$origin$normalizedPath"
    }

    /**
     * Returns standard device + optional Bearer auth headers for Stage 2A/3A requests (uploads, downloads, Coil, Media3).
     */
    suspend fun currentHeaders(authenticated: Boolean = true): Map<String, String> {
        val headers = LinkedHashMap<String, String>()
        val deviceId = credentialsProvider.deviceId()
        headers.putAll(ServerUrl.deviceHeaders(deviceId, credentialsProvider.deviceName()))
        if (authenticated) {
            val token = credentialsProvider.accessToken()
            if (!token.isNullOrBlank()) {
                headers["Authorization"] = "Bearer $token"
            }
        }
        return headers
    }

    /**
     * Executes a custom request and deserializes its JSON response, handling errors and 401 notifications uniformly.
     */
    suspend fun <T> executeJson(
        request: Request,
        authenticated: Boolean,
        deserializer: DeserializationStrategy<T>,
    ): T {
        val origin = originOf(request.url)
        return executeJson(request, authenticated, origin, request.url.encodedPath, deserializer)
    }

    suspend fun executeNoContent(request: Request, authenticated: Boolean) {
        val origin = originOf(request.url)
        executeNoContent(request, authenticated, origin, request.url.encodedPath)
    }

    internal fun originOf(url: HttpUrl): String {
        val hostPart = if (url.host.contains(':')) "[${url.host}]" else url.host
        val isDefaultPort = (url.scheme == "https" && url.port == 443) || (url.scheme == "http" && url.port == 80)
        val portPart = if (isDefaultPort) "" else ":${url.port}"
        return "${url.scheme}://$hostPart$portPart"
    }

    fun emitSessionExpiredIf401(statusCode: Int, serverOrigin: String, path: String) {
        if (statusCode == 401) {
            _sessionExpiredEvents.tryEmit(SessionExpiredEvent(serverOrigin = serverOrigin, path = path))
        }
    }

    private suspend fun <T> executeJson(
        request: Request,
        authenticated: Boolean,
        origin: String,
        path: String,
        deserializer: DeserializationStrategy<T>,
    ): T {
        val raw = executeRaw(request, authenticated = authenticated, origin = origin, path = path)
        if (raw.statusCode !in 200..299) {
            throw handleHttpError(raw, authenticated = authenticated, origin = origin, path = path)
        }
        return try {
            json.decodeFromString(deserializer, raw.body)
        } catch (e: Exception) {
            throw ApiError(
                errorCode = ApiErrorCode.UNKNOWN,
                rawCode = "DECODE_ERROR",
                httpStatus = raw.statusCode,
                userMessage = "服务器返回数据解析失败",
                cause = e,
            )
        }
    }

    private suspend fun executeNoContent(
        request: Request,
        authenticated: Boolean,
        origin: String,
        path: String,
    ) {
        val raw = executeRaw(request, authenticated = authenticated, origin = origin, path = path)
        if (raw.statusCode !in 200..299) {
            throw handleHttpError(raw, authenticated = authenticated, origin = origin, path = path)
        }
    }

    private fun handleHttpError(
        raw: RawHttpResponse,
        authenticated: Boolean,
        origin: String,
        path: String,
    ): ApiError {
        if (authenticated && raw.statusCode == 401) {
            emitSessionExpiredIf401(raw.statusCode, origin, path)
        }
        return ApiError.fromResponse(raw.statusCode, raw.body, raw.retryAfterHeader)
    }

    private suspend fun requireConfiguredOrigin(): String {
        val origin = credentialsProvider.serverOrigin()
            ?: throw ApiError.notConfigured()
        return validateOrigin(origin)
    }

    private fun validateOrigin(origin: String): String {
        if (allowInsecureHttpForTest && origin.startsWith("http://")) {
            return origin.trimEnd('/')
        }
        return try {
            ServerUrl.normalizeServerUrl(origin)
        } catch (e: ServerUrlException) {
            throw ApiError.invalidServer(e.message ?: ApiErrorCode.INVALID_SERVER.defaultMessage)
        }
    }

    private suspend fun buildRequest(
        origin: String,
        path: String,
        method: String,
        jsonBody: String? = null,
        emptyPostBody: Boolean = false,
        authenticated: Boolean = true,
    ): Request {
        val url = "$origin${if (path.startsWith('/')) path else "/$path"}"
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")

        for ((k, v) in currentHeaders(authenticated = authenticated)) {
            builder.header(k, v)
        }

        val body: RequestBody? = when {
            jsonBody != null -> jsonBody.toRequestBody(JSON_MEDIA_TYPE)
            emptyPostBody -> EMPTY_BODY
            method == "POST" || method == "PUT" || method == "PATCH" -> EMPTY_BODY
            else -> null
        }
        builder.method(method, body)
        return builder.build()
    }

    private suspend fun executeRaw(
        request: Request,
        authenticated: Boolean,
        origin: String,
        path: String,
    ): RawHttpResponse {
        val call = okHttpClient.newCall(request)
        return try {
            suspendCancellableCoroutine { cont ->
                cont.invokeOnCancellation { call.cancel() }
                call.enqueue(object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (cont.isActive) cont.resumeWithException(ApiError.network(e))
                    }

                    override fun onResponse(call: Call, response: Response) {
                        response.use { res ->
                            val bodyStr = runCatching { res.body?.string().orEmpty() }.getOrDefault("")
                            val raw = RawHttpResponse(
                                statusCode = res.code,
                                body = bodyStr,
                                retryAfterHeader = res.header("Retry-After"),
                            )
                            if (cont.isActive) cont.resume(raw)
                        }
                    }
                })
            }
        } catch (e: ApiError) {
            throw e
        } catch (e: IOException) {
            throw ApiError.network(e)
        }
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val EMPTY_BODY = ByteArray(0).toRequestBody(null)

        fun defaultJson(): Json = Json {
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
        }
    }
}
