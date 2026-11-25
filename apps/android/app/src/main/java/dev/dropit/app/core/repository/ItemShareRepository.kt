package dev.dropit.app.core.repository

import dev.dropit.app.core.network.ItemShare
import dev.dropit.app.core.network.TargetScope

/**
 * Decoupling contract for Bearer-accessible per-item share links (Stage 3A -> Stage 3B).
 */
interface ItemShareRepository {
    suspend fun createShare(
        scope: TargetScope,
        itemId: String,
        expiresIn: String = "7d",
        maxViews: Int? = null,
    ): ItemShare

    suspend fun listShares(scope: TargetScope, itemId: String): List<ItemShare>
    suspend fun revokeShare(scope: TargetScope, shareId: String)
}

class PlaceholderItemShareRepository : ItemShareRepository {
    override suspend fun createShare(
        scope: TargetScope,
        itemId: String,
        expiresIn: String,
        maxViews: Int?,
    ): ItemShare = throw UnsupportedOperationException("ItemShareRepository implementation pending Stage 3A")

    override suspend fun listShares(scope: TargetScope, itemId: String): List<ItemShare> = emptyList()

    override suspend fun revokeShare(scope: TargetScope, shareId: String) = Unit
}
