package dev.dropit.app.ui.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabsHelperTest {

    @Test
    fun resolveCustomTabsPackage_prefersPreferredListThenFallsBackToAnyProvider() {
        assertTrue(CustomTabsHelper.PREFERRED_PACKAGES.first() == "com.android.chrome")

        val calls = mutableListOf<List<String>>()
        val chrome = CustomTabsHelper.resolveCustomTabsPackage { preferred ->
            calls.add(preferred)
            if (preferred.isNotEmpty()) "com.android.chrome" else "com.other.browser"
        }
        assertEquals("com.android.chrome", chrome)
        assertEquals(1, calls.size)
        assertEquals(CustomTabsHelper.PREFERRED_PACKAGES, calls.first())

        // When none of the preferred packages match, queries empty list for default Custom Tabs provider
        val fallbackCalls = mutableListOf<List<String>>()
        val fallback = CustomTabsHelper.resolveCustomTabsPackage { preferred ->
            fallbackCalls.add(preferred)
            if (preferred.isEmpty()) "com.vendor.customtabs" else null
        }
        assertEquals("com.vendor.customtabs", fallback)
        assertEquals(2, fallbackCalls.size)
        assertTrue(fallbackCalls[1].isEmpty())

        // Returns null when no Custom Tabs provider is installed
        assertNull(CustomTabsHelper.resolveCustomTabsPackage { null })
    }
}
