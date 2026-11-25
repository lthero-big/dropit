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
    INSUFFICIENT_SCOPE("当前令牌权限不足，请重新登录以升级权限"),
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
    INVALID_CREDENTIALS("邮箱或密码不正确"),
    USER_DISABLED("账号已停用"),
    PASSWORD_CHANGE_REQUIRED("请先修改临时密码"),
    PASSWORD_TOO_SHORT("密码至少需要 8 位"),
    CURRENT_PASSWORD_INVALID("当前密码不正确"),
    PASSWORD_UNCHANGED("新密码不能与当前密码相同"),
    OAUTH_CODE_INVALID("登录授权码无效或已过期，请重试"),
    OAUTH_STATE_INVALID("登录状态已失效，请重试"),
    OAUTH_DENIED("已取消第三方登录"),
    OAUTH_PROVIDER_ERROR("第三方登录服务暂时不可用"),
    PROVIDER_UNAVAILABLE("该登录方式未配置或未启用"),
    PROVIDER_UNSUPPORTED("不支持的登录方式"),
    ACCOUNT_EXISTS("这个邮箱已有账号，请先用原方式登录后再到设置中绑定"),
    IDENTITY_IN_USE("该第三方账号已绑定到另一个 dropit 账号"),
    PROVIDER_ALREADY_LINKED("已绑定过该登录方式，请先解绑再更换"),
    LAST_IDENTITY("至少需要保留一种登录方式"),
    INVITE_INVALID("邀请无效或已过期"),
    INVITE_NEEDS_ACCOUNT("该邀请仅限已有账号使用，请先登录"),
    INVITATION_REQUIRED("需要邀请才能注册"),
    REGISTRATION_CLOSED("本站已关闭注册，请联系管理员"),
    VERIFIED_EMAIL_REQUIRED("需要已验证的邮箱"),
    INVITE_LIMIT_REACHED("邀请名额已用完"),
    INVITES_DISABLED("管理员已关闭空间邀请功能"),
    INVITE_USED("该邀请已被使用，无法撤销"),
    INVITES_ADMIN_ONLY("只有管理员可以创建注册邀请"),
    OWNER_CANNOT_LEAVE("空间所有者不能退出自己的空间"),
    TOKEN_ACTIVE("令牌仍然有效，请先撤销再删除"),
    SHARE_NOT_REVOKED("请先撤销分享链接，再删除记录"),
    LAST_ADMIN("必须保留至少一位管理员"),
    EMAIL_IN_USE("该邮箱已有账号"),
    INVALID_LIMITS("限制值不在允许范围，或与其他限制冲突"),
    INVALID_CLIENT_ID("Client ID 格式无效"),
    OAUTH_SECRET_REQUIRED("请填写 Client Secret"),
    INVALID_ORIGIN("站点地址格式不正确"),
    ORIGIN_CONFIRM_REQUIRED("新站点地址与当前访问地址不同，需要确认"),
    INVALID_APP_REDIRECT("应用回调地址不被允许"),
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

    val isInsufficientScope: Boolean
        get() = httpStatus == 403 && errorCode == ApiErrorCode.INSUFFICIENT_SCOPE

    val isPasswordChangeRequired: Boolean
        get() = httpStatus == 403 && errorCode == ApiErrorCode.PASSWORD_CHANGE_REQUIRED

    val isOriginConfirmRequired: Boolean
        get() = httpStatus == 409 && errorCode == ApiErrorCode.ORIGIN_CONFIRM_REQUIRED

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

        fun fromOAuthErrorCode(rawCode: String): ApiError {
            val trimmed = rawCode.trim()
            val mapped = mapCode(trimmed, httpStatus = 0)
            val message = if (mapped != ApiErrorCode.UNKNOWN) {
                mapped.defaultMessage
            } else if (trimmed.isNotEmpty()) {
                "登录失败（$trimmed）"
            } else {
                ApiErrorCode.OAUTH_PROVIDER_ERROR.defaultMessage
            }
            return ApiError(
                errorCode = mapped,
                rawCode = trimmed.ifBlank { "OAUTH_PROVIDER_ERROR" },
                httpStatus = 0,
                userMessage = message,
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
                "INVALID_CREDENTIALS" -> ApiErrorCode.INVALID_CREDENTIALS
                "USER_DISABLED" -> ApiErrorCode.USER_DISABLED
                "PASSWORD_CHANGE_REQUIRED" -> ApiErrorCode.PASSWORD_CHANGE_REQUIRED
                "PASSWORD_TOO_SHORT" -> ApiErrorCode.PASSWORD_TOO_SHORT
                "CURRENT_PASSWORD_INVALID" -> ApiErrorCode.CURRENT_PASSWORD_INVALID
                "PASSWORD_UNCHANGED" -> ApiErrorCode.PASSWORD_UNCHANGED
                "OAUTH_CODE_INVALID" -> ApiErrorCode.OAUTH_CODE_INVALID
                "OAUTH_STATE_INVALID" -> ApiErrorCode.OAUTH_STATE_INVALID
                "OAUTH_DENIED" -> ApiErrorCode.OAUTH_DENIED
                "OAUTH_PROVIDER_ERROR" -> ApiErrorCode.OAUTH_PROVIDER_ERROR
                "PROVIDER_UNAVAILABLE" -> ApiErrorCode.PROVIDER_UNAVAILABLE
                "PROVIDER_UNSUPPORTED" -> ApiErrorCode.PROVIDER_UNSUPPORTED
                "ACCOUNT_EXISTS" -> ApiErrorCode.ACCOUNT_EXISTS
                "IDENTITY_IN_USE" -> ApiErrorCode.IDENTITY_IN_USE
                "PROVIDER_ALREADY_LINKED" -> ApiErrorCode.PROVIDER_ALREADY_LINKED
                "LAST_IDENTITY" -> ApiErrorCode.LAST_IDENTITY
                "INVITE_INVALID" -> ApiErrorCode.INVITE_INVALID
                "INVITE_NEEDS_ACCOUNT" -> ApiErrorCode.INVITE_NEEDS_ACCOUNT
                "INVITATION_REQUIRED" -> ApiErrorCode.INVITATION_REQUIRED
                "REGISTRATION_CLOSED" -> ApiErrorCode.REGISTRATION_CLOSED
                "VERIFIED_EMAIL_REQUIRED" -> ApiErrorCode.VERIFIED_EMAIL_REQUIRED
                "INVITE_LIMIT_REACHED" -> ApiErrorCode.INVITE_LIMIT_REACHED
                "INVITES_DISABLED" -> ApiErrorCode.INVITES_DISABLED
                "INVITE_USED" -> ApiErrorCode.INVITE_USED
                "INVITES_ADMIN_ONLY" -> ApiErrorCode.INVITES_ADMIN_ONLY
                "OWNER_CANNOT_LEAVE" -> ApiErrorCode.OWNER_CANNOT_LEAVE
                "TOKEN_ACTIVE" -> ApiErrorCode.TOKEN_ACTIVE
                "SHARE_NOT_REVOKED" -> ApiErrorCode.SHARE_NOT_REVOKED
                "LAST_ADMIN" -> ApiErrorCode.LAST_ADMIN
                "EMAIL_IN_USE" -> ApiErrorCode.EMAIL_IN_USE
                "INVALID_LIMITS" -> ApiErrorCode.INVALID_LIMITS
                "INVALID_CLIENT_ID" -> ApiErrorCode.INVALID_CLIENT_ID
                "OAUTH_SECRET_REQUIRED" -> ApiErrorCode.OAUTH_SECRET_REQUIRED
                "INVALID_ORIGIN" -> ApiErrorCode.INVALID_ORIGIN
                "ORIGIN_CONFIRM_REQUIRED" -> ApiErrorCode.ORIGIN_CONFIRM_REQUIRED
                "INVALID_APP_REDIRECT" -> ApiErrorCode.INVALID_APP_REDIRECT
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
