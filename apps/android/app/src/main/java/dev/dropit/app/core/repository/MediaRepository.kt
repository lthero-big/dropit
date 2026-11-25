package dev.dropit.app.core.repository

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import coil.ImageLoader
import dev.dropit.app.core.network.ServerUrl
import dev.dropit.app.core.network.TargetScope
import okhttp3.OkHttpClient

/**
 * Decoupling contract for authenticated image/media/text preview loading (Stage 3A -> Stage 3B).
 */
interface MediaRepository {
    suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String
    suspend fun previewUrl(scope: TargetScope, itemId: String): String
    suspend fun mediaUrl(scope: TargetScope, itemId: String): String
    suspend fun downloadUrl(scope: TargetScope, itemId: String): String
    fun createImageLoader(): ImageLoader
    fun createMediaDataSourceFactory(): DataSource.Factory
    suspend fun fetchTextContent(scope: TargetScope, itemId: String, maxBytes: Int = 512 * 1024): String
    suspend fun clearCaches()
}

class PlaceholderMediaRepository(
    private val context: Context,
    private val okHttpClient: OkHttpClient,
    private val serverOriginProvider: suspend () -> String?,
) : MediaRepository {
    override suspend fun thumbnailUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "thumbnail")

    override suspend fun previewUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "preview")

    override suspend fun mediaUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "media")

    override suspend fun downloadUrl(scope: TargetScope, itemId: String): String =
        buildItemUrl(scope, itemId, "download")

    override fun createImageLoader(): ImageLoader =
        ImageLoader.Builder(context.applicationContext)
            .okHttpClient(okHttpClient)
            .build()

    @OptIn(UnstableApi::class)
    override fun createMediaDataSourceFactory(): DataSource.Factory =
        OkHttpDataSource.Factory(okHttpClient)

    override suspend fun fetchTextContent(scope: TargetScope, itemId: String, maxBytes: Int): String = ""

    override suspend fun clearCaches() = Unit

    private suspend fun buildItemUrl(scope: TargetScope, itemId: String, suffix: String): String {
        val origin = serverOriginProvider().orEmpty().trimEnd('/')
        return "$origin${scope.apiBasePath}/items/${ServerUrl.encodeURIComponent(itemId)}/$suffix"
    }
}
