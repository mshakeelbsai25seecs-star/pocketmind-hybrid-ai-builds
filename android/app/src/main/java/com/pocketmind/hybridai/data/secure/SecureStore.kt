package com.pocketmind.hybridai.data.secure

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** Identifies which provider an API key belongs to inside [SecureStore]. */
enum class ApiProvider(val storageKey: String, val displayName: String) {
    GROQ("key_groq", "Groq"),
    GEMINI("key_gemini", "Google Gemini"),
    OPENROUTER("key_openrouter", "OpenRouter"),
    DEEPSEEK("key_deepseek", "DeepSeek"),
    MISTRAL("key_mistral", "Mistral"),
    TOGETHER("key_together", "Together AI"),
    HF("key_hf", "Hugging Face"),
    POLLINATIONS("key_pollinations", "Pollinations")
}

/**
 * Encrypted key/value storage for anything sensitive: cloud API keys, the
 * org-server URL/token, and a handful of security-relevant flags. Backed by
 * [EncryptedSharedPreferences] so values are safe even on rooted devices with
 * file access, without requiring a full biometric unlock just to read them.
 */
@Singleton
class SecureStore @Inject constructor(@ApplicationContext context: Context) {

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "pm_secure_store",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun getApiKey(provider: ApiProvider): String? = prefs.getString(provider.storageKey, null)?.takeIf { it.isNotBlank() }

    fun setApiKey(provider: ApiProvider, value: String?) {
        prefs.edit().apply {
            if (value.isNullOrBlank()) remove(provider.storageKey) else putString(provider.storageKey, value.trim())
        }.apply()
    }

    fun hasApiKey(provider: ApiProvider): Boolean = !getApiKey(provider).isNullOrBlank()

    var orgUrl: String?
        get() = prefs.getString(KEY_ORG_URL, null)
        set(value) = prefs.edit().putString(KEY_ORG_URL, value?.trim()).apply()

    var orgToken: String?
        get() = prefs.getString(KEY_ORG_TOKEN, null)?.takeIf { it.isNotBlank() }
        set(value) = prefs.edit().apply {
            if (value.isNullOrBlank()) remove(KEY_ORG_TOKEN) else putString(KEY_ORG_TOKEN, value.trim())
        }.apply()

    var allowLanHttp: Boolean
        get() = prefs.getBoolean(KEY_ALLOW_LAN_HTTP, true)
        set(value) = prefs.edit().putBoolean(KEY_ALLOW_LAN_HTTP, value).apply()

    var biometricEnabled: Boolean
        get() = prefs.getBoolean(KEY_BIOMETRIC_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_BIOMETRIC_ENABLED, value).apply()

    var onboardingDone: Boolean
        get() = prefs.getBoolean(KEY_ONBOARDING_DONE, false)
        set(value) = prefs.edit().putBoolean(KEY_ONBOARDING_DONE, value).apply()

    var safeCpuOnly: Boolean
        get() = prefs.getBoolean(KEY_SAFE_CPU_ONLY, false)
        set(value) = prefs.edit().putBoolean(KEY_SAFE_CPU_ONLY, value).apply()

    var sleepOnBackground: Boolean
        get() = prefs.getBoolean(KEY_SLEEP_ON_BACKGROUND, true)
        set(value) = prefs.edit().putBoolean(KEY_SLEEP_ON_BACKGROUND, value).apply()

    /** One of "system", "light", "dark". Defaults to dark (conductor.build aesthetic). */
    var themeMode: String
        get() = prefs.getString(KEY_THEME_MODE, "dark") ?: "dark"
        set(value) = prefs.edit().putString(KEY_THEME_MODE, value).apply()

    fun clearAllApiKeys() {
        prefs.edit().apply {
            ApiProvider.entries.forEach { remove(it.storageKey) }
        }.apply()
    }

    private companion object {
        const val KEY_ORG_URL = "org_url"
        const val KEY_ORG_TOKEN = "org_token"
        const val KEY_ALLOW_LAN_HTTP = "allow_lan_http"
        const val KEY_BIOMETRIC_ENABLED = "biometric_enabled"
        const val KEY_ONBOARDING_DONE = "onboarding_done"
        const val KEY_SAFE_CPU_ONLY = "safe_cpu_only"
        const val KEY_SLEEP_ON_BACKGROUND = "sleep_on_background"
        const val KEY_THEME_MODE = "theme_mode"
    }
}
