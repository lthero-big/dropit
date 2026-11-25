package dev.dropit.app.ui.theme

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween

/**
 * Motion timing and easing tokens matching `docs/android-native-ux-spec.md` §1.7
 * and `apps/web/src/lib/motion.ts`.
 */
object DropitMotion {
    const val DUR_FAST = 120
    const val DUR_BASE = 200
    const val DUR_SLOW = 320

    val EaseEnter = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)
    val EaseExit = CubicBezierEasing(0.55f, 0f, 1f, 0.45f)

    fun <T> fastEnter(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else tween(DUR_FAST, easing = EaseEnter)

    fun <T> fastExit(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else tween(DUR_FAST, easing = EaseExit)

    fun <T> baseEnter(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else tween(DUR_BASE, easing = EaseEnter)

    fun <T> slowEnter(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else tween(DUR_SLOW, easing = EaseEnter)

    fun <T> springSettle(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else spring(dampingRatio = 0.95f, stiffness = 420f)

    fun <T> springBounce(reducedMotion: Boolean = false): FiniteAnimationSpec<T> =
        if (reducedMotion) snap() else spring(dampingRatio = 0.55f, stiffness = 520f)

    fun isSystemReducedMotion(context: Context): Boolean {
        val scale = runCatching {
            Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            )
        }.getOrDefault(1f)
        return scale == 0f
    }
}
