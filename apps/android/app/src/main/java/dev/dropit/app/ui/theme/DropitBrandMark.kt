package dev.dropit.app.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Shared brand mark matching `apps/web/public/favicon.svg`, `apps/web/src/components/logo.tsx`,
 * and `res/drawable/ic_launcher_foreground.xml`:
 * an ink rounded-square tile with a centered geometric lowercase `d` and a top-right brand dot.
 *
 * Rendered via vector paths so typography scaling never shifts or clips the emblem.
 */
@Composable
fun DropitBrandMark(
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
    contentDescription: String? = null,
) {
    val colors = DropitTheme.colors
    val tileColor = colors.fg
    val glyphColor = if (colors.isDark) colors.bg else DropitBrandTokens.LightGlyph
    val dotColor = colors.brand

    val paths = remember { buildBrandMarkPaths() }
    val semanticsModifier = if (contentDescription != null) {
        modifier.semantics { this.contentDescription = contentDescription }
    } else {
        modifier
    }

    Canvas(modifier = semanticsModifier.size(size)) {
        val canvasSize = this.size
        val scale = minOf(canvasSize.width, canvasSize.height) / BRAND_VIEWPORT_SIZE
        withTransform({
            translate(
                left = (canvasSize.width - BRAND_VIEWPORT_SIZE * scale) / 2f - BRAND_ORIGIN_X * scale,
                top = (canvasSize.height - BRAND_VIEWPORT_SIZE * scale) / 2f - BRAND_ORIGIN_Y * scale,
            )
            scale(scaleX = scale, scaleY = scale, pivot = Offset.Zero)
        }) {
            drawPath(path = paths.tileNotched, color = tileColor)
            drawPath(path = paths.glyphD, color = glyphColor)
            drawCircle(
                color = dotColor,
                radius = BRAND_DOT_RADIUS,
                center = Offset(BRAND_DOT_CX, BRAND_DOT_CY),
            )
        }
    }
}

/**
 * Horizontal brand lockup combining [DropitBrandMark] with the `dropit` wordmark and optional subtitle.
 */
@Composable
fun DropitBrandLockup(
    modifier: Modifier = Modifier,
    markSize: Dp = 40.dp,
    subtitle: String? = null,
) {
    val colors = DropitTheme.colors
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        DropitBrandMark(size = markSize)
        Column {
            Text(
                text = "dropit",
                style = MaterialTheme.typography.titleLarge,
                color = colors.fg,
            )
            if (!subtitle.isNullOrBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.fg3,
                )
            }
        }
    }
}

object DropitBrandTokens {
    val LightTile = Color(0xFF1D1B18)
    val LightGlyph = Color(0xFFFAFAF8)
    val LightDot = Color(0xFFD0021B)
    val LightLauncherBg = Color(0xFFF4F2EE)

    val DarkTile = Color(0xFFEEEBE6)
    val DarkGlyph = Color(0xFF121110)
    val DarkDot = Color(0xFFF0434F)
}

private const val BRAND_ORIGIN_X = 29.0f
private const val BRAND_ORIGIN_Y = 28.6f
private const val BRAND_VIEWPORT_SIZE = 50.4f
private const val BRAND_DOT_CX = 72.0f
private const val BRAND_DOT_CY = 36.0f
private const val BRAND_DOT_RADIUS = 7.4f
private const val BRAND_NOTCH_RADIUS = 9.8f

private data class BrandMarkPaths(
    val tileNotched: Path,
    val glyphD: Path,
)

private fun buildBrandMarkPaths(): BrandMarkPaths {
    val tileRect = Path().apply {
        addRoundRect(
            RoundRect(
                left = 29.0f,
                top = 33.0f,
                right = 75.0f,
                bottom = 79.0f,
                cornerRadius = CornerRadius(10.0f, 10.0f),
            ),
        )
    }
    val dotNotch = Path().apply {
        addOval(
            Rect(
                left = BRAND_DOT_CX - BRAND_NOTCH_RADIUS,
                top = BRAND_DOT_CY - BRAND_NOTCH_RADIUS,
                right = BRAND_DOT_CX + BRAND_NOTCH_RADIUS,
                bottom = BRAND_DOT_CY + BRAND_NOTCH_RADIUS,
            ),
        )
    }
    val tileNotched = Path.combine(PathOperation.Difference, tileRect, dotNotch)

    val glyphD = Path().apply {
        fillType = PathFillType.EvenOdd
        // Outer contour of lowercase geometric sans-serif 'd' (mirrors ic_launcher_foreground.xml)
        moveTo(61.5f, 42.2f)
        lineTo(61.5f, 69.2f)
        lineTo(57.3f, 69.2f)
        lineTo(57.3f, 66.5f)
        cubicTo(55.9f, 68.5f, 53.5f, 69.6f, 50.6f, 69.6f)
        cubicTo(45.6f, 69.6f, 42.1f, 65.6f, 42.1f, 59.9f)
        cubicTo(42.1f, 54.2f, 45.6f, 50.2f, 50.6f, 50.2f)
        cubicTo(53.5f, 50.2f, 55.9f, 51.3f, 57.2f, 53.3f)
        lineTo(57.2f, 42.2f)
        close()

        // Inner counter contour
        moveTo(51.7f, 53.8f)
        cubicTo(48.4f, 53.8f, 46.5f, 56.3f, 46.5f, 59.9f)
        cubicTo(46.5f, 63.5f, 48.4f, 66.0f, 51.7f, 66.0f)
        cubicTo(55.0f, 66.0f, 57.2f, 63.5f, 57.2f, 59.9f)
        cubicTo(57.2f, 56.3f, 55.0f, 53.8f, 51.7f, 53.8f)
        close()
    }

    return BrandMarkPaths(
        tileNotched = tileNotched,
        glyphD = glyphD,
    )
}
