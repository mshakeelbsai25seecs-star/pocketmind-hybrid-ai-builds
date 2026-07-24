package com.pocketmind.hybridai.data.network

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/** A single chat turn to send to a provider; role is "system", "user" or "assistant". */
data class ChatTurn(val role: String, val content: String)

/** A model entry as returned by a provider's `/models` listing endpoint. */
data class RemoteModel(
    val id: String,
    val ownedBy: String? = null,
    val contextLength: Int? = null
)

class ProviderRequestException(message: String, val httpCode: Int? = null) : IOException(message)

/**
 * Generic client for any provider that speaks the OpenAI Chat Completions
 * wire format (Groq, OpenRouter, DeepSeek, Mistral, Together, Hugging Face
 * router, and self-hosted "org" servers like llama.cpp server / vLLM / LM
 * Studio). Handles model listing and streamed chat completions via SSE.
 */
@Singleton
class OpenAiCompatibleClient @Inject constructor(
    private val http: OkHttpClient,
    private val json: Json
) {
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO

    /** Ensures a user-supplied base URL always ends in a single trailing `/v1/`. */
    fun normalizeBaseUrl(raw: String): String {
        var url = raw.trim()
        if (url.isEmpty()) return url
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        url = url.trimEnd('/')
        if (!url.endsWith("/v1")) {
            url += "/v1"
        }
        return "$url/"
    }

    suspend fun listModels(baseUrl: String, apiKey: String?): Result<List<RemoteModel>> = withContext(ioDispatcher) {
        runCatching {
            val request = Request.Builder()
                .url(baseUrl.trimEnd('/') + "/models")
                .apply { if (!apiKey.isNullOrBlank()) addHeader("Authorization", "Bearer $apiKey") }
                .get()
                .build()

            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ProviderRequestException("Model list request failed (HTTP ${response.code})", response.code)
                }
                val bodyText = response.body?.string().orEmpty()
                val root = json.parseToJsonElement(bodyText).jsonObject
                val data = (root["data"] as? JsonArray) ?: buildJsonArray { }
                data.mapNotNull { element ->
                    val obj = element as? JsonObject ?: return@mapNotNull null
                    val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    RemoteModel(
                        id = id,
                        ownedBy = obj["owned_by"]?.jsonPrimitive?.contentOrNull,
                        contextLength = obj["context_length"]?.jsonPrimitive?.int
                            ?: obj["context_window"]?.jsonPrimitive?.int
                    )
                }
            }
        }
    }

    /**
     * Streams a chat completion. Emits incremental text deltas (not the
     * accumulated response) so the caller can append them to a growing
     * message as they arrive.
     */
    fun streamChatCompletions(
        baseUrl: String,
        apiKey: String?,
        model: String,
        messages: List<ChatTurn>,
        temperature: Float = 0.7f,
        maxTokens: Int = 1024,
        topP: Float = 0.95f
    ): Flow<String> = callbackFlow {
        val requestBodyJson = buildJsonObject {
            put("model", model)
            put("stream", true)
            put("temperature", temperature.toDouble())
            put("max_tokens", maxTokens)
            put("top_p", topP.toDouble())
            putJsonArray("messages") {
                messages.forEach { turn ->
                    addJsonObject {
                        put("role", turn.role)
                        put("content", turn.content)
                    }
                }
            }
        }

        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + "/chat/completions")
            .apply { if (!apiKey.isNullOrBlank()) addHeader("Authorization", "Bearer $apiKey") }
            .addHeader("Accept", "text/event-stream")
            .post(requestBodyJson.toString().toRequestBody("application/json".toMediaType()))
            .build()

        val call = http.newCall(request)
        call.enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                close(e)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        val errorBody = runCatching { resp.body?.string() }.getOrNull().orEmpty()
                        close(ProviderRequestException("Request failed (HTTP ${resp.code}): ${errorBody.take(300)}", resp.code))
                        return
                    }
                    val source = resp.body?.source()
                    if (source == null) {
                        close(ProviderRequestException("Empty response body"))
                        return
                    }
                    try {
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            if (line.isBlank()) continue
                            if (!line.startsWith("data:")) continue
                            val payload = line.removePrefix("data:").trim()
                            if (payload == "[DONE]") break
                            val delta = extractDeltaText(payload)
                            if (!delta.isNullOrEmpty()) {
                                trySend(delta)
                            }
                        }
                        close()
                    } catch (e: IOException) {
                        close(e)
                    }
                }
            }
        })

        awaitClose { call.cancel() }
    }.flowOn(ioDispatcher)

    private fun extractDeltaText(payload: String): String? = runCatching {
        val root = json.parseToJsonElement(payload).jsonObject
        val choices = root["choices"]?.jsonArray ?: return null
        val first = choices.firstOrNull()?.jsonObject ?: return null
        val delta = first["delta"]?.jsonObject
        val fromDelta = delta?.get("content")?.jsonPrimitive?.contentOrNull
        if (fromDelta != null) return fromDelta
        // Some providers (or non-stream fallbacks) use `message.content` instead of `delta.content`.
        val message = first["message"]?.jsonObject
        message?.get("content")?.jsonPrimitive?.contentOrNull
    }.getOrNull()
}
