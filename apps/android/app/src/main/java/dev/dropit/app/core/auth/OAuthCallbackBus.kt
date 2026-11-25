package dev.dropit.app.core.auth

import android.content.Intent
import dev.dropit.app.core.network.ApiError
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.URI
import java.net.URLDecoder

/**
 * Parsed payload from a `dropit://auth/callback?...` OAuth redirect intent.
 */
sealed class OAuthCallbackPayload {
    abstract val state: String

    data class LoginCode(
        val code: String,
        override val state: String,
    ) : OAuthCallbackPayload()

    data class Linked(
        val provider: String,
        val alreadyLinked: Boolean,
        override val state: String,
    ) : OAuthCallbackPayload()

    data class Error(
        val errorCode: String,
        override val state: String,
        val userMessage: String,
    ) : OAuthCallbackPayload()
}

/**
 * Pure JVM parser for `dropit://auth/callback` URIs (no Android `Uri` dependency so unit tests
 * run on plain JVM as well as Robolectric).
 */
object OAuthCallbackParser {
    const val SCHEME = "dropit"
    const val HOST = "auth"
    const val PATH = "/callback"

    fun isCallbackUri(rawUri: String?): Boolean {
        if (rawUri.isNullOrBlank()) return false
        val parsed = runCatching { URI(rawUri.trim()) }.getOrNull() ?: return false
        return parsed.scheme.equals(SCHEME, ignoreCase = true) &&
            parsed.host.equals(HOST, ignoreCase = true) &&
            parsed.path == PATH
    }

    fun parse(rawUri: String?): OAuthCallbackPayload? {
        if (!isCallbackUri(rawUri)) return null
        val parsed = runCatching { URI(rawUri!!.trim()) }.getOrNull() ?: return null
        val params = parseQuery(parsed.rawQuery)
        val state = params["state"]?.trim().orEmpty()
        if (state.isEmpty()) return null

        val errorCode = params["error"]?.trim().orEmpty()
        if (errorCode.isNotEmpty()) {
            val apiError = ApiError.fromOAuthErrorCode(errorCode)
            return OAuthCallbackPayload.Error(
                errorCode = errorCode,
                state = state,
                userMessage = apiError.userMessage,
            )
        }

        val code = params["code"]?.trim().orEmpty()
        if (code.isNotEmpty()) {
            return OAuthCallbackPayload.LoginCode(
                code = code,
                state = state,
            )
        }

        val linked = params["linked"]?.trim().orEmpty()
        if (linked.isNotEmpty()) {
            val alreadyRaw = params["already"]?.trim().orEmpty()
            val already = alreadyRaw == "1" || alreadyRaw.equals("true", ignoreCase = true)
            return OAuthCallbackPayload.Linked(
                provider = linked,
                alreadyLinked = already,
                state = state,
            )
        }

        return null
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        val result = LinkedHashMap<String, String>()
        for (pair in rawQuery.split('&')) {
            if (pair.isEmpty()) continue
            val eqIdx = pair.indexOf('=')
            val rawKey = if (eqIdx < 0) pair else pair.substring(0, eqIdx)
            val rawVal = if (eqIdx < 0) "" else pair.substring(eqIdx + 1)
            val key = runCatching { URLDecoder.decode(rawKey, Charsets.UTF_8.name()) }.getOrDefault(rawKey)
            val value = runCatching { URLDecoder.decode(rawVal, Charsets.UTF_8.name()) }.getOrDefault(rawVal)
            if (key.isNotEmpty() && key !in result) {
                result[key] = value
            }
        }
        return result
    }
}

/**
 * Pure guard for incoming `dropit://auth/callback` intents in [dev.dropit.app.MainActivity].
 * Ignores intents replayed from Android Recents (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`).
 */
object OAuthCallbackGuard {
    fun shouldCapture(intent: Intent?): Boolean {
        if (intent == null) return false
        return shouldCapture(
            action = intent.action,
            dataString = intent.dataString,
            flags = intent.flags,
        )
    }

    fun shouldCapture(action: String?, dataString: String?, flags: Int): Boolean {
        if ((flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        if (action != Intent.ACTION_VIEW) return false
        return OAuthCallbackParser.isCallbackUri(dataString)
    }
}

/**
 * Process-scoped event & pending-callback bus bridging `MainActivity` deep-link delivery
 * (`dropit://auth/callback`) with Onboarding and Settings ViewModels.
 *
 * Exposes both a live [events] SharedFlow and a sticky [pendingCallback] StateFlow so callbacks
 * delivered during cold Activity recreation are never dropped before a screen attaches.
 */
class OAuthCallbackBus {
    private val _events = MutableSharedFlow<OAuthCallbackPayload>(extraBufferCapacity = 8)
    val events: SharedFlow<OAuthCallbackPayload> = _events.asSharedFlow()

    private val _pendingCallback = MutableStateFlow<OAuthCallbackPayload?>(null)
    val pendingCallback: StateFlow<OAuthCallbackPayload?> = _pendingCallback.asStateFlow()

    fun onCallbackIntent(intent: Intent?): Boolean {
        if (!OAuthCallbackGuard.shouldCapture(intent)) return false
        return onCallbackUri(intent?.dataString)
    }

    fun onCallbackUri(rawUri: String?): Boolean {
        val payload = OAuthCallbackParser.parse(rawUri) ?: return false
        _pendingCallback.value = payload
        _events.tryEmit(payload)
        return true
    }

    fun consumePendingCallback(): OAuthCallbackPayload? {
        val current = _pendingCallback.value ?: return null
        _pendingCallback.value = null
        return current
    }

    fun clearPendingCallback() {
        _pendingCallback.value = null
    }
}
