package dev.dropit.app

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.dropit.app.ui.navigation.AppViewModel
import dev.dropit.app.ui.navigation.DropitApp
import dev.dropit.app.ui.navigation.ShareIntentGuard
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.resolveDarkTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Native Jetpack Compose entry point for dropit Android.
 * - Cold-starts directly into local paper UI without blocking on network/update checks.
 * - Adapts Edge-to-Edge system bars dynamically to Light/Dark Paper theme.
 * - Captures `ACTION_SEND` / `ACTION_SEND_MULTIPLE` on cold start and `onNewIntent`
 *   (ignoring `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY` to prevent duplicate submissions).
 * - Forwards foreground/background lifecycle transitions to [dev.dropit.app.core.realtime.RealtimeClient].
 */
class MainActivity : ComponentActivity() {

    private val appContainer by lazy { (application as DropitApplication).container }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (savedInstanceState == null) {
            captureShareIntentIfNeeded(intent)
            captureOAuthCallbackIfNeeded(intent)
        }

        setContent {
            val appViewModel: AppViewModel = viewModel(
                factory = AppViewModel.Factory(appContainer),
            )
            val rootState by appViewModel.uiState.collectAsStateWithLifecycle()
            val isDark = resolveDarkTheme(rootState.themeMode)

            DisposableEffect(isDark) {
                enableEdgeToEdge(
                    statusBarStyle = if (isDark) {
                        SystemBarStyle.dark(Color.TRANSPARENT)
                    } else {
                        SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                    },
                    navigationBarStyle = if (isDark) {
                        SystemBarStyle.dark(Color.TRANSPARENT)
                    } else {
                        SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                    },
                )
                onDispose {}
            }

            DropitTheme(
                themeMode = rootState.themeMode,
                darkTheme = isDark,
            ) {
                DropitApp(
                    container = appContainer,
                    appViewModel = appViewModel,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        captureShareIntentIfNeeded(intent)
        captureOAuthCallbackIfNeeded(intent)
    }

    override fun onStart() {
        super.onStart()
        if (appContainer.authRepository.sessionState.value.isSignedIn) {
            appContainer.realtimeClient.onAppForeground()
            lifecycleScope.launch(Dispatchers.IO) {
                runCatching { appContainer.transferManager.verifyAllSavedDownloads() }
            }
        }
    }

    override fun onStop() {
        appContainer.realtimeClient.onAppBackground()
        super.onStop()
    }

    private fun captureShareIntentIfNeeded(incomingIntent: Intent?) {
        if (!ShareIntentGuard.shouldCapture(incomingIntent)) return
        val snapshotIntent = Intent(incomingIntent)
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching {
                appContainer.shareInbox.captureIntent(snapshotIntent)
            }
        }
    }

    private fun captureOAuthCallbackIfNeeded(incomingIntent: Intent?) {
        appContainer.oauthCallbackBus.onCallbackIntent(incomingIntent)
    }
}
