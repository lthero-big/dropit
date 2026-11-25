package dev.dropit.app.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import kotlin.math.abs

/**
 * Paper (纸感) extended semantic color tokens strictly mapped from
 * `docs/android-native-ux-spec.md` §1.2 and `apps/web/src/index.css`.
 */
@Immutable
data class DropitExtendedColors(
    val isDark: Boolean,
    val bg: Color,
    val surface0: Color,
    val surface1: Color,
    val surface2: Color,
    val surfaceSunken: Color,
    val line1: Color,
    val line2: Color,
    val line3: Color,
    val fg: Color,
    val fg2: Color,
    val fg3: Color,
    val fg4: Color,
    val brand: Color,
    val brandFg: Color,
    val brandSoft: Color,
    val ok: Color,
    val okSoft: Color,
    val warn: Color,
    val warnSoft: Color,
    val destructive: Color,
    val codeBg: Color,
    val focusRing: Color,
    val devMac: Color,
    val devPhone: Color,
    val devPad: Color,
    val devPc: Color,
) {
    fun deviceColor(kind: String?): Color = when (kind?.lowercase()) {
        "mac" -> devMac
        "phone" -> devPhone
        "pad" -> devPad
        "pc", "cli" -> devPc
        else -> fg3
    }
}

val DropitLightColors = DropitExtendedColors(
    isDark = false,
    bg = Color(0xFFF4F2EE),
    surface0 = Color(0xFFFAF9F7),
    surface1 = Color(0xFFFFFFFF),
    surface2 = Color(0xFFF0EDE8),
    surfaceSunken = Color(0xFFEBE8E2),
    line1 = Color(0xFFE7E3DC),
    line2 = Color(0xFFD9D4CB),
    line3 = Color(0xFFBDB6AA),
    fg = Color(0xFF1D1B18),
    fg2 = Color(0xFF4A4640),
    fg3 = Color(0xFF7D776D),
    fg4 = Color(0xFFA59F94),
    brand = Color(0xFFD0021B),
    brandFg = Color(0xFFFFFFFF),
    brandSoft = Color(0xFFD0021B).copy(alpha = 0.10f),
    ok = Color(0xFF2F7D4F),
    okSoft = Color(0xFF2F7D4F).copy(alpha = 0.14f),
    warn = Color(0xFFB45309),
    warnSoft = Color(0xFFB45309).copy(alpha = 0.14f),
    destructive = Color(0xFFD0021B),
    codeBg = Color(0xFFF6F4F0),
    focusRing = Color(0xFFD0021B).copy(alpha = 0.55f),
    devMac = Color(0xFF6B6A8F),
    devPhone = Color(0xFF3F7F74),
    devPad = Color(0xFFA86B2D),
    devPc = Color(0xFF4D6F9C),
)

val DropitDarkColors = DropitExtendedColors(
    isDark = true,
    bg = Color(0xFF121110),
    surface0 = Color(0xFF171615),
    surface1 = Color(0xFF1D1C1A),
    surface2 = Color(0xFF252321),
    surfaceSunken = Color(0xFF0E0D0C),
    line1 = Color(0xFF2A2826),
    line2 = Color(0xFF36332F),
    line3 = Color(0xFF4D4943),
    fg = Color(0xFFEEEBE6),
    fg2 = Color(0xFFC7C2BA),
    fg3 = Color(0xFF958F85),
    fg4 = Color(0xFF6C675F),
    brand = Color(0xFFF0434F),
    brandFg = Color(0xFF160707),
    brandSoft = Color(0xFFF0434F).copy(alpha = 0.14f),
    ok = Color(0xFF5CC28A),
    okSoft = Color(0xFF5CC28A).copy(alpha = 0.16f),
    warn = Color(0xFFE0A165),
    warnSoft = Color(0xFFE0A165).copy(alpha = 0.16f),
    destructive = Color(0xFFF0434F),
    codeBg = Color(0xFF151413),
    focusRing = Color(0xFFF0434F).copy(alpha = 0.55f),
    devMac = Color(0xFFA3A1D6),
    devPhone = Color(0xFF6CC4B4),
    devPad = Color(0xFFE0A165),
    devPc = Color(0xFF86A9D8),
)

/**
 * File-type semantic badge colors matching `apps/web/src/lib/file-type.ts` and spec §1.3.
 */
object DropitFileTypeColors {
    val Pdf = Color(0xFFD0453A)
    val Archive = Color(0xFFA07A2C)
    val Audio = Color(0xFF8A5CC2)
    val Video = Color(0xFFC2577F)
    val Image = Color(0xFF3F8F7A)
    val Design = Color(0xFF4F6FD0)
    val Code = Color(0xFF4D6F9C)
    val Doc = Color(0xFF6B7A8F)
    val Default = Color(0xFF7D776D)
}

