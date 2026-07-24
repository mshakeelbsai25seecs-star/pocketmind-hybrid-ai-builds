package com.pocketmind.hybridai.data.repo

import com.pocketmind.hybridai.data.db.ConversationDao
import com.pocketmind.hybridai.data.db.ConversationEntity
import com.pocketmind.hybridai.data.db.MessageDao
import com.pocketmind.hybridai.data.db.MessageEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Chat roles stored on [MessageEntity.role]. */
object ChatRole {
    const val SYSTEM = "system"
    const val USER = "user"
    const val ASSISTANT = "assistant"
}

/** Plain snapshot of a conversation plus its messages, used for JSON backup/export. */
data class ConversationExport(
    val conversation: ConversationEntity,
    val messages: List<MessageEntity>
)

/**
 * CRUD + streaming access to conversations and their messages. All reads are
 * exposed as [Flow]s so the chat list and chat screen stay in sync with the
 * database automatically while a response streams in.
 */
@Singleton
class ChatRepository @Inject constructor(
    private val conversationDao: ConversationDao,
    private val messageDao: MessageDao,
    private val settings: SettingsRepository
) {
    fun observeConversations(): Flow<List<ConversationEntity>> = conversationDao.observeAll()

    fun observeConversationsForActiveProfile(): Flow<List<ConversationEntity>> =
        kotlinx.coroutines.flow.combine(
            conversationDao.observeAll(),
            settings.activeProfileId
        ) { all, profileId ->
            all.filter { it.profileId == profileId }
        }

    fun observeConversation(id: String): Flow<ConversationEntity?> = conversationDao.observeById(id)

    fun observeMessages(conversationId: String): Flow<List<MessageEntity>> =
        messageDao.observeForConversation(conversationId)

    suspend fun getConversation(id: String): ConversationEntity? = conversationDao.getById(id)

    suspend fun createConversation(
        title: String,
        modelId: String,
        modelLabel: String,
        modelKind: String,
        systemPrompt: String? = null,
        characterId: String? = null,
        profileId: String? = null
    ): ConversationEntity {
        val now = System.currentTimeMillis()
        val pid = profileId ?: settings.activeProfileId.first()
        val entity = ConversationEntity(
            id = UUID.randomUUID().toString(),
            title = title,
            modelId = modelId,
            modelLabel = modelLabel,
            modelKind = modelKind,
            systemPrompt = systemPrompt,
            characterId = characterId,
            profileId = pid,
            createdAt = now,
            updatedAt = now
        )
        conversationDao.upsert(entity)
        return entity
    }

    suspend fun renameConversation(id: String, newTitle: String) {
        val existing = conversationDao.getById(id) ?: return
        conversationDao.update(existing.copy(title = newTitle, updatedAt = System.currentTimeMillis()))
    }

    suspend fun setPinned(id: String, pinned: Boolean) {
        val existing = conversationDao.getById(id) ?: return
        conversationDao.update(existing.copy(pinned = pinned))
    }

    suspend fun touchConversation(id: String) {
        val existing = conversationDao.getById(id) ?: return
        conversationDao.update(existing.copy(updatedAt = System.currentTimeMillis()))
    }

    suspend fun switchModel(id: String, modelId: String, modelLabel: String, modelKind: String) {
        val existing = conversationDao.getById(id) ?: return
        conversationDao.update(
            existing.copy(modelId = modelId, modelLabel = modelLabel, modelKind = modelKind, updatedAt = System.currentTimeMillis())
        )
    }

    suspend fun deleteConversation(id: String) {
        conversationDao.deleteById(id)
    }

    suspend fun deleteAllConversations() {
        conversationDao.deleteAll()
    }

    suspend fun addMessage(
        conversationId: String,
        role: String,
        content: String,
        attachmentsSummary: String? = null,
        isError: Boolean = false,
        isStreaming: Boolean = false
    ): MessageEntity {
        val entity = MessageEntity(
            id = UUID.randomUUID().toString(),
            conversationId = conversationId,
            role = role,
            content = content,
            attachmentsSummary = attachmentsSummary,
            isError = isError,
            isStreaming = isStreaming,
            createdAt = System.currentTimeMillis()
        )
        messageDao.upsert(entity)
        touchConversation(conversationId)
        return entity
    }

    suspend fun updateMessageContent(message: MessageEntity, newContent: String, isStreaming: Boolean, isError: Boolean = false) {
        messageDao.update(message.copy(content = newContent, isStreaming = isStreaming, isError = isError))
    }

    suspend fun getMessagesOnce(conversationId: String): List<MessageEntity> =
        messageDao.getForConversationOnce(conversationId)

    suspend fun exportAll(): List<ConversationExport> =
        conversationDao.getAllOnce().map { conversation ->
            ConversationExport(conversation, messageDao.getForConversationOnce(conversation.id))
        }

    suspend fun importAll(exports: List<ConversationExport>) {
        exports.forEach { export ->
            conversationDao.upsert(export.conversation)
            export.messages.forEach { messageDao.upsert(it) }
        }
    }
}
