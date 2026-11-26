package dev.dropit.app.data.transfer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.URI

/**
 * Abstraction for verifying whether a previously saved local download URI still exists and is readable.
 * Injectable for deterministic unit tests.
 */
fun interface LocalSavedFileChecker {
    suspend fun exists(uriString: String, expectedSize: Long): Boolean
}

/**
 * Pure JVM filesystem checker used as default in unit tests without Android [Context].
 */
object FileSystemLocalSavedFileChecker : LocalSavedFileChecker {
    override suspend fun exists(uriString: String, expectedSize: Long): Boolean = withContext(Dispatchers.IO) {
        val trimmed = uriString.trim()
        if (trimmed.isEmpty()) return@withContext false
        if (trimmed.startsWith("content://", ignoreCase = true)) {
            return@withContext false
        }
        val file = resolveLocalFile(trimmed) ?: return@withContext false
        if (!file.isFile || !file.canRead()) return@withContext false
        val actualSize = file.length()
        if (expectedSize > 0L && actualSize != expectedSize) return@withContext false
        true
    }

    internal fun resolveLocalFile(uriString: String): File? {
        if (uriString.startsWith("file://", ignoreCase = true)) {
            val viaUri = runCatching { File(URI(uriString)) }.getOrNull()
            if (viaUri != null) return viaUri
            val rawPath = uriString.removePrefix("file://").removePrefix("FILE://")
            return rawPath.takeIf { it.isNotBlank() }?.let { File(it) }
        }
        if (uriString.contains("://")) return null
        return File(uriString)
    }
}

/**
 * Production Android implementation verifying both `content://` (MediaStore Downloads / FileProvider)
 * and `file://` / local file paths strictly on [ioDispatcher].
 */
class AndroidLocalSavedFileChecker(
    context: Context,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : LocalSavedFileChecker {
    private val appContext = context.applicationContext

    override suspend fun exists(uriString: String, expectedSize: Long): Boolean = withContext(ioDispatcher) {
        val trimmed = uriString.trim()
        if (trimmed.isEmpty()) return@withContext false
        val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return@withContext false
        val scheme = uri.scheme?.lowercase()

        when (scheme) {
            "content" -> verifyContentUri(uri, expectedSize)
            "file" -> {
                val path = uri.path?.takeIf { it.isNotBlank() } ?: return@withContext false
                verifyLocalFile(File(path), expectedSize)
            }
            null -> verifyLocalFile(File(trimmed), expectedSize)
            else -> false
        }
    }

    private fun verifyContentUri(uri: Uri, expectedSize: Long): Boolean {
        val resolver = appContext.contentResolver
        var queriedSize: Long? = null

        val querySucceeded = runCatching {
            resolver.query(
                uri,
                arrayOf(OpenableColumns.SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (!cursor.moveToFirst()) {
                    return false
                }
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    queriedSize = cursor.getLong(sizeIndex)
                }
            }
            true
        }.getOrDefault(false)

        if (!querySucceeded) return false
        val sizeFromCursor = queriedSize
        if (expectedSize > 0L && sizeFromCursor != null && sizeFromCursor >= 0L && sizeFromCursor != expectedSize) {
            return false
        }

        return runCatching {
            resolver.openAssetFileDescriptor(uri, "r")?.use { afd ->
                val fdLength = afd.length
                if (expectedSize > 0L && fdLength >= 0L && fdLength != expectedSize) {
                    false
                } else {
                    true
                }
            } ?: false
        }.getOrDefault(false)
    }

    private fun verifyLocalFile(file: File, expectedSize: Long): Boolean {
        if (!file.isFile || !file.canRead()) return false
        if (expectedSize > 0L && file.length() != expectedSize) return false
        return true
    }
}
