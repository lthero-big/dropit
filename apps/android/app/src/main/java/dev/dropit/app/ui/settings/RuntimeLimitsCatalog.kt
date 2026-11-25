package dev.dropit.app.ui.settings

import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.data.account.LimitField
import kotlin.math.abs
import kotlin.math.roundToLong

enum class RuntimeLimitGroup(val label: String, val hint: String) {
    CAPACITY("容量", "文件、文本、配额、分片"),
    TIME("时间", "保留、会话、超时"),
    RATE("限流", "请求频率与并发"),
}

enum class RuntimeLimitUnit(val label: String, val factor: Long) {
    MB("MB", 1024L * 1024L),
    GB("GB", 1024L * 1024L * 1024L),
    SECOND("秒", 1_000L),
    MINUTE("分钟", 60_000L),
    HOUR("小时", 3_600_000L),
    DAY("天", 86_400_000L),
    COUNT("", 1L),
}

data class RuntimeLimitSpec(
    val key: String,
    val label: String,
    val group: RuntimeLimitGroup,
    val hint: String? = null,
)

/**
 * Pure Kotlin mirror of `apps/web/src/lib/limits-form.ts` for native Admin runtime limits editing.
 */
object RuntimeLimitsCatalog {
    private val BYTE_KEYS = setOf(
        "maxFileBytes",
        "maxTextBytes",
        "userQuotaBytes",
        "roomQuotaBytes",
        "roomMaxFileBytes",
        "uploadChunkBytes",
    )
    private val LONG_TIME_KEYS = setOf("retentionMs", "roomRetentionMs", "sessionMs")
    private val SHORT_TIME_KEYS = setOf("rateWindowMs", "uploadChunkTimeoutMs")

