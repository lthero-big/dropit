package dev.dropit.app.core.network

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

enum class ApiErrorCode(val defaultMessage: String) {
    FILE_TOO_LARGE("文件太大，超过服务器限制"),
    QUOTA_EXCEEDED("空间已满"),
    ITEM_LIMIT("条目数量已达上限"),
    INVALID_IMAGE("图片无法识别"),
    TEXT_TOO_LARGE("文字太长"),
    EMPTY_TEXT("内容是空的"),
    INVALID_INPUT("内容无效"),
    RATE_LIMITED("操作太频繁，请稍后再试"),
    INSUFFICIENT_SCOPE("这个设备令牌没有写入权限"),
    UNAUTHENTICATED("登录已失效，请重新登录"),
    READ_ONLY("当前空间为只读权限，无法修改"),
    FORBIDDEN("没有权限执行此操作"),
    NOT_FOUND("内容不存在或已被移除"),
    BROWSER_SESSION_REQUIRED("此操作需在系统浏览器中完成"),
    PIN_REQUIRED("需要输入房间 PIN"),
    PIN_INVALID("房间 PIN 不正确"),
    CODE_TAKEN("房间码已被占用"),
    INVALID_CODE("房间码格式不正确"),
    INVALID_PIN("PIN 格式不正确"),
    INVALID_GROUP("分组名称无效"),
    GROUP_LIMIT("分组数量已达上限"),
    NO_RELEASE("服务器暂未发布 Android 安装包"),
    SOCKET_LIMIT("当前连接数已达上限，请稍后再试"),
    INVALID_SERVER("这个地址不是 dropit 服务器（/api/version 没有正确响应）"),
    NETWORK_ERROR("网络连接失败，请稍后重试"),
    UNKNOWN("请求失败"),
}

