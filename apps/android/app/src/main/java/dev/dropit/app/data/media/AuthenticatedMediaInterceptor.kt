package dev.dropit.app.data.media

import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.SessionCredentialsProvider
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

/**
 * OkHttp application interceptor that attaches `Authorization: Bearer <token>` and
 * `X-Dropit-Device*` headers ONLY to requests targeting the currently configured dropit
 * server origin, preserving `Range` and other media streaming headers.
 *
 * Emits [onUnauthorized] when the configured server answers HTTP 401 to an authenticated
 * media request. Never sends Bearer credentials to third-party origins.
 */
class AuthenticatedMediaInterceptor(
    private val credentialsProvider: SessionCredentialsProvider,
    private val onUnauthorized: (serverOrigin: String, path: String) -> Unit = { _, _ -> },
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val configuredOrigin = runBlocking { credentialsProvider.serverOrigin() }?.trimEnd('/')
        if (configuredOrigin.isNullOrBlank() || !isSameOrigin(original.url, configuredOrigin)) {
            return chain.proceed(original)
        }

        val token = runBlocking { credentialsProvider.accessToken() }?.takeIf { it.isNotBlank() }
        val deviceId = runBlocking { credentialsProvider.deviceId() }
        val deviceHeaders = ServerUrl.deviceHeaders(deviceId, credentialsProvider.deviceName())

        val builder = original.newBuilder()
        var attachedBearer = false
        if (token != null && original.header("Authorization") == null) {
            builder.header("Authorization", "Bearer $token")
            attachedBearer = true
        }
        for ((k, v) in deviceHeaders) {
            if (original.header(k) == null) {
                builder.header(k, v)
            }
        }

        val response = chain.proceed(builder.build())
        if (attachedBearer && response.code == 401) {
            onUnauthorized(configuredOrigin, original.url.encodedPath)
        }
        return response
    }

    companion object {
        fun originOf(url: HttpUrl): String {
            val host = url.host.lowercase()
            val hostPart = if (host.contains(':')) "[$host]" else host
            val isDefaultPort = (url.scheme == "https" && url.port == 443) ||
                (url.scheme == "http" && url.port == 80)
            val portPart = if (isDefaultPort) "" else ":${url.port}"
            return "${url.scheme.lowercase()}://$hostPart$portPart"
        }

        fun isSameOrigin(requestUrl: HttpUrl, configuredOrigin: String?): Boolean {
            val parsedOrigin = configuredOrigin?.trim()?.toHttpUrlOrNull() ?: return false
            return originOf(requestUrl) == originOf(parsedOrigin)
        }
    }
}

/**
 * Network-level guard ensuring cross-origin redirects can never carry the dropit Bearer token.
 */
internal class CrossOriginAuthStripInterceptor(
    private val serverOriginProvider: suspend () -> String?,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header("Authorization") != null) {
            val configuredOrigin = runBlocking { serverOriginProvider() }?.trimEnd('/')
            if (!AuthenticatedMediaInterceptor.isSameOrigin(request.url, configuredOrigin)) {
                return chain.proceed(request.newBuilder().removeHeader("Authorization").build())
            }
        }
        return chain.proceed(request)
    }
}
