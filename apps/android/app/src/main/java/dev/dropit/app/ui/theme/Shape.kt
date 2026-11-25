package dev.dropit.app.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Paper corner radius hierarchy aligned with `docs/android-native-ux-spec.md` §1.6
 * (`--radius: 7px` baseline).
 */
@Immutable
data class DropitShapes(
    val xs: RoundedCornerShape = RoundedCornerShape(3.dp),
    val sm: RoundedCornerShape = RoundedCornerShape(5.dp),
    val md: RoundedCornerShape = RoundedCornerShape(7.dp),
    val lg: RoundedCornerShape = RoundedCornerShape(10.dp),
    val sheet: RoundedCornerShape = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp),
    val pill: Shape = CircleShape,
)

val DefaultDropitShapes = DropitShapes()

val DropitMaterialShapes = Shapes(
    extraSmall = DefaultDropitShapes.xs,
    small = DefaultDropitShapes.sm,
    medium = DefaultDropitShapes.md,
    large = DefaultDropitShapes.lg,
    extraLarge = DefaultDropitShapes.sheet,
)

/**
 * Paper elevation levels (spec §1.6): Light mode uses crisp warm shadows; Dark mode relies on 1.dp borders.
 */
object DropitElevation {
    fun card(isDark: Boolean): Dp = if (isDark) 0.dp else 1.dp
    fun floating(isDark: Boolean): Dp = if (isDark) 2.dp else 3.dp
    fun modal(isDark: Boolean): Dp = if (isDark) 6.dp else 8.dp
}