class ApiError(
    val errorCode: ApiErrorCode,
    val rawCode: String,
    val httpStatus: Int,
    val userMessage: String,
    val retryAfterSeconds: Long? = null,
    val details: Map<String, String> = emptyMap(),
    cause: Throwable? = null,
) : Exception(userMessage, cause) {

    val isUnauthorized: Boolean
        get() = httpStatus == 401 || errorCode == ApiErrorCode.UNAUTHENTICATED

    companion object {
        private val lenientJson = Json { ignoreUnknownKeys = true; isLenient = true }

        fun fromResponse(
            httpStatus: Int,
            rawBody: String?,
            retryAfterHeader: String? = null,
        ): ApiError {
            val parsed = parseErrorPayload(rawBody)
            val rawCode = parsed.code.orEmpty()
            val mappedCode = mapCode(rawCode, httpStatus)
            val retryAfter = retryAfterHeader?.trim()?.toLongOrNull()?.takeIf { it > 0 }
            val message = when {
                mappedCode != ApiErrorCode.UNKNOWN -> mappedCode.defaultMessage
                rawCode.isNotBlank() -> "请求失败（$rawCode）"
                httpStatus > 0 -> "请求失败（$httpStatus）"
                else -> ApiErrorCode.UNKNOWN.defaultMessage
            }
            return ApiError(
                errorCode = mappedCode,
                rawCode = rawCode.ifBlank { httpStatus.toString() },
                httpStatus = httpStatus,
                userMessage = message,
                retryAfterSeconds = retryAfter,
                details = parsed.details,
            )
        }

        fun network(cause: Throwable): ApiError = ApiError(
            errorCode = ApiErrorCode.NETWORK_ERROR,
            rawCode = "NETWORK_ERROR",
            httpStatus = 0,
            userMessage = ApiErrorCode.NETWORK_ERROR.defaultMessage,
            cause = cause,
        )

        fun invalidServer(message: String = ApiErrorCode.INVALID_SERVER.defaultMessage): ApiError = ApiError(
            errorCode = ApiErrorCode.INVALID_SERVER,
            rawCode = "INVALID_SERVER",
            httpStatus = 0,
            userMessage = message,
        )

        fun notConfigured(): ApiError = ApiError(
            errorCode = ApiErrorCode.INVALID_SERVER,
            rawCode = "SERVER_NOT_CONFIGURED",
            httpStatus = 0,
            userMessage = "尚未配置服务器地址",
        )

        private data class ParsedError(val code: String?, val details: Map<String, String>)

        private fun parseErrorPayload(rawBody: String?): ParsedError {
            if (rawBody.isNullOrBlank()) return ParsedError(null, emptyMap())
            val root = runCatching { lenientJson.parseToJsonElement(rawBody) as? JsonObject }.getOrNull()
                ?: return ParsedError(null, emptyMap())
            val errorElem = root["error"] ?: return ParsedError(null, emptyMap())
            return when (errorElem) {
                is JsonPrimitive -> ParsedError(errorElem.contentOrNull, emptyMap())
                is JsonObject -> {
                    val code = (errorElem["code"] as? JsonPrimitive)?.contentOrNull
                    val details = buildMap {
                        for ((k, v) in errorElem) {
                            if (k != "code" && v is JsonPrimitive) {
                                v.contentOrNull?.let { put(k, it) }
                            }
                        }
                    }
                    ParsedError(code, details)
                }
                else -> ParsedError(null, emptyMap())
            }
        }

        private fun mapCode(code: String, httpStatus: Int): ApiErrorCode {
            val normalized = code.trim().uppercase()
            val byName = when (normalized) {
                "FILE_TOO_LARGE", "BODY_TOO_LARGE" -> ApiErrorCode.FILE_TOO_LARGE
                "QUOTA_EXCEEDED" -> ApiErrorCode.QUOTA_EXCEEDED
                "ITEM_LIMIT" -> ApiErrorCode.ITEM_LIMIT
                "INVALID_IMAGE" -> ApiErrorCode.INVALID_IMAGE
                "TEXT_TOO_LARGE" -> ApiErrorCode.TEXT_TOO_LARGE
                "EMPTY_TEXT" -> ApiErrorCode.EMPTY_TEXT
                "INVALID_INPUT", "INVALID_JSON", "JSON_REQUIRED" -> ApiErrorCode.INVALID_INPUT
                "RATE_LIMITED", "UPLOAD_BUSY", "CHUNK_BUSY", "PREVIEW_BUSY" -> ApiErrorCode.RATE_LIMITED
                "INSUFFICIENT_SCOPE" -> ApiErrorCode.INSUFFICIENT_SCOPE
                "UNAUTHENTICATED" -> ApiErrorCode.UNAUTHENTICATED
                "READ_ONLY" -> ApiErrorCode.READ_ONLY
                "FORBIDDEN" -> ApiErrorCode.FORBIDDEN
                "NOT_FOUND" -> ApiErrorCode.NOT_FOUND
                "BROWSER_SESSION_REQUIRED" -> ApiErrorCode.BROWSER_SESSION_REQUIRED
                "PIN_REQUIRED" -> ApiErrorCode.PIN_REQUIRED
                "PIN_INVALID" -> ApiErrorCode.PIN_INVALID
                "CODE_TAKEN" -> ApiErrorCode.CODE_TAKEN
                "INVALID_CODE" -> ApiErrorCode.INVALID_CODE
                "INVALID_PIN" -> ApiErrorCode.INVALID_PIN
                "INVALID_GROUP" -> ApiErrorCode.INVALID_GROUP
                "GROUP_LIMIT" -> ApiErrorCode.GROUP_LIMIT
                "NO_RELEASE" -> ApiErrorCode.NO_RELEASE
                "SOCKET_LIMIT" -> ApiErrorCode.SOCKET_LIMIT
                else -> null
            }
            if (byName != null) return byName
            return when (httpStatus) {
                401 -> ApiErrorCode.UNAUTHENTICATED
                403 -> ApiErrorCode.FORBIDDEN
                404 -> ApiErrorCode.NOT_FOUND
                413 -> ApiErrorCode.FILE_TOO_LARGE
                429 -> ApiErrorCode.RATE_LIMITED
                else -> ApiErrorCode.UNKNOWN
            }
        }
    }
}
