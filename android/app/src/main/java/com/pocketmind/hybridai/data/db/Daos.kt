package com.pocketmind.hybridai.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ConversationDao {
    @Query("SELECT * FROM conversations ORDER BY pinned DESC, updatedAt DESC")
    fun observeAll(): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE profileId = :profileId ORDER BY pinned DESC, updatedAt DESC")
    fun observeForProfile(profileId: String): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun getById(id: String): ConversationEntity?

    @Query("SELECT * FROM conversations WHERE id = :id")
    fun observeById(id: String): Flow<ConversationEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: ConversationEntity)

    @Update
    suspend fun update(entity: ConversationEntity)

    @Query("DELETE FROM conversations WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM conversations")
    suspend fun deleteAll()

    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    suspend fun getAllOnce(): List<ConversationEntity>
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY createdAt ASC")
    fun observeForConversation(conversationId: String): Flow<List<MessageEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: MessageEntity)

    @Update
    suspend fun update(entity: MessageEntity)

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun deleteForConversation(conversationId: String)

    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY createdAt ASC")
    suspend fun getForConversationOnce(conversationId: String): List<MessageEntity>

    @Delete
    suspend fun delete(entity: MessageEntity)
}

@Dao
interface CharacterDao {
    @Query("SELECT * FROM characters ORDER BY isBuiltIn DESC, createdAt ASC")
    fun observeAll(): Flow<List<CharacterEntity>>

    @Query("SELECT * FROM characters WHERE id = :id")
    suspend fun getById(id: String): CharacterEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: CharacterEntity)

    @Query("DELETE FROM characters WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT COUNT(*) FROM characters")
    suspend fun count(): Int
}

@Dao
interface PromptDao {
    @Query("SELECT * FROM prompts ORDER BY isBuiltIn DESC, category ASC, createdAt ASC")
    fun observeAll(): Flow<List<PromptEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: PromptEntity)

    @Query("DELETE FROM prompts WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT COUNT(*) FROM prompts")
    suspend fun count(): Int
}

@Dao
interface ModelRecordDao {
    @Query("SELECT * FROM model_records ORDER BY label ASC")
    fun observeAll(): Flow<List<ModelRecordEntity>>

    @Query("SELECT * FROM model_records WHERE kind = :kind ORDER BY label ASC")
    fun observeByKind(kind: String): Flow<List<ModelRecordEntity>>

    @Query("SELECT * FROM model_records WHERE kind = :kind ORDER BY label ASC")
    suspend fun getByKindOnce(kind: String): List<ModelRecordEntity>

    @Query("SELECT * FROM model_records WHERE id = :id")
    suspend fun getById(id: String): ModelRecordEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: ModelRecordEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(entities: List<ModelRecordEntity>)

    @Query("DELETE FROM model_records WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM model_records WHERE kind = :kind AND providerId = :providerId")
    suspend fun deleteByProvider(kind: String, providerId: String)
}

@Dao
interface WorkspaceProfileDao {
    @Query("SELECT * FROM workspace_profiles ORDER BY isDefault DESC, name ASC")
    fun observeAll(): Flow<List<WorkspaceProfileEntity>>

    @Query("SELECT * FROM workspace_profiles WHERE id = :id")
    suspend fun getById(id: String): WorkspaceProfileEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: WorkspaceProfileEntity)

    @Query("DELETE FROM workspace_profiles WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT COUNT(*) FROM workspace_profiles WHERE id = :id")
    suspend fun exists(id: String): Int
}

@Dao
interface DocSummaryDao {
    @Query("SELECT * FROM doc_summaries WHERE profileId = :profileId ORDER BY createdAt DESC")
    fun observeForProfile(profileId: String): Flow<List<DocSummaryEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: DocSummaryEntity)

    @Query("DELETE FROM doc_summaries WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM doc_summaries WHERE profileId = :profileId")
    suspend fun deleteForProfile(profileId: String)
}

@Dao
interface GeneratedImageDao {
    @Query("SELECT * FROM generated_images ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<GeneratedImageEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entity: GeneratedImageEntity)

    @Query("DELETE FROM generated_images WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM generated_images")
    suspend fun deleteAll()
}
