package dev.dropit.app

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.dropit.app.ui.navigation.AppViewModel
import dev.dropit.app.ui.navigation.DropitApp
import dev.dropit.app.ui.theme.DropitTheme
import dev.dropit.app.ui.theme.resolveDarkTheme

/**
 * Native Jetpack Compose entry point for dropit Android.
 * Cold-starts directly into local paper UI without blocking on network/update checks,
 * adapts Edge-to-Edge system bars dynamically to Light/Dark Paper theme,
 * and forwards foreground/background lifecycle transitions to [dev.dropit.app.core.realtime.RealtimeClient].
 */
class MainActivity : ComponentActivity() {

    private val appContainer by lazy { (application as DropitApplication).container }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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

    override fun onStart() {
        super.onStart()
        if (appContainer.authRepository.sessionState.value.isSignedIn) {
            appContainer.realtimeClient.onAppForeground()
        }
    }

    override fun onStop() {
        appContainer.realtimeClient.onAppBackground()
        super.onStop()
    }
}
