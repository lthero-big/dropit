package dev.dropit.app.data.transfer

import java.util.ArrayDeque
import kotlin.math.ceil

data class TransferRuntimeMetrics(
    val transferredBytes: Long = 0L,
    val speedBytesPerSec: Long = 0L,
    val etaSeconds: Long? = null,
)

/**
 * Sliding-window transfer speed (bytes/sec) and remaining-time (ETA seconds) estimator.
 * Thread-safe and deterministic with an injectable monotonic clock for unit testing.
 */
class TransferSpeedTracker(
    private val windowMs: Long = 3_000L,
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) {
    private data class Sample(val timestampMs: Long, val bytes: Long)

    private val samples = ArrayDeque<Sample>()

    @Synchronized
    fun reset() {
        samples.clear()
    }

    @Synchronized
    fun record(transferredBytes: Long, totalBytes: Long): TransferRuntimeMetrics {
        val now = clockMs()
        val safeBytes = transferredBytes.coerceAtLeast(0L)
        if (samples.isEmpty() || safeBytes < samples.last.bytes) {
            samples.clear()
            samples.addLast(Sample(now, safeBytes))
            return TransferRuntimeMetrics(transferredBytes = safeBytes, speedBytesPerSec = 0L, etaSeconds = null)
        }
        val last = samples.last
        if (now > last.timestampMs || safeBytes > last.bytes) {
            samples.addLast(Sample(now, safeBytes))
        }
        while (samples.size > 2 && now - samples.first.timestampMs > windowMs) {
            samples.removeFirst()
        }
        val oldest = samples.first
        val deltaMs = (now - oldest.timestampMs).coerceAtLeast(0L)
        val deltaBytes = (safeBytes - oldest.bytes).coerceAtLeast(0L)
        val speed = if (deltaMs > 0L && deltaBytes > 0L) {
            (deltaBytes * 1_000L) / deltaMs
        } else {
            0L
        }
        val remaining = (totalBytes - safeBytes).coerceAtLeast(0L)
        val eta = when {
            remaining == 0L && totalBytes > 0L -> 0L
            speed > 0L && totalBytes > 0L -> ceil(remaining.toDouble() / speed.toDouble()).toLong()
            else -> null
        }
        return TransferRuntimeMetrics(
            transferredBytes = safeBytes,
            speedBytesPerSec = speed,
            etaSeconds = eta,
        )
    }
}
