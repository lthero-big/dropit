package dev.dropit.app.data.itemshare

import dev.dropit.app.core.network.ApiError
import dev.dropit.app.core.network.ApiErrorCode
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SharesResponse
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.repository.ItemShareRepository
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Concrete implementation of [ItemShareRepository] for Bearer-accessible per-item share routes:
 * - `POST /api/spaces/:space/items/:id/shares` (and `/api/rooms/:room/items/:id/shares`)
 * - `GET  /api/spaces/:space/items/:id/shares` (and `/api/rooms/:room/items/:id/shares`)
 * - `DELETE /api/spaces/:space/shares/:shareId` (and `/api/rooms/:room/shares/:shareId`)
 *
 * Deliberately never calls `browserSession()`-only endpoints (`/api/shares`, `/api/shares/:shareId/link`,
 * `/api/shares/:shareId/revoke`, `/api/me/share-presets`).
 */
class DefaultItemShareRepository(
    private val apiClient: DropitApiClient,
) : ItemShareRepository {

    override suspend fun createShare(
        scope: TargetScope,
        itemId: String,
        expiresIn: String,
        maxViews: Int?,
    ): ItemShare {
        val cleanItemId = itemId.trim()
        if (cleanItemId.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "条目 ID 不能为空",
            )
        }
        val cleanExpires = expiresIn.trim()
        if (cleanExpires.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "分享有效期不能为空",
            )
        }
        if (maxViews != null && (maxViews < 1 || maxViews > MAX_VIEWS_LIMIT)) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "最大查看次数需在 1 到 $MAX_VIEWS_LIMIT 之间",
            )
        }

        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(cleanItemId)}/shares"
        val url = apiClient.buildUrl(path)
        val origin = extractOriginFromUrl(url)

        val payload = buildJsonObject {
            put("expiresIn", JsonPrimitive(cleanExpires))
            if (maxViews != null) {
                put("maxViews", JsonPrimitive(maxViews))
            }
        }
        val body = apiClient.json.encodeToString(JsonObject.serializer(), payload)
            .toRequestBody(JSON_MEDIA_TYPE)

        val request = buildAuthorizedRequest(url = url, method = "POST", body = body)
        val created = apiClient.executeJson(
            request = request,
            authenticated = true,
            deserializer = ItemShare.serializer(),
        )
        return resolveShareLinks(origin, created)
    }

    override suspend fun listShares(scope: TargetScope, itemId: String): List<ItemShare> {
        val cleanItemId = itemId.trim()
        if (cleanItemId.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "条目 ID 不能为空",
            )
        }
        val path = "${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(cleanItemId)}/shares"
        val url = apiClient.buildUrl(path)
        val origin = extractOriginFromUrl(url)

        val request = buildAuthorizedRequest(url = url, method = "GET", body = null)
        val response = apiClient.executeJson(
            request = request,
            authenticated = true,
            deserializer = SharesResponse.serializer(),
        )
        return response.shares.map { resolveShareLinks(origin, it) }
    }

    override suspend fun revokeShare(scope: TargetScope, shareId: String) {
        val cleanShareId = shareId.trim()
        if (cleanShareId.isEmpty()) {
            throw ApiError(
                errorCode = ApiErrorCode.INVALID_INPUT,
                rawCode = "INVALID_INPUT",
                httpStatus = 400,
                userMessage = "分享 ID 不能为空",
            )
        }
        val path = "${scope.apiBasePath}/shares/${ServerUrl.encodeURIComponent(cleanShareId)}"
        val url = apiClient.buildUrl(path)
        val request = buildAuthorizedRequest(url = url, method = "DELETE", body = null)
        apiClient.executeNoContent(request = request, authenticated = true)
    }

    private suspend fun buildAuthorizedRequest(
        url: String,
        method: String,
        body: okhttp3.RequestBody?,
    ): Request {
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .method(method, body)
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

    companion object {
        private const val MAX_VIEWS_LIMIT = 1_000_000
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /**
         * Normalizes share links returned by the server so both page short-links (`/s/:token`)
         * and file direct download short-links (`/d/:token`) are always absolute URLs.
         */
        fun resolveShareLinks(origin: String, share: ItemShare): ItemShare {
            val cleanOrigin = origin.trimEnd('/')
            val token = share.token?.trim()?.takeIf { it.isNotEmpty() }
            val resolvedUrl = resolveAbsoluteUrl(
                origin = cleanOrigin,
                raw = share.url,
                fallbackPath = token?.let { "/s/${ServerUrl.encodeURIComponent(it)}" },
            )
            val resolvedDirectUrl = resolveAbsoluteUrl(
                origin = cleanOrigin,
                raw = share.directUrl,
                fallbackPath = null,
            )
            return share.copy(
                url = resolvedUrl,
                directUrl = resolvedDirectUrl,
            )
        }

        private fun resolveAbsoluteUrl(
            origin: String,
            raw: String?,
            fallbackPath: String?,
        ): String? {
            val trimmed = raw?.trim().orEmpty()
            return when {
                trimmed.startsWith("https://", ignoreCase = true) ||
                    trimmed.startsWith("http://", ignoreCase = true) -> trimmed
                trimmed.startsWith("/") -> "$origin$trimmed"
                trimmed.isNotEmpty() -> "$origin/$trimmed"
                fallbackPath != null -> "$origin$fallbackPath"
                else -> null
            }
        }
    }
}