    val SPECS: List<RuntimeLimitSpec> = listOf(
        RuntimeLimitSpec("maxFileBytes", "单文件上限", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("maxTextBytes", "文本上限", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("userQuotaBytes", "默认用户配额", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("roomQuotaBytes", "房间配额", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("roomMaxFileBytes", "房间单文件", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("maxItems", "每空间条目上限", RuntimeLimitGroup.CAPACITY),
        RuntimeLimitSpec("uploadChunkBytes", "上传分片大小", RuntimeLimitGroup.CAPACITY, "只影响新上传；已有上传保持原分片大小。"),
        RuntimeLimitSpec("retentionMs", "内容保留", RuntimeLimitGroup.TIME, "只影响新条目。"),
        RuntimeLimitSpec("roomRetentionMs", "房间保留", RuntimeLimitGroup.TIME, "只影响新房间，且不超过 24 小时。"),
        RuntimeLimitSpec("sessionMs", "会话时长", RuntimeLimitGroup.TIME, "只影响新的登录会话。"),
        RuntimeLimitSpec("rateWindowMs", "限流窗口", RuntimeLimitGroup.TIME, "最长 1 小时。"),
        RuntimeLimitSpec("uploadChunkTimeoutMs", "单片上传超时", RuntimeLimitGroup.TIME),
        RuntimeLimitSpec("rateGeneral", "通用限流", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("rateAuth", "登录限流", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("rateInvite", "邀请限流", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("rateUpload", "上传限流", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("rateRoom", "房间写入限流", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("rateChunk", "分片请求限流", RuntimeLimitGroup.RATE, "独立于普通上传限流。"),
        RuntimeLimitSpec("uploadChunksPerSession", "每次上传并行分片", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("uploadChunksPerUser", "每用户并行分片", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("uploadChunksGlobal", "全局并行分片", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("uploadSessionsPerUser", "每用户未完成上传", RuntimeLimitGroup.RATE),
        RuntimeLimitSpec("uploadSessionsGlobal", "全局未完成上传", RuntimeLimitGroup.RATE),
    )

    fun labelFor(key: String): String =
        SPECS.firstOrNull { it.key == key }?.label ?: key

    fun unitsFor(key: String): List<RuntimeLimitUnit> = when {
        key in BYTE_KEYS -> listOf(RuntimeLimitUnit.MB, RuntimeLimitUnit.GB)
        key in SHORT_TIME_KEYS -> listOf(RuntimeLimitUnit.SECOND, RuntimeLimitUnit.MINUTE, RuntimeLimitUnit.HOUR)
        key in LONG_TIME_KEYS -> listOf(RuntimeLimitUnit.HOUR, RuntimeLimitUnit.DAY)
        else -> listOf(RuntimeLimitUnit.COUNT)
    }

    fun defaultUnit(key: String, value: Long): RuntimeLimitUnit = when {
        key in BYTE_KEYS -> if (value >= RuntimeLimitUnit.GB.factor && value % RuntimeLimitUnit.GB.factor == 0L) {
            RuntimeLimitUnit.GB
        } else {
            RuntimeLimitUnit.MB
        }
        key in SHORT_TIME_KEYS -> when {
            value >= RuntimeLimitUnit.HOUR.factor && value % RuntimeLimitUnit.HOUR.factor == 0L -> RuntimeLimitUnit.HOUR
            value >= RuntimeLimitUnit.MINUTE.factor && value % RuntimeLimitUnit.MINUTE.factor == 0L -> RuntimeLimitUnit.MINUTE
            else -> RuntimeLimitUnit.SECOND
        }
        key in LONG_TIME_KEYS -> if (value >= RuntimeLimitUnit.DAY.factor && value % RuntimeLimitUnit.DAY.factor == 0L) {
            RuntimeLimitUnit.DAY
        } else {
            RuntimeLimitUnit.HOUR
        }
        else -> RuntimeLimitUnit.COUNT
    }

    fun toInput(value: Long, unit: RuntimeLimitUnit): String {
        if (unit == RuntimeLimitUnit.COUNT) return value.toString()
        if (value % unit.factor == 0L) return (value / unit.factor).toString()
        val raw = value.toDouble() / unit.factor.toDouble()
        for (digits in 1..6) {
            val formatted = "%.${digits}f".format(java.util.Locale.US, raw).trimEnd('0').trimEnd('.')
            val parsed = formatted.toDoubleOrNull()
            if (parsed != null && abs((parsed * unit.factor).roundToLong() - value) == 0L) {
                return formatted
            }
        }
        return "%.4f".format(java.util.Locale.US, raw).trimEnd('0').trimEnd('.')
    }

    fun toCanonical(raw: String, unit: RuntimeLimitUnit): Long? {
        val text = raw.trim()
        if (text.isEmpty()) return null
        if (unit == RuntimeLimitUnit.COUNT) {
            if (!text.all { it.isDigit() }) return null
            val v = text.toLongOrNull() ?: return null
            return v.takeIf { it >= 1L }
        }
        if (!Regex("^\\d+(\\.\\d+)?$").matches(text)) return null
        val amount = text.toDoubleOrNull() ?: return null
        if (!amount.isFinite() || amount <= 0.0) return null
        val rounded = (amount * unit.factor.toDouble()).roundToLong()
        return rounded.takeIf { it >= 1L }
    }

    fun formatDuration(ms: Long): String = when {
        ms >= RuntimeLimitUnit.DAY.factor && ms % RuntimeLimitUnit.DAY.factor == 0L -> "${ms / RuntimeLimitUnit.DAY.factor} 天"
        ms >= RuntimeLimitUnit.HOUR.factor && ms % RuntimeLimitUnit.HOUR.factor == 0L -> "${ms / RuntimeLimitUnit.HOUR.factor} 小时"
        ms >= RuntimeLimitUnit.MINUTE.factor && ms % RuntimeLimitUnit.MINUTE.factor == 0L -> "${ms / RuntimeLimitUnit.MINUTE.factor} 分钟"
        ms >= RuntimeLimitUnit.SECOND.factor && ms % RuntimeLimitUnit.SECOND.factor == 0L -> "${ms / RuntimeLimitUnit.SECOND.factor} 秒"
        else -> "$ms 毫秒"
    }

    fun formatLimit(key: String, value: Long): String = when {
        key in BYTE_KEYS -> ServerUrl.formatSize(value)
        key in LONG_TIME_KEYS || key in SHORT_TIME_KEYS -> formatDuration(value)
        key == "maxItems" -> "$value 条"
        else -> "$value 次"
    }

    fun localLimitError(key: String, canonical: Long, limits: Map<String, LimitField>): String? {
        val field = limits[key] ?: return null
        if (canonical < field.min || canonical > field.max) {
            return "需在 ${formatLimit(key, field.min)} 到 ${formatLimit(key, field.max)} 之间"
        }
        fun valueOf(k: String): Long? = if (k == key) canonical else limits[k]?.value
        val maxFile = valueOf("maxFileBytes")
        val roomMaxFile = valueOf("roomMaxFileBytes")
        if ((key == "roomMaxFileBytes" || key == "maxFileBytes") &&
            maxFile != null && roomMaxFile != null && roomMaxFile >= maxFile
        ) {
            return "房间单文件必须小于单文件上限"
        }
        val userQuota = valueOf("userQuotaBytes")
        val roomQuota = valueOf("roomQuotaBytes")
        if ((key == "roomQuotaBytes" || key == "userQuotaBytes") &&
            userQuota != null && roomQuota != null && roomQuota >= userQuota
        ) {
            return "房间配额必须小于默认用户配额"
        }
        val retention = valueOf("retentionMs")
        val roomRetention = valueOf("roomRetentionMs")
        if ((key == "roomRetentionMs" || key == "retentionMs") &&
            retention != null && roomRetention != null && roomRetention > retention
        ) {
            return "房间保留不能长于内容保留"
        }
        val general = valueOf("rateGeneral")
        val auth = valueOf("rateAuth")
        val invite = valueOf("rateInvite")
        val upload = valueOf("rateUpload")
        val room = valueOf("rateRoom")
        if ((key == "rateAuth" || key == "rateGeneral") && general != null && auth != null && auth >= general) {
            return "登录限流必须小于通用限流"
        }
        if ((key == "rateInvite" || key == "rateGeneral") && general != null && invite != null && invite >= general) {
            return "邀请限流必须小于通用限流"
        }
        if ((key == "rateUpload" || key == "rateGeneral") && general != null && upload != null && upload >= general) {
            return "上传限流必须小于通用限流"
        }
        if ((key == "rateRoom" || key == "rateUpload") && upload != null && room != null && room >= upload) {
            return "房间写入限流必须小于上传限流"
        }
        return null
    }

    val OAUTH_CHECK_LABELS: Map<String, String> = mapOf(
        "CREDENTIALS_OK" to "Client ID / Secret 有效（回调地址在首次真实登录后确认）",
        "LOGIN_OK" to "已通过真实登录验证（ID、Secret、回调地址均正确）",
        "INVALID_CLIENT" to "Client ID 或 Client Secret 不正确",
        "REDIRECT_MISMATCH" to "回调地址与控制台登记的不一致",
        "REDIRECT_NOT_ALLOWED" to "Google 不接受 http 或纯 IP 回调地址，需要 https 域名",
        "PROVIDER_UNREACHABLE" to "服务器暂时无法连接该登录服务",
        "UNEXPECTED_RESPONSE" to "登录服务返回了无法识别的结果",
    )
}
