package dev.dropit.app.core.repository

import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.MeResponse
import dev.dropit.app.core.network.ScopeDetails
import dev.dropit.app.core.network.Space
import dev.dropit.app.core.network.TargetScope

interface SpaceRepository {
    suspend fun getMe(): MeResponse
    suspend fun getSpaces(): List<Space>
    suspend fun getScopeDetails(scope: TargetScope): ScopeDetails
    fun pickDefaultSpace(spaces: List<Space>, userId: String): Space?
}

class DefaultSpaceRepository(
    private val apiClient: DropitApiClient,
) : SpaceRepository {
    override suspend fun getMe(): MeResponse = apiClient.getMe()

    override suspend fun getSpaces(): List<Space> = apiClient.getSpaces()

    override suspend fun getScopeDetails(scope: TargetScope): ScopeDetails = apiClient.getScopeDetails(scope)

    /**
     * Picks the user's own permanent private space (matching mobile/www/core.js pickSpace),
     * falling back to the first available space.
     */
    override fun pickDefaultSpace(spaces: List<Space>, userId: String): Space? =
        spaces.firstOrNull { it.isPersonalFor(userId) } ?: spaces.firstOrNull()
}
