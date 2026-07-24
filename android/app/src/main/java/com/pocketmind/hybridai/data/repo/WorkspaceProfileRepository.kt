package com.pocketmind.hybridai.data.repo

import com.pocketmind.hybridai.data.db.WorkspaceProfileDao
import com.pocketmind.hybridai.data.db.WorkspaceProfileEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class WorkspaceProfileRepository @Inject constructor(
    private val dao: WorkspaceProfileDao,
    private val settings: SettingsRepository
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    init {
        scope.launch { ensureDefaultProfile() }
    }

    fun observeProfiles(): Flow<List<WorkspaceProfileEntity>> = dao.observeAll()

    val activeProfileId: Flow<String> = settings.activeProfileId

    suspend fun ensureDefaultProfile() {
        if (dao.exists("default") == 0) {
            dao.upsert(
                WorkspaceProfileEntity(
                    id = "default",
                    name = "Default",
                    createdAt = System.currentTimeMillis(),
                    isDefault = true
                )
            )
        }
    }

    suspend fun createProfile(name: String): WorkspaceProfileEntity {
        ensureDefaultProfile()
        val trimmed = name.trim().ifBlank { "Profile" }
        val entity = WorkspaceProfileEntity(
            id = UUID.randomUUID().toString(),
            name = trimmed,
            createdAt = System.currentTimeMillis(),
            isDefault = false
        )
        dao.upsert(entity)
        return entity
    }

    suspend fun setActiveProfile(id: String) {
        ensureDefaultProfile()
        if (dao.exists(id) == 0) error("Workspace profile not found")
        settings.setActiveProfileId(id)
    }

    suspend fun deleteProfile(id: String) {
        if (id == "default") error("Cannot delete the Default profile")
        val active = settings.activeProfileId.first()
        if (active == id) error("Switch away from this profile before deleting it")
        dao.deleteById(id)
    }
}
