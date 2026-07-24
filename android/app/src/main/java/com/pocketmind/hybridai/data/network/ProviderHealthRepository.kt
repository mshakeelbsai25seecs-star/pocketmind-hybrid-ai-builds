package com.pocketmind.hybridai.data.network

import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import javax.inject.Inject
import javax.inject.Singleton

/** Live health/availability snapshot for one provider. */
data class ProviderStatus(
    val providerId: String,
    val displayName: String,
    val isOnline: Boolean,
    val hasApiKey: Boolean,
    val models: List<RemoteModel> = emptyList(),
    val message: String? = null
)

/**
 * Probes each cloud provider's real endpoints so the app only ever offers
 * models that are actually reachable right now. Nothing here hardcodes a
 * "known good" model id as always-on: dead/retired ids only show up if a
 * provider's own `/models` response includes them.
 */
@Singleton
class ProviderHealthRepository @Inject constructor(
    private val openAiClient: OpenAiCompatibleClient,
    private val geminiClient: GeminiClient,
    private val http: OkHttpClient,
    private val json: Json,
    private val secureStore: SecureStore
) {
    suspend fun probeAll(): List<ProviderStatus> = coroutineScope {
        val groq = async { probeOpenAiCompatible("groq", "Groq", ProviderCatalog.GROQ_BASE, ApiProvider.GROQ) }
        val gemini = async { probeGemini() }
        val openRouter = async { probeOpenAiCompatible("openrouter", "OpenRouter", ProviderCatalog.OPENROUTER_BASE, ApiProvider.OPENROUTER) }
        val deepseek = async { probeOpenAiCompatible("deepseek", "DeepSeek", ProviderCatalog.DEEPSEEK_BASE, ApiProvider.DEEPSEEK) }
        val mistral = async { probeOpenAiCompatible("mistral", "Mistral", ProviderCatalog.MISTRAL_BASE, ApiProvider.MISTRAL) }
        val together = async { probeOpenAiCompatible("together", "Together AI", ProviderCatalog.TOGETHER_BASE, ApiProvider.TOGETHER) }
        val pollinations = async { probePollinationsImageModels() }
        listOf(groq.await(), gemini.await(), openRouter.await(), deepseek.await(), mistral.await(), together.await(), pollinations.await())
    }

    suspend fun probeOpenAiCompatible(providerId: String, displayName: String, baseUrl: String, apiKeyKind: ApiProvider): ProviderStatus {
        val key = secureStore.getApiKey(apiKeyKind)
        if (key.isNullOrBlank()) {
            return ProviderStatus(providerId, displayName, isOnline = false, hasApiKey = false, message = "No API key set")
        }
        return openAiClient.listModels(baseUrl, key).fold(
            onSuccess = { models -> ProviderStatus(providerId, displayName, isOnline = true, hasApiKey = true, models = models) },
            onFailure = { e -> ProviderStatus(providerId, displayName, isOnline = false, hasApiKey = true, message = e.message ?: "Unreachable") }
        )
    }

    suspend fun probeGemini(): ProviderStatus {
        val key = secureStore.getApiKey(ApiProvider.GEMINI)
        if (key.isNullOrBlank()) {
            return ProviderStatus("gemini", "Google Gemini", isOnline = false, hasApiKey = false, message = "No API key set")
        }
        return geminiClient.listModels(key).fold(
            onSuccess = { models -> ProviderStatus("gemini", "Google Gemini", isOnline = true, hasApiKey = true, models = models) },
            onFailure = { e -> ProviderStatus("gemini", "Google Gemini", isOnline = false, hasApiKey = true, message = e.message ?: "Unreachable") }
        )
    }

    /** Pollinations image generation has no auth requirement for the free tier, so it's probed unconditionally. */
    suspend fun probePollinationsImageModels(): ProviderStatus = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder().url(ProviderCatalog.POLLINATIONS_MODELS_URL).get().build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ProviderRequestException("HTTP ${response.code}", response.code)
                }
                val bodyText = response.body?.string().orEmpty()
                val arr = json.parseToJsonElement(bodyText).jsonArray
                arr.mapNotNull { element ->
                    element.jsonPrimitive.contentOrNull
                        ?: runCatching { element.jsonPrimitive.contentOrNull }.getOrNull()
                }.map { RemoteModel(id = it) }
            }
        }.fold(
            onSuccess = { models ->
                val merged = (models.map { it.id } + ProviderCatalog.IMAGE_MODELS).distinct().map { RemoteModel(id = it) }
                ProviderStatus("pollinations", "Pollinations Image", isOnline = true, hasApiKey = true, models = merged)
            },
            onFailure = { e ->
                ProviderStatus(
                    "pollinations",
                    "Pollinations Image",
                    isOnline = false,
                    hasApiKey = true,
                    models = ProviderCatalog.IMAGE_MODELS.map { RemoteModel(id = it) },
                    message = e.message ?: "Unreachable, showing known model list"
                )
            }
        )
    }
}
