package dev.dropit.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.di.AppContainer

/**
 * Minimal native Jetpack Compose entry point for Stage 1.
 * Cold-starts directly into native UI without blocking on network/update checks.
 * Stage 2B / Stage 3B will replace this placeholder content with the full navigation graph.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val container = (application as DropitApplication).container
        setContent {
            MaterialTheme {
                Stage1PlaceholderHome(container = container)
            }
        }
    }
}

@Composable
private fun Stage1PlaceholderHome(container: AppContainer) {
    val session by container.authRepository.sessionState.collectAsState()
    val buildLabel = ServerUrl.versionLabel(
        version = BuildConfig.VERSION_NAME,
        commit = BuildConfig.BUILD_COMMIT,
        date = BuildConfig.BUILD_DATE,
    )

    LaunchedEffect(Unit) {
        container.initialize()
    }

    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "dropit",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = buildLabel,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            val statusText = when {
                session.isSignedIn -> "已连接：${session.serverOrigin}"
                !session.serverOrigin.isNullOrBlank() -> "服务器已配置：${session.serverOrigin}（待登录）"
                else -> "本地原生底座已就绪，等待配置服务器"
            }
            Text(
                text = statusText,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}