/**
 * Immersive media overlay colors (independent of light/dark theme, spec §1.3).
 */
object DropitMediaColors {
    val LightboxScrim = Color(0xF00E0D0C)
    val OverlayPrimary = Color(0xD9FFFFFF)
    val OverlaySecondary = Color(0x8CFFFFFF)
}

/**
 * Deterministic group hue calculation matching `apps/web/src/lib/groups.ts:3-10`.
 */
fun groupHue(name: String): Float {
    when (name) {
        "工作" -> return 250f
        "个人" -> return 150f
    }
    var h = 0
    for (ch in name) {
        h = (h * 37 + ch.code) % 360
    }
    return (((h % 360) + 360) % 360).toFloat()
}

/**
 * Converts a group name to a paper-harmonious dot color (Light HSL(h, 0.42, 0.48), Dark HSL(h, 0.45, 0.65)).
 */
fun groupDotColor(name: String?, isDark: Boolean, fallback: Color): Color {
    if (name.isNullOrBlank()) return fallback
    val hue = groupHue(name)
    return if (isDark) {
        hslToColor(hue, 0.45f, 0.65f)
    } else {
        hslToColor(hue, 0.42f, 0.48f)
    }
}

internal fun hslToColor(hue: Float, saturation: Float, lightness: Float): Color {
    val h = ((hue % 360f) + 360f) % 360f
    val c = (1f - abs(2f * lightness - 1f)) * saturation
    val x = c * (1f - abs((h / 60f) % 2f - 1f))
    val m = lightness - c / 2f
    val (r1, g1, b1) = when {
        h < 60f -> Triple(c, x, 0f)
        h < 120f -> Triple(x, c, 0f)
        h < 180f -> Triple(0f, c, x)
        h < 240f -> Triple(0f, x, c)
        h < 300f -> Triple(x, 0f, c)
        else -> Triple(c, 0f, x)
    }
    return Color(
        red = (r1 + m).coerceIn(0f, 1f),
        green = (g1 + m).coerceIn(0f, 1f),
        blue = (b1 + m).coerceIn(0f, 1f),
        alpha = 1f,
    )
}

/**
 * Material 3 [ColorScheme] mapping strictly aligned with spec §1.4.
 * Sets [surfaceTint] to [Color.Transparent] so M3 never applies purple/pink tonal elevation tinting.
 */
fun toMaterial3ColorScheme(colors: DropitExtendedColors): ColorScheme = if (colors.isDark) {
    darkColorScheme(
        primary = colors.brand,
        onPrimary = colors.brandFg,
        primaryContainer = colors.brandSoft,
        onPrimaryContainer = colors.brand,
        secondary = colors.fg,
        onSecondary = colors.bg,
        secondaryContainer = colors.surface2,
        onSecondaryContainer = colors.fg,
        tertiary = colors.ok,
        onTertiary = Color(0xFF071A10),
        tertiaryContainer = colors.okSoft,
        onTertiaryContainer = colors.ok,
        background = colors.bg,
        onBackground = colors.fg,
        surface = colors.surface1,
        onSurface = colors.fg,
        surfaceVariant = colors.surface2,
        onSurfaceVariant = colors.fg3,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = colors.surfaceSunken,
        surfaceContainerLow = colors.surface0,
        surfaceContainer = colors.surface1,
        surfaceContainerHigh = colors.surface2,
        surfaceContainerHighest = colors.surface2,
        outline = colors.line2,
        outlineVariant = colors.line1,
        error = colors.destructive,
        onError = colors.brandFg,
        errorContainer = colors.brandSoft,
        onErrorContainer = colors.destructive,
        scrim = Color(0x99000000),
    )
} else {
    lightColorScheme(
        primary = colors.brand,
        onPrimary = colors.brandFg,
        primaryContainer = colors.brandSoft,
        onPrimaryContainer = colors.brand,
        secondary = colors.fg,
        onSecondary = colors.bg,
        secondaryContainer = colors.surface2,
        onSecondaryContainer = colors.fg,
        tertiary = colors.ok,
        onTertiary = Color.White,
        tertiaryContainer = colors.okSoft,
        onTertiaryContainer = colors.ok,
        background = colors.bg,
        onBackground = colors.fg,
        surface = colors.surface1,
        onSurface = colors.fg,
        surfaceVariant = colors.surface2,
        onSurfaceVariant = colors.fg3,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = colors.surfaceSunken,
        surfaceContainerLow = colors.surface0,
        surfaceContainer = colors.surface1,
        surfaceContainerHigh = colors.surface2,
        surfaceContainerHighest = colors.surface2,
        outline = colors.line2,
        outlineVariant = colors.line1,
        error = colors.destructive,
        onError = colors.brandFg,
        errorContainer = colors.brandSoft,
        onErrorContainer = colors.destructive,
        scrim = Color(0x661D1B18),
    )
}
