package com.pocketmind.hybridai.data.db

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import kotlinx.serialization.Serializable

/**
 * A single chat thread. [modelKind] mirrors the tab it was started from
 * (local / org / free / premium) purely for display + re-selection purposes.
 */
@Serializable
@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val title: String,
    val modelId: String,
    val modelLabel: String,
    val modelKind: String,
    val systemPrompt: String? = null,
    val characterId: String? = null,
    val profileId: String = "default",
    val pinned: Boolean = false,
    val createdAt: Long,
    val updatedAt: Long
)

/**
 * A single message within a conversation. [role] is one of "system", "user"
 * or "assistant". [attachmentsSummary] is a short human-readable label such
 * as "1 attachment: notes.txt" used for the chat bubble footer.
 */
@Serializable
@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(
            entity = ConversationEntity::class,
            parentColumns = ["id"],
            childColumns = ["conversationId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("conversationId")]
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val role: String,
    val content: String,
    val attachmentsSummary: String? = null,
    val isError: Boolean = false,
    val isStreaming: Boolean = false,
    val createdAt: Long
)

/** A persona / character preset that supplies a system prompt for new chats. */
@Entity(tableName = "characters")
data class CharacterEntity(
    @PrimaryKey val id: String,
    val name: String,
    val avatarEmoji: String,
    val description: String,
    val systemPrompt: String,
    val isBuiltIn: Boolean = false,
    val createdAt: Long
)

/** A reusable prompt preset, grouped by [category] (Study/Coding/Business/Writing/Custom). */
@Entity(tableName = "prompts")
data class PromptEntity(
    @PrimaryKey val id: String,
    val title: String,
    val category: String,
    val content: String,
    val isBuiltIn: Boolean = false,
    val createdAt: Long
)

/**
 * Cached record of a model the app knows about, whether it's an imported
 * local GGUF file, an org-server model, or a probed free/premium cloud model.
 */
@Entity(tableName = "model_records")
data class ModelRecordEntity(
    @PrimaryKey val id: String,
    val providerId: String,
    val modelId: String,
    val label: String,
    val kind: String,
    val contextLength: Int? = null,
    val isAvailable: Boolean = true,
    val filePath: String? = null,
    val sizeBytes: Long? = null,
    val sha256: String? = null,
    val lastCheckedAt: Long
)

/** Workspace profile for separating chats/settings per project or context. */
@Entity(tableName = "workspace_profiles")
data class WorkspaceProfileEntity(
    @PrimaryKey val id: String,
    val name: String,
    val createdAt: Long,
    val isDefault: Boolean = false
)

/** Cached excerpt from batch-uploaded docs (online/org only — no local HNSW index). */
@Entity(tableName = "doc_summaries")
data class DocSummaryEntity(
    @PrimaryKey val id: String,
    val fileName: String,
    val sourceUri: String? = null,
    val excerpt: String,
    val charCount: Int,
    val providerKind: String,
    val createdAt: Long,
    val profileId: String = "default"
)

/** A locally-cached generated image plus the prompt/provider used to create it. */
@Entity(tableName = "generated_images")
data class GeneratedImageEntity(
    @PrimaryKey val id: String,
    val prompt: String,
    val provider: String,
    val model: String,
    val localPath: String,
    val seed: Long? = null,
    val createdAt: Long
)
