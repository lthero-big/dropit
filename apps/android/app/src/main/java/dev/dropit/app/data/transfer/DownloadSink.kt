package dev.dropit.app.data.transfer

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.Locale

data class SavedDownloadResult(
    val uriString: String,
    val contentUri: Uri? = null,
    val savedFile: File? = null,
)

/**
 * Platform storage abstraction for persisting completed downloads to system Downloads
 * (MediaStore on API 29+, safe external downloads directory on API 23-28) and to the
 * FileProvider-backed cache for re-sharing to other apps.
 */
interface DownloadSink {
    fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String): SavedDownloadResult
    fun saveToShareCache(sourceFile: File, itemId: String, fileName: String): SavedDownloadResult
    fun mimeFromExtension(ext: String): String?
    fun extensionFromMime(mime: String): String?
}

class AndroidDownloadSink(
    context: Context,
) : DownloadSink {
    private val appContext = context.applicationContext
    private val authority = "${appContext.packageName}.fileprovider"

    override fun saveToSystemDownloads(sourceFile: File, fileName: String, mimeType: String): SavedDownloadResult {
        val safeName = DownloadName.sanitize(fileName) ?: "dropit-download"
        val safeMime = DownloadName.baseMime(mimeType).ifBlank { "application/octet-stream" }
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveViaMediaStore(sourceFile, safeName, safeMime)
        } else {
            saveViaLegacyExternalDir(sourceFile, safeName)
        }
    }

    override fun saveToShareCache(sourceFile: File, itemId: String, fileName: String): SavedDownloadResult {
        val safeName = DownloadName.sanitize(fileName) ?: "dropit-download"
        val safeId = itemId.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "item" }
        val shareRoot = File(appContext.cacheDir, SHARE_CACHE_DIR_NAME)
        val itemDir = File(shareRoot, safeId)
        if (!itemDir.isDirectory && !itemDir.mkdirs()) {
            throw IOException("无法创建分享缓存目录")
        }
        pruneOldShareCache(shareRoot, keepDir = itemDir)
        val target = File(itemDir, safeName)
        ensureWithinDirectory(shareRoot, target)
        copyFileAtomically(sourceFile, target)
        val uri = FileProvider.getUriForFile(appContext, authority, target)
        return SavedDownloadResult(
            uriString = uri.toString(),
            contentUri = uri,
            savedFile = target,
        )
    }

    override fun mimeFromExtension(ext: String): String? {
        val normalized = ext.lowercase(Locale.ROOT)
        return runCatching { MimeTypeMap.getSingleton().getMimeTypeFromExtension(normalized) }.getOrNull()
            ?: DownloadName.defaultMimeForExtension(normalized)
    }

    override fun extensionFromMime(mime: String): String? {
        val normalized = DownloadName.baseMime(mime)
        return runCatching { MimeTypeMap.getSingleton().getExtensionFromMimeType(normalized) }.getOrNull()
            ?: DownloadName.defaultExtensionForMime(normalized)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun saveViaMediaStore(sourceFile: File, fileName: String, mimeType: String): SavedDownloadResult {
        val resolver = appContext.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("无法写入系统下载目录")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                FileInputStream(sourceFile).use { input ->
                    input.copyTo(out, bufferSize = 64 * 1024)
                }
                out.flush()
            } ?: throw IOException("无法打开系统下载输出流")
            val publish = ContentValues().apply {
                put(MediaStore.Downloads.IS_PENDING, 0)
            }
            resolver.update(uri, publish, null, null)
            return SavedDownloadResult(uriString = uri.toString(), contentUri = uri)
        } catch (e: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
    }

    @Suppress("DEPRECATION")
    private fun saveViaLegacyExternalDir(sourceFile: File, fileName: String): SavedDownloadResult {
        // Prefer public Downloads when writable; safely fall back to app-specific external Downloads
        // on API 23-28 when WRITE_EXTERNAL_STORAGE is not granted.
        val publicDir = runCatching {
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        }.getOrNull()
        val targetDir = when {
            publicDir != null && (publicDir.isDirectory || publicDir.mkdirs()) && publicDir.canWrite() -> publicDir
            else -> appContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                ?: File(appContext.filesDir, "downloads")
        }
        if (!targetDir.isDirectory && !targetDir.mkdirs()) {
            throw IOException("无法创建下载目录")
        }
        val target = uniqueFile(targetDir, fileName)
        ensureWithinDirectory(targetDir, target)
        copyFileAtomically(sourceFile, target)
        val uri = runCatching {
            FileProvider.getUriForFile(appContext, authority, target)
        }.getOrElse { Uri.fromFile(target) }
        return SavedDownloadResult(
            uriString = uri.toString(),
            contentUri = uri,
            savedFile = target,
        )
    }

    private fun pruneOldShareCache(root: File, keepDir: File) {
        val dirs = root.listFiles()?.filter { it != keepDir }?.sortedByDescending { it.lastModified() } ?: return
        if (dirs.size <= MAX_CACHED_SHARE_ENTRIES) return
        dirs.drop(MAX_CACHED_SHARE_ENTRIES).forEach { stale ->
            runCatching { stale.deleteRecursively() }
        }
    }

    companion object {
        const val SHARE_CACHE_DIR_NAME = "shared_downloads"
        private const val MAX_CACHED_SHARE_ENTRIES = 16

        fun uniqueFile(dir: File, fileName: String): File {
            val initial = File(dir, fileName)
            if (!initial.exists()) return initial
            val ext = DownloadName.extension(fileName)
            val stem = if (ext != null) fileName.removeSuffix(".$ext") else fileName
            for (index in 1..999) {
                val candidateName = if (ext != null) "$stem ($index).$ext" else "$stem ($index)"
                val candidate = File(dir, candidateName)
                if (!candidate.exists()) return candidate
            }
            val fallbackName = if (ext != null) "${stem}_${System.currentTimeMillis()}.$ext" else "${stem}_${System.currentTimeMillis()}"
            return File(dir, fallbackName)
        }

        fun ensureWithinDirectory(root: File, candidate: File) {
            val rootPath = root.canonicalPath
            val candidatePath = candidate.canonicalPath
            if (candidatePath != rootPath && !candidatePath.startsWith("$rootPath${File.separator}")) {
                throw IOException("非法的目标文件路径")
            }
        }

        fun copyFileAtomically(source: File, target: File) {
            val parent = target.parentFile ?: throw IOException("目标父目录不存在")
            if (!parent.isDirectory && !parent.mkdirs()) {
                throw IOException("无法创建目标目录")
            }
            val tmp = File(parent, ".${target.name}.${System.nanoTime()}.tmp")
            try {
                FileInputStream(source).use { input ->
                    FileOutputStream(tmp).use { output ->
                        input.copyTo(output, bufferSize = 64 * 1024)
                        output.fd.sync()
                    }
                }
                if (target.exists() && !target.delete()) {
                    throw IOException("无法替换已有文件")
                }
                if (!tmp.renameTo(target)) {
                    FileInputStream(tmp).use { input ->
                        FileOutputStream(target).use { output ->
                            input.copyTo(output, bufferSize = 64 * 1024)
                        }
                    }
                    tmp.delete()
                }
            } catch (e: Exception) {
                tmp.delete()
                throw e
            }
        }
    }
}
