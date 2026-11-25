package dev.dropit.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import dev.dropit.app.core.auth.ThemeMode

val LocalDropitColors = staticCompositionLocalOf { DropitLightColors }
val LocalDropitShapes = staticCompositionLocalOf { DefaultDropitShapes }
val LocalReducedMotion = staticCompositionLocalOf { false }

object DropitTheme {
    val colors: DropitExtendedColors
        @Composable
        @ReadOnlyComposable
        get() = LocalDropitColors.current

    val shapes: DropitShapes
        @Composable
        @ReadOnlyComposable
        get() = LocalDropitShapes.current

    val reducedMotion: Boolean
        @Composable
        @ReadOnlyComposable
        get() = LocalReducedMotion.current
}

@Composable
fun resolveDarkTheme(themeMode: ThemeMode): Boolean = when (themeMode) {
    ThemeMode.SYSTEM -> isSystemInDarkTheme()
    ThemeMode.LIGHT -> false
    ThemeMode.DARK -> true
}

@Composable
fun DropitTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    darkTheme: Boolean = resolveDarkTheme(themeMode),
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val reducedMotion = remember(context) { DropitMotion.isSystemReducedMotion(context) }
    val extendedColors = if (darkTheme) DropitDarkColors else DropitLightColors
    val materialScheme = remember(darkTheme) { toMaterial3ColorScheme(extendedColors) }

    CompositionLocalProvider(
        LocalDropitColors provides extendedColors,
        LocalDropitShapes provides DefaultDropitShapes,
        LocalReducedMotion provides reducedMotion,
    ) {
        MaterialTheme(
            colorScheme = materialScheme,
            typography = resolveDropitTypography(),
            shapes = DropitMaterialShapes,
            content = content,
        )
    }
}
