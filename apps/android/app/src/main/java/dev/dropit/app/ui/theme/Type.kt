package dev.dropit.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

val DropitSans: FontFamily = FontFamily.SansSerif
val DropitMono: FontFamily = FontFamily.Monospace

/**
 * Tabular monospace text styles matching `.dd-mono` (`tnum, zero`, spec §1.5).
 */
object DropitMonoTypography {
    val deviceCode = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = 0.12.em,
        fontFeatureSettings = "tnum, zero",
    )

    val deviceCodeCompact = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.SemiBold,
        fontSize = 24.sp,
        lineHeight = 30.sp,
        letterSpacing = 0.04.em,
        fontFeatureSettings = "tnum, zero",
    )

    val codeBlock = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 18.sp,
        fontFeatureSettings = "tnum, zero",
    )

    val meta = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp,
        letterSpacing = 0.02.em,
        fontFeatureSettings = "tnum, zero",
    )

    val url = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.Normal,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontFeatureSettings = "tnum, zero",
    )
}

/**
 * Typography scale strictly aligned with `docs/android-native-ux-spec.md` §1.5.
 * Every text size is declared in `sp` so system font scaling (1.0x-2.0x) works cleanly.
 */
val DropitTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = DropitMono,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = 0.12.em,
        fontFeatureSettings = "tnum, zero",
    ),
    headlineSmall = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 27.sp,
        letterSpacing = (-0.01).em,
    ),
    titleLarge = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp,
        lineHeight = 26.sp,
        letterSpacing = (-0.01).em,
    ),
    titleMedium = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        letterSpacing = 0.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Normal,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        letterSpacing = 0.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = DropitSans,
        fontWeight = FontWeight.Medium,
        fontSize = 11.sp,
        lineHeight = 15.sp,
        letterSpacing = 0.02.em,
    ),
)
