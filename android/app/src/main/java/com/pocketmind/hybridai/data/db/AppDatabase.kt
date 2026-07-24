package com.pocketmind.hybridai.data.db

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [
        ConversationEntity::class,
        MessageEntity::class,
        CharacterEntity::class,
        PromptEntity::class,
        ModelRecordEntity::class,
        GeneratedImageEntity::class,
        WorkspaceProfileEntity::class,
        DocSummaryEntity::class
    ],
    version = 2,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun conversationDao(): ConversationDao
    abstract fun messageDao(): MessageDao
    abstract fun characterDao(): CharacterDao
    abstract fun promptDao(): PromptDao
    abstract fun modelRecordDao(): ModelRecordDao
    abstract fun generatedImageDao(): GeneratedImageDao
    abstract fun workspaceProfileDao(): WorkspaceProfileDao
    abstract fun docSummaryDao(): DocSummaryDao

    companion object {
        const val DATABASE_NAME = "pocketmind.db"
    }
}
