package dev.dropit.app.ui.common

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * Shared Custom Tabs launcher that prefers installed Custom Tabs browsers (Chrome first)
 * via [CustomTabsClient.getPackageName] so OAuth authorization pages open in a compatible
 * Custom Tabs container instead of falling into incompatible third-party browsers.
 */
object CustomTabsHelper {

    val PREFERRED_PACKAGES: List<String> = listOf(
        "com.android.chrome",
        "com.chrome.beta",
        "com.chrome.dev",
        "com.chrome.canary",
        "com.microsoft.emmx",
        "com.brave.browser",
        "com.vivaldi.browser",
        "org.mozilla.firefox",
        "com.sec.android.app.sbrowser",
    )

    fun resolveCustomTabsPackage(context: Context): String? =
        resolveCustomTabsPackage { preferred ->
            runCatching {
                CustomTabsClient.getPackageName(context, preferred, false)
            }.getOrNull()
        }

    internal fun resolveCustomTabsPackage(
        resolver: (preferredPackages: List<String>) -> String?,
    ): String? {
        val preferred = resolver(PREFERRED_PACKAGES)?.trim()?.takeIf { it.isNotEmpty() }
        if (preferred != null) return preferred
        return resolver(emptyList())?.trim()?.takeIf { it.isNotEmpty() }
    }

    fun buildCustomTabsIntent(
        context: Context,
        preferredPackage: String? = resolveCustomTabsPackage(context),
    ): CustomTabsIntent {
        val customTabsIntent = CustomTabsIntent.Builder()
            .setShowTitle(true)
            .build()
        if (!preferredPackage.isNullOrBlank()) {
            customTabsIntent.intent.setPackage(preferredPackage)
        }
        if (context !is Activity) {
            customTabsIntent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return customTabsIntent
    }

    fun openUrl(
        context: Context,
        rawUrl: String,
        fallbackErrorMessage: String = "未找到可用的浏览器",
    ) {
        val uri = runCatching { Uri.parse(rawUrl) }.getOrNull() ?: return
        val preferredPackage = resolveCustomTabsPackage(context)
        val opened = runCatching {
            buildCustomTabsIntent(context, preferredPackage).launchUrl(context, uri)
        }.isSuccess
        if (!opened) {
            runCatching {
                val viewIntent = Intent(Intent.ACTION_VIEW, uri).apply {
                    if (context !is Activity) {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                }
                context.startActivity(viewIntent)
            }.onFailure {
                Toast.makeText(context, fallbackErrorMessage, Toast.LENGTH_SHORT).show()
            }
        }
    }
}
