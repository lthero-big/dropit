package dev.dropit.app.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Verifies exact token parity between `ui/theme/` and `docs/android-native-ux-spec.md` §1.2-§1.7.
 */
class PaperThemeTokensTest {

    @Test
    fun lightColors_matchUxSpecExactly() {
        val c = DropitLightColors
        assertEquals(Color(0xFFF4F2EE), c.bg)
        assertEquals(Color(0xFFFAF9F7), c.surface0)
        assertEquals(Color(0xFFFFFFFF), c.surface1)
        assertEquals(Color(0xFFF0EDE8), c.surface2)
        assertEquals(Color(0xFFEBE8E2), c.surfaceSunken)
        assertEquals(Color(0xFFE7E3DC), c.line1)
        assertEquals(Color(0xFFD9D4CB), c.line2)
        assertEquals(Color(0xFFBDB6AA), c.line3)
        assertEquals(Color(0xFF1D1B18), c.fg)
        assertEquals(Color(0xFF4A4640), c.fg2)
        assertEquals(Color(0xFF7D776D), c.fg3)
        assertEquals(Color(0xFFA59F94), c.fg4)
        assertEquals(Color(0xFFD0021B), c.brand)
        assertEquals(Color(0xFFFFFFFF), c.brandFg)
        assertEquals(Color(0xFF2F7D4F), c.ok)
        assertEquals(Color(0xFFB45309), c.warn)
        assertEquals(Color(0xFFD0021B), c.destructive)
        assertEquals(Color(0xFFF6F4F0), c.codeBg)
        assertEquals(Color(0xFF6B6A8F), c.devMac)
        assertEquals(Color(0xFF3F7F74), c.devPhone)
        assertEquals(Color(0xFFA86B2D), c.devPad)
        assertEquals(Color(0xFF4D6F9C), c.devPc)
    }

    @Test
    fun darkColors_matchUxSpecAndNeverUsePureBlack() {
        val c = DropitDarkColors
        assertEquals(Color(0xFF121110), c.bg)
        assertEquals(Color(0xFF171615), c.surface0)
        assertEquals(Color(0xFF1D1C1A), c.surface1)
        assertEquals(Color(0xFF252321), c.surface2)
        assertEquals(Color(0xFF0E0D0C), c.surfaceSunken)
        assertEquals(Color(0xFF2A2826), c.line1)
        assertEquals(Color(0xFF36332F), c.line2)
        assertEquals(Color(0xFF4D4943), c.line3)
        assertEquals(Color(0xFFEEEBE6), c.fg)
        assertEquals(Color(0xFFC7C2BA), c.fg2)
        assertEquals(Color(0xFF958F85), c.fg3)
        assertEquals(Color(0xFF6C675F), c.fg4)
        assertEquals(Color(0xFFF0434F), c.brand)
        assertEquals(Color(0xFF160707), c.brandFg)
        assertEquals(Color(0xFF5CC28A), c.ok)
        assertEquals(Color(0xFFE0A165), c.warn)
        assertEquals(Color(0xFF151413), c.codeBg)

        // Never pure black #000000 for canvas or card surfaces
        assertNotEquals(Color.Black, c.bg)
        assertNotEquals(Color.Black, c.surface0)
        assertNotEquals(Color.Black, c.surface1)

        // Material 3 surfaceTint must remain transparent to avoid purple tonal elevation
        assertEquals(Color.Transparent, toMaterial3ColorScheme(DropitLightColors).surfaceTint)
        assertEquals(Color.Transparent, toMaterial3ColorScheme(DropitDarkColors).surfaceTint)
    }

    @Test
    fun groupHueAndDeviceColorMapping_matchWebRules() {
        assertEquals(250f, groupHue("工作"))
        assertEquals(150f, groupHue("个人"))
        assertEquals(DropitLightColors.devPc, DropitLightColors.deviceColor("cli"))
        assertEquals(DropitLightColors.devPhone, DropitLightColors.deviceColor("phone"))
        assertEquals(120, DropitMotion.DUR_FAST)
        assertEquals(200, DropitMotion.DUR_BASE)
        assertEquals(320, DropitMotion.DUR_SLOW)
    }
}
