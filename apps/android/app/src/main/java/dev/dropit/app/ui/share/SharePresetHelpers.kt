package dev.dropit.app.ui.share

import dev.dropit.app.data.account.SharePresets

enum class ShareExpiryUnit(
    val label: String,
    val suffix: String,
    val max: Int,
    val hoursFactor: Int,
) {
    HOURS(label = "小时", suffix = "h", max = 87_600, hoursFactor = 1),
    DAYS(label = "天", suffix = "d", max = 3_650, hoursFactor = 24),
    MONTHS(label = "个月", suffix = "mo", max = 121, hoursFactor = 720),
}

data class CustomShareExpiry(
    val unit: ShareExpiryUnit,
    val value: Int,
    val hours: Long,
    val expiresIn: String,
    val label: String,
)

/**
 * Pure preset normalization & merging helpers matching `apps/web/src/lib/share-presets.ts`.
 */
object SharePresetHelpers {
    const val MAX_CUSTOM_ITEMS = 20
    const val MAX_CUSTOM_VIEWS = 1_000_000

    val DEFAULT_HOURS: List<Int> = listOf(1)
    val DEFAULT_DAYS: List<Int> = listOf(1, 3, 7)
    val DEFAULT_VIEWS: List<Int> = listOf(1, 5, 10)

    fun customExpiries(presets: SharePresets): List<CustomShareExpiry> {
        val list = mutableListOf<CustomShareExpiry>()
        presets.hours.filter { it > 0 }.distinct().forEach { v ->
            list += CustomShareExpiry(
                unit = ShareExpiryUnit.HOURS,
                value = v,
                hours = v.toLong() * ShareExpiryUnit.HOURS.hoursFactor,
                expiresIn = "${v}${ShareExpiryUnit.HOURS.suffix}",
                label = "$v ${ShareExpiryUnit.HOURS.label}",
            )
        }
        presets.days.filter { it > 0 }.distinct().forEach { v ->
            list += CustomShareExpiry(
                unit = ShareExpiryUnit.DAYS,
                value = v,
                hours = v.toLong() * ShareExpiryUnit.DAYS.hoursFactor,
                expiresIn = "${v}${ShareExpiryUnit.DAYS.suffix}",
                label = "$v ${ShareExpiryUnit.DAYS.label}",
            )
        }
        presets.months.filter { it > 0 }.distinct().forEach { v ->
            list += CustomShareExpiry(
                unit = ShareExpiryUnit.MONTHS,
                value = v,
                hours = v.toLong() * ShareExpiryUnit.MONTHS.hoursFactor,
                expiresIn = "${v}${ShareExpiryUnit.MONTHS.suffix}",
                label = "$v ${ShareExpiryUnit.MONTHS.label}",
            )
        }
        return list.sortedWith(compareBy<CustomShareExpiry> { it.hours }.thenBy { it.unit.ordinal })
    }

    /**
     * Merges built-in defaults (1h, 1d, 3d, 7d) with custom server presets (hours/days/months),
     * deduplicating by equivalent duration in hours (defaults win), sorting ascending, and
     * appending "never" ("不过期").
     */
    fun mergedExpiryOptions(presets: SharePresets): List<ShareExpiryOption> {
        val defaults = customExpiries(SharePresets(hours = DEFAULT_HOURS, days = DEFAULT_DAYS))
        val custom = customExpiries(presets)
        val seenHours = HashSet<Long>()
        val deduped = mutableListOf<CustomShareExpiry>()
        for (entry in defaults + custom) {
            if (seenHours.add(entry.hours)) {
                deduped += entry
            }
        }
        val sorted = deduped.sortedBy { it.hours }
        return sorted.map { ShareExpiryOption(value = it.expiresIn, label = it.label) } +
            ShareExpiryOption(value = "never", label = "不过期")
    }

    /**
     * Merges built-in defaults (1, 5, 10) with custom server views, deduplicating & sorting
     * ascending, and appending null ("不限").
     */
    fun mergedViewsOptions(presets: SharePresets): List<ShareViewsOption> {
        val merged = (DEFAULT_VIEWS + presets.views.filter { it > 0 }).distinct().sorted()
        return merged.map { count ->
            ShareViewsOption(
                value = count,
                label = if (count == 1) "仅一次" else "$count 次",
            )
        } + ShareViewsOption(value = null, label = "不限")
    }

    fun isDuplicateExpiry(presets: SharePresets, unit: ShareExpiryUnit, value: Int): Boolean {
        val candidateHours = value.toLong() * unit.hoursFactor
        val existingDefaults = customExpiries(SharePresets(hours = DEFAULT_HOURS, days = DEFAULT_DAYS))
        val existingCustom = customExpiries(presets)
        return (existingDefaults + existingCustom).any { it.hours == candidateHours }
    }

    fun isDuplicateViews(presets: SharePresets, value: Int): Boolean =
        value in DEFAULT_VIEWS || value in presets.views
}
