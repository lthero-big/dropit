package dev.dropit.app.core.repository

import dev.dropit.app.core.network.ClipItem
import dev.dropit.app.core.network.DropitApiClient
import dev.dropit.app.core.network.GroupInfo
import dev.dropit.app.core.network.OptionalField
import dev.dropit.app.core.network.TargetScope
import dev.dropit.app.core.network.WsEvent

interface BoardRepository {
    suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot
    suspend fun createText(scope: TargetScope, text: String, group: String? = null): ClipItem
    suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem
    suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem
    suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem
    suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem
    suspend fun updateLabels(
        scope: TargetScope,
        itemId: String,
        pinned: Boolean? = null,
        tags: List<String>? = null,
        group: OptionalField<String?> = OptionalField.Absent,
    ): ClipItem

    suspend fun retractItem(scope: TargetScope, itemId: String)

    suspend fun getGroups(scope: TargetScope): List<String>
    suspend fun createGroup(scope: TargetScope, name: String): List<String>
    suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String>
    suspend fun deleteGroup(scope: TargetScope, name: String): List<String>

    fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo>
}

class DefaultBoardRepository(
    private val apiClient: DropitApiClient,
) : BoardRepository {
    override suspend fun fetchSnapshot(scope: TargetScope): WsEvent.Snapshot =
        apiClient.getSnapshot(scope)

    override suspend fun createText(scope: TargetScope, text: String, group: String?): ClipItem =
        apiClient.createTextItem(scope, text, group)

    override suspend fun editText(scope: TargetScope, itemId: String, text: String): ClipItem =
        apiClient.editTextItem(scope, itemId, text)

    override suspend fun setPinned(scope: TargetScope, itemId: String, pinned: Boolean): ClipItem =
        apiClient.updateItemLabels(scope, itemId, pinned = pinned)

    override suspend fun setTags(scope: TargetScope, itemId: String, tags: List<String>): ClipItem =
        apiClient.updateItemLabels(scope, itemId, tags = tags)

    override suspend fun setGroup(scope: TargetScope, itemId: String, group: String?): ClipItem =
        apiClient.updateItemLabels(scope, itemId, group = OptionalField.Present(group))

    override suspend fun updateLabels(
        scope: TargetScope,
        itemId: String,
        pinned: Boolean?,
        tags: List<String>?,
        group: OptionalField<String?>,
    ): ClipItem = apiClient.updateItemLabels(scope, itemId, pinned = pinned, tags = tags, group = group)

    override suspend fun retractItem(scope: TargetScope, itemId: String) =
        apiClient.retractItem(scope, itemId)

    override suspend fun getGroups(scope: TargetScope): List<String> =
        apiClient.getGroups(scope)

    override suspend fun createGroup(scope: TargetScope, name: String): List<String> =
        apiClient.createGroup(scope, name)

    override suspend fun renameGroup(scope: TargetScope, oldName: String, newName: String): List<String> =
        apiClient.renameGroup(scope, oldName, newName)

    override suspend fun deleteGroup(scope: TargetScope, name: String): List<String> =
        apiClient.deleteGroup(scope, name)

    override fun buildGroupInfos(groups: List<String>, items: List<ClipItem>): List<GroupInfo> {
        val counts = items.groupingBy { it.group }.eachCount()
        return groups.map { name -> GroupInfo(name = name, itemCount = counts[name] ?: 0) }
    }
}
