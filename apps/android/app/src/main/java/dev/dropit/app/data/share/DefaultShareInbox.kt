package dev.dropit.app.data.share

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.core.content.IntentCompat
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.repository.PendingShare
import dev.dropit.app.core.repository.ShareInbox
import dev.dropit.app.core.repository.StagedShareFile
import dev.dropit.app.data.transfer.AndroidDownloadSink
import dev.dropit.app.data.transfer.DownloadName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale
import java.util.UUID

/**
 * Platform-independent representation of a parsed share payload before staging.
 */
data class ExtractedSharePayload(
    val text: String? = null,
    val subject: String? = null,
    val streams: List<ShareStreamSource> = emptyList(),
)

data class ShareStreamSource(
    val displayName: String,
    val mimeType: String,
    val declaredSizeBytes: Long = -1L,
    val openStream: () -> InputStream?,
)

/**
 * Extracts text/subject and stream sources from an Android ACTION_SEND / ACTION_SEND_MULTIPLE Intent.
 * Abstracted so JVM unit tests can exercise staging, merging, persistence, and cleanup deterministically.
 */
fun interface ShareIntentExtractor {
    fun extract(intent: Intent?): ExtractedSharePayload?
}

class AndroidShareIntentExtractor(
    context: Context,
) : ShareIntentExtractor {
    private val appContext = context.applicationContext

    override fun extract(intent: Intent?): ExtractedSharePayload? {
        if (intent == null) return null
        // Ignore intents replayed when re-opening the app from Android Recents.
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return null

        val action = intent.action ?: return null
        val isSingle = action == Intent.ACTION_SEND
        val isMultiple = action == Intent.ACTION_SEND_MULTIPLE
        if (!isSingle && !isMultiple) return null

        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)

        val uris = LinkedHashSet<Uri>()
        if (isSingle) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
        } else {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                ?.filterNotNull()
                ?.let { uris.addAll(it) }
        }
        if (uris.isEmpty()) {
            val clip = intent.clipData
            if (clip != null) {
                for (i in 0 until clip.itemCount) {
                    clip.getItemAt(i)?.uri?.let { uris.add(it) }
                }
            }
        }

        val resolver = appContext.contentResolver
        val intentMime = intent.type
        val sources = uris.map { uri ->
            val (name, size) = describeUri(resolver, uri)
            val mime = resolveMime(resolver, uri, intentMime, name)
            ShareStreamSource(
                displayName = name,
                mimeType = mime,
                declaredSizeBytes = size,
                openStream = { resolver.openInputStream(uri) },
            )
        }

        return ExtractedSharePayload(
            text = text,
            subject = subject,
            streams = sources,
        )
    }

    private fun describeUri(resolver: ContentResolver, uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment
        var size = -1L
        runCatching {
            resolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) {
                        name = cursor.getString(nameIdx)
                    }
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                        size = cursor.getLong(sizeIdx)
                    }
                }
            }
        }
        val clean = DownloadName.sanitize(name) ?: "shared"
        return clean to size
    }

    private fun resolveMime(
        resolver: ContentResolver,
        uri: Uri,
        intentType: String?,
        fileName: String,
    ): String {
        val fromResolver = runCatching { resolver.getType(uri) }.getOrNull()
        val candidate = when {
            !fromResolver.isNullOrBlank() && !fromResolver.contains('*') -> fromResolver
            !intentType.isNullOrBlank() && !intentType.contains('*') -> intentType
            else -> null
        }
        val base = DownloadName.baseMime(candidate)
        if (base.isNotEmpty() && !DownloadName.genericMime(base)) {
            return base
        }
        val ext = DownloadName.extension(fileName)
        if (ext != null) {
            val fromMap = runCatching {
                MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase(Locale.ROOT))
            }.getOrNull() ?: DownloadName.defaultMimeForExtension(ext)
            if (!fromMap.isNullOrBlank()) return DownloadName.baseMime(fromMap)
        }
        return base.ifEmpty { "application/octet-stream" }
    }
}

