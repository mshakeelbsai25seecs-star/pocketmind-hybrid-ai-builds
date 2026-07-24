package com.pocketmind.hybridai.data.db

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS workspace_profiles (
                id TEXT NOT NULL PRIMARY KEY,
                name TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                isDefault INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent()
        )
        db.execSQL(
            """
            INSERT OR IGNORE INTO workspace_profiles (id, name, createdAt, isDefault)
            VALUES ('default', 'Default', ${System.currentTimeMillis()}, 1)
            """.trimIndent()
        )
        db.execSQL(
            "ALTER TABLE conversations ADD COLUMN profileId TEXT NOT NULL DEFAULT 'default'"
        )
        db.execSQL("ALTER TABLE model_records ADD COLUMN sha256 TEXT")
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS doc_summaries (
                id TEXT NOT NULL PRIMARY KEY,
                fileName TEXT NOT NULL,
                sourceUri TEXT,
                excerpt TEXT NOT NULL,
                charCount INTEGER NOT NULL,
                providerKind TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                profileId TEXT NOT NULL DEFAULT 'default'
            )
            """.trimIndent()
        )
    }
}
