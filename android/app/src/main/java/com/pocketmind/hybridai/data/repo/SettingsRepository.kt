package com.pocketmind.hybridai.data.repo

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.pocketmind.hybridai.data.secure.SecureStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

val Context.settingsDataStore by preferencesDataStore(name = "pm_settings")

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** Default generation parameters used across chat/local providers. */
object GenerationDefaults {
    const val TEMPERATURE = 0.7f
    const val MAX_TOKENS = 1024
    const val TOP_P = 0.95f
    const val STREAM_RESPONSES = true
}

/**
 * Lightweight app preferences: generation parameters live in DataStore
 * (reactive, non-sensitive). Theme mode and onboarding state are persisted in
 * [SecureStore] per the security/storage spec, but exposed here as reactive
 * [StateFlow]s so Compose screens can collect them like any other setting.
 */
@Singleton
class SettingsRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val secureStore: SecureStore
) {
    private val dataStore get() = context.settingsDataStore

    private object Keys {
        val TEMPERATURE = floatPreferencesKey("temperature")
        val MAX_TOKENS = intPreferencesKey("max_tokens")
        val TOP_P = floatPreferencesKey("top_p")
        val STREAM_RESPONSES = booleanPreferencesKey("stream_responses")
        val DEFAULT_MODEL_ID = stringPreferencesKey("default_model_id")
        val DEFAULT_MODEL_LABEL = stringPreferencesKey("default_model_label")
        val DEFAULT_MODEL_KIND = stringPreferencesKey("default_model_kind")
        val KEEP_LAST_N = intPreferencesKey("keep_last_n")
        val ACTIVE_PROFILE_ID = stringPreferencesKey("active_workspace_profile")
    }

    val temperature: kotlinx.coroutines.flow.Flow<Float> = dataStore.data.map { it[Keys.TEMPERATURE] ?: GenerationDefaults.TEMPERATURE }
    val maxTokens: kotlinx.coroutines.flow.Flow<Int> = dataStore.data.map { it[Keys.MAX_TOKENS] ?: GenerationDefaults.MAX_TOKENS }
    val topP: kotlinx.coroutines.flow.Flow<Float> = dataStore.data.map { it[Keys.TOP_P] ?: GenerationDefaults.TOP_P }
    val streamResponses: kotlinx.coroutines.flow.Flow<Boolean> = dataStore.data.map { it[Keys.STREAM_RESPONSES] ?: GenerationDefaults.STREAM_RESPONSES }
    val defaultModelId: kotlinx.coroutines.flow.Flow<String?> = dataStore.data.map { it[Keys.DEFAULT_MODEL_ID] }
    val defaultModelLabel: kotlinx.coroutines.flow.Flow<String?> = dataStore.data.map { it[Keys.DEFAULT_MODEL_LABEL] }
    val defaultModelKind: kotlinx.coroutines.flow.Flow<String?> = dataStore.data.map { it[Keys.DEFAULT_MODEL_KIND] }
    val keepLastN: kotlinx.coroutines.flow.Flow<Int> = dataStore.data.map { it[Keys.KEEP_LAST_N] ?: com.pocketmind.hybridai.util.DEFAULT_KEEP_LAST_N }
    val activeProfileId: kotlinx.coroutines.flow.Flow<String> = dataStore.data.map { it[Keys.ACTIVE_PROFILE_ID] ?: "default" }

    suspend fun setTemperature(value: Float) = dataStore.edit { it[Keys.TEMPERATURE] = value }
    suspend fun setMaxTokens(value: Int) = dataStore.edit { it[Keys.MAX_TOKENS] = value }
    suspend fun setTopP(value: Float) = dataStore.edit { it[Keys.TOP_P] = value }
    suspend fun setStreamResponses(value: Boolean) = dataStore.edit { it[Keys.STREAM_RESPONSES] = value }
    suspend fun setDefaultModel(id: String, label: String, kind: String) = dataStore.edit {
        it[Keys.DEFAULT_MODEL_ID] = id
        it[Keys.DEFAULT_MODEL_LABEL] = label
        it[Keys.DEFAULT_MODEL_KIND] = kind
    }
    suspend fun setKeepLastN(value: Int) = dataStore.edit {
        it[Keys.KEEP_LAST_N] = value.coerceIn(2, 40)
    }
    suspend fun setActiveProfileId(id: String) = dataStore.edit {
        it[Keys.ACTIVE_PROFILE_ID] = id
    }

    private val _themeMode = MutableStateFlow(parseThemeMode(secureStore.themeMode))
    val themeMode: StateFlow<ThemeMode> = _themeMode.asStateFlow()

    fun setThemeMode(mode: ThemeMode) {
        secureStore.themeMode = mode.name.lowercase()
        _themeMode.value = mode
    }

    private val _onboardingDone = MutableStateFlow(secureStore.onboardingDone)
    val onboardingDone: StateFlow<Boolean> = _onboardingDone.asStateFlow()

    fun completeOnboarding() {
        secureStore.onboardingDone = true
        _onboardingDone.value = true
    }

    private val _safeCpuOnly = MutableStateFlow(secureStore.safeCpuOnly)
    val safeCpuOnly: StateFlow<Boolean> = _safeCpuOnly.asStateFlow()

    fun setSafeCpuOnly(value: Boolean) {
        secureStore.safeCpuOnly = value
        _safeCpuOnly.value = value
    }

    private val _sleepOnBackground = MutableStateFlow(secureStore.sleepOnBackground)
    val sleepOnBackground: StateFlow<Boolean> = _sleepOnBackground.asStateFlow()

    fun setSleepOnBackground(value: Boolean) {
        secureStore.sleepOnBackground = value
        _sleepOnBackground.value = value
    }

    private val _biometricEnabled = MutableStateFlow(secureStore.biometricEnabled)
    val biometricEnabled: StateFlow<Boolean> = _biometricEnabled.asStateFlow()

    fun setBiometricEnabled(value: Boolean) {
        secureStore.biometricEnabled = value
        _biometricEnabled.value = value
    }

    private fun parseThemeMode(raw: String): ThemeMode = when (raw.lowercase()) {
        "light" -> ThemeMode.LIGHT
        "system" -> ThemeMode.SYSTEM
        else -> ThemeMode.DARK
    }
}