/**
 * Concrete [ShareInbox] implementation that immediately copies shared content:// URIs into an
 * app-private staging directory and persists metadata to disk so shares survive backgrounding
 * and process death (e.g., while completing login in Custom Tabs).
 */
class DefaultShareInbox(
    private val stagingRootDir: File,
    private val extractor: ShareIntentExtractor,
    private val json: Json = DropitApiClient.defaultJson(),
    private val clockMs: () -> Long = { System.currentTimeMillis() },
) : ShareInbox {

    @Serializable
    private data class PersistedShareFile(
        val id: String,
        val displayName: String,
        val mimeType: String,
        val sizeBytes: Long,
        val stagedFilePath: String,
    )

    @Serializable
    private data class PersistedPendingShare(
        val id: String,
        val text: String? = null,
        val files: List<PersistedShareFile> = emptyList(),
        val receivedAt: Long,
    )

    private val mutex = Mutex()
    private val _pendingShare = MutableStateFlow<PendingShare?>(null)
    override val pendingShare: StateFlow<PendingShare?> = _pendingShare.asStateFlow()

    private val manifestFile: File
        get() = File(stagingRootDir, MANIFEST_FILE_NAME)

    init {
        restoreFromDiskIfValid()
    }

    override suspend fun captureIntent(intent: Intent?): Boolean {
        val extracted = extractor.extract(intent) ?: return false
        return stagePayload(extracted)
    }

    /**
     * Stages an already-extracted share payload directly (used internally and by JVM unit tests).
     */
    suspend fun stagePayload(payload: ExtractedSharePayload): Boolean = withContext(Dispatchers.IO) {
        mutex.withLock {
            val mergedText = ServerUrl.sharedText(payload.text, payload.subject)
            if (mergedText == null && payload.streams.isEmpty()) {
                return@withLock false
            }

            val shareId = UUID.randomUUID().toString()
            val shareDir = File(stagingRootDir, shareId)
            val stagedFiles = ArrayList<StagedShareFile>(payload.streams.size)

            if (payload.streams.isNotEmpty()) {
                if (!shareDir.isDirectory && !shareDir.mkdirs()) {
                    throw IOException("无法创建分享暂存目录")
                }
                payload.streams.forEachIndexed { index, source ->
                    val staged = copySourceToStaging(shareDir, index, source)
                    if (staged != null) {
                        stagedFiles.add(staged)
                    }
                }
            }

            if (mergedText == null && stagedFiles.isEmpty()) {
                runCatching { shareDir.deleteRecursively() }
                return@withLock false
            }

            // Clean up any previously unconsumed pending share's staged files before replacing.
            val previous = _pendingShare.value
            if (previous != null) {
                deleteShareFiles(previous)
            }

            val next = PendingShare(
                id = shareId,
                text = mergedText,
                files = stagedFiles,
                receivedAt = clockMs(),
            )
            persistManifest(next)
            _pendingShare.value = next
            true
        }
    }

    /**
     * Consumes the current pending share for submission to [dev.dropit.app.core.repository.TransferManager].
     * Staged files are intentionally kept on disk because ownership transfers to TransferManager,
     * which deletes them once each upload succeeds or is cancelled.
     */
    override suspend fun consumePendingShare(): PendingShare? = withContext(Dispatchers.IO) {
        mutex.withLock {
            val current = _pendingShare.value
            _pendingShare.value = null
            runCatching { manifestFile.delete() }
            current
        }
    }

    /**
     * Discards the pending share and immediately deletes all staged files belonging to it.
     */
    override suspend fun discardPendingShare() = withContext(Dispatchers.IO) {
        mutex.withLock {
            val current = _pendingShare.value
            _pendingShare.value = null
            runCatching { manifestFile.delete() }
            if (current != null) {
                deleteShareFiles(current)
            }
        }
    }

    private fun copySourceToStaging(
        shareDir: File,
        index: Int,
        source: ShareStreamSource,
    ): StagedShareFile? {
        val rawName = DownloadName.sanitize(source.displayName) ?: "shared"
        val cleanMime = DownloadName.baseMime(source.mimeType).ifBlank { "application/octet-stream" }
        val finalName = if (DownloadName.extension(rawName) == null && !DownloadName.genericMime(cleanMime)) {
            val guessedExt = DownloadName.defaultExtensionForMime(cleanMime)
            if (guessedExt != null) DownloadName.sanitize("$rawName.$guessedExt") ?: rawName else rawName
        } else {
            rawName
        }
        val fileId = "f${index}_${UUID.randomUUID().toString().take(8)}"
        val target = File(shareDir, "${fileId}_$finalName")
        runCatching { AndroidDownloadSink.ensureWithinDirectory(stagingRootDir, target) }
            .onFailure { return null }

        return try {
            val input = source.openStream() ?: return null
            val bytesCopied = input.use { stream ->
                FileOutputStream(target).use { out ->
                    stream.copyTo(out, bufferSize = 64 * 1024)
                }
            }
            StagedShareFile(
                id = fileId,
                displayName = finalName,
                mimeType = cleanMime,
                sizeBytes = bytesCopied,
                stagedFilePath = target.absolutePath,
            )
        } catch (_: Exception) {
            runCatching { target.delete() }
            null
        }
    }

    private fun persistManifest(share: PendingShare) {
        if (!stagingRootDir.isDirectory) stagingRootDir.mkdirs()
        val persisted = PersistedPendingShare(
            id = share.id,
            text = share.text,
            files = share.files.map { f ->
                PersistedShareFile(
                    id = f.id,
                    displayName = f.displayName,
                    mimeType = f.mimeType,
                    sizeBytes = f.sizeBytes,
                    stagedFilePath = f.stagedFilePath,
                )
            },
            receivedAt = share.receivedAt,
        )
        val tmp = File(stagingRootDir, "$MANIFEST_FILE_NAME.tmp")
        runCatching {
            tmp.writeText(json.encodeToString(persisted), Charsets.UTF_8)
            if (manifestFile.exists()) manifestFile.delete()
            if (!tmp.renameTo(manifestFile)) {
                manifestFile.writeText(tmp.readText(Charsets.UTF_8), Charsets.UTF_8)
                tmp.delete()
            }
        }.onFailure {
            runCatching { tmp.delete() }
        }
    }

    private fun restoreFromDiskIfValid() {
        if (!manifestFile.isFile) return
        val restored = runCatching {
            val raw = manifestFile.readText(Charsets.UTF_8)
            val parsed = json.decodeFromString(PersistedPendingShare.serializer(), raw)
            val validFiles = parsed.files.mapNotNull { f ->
                val file = File(f.stagedFilePath)
                val withinRoot = runCatching {
                    AndroidDownloadSink.ensureWithinDirectory(stagingRootDir, file)
                    true
                }.getOrDefault(false)
                if (withinRoot && file.isFile && file.canRead()) {
                    StagedShareFile(
                        id = f.id,
                        displayName = f.displayName,
                        mimeType = f.mimeType,
                        sizeBytes = file.length(),
                        stagedFilePath = file.absolutePath,
                    )
                } else {
                    null
                }
            }
            PendingShare(
                id = parsed.id,
                text = parsed.text?.takeIf { it.isNotBlank() },
                files = validFiles,
                receivedAt = parsed.receivedAt,
            )
        }.getOrNull()

        if (restored != null && !restored.isEmpty) {
            _pendingShare.value = restored
        } else {
            runCatching { manifestFile.delete() }
        }
    }

    private fun deleteShareFiles(share: PendingShare) {
        val shareDir = File(stagingRootDir, share.id)
        val isWithinRoot = runCatching {
            AndroidDownloadSink.ensureWithinDirectory(stagingRootDir, shareDir)
            true
        }.getOrDefault(false)
        if (isWithinRoot && shareDir.exists()) {
            runCatching { shareDir.deleteRecursively() }
        } else {
            for (file in share.files) {
                val target = File(file.stagedFilePath)
                runCatching {
                    AndroidDownloadSink.ensureWithinDirectory(stagingRootDir, target)
                    target.delete()
                }
            }
        }
    }

    companion object {
        const val STAGING_DIR_NAME = "share_staging"
        private const val MANIFEST_FILE_NAME = "pending_share.json"
    }
}
