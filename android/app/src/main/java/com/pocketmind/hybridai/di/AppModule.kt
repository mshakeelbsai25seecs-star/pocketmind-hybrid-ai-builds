package com.pocketmind.hybridai.di

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.room.Room
import com.pocketmind.hybridai.BuildConfig
import com.pocketmind.hybridai.data.db.AppDatabase
import com.pocketmind.hybridai.data.db.CharacterDao
import com.pocketmind.hybridai.data.db.ConversationDao
import com.pocketmind.hybridai.data.db.DocSummaryDao
import com.pocketmind.hybridai.data.db.GeneratedImageDao
import com.pocketmind.hybridai.data.db.MessageDao
import com.pocketmind.hybridai.data.db.MIGRATION_1_2
import com.pocketmind.hybridai.data.db.ModelRecordDao
import com.pocketmind.hybridai.data.db.PromptDao
import com.pocketmind.hybridai.data.db.WorkspaceProfileDao
import com.pocketmind.hybridai.data.repo.settingsDataStore
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.engine.llama.LocalProcessLlamaEngine
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

/** Provides app-wide singletons: networking, JSON, database, DAOs and preferences. */
@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
        explicitNulls = false
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BASIC else HttpLoggingInterceptor.Level.NONE
        }
        return OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            // Streaming chat completions can legitimately take minutes on slow local models.
            .readTimeout(5, TimeUnit.MINUTES)
            .writeTimeout(1, TimeUnit.MINUTES)
            .callTimeout(6, TimeUnit.MINUTES)
            .retryOnConnectionFailure(true)
            .addInterceptor(logging)
            .build()
    }

    @Provides
    @Singleton
    fun provideAppDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, AppDatabase.DATABASE_NAME)
            .addMigrations(MIGRATION_1_2)
            .build()

    @Provides
    fun provideConversationDao(db: AppDatabase): ConversationDao = db.conversationDao()

    @Provides
    fun provideMessageDao(db: AppDatabase): MessageDao = db.messageDao()

    @Provides
    fun provideCharacterDao(db: AppDatabase): CharacterDao = db.characterDao()

    @Provides
    fun providePromptDao(db: AppDatabase): PromptDao = db.promptDao()

    @Provides
    fun provideModelRecordDao(db: AppDatabase): ModelRecordDao = db.modelRecordDao()

    @Provides
    fun provideGeneratedImageDao(db: AppDatabase): GeneratedImageDao = db.generatedImageDao()

    @Provides
    fun provideWorkspaceProfileDao(db: AppDatabase): WorkspaceProfileDao = db.workspaceProfileDao()

    @Provides
    fun provideDocSummaryDao(db: AppDatabase): DocSummaryDao = db.docSummaryDao()

    @Provides
    @Singleton
    fun provideDataStore(@ApplicationContext context: Context): DataStore<Preferences> = context.settingsDataStore
}

/** Binds the on-device inference interface to its process-based implementation. */
@Module
@InstallIn(SingletonComponent::class)
abstract class EngineModule {
    @Binds
    abstract fun bindLocalLlamaEngine(impl: LocalProcessLlamaEngine): LocalLlamaEngine
}
