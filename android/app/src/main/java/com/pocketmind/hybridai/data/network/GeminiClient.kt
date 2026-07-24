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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Client for Google's Gemini "generateContent" API. Prefers server-sent
 * streaming (`alt=sse`) and transparently falls back to a single non-stream
 * call (emitting the whole answer as one item) if streaming fails outright,
 * e.g. on networks that buffer/strip SSE responses.
 */
@Singleton
class GeminiClient @Inject constructor(
    private val http: OkHttpClient,
    private val json: Json
) {
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO

    suspend fun listModels(apiKey: String): Result<List<RemoteModel>> = withContext(ioDispatcher) {
        runCatching {
            val request = Request.Builder()
                .url("${ProviderCatalog.GEMINI_BASE}models?key=$apiKey")
                .get()
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ProviderRequestException("Gemini model list failed (HTTP ${response.code})", response.code)
                }
                val bodyText = response.body?.string().orEmpty()
                val root = json.parseToJsonElement(bodyText).jsonObject
                val models = (root["models"] as? JsonArray) ?: return@use emptyList()
                models.mapNotNull { element ->
                    val obj = element as? JsonObject ?: return@mapNotNull null
                    val methods = obj["supportedGenerationMethods"]?.jsonArray
                        ?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
                    if ("generateContent" !in methods) return@mapNotNull null
                    val rawName = obj["name"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    RemoteModel(
                        id = rawName.removePrefix("models/"),
                        contextLength = obj["inputTokenLimit"]?.jsonPrimitive?.int
                    )
                }
            }
        }
    }

    /** Streams a reply for [messages] (last entry should be the newest user turn). */
    fun streamGenerate(
        apiKey: String,
        model: String,
        messages: List<ChatTurn>,
        temperature: Float = 0.7f
    ): Flow<String> = callbackFlow {
        val systemText = messages.filter { it.role == "system" }.joinToString("\n") { it.content }
        val turns = messages.filter { it.role != "system" }

        val requestBodyJson = buildJsonObject {
            if (systemText.isNotBlank()) {
                putJsonObject("systemInstruction") {
                    putJsonArray("parts") { addJsonObject { put("text", systemText) } }
                }
            }
            putJsonArray("contents") {
                turns.forEach { turn ->
                    addJsonObject {
                        put("role", if (turn.role == "assistant") "model" else "user")
                        putJsonArray("parts") { addJsonObject { put("text", turn.content) } }
                    }
                }
            }
            putJsonObject("generationConfig") {
                put("temperature", temperature.toDouble())
            }
        }

        val url = "${ProviderCatalog.GEMINI_BASE}models/$model:streamGenerateContent?alt=sse&key=$apiKey"
        val request = Request.Builder()
            .url(url)
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
                        close(ProviderRequestException("Gemini request failed (HTTP ${resp.code}): ${errorBody.take(300)}", resp.code))
                        return
                    }
                    val source = resp.body?.source()
                    if (source == null) {
                        close(ProviderRequestException("Empty Gemini response body"))
                        return
                    }
                    try {
                        while (!source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            if (line.isBlank() || !line.startsWith("data:")) continue
                            val payload = line.removePrefix("data:").trim()
                            val text = extractText(payload)
                            if (!text.isNullOrEmpty()) trySend(text)
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

    /** Non-streaming fallback used by callers when [streamGenerate] fails to connect at all. */
    suspend fun generateOnce(apiKey: String, model: String, messages: List<ChatTurn>, temperature: Float = 0.7f): Result<String> =
        withContext(ioDispatcher) {
            runCatching {
                val systemText = messages.filter { it.role == "system" }.joinToString("\n") { it.content }
                val turns = messages.filter { it.role != "system" }
                val requestBodyJson = buildJsonObject {
                    if (systemText.isNotBlank()) {
                        putJsonObject("systemInstruction") {
                            putJsonArray("parts") { addJsonObject { put("text", systemText) } }
                        }
                    }
                    putJsonArray("contents") {
                        turns.forEach { turn ->
                            addJsonObject {
                                put("role", if (turn.role == "assistant") "model" else "user")
                                putJsonArray("parts") { addJsonObject { put("text", turn.content) } }
                            }
                        }
                    }
                    putJsonObject("generationConfig") { put("temperature", temperature.toDouble()) }
                }
                val url = "${ProviderCatalog.GEMINI_BASE}models/$model:generateContent?key=$apiKey"
                val request = Request.Builder()
                    .url(url)
                    .post(requestBodyJson.toString().toRequestBody("application/json".toMediaType()))
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw ProviderRequestException("Gemini request failed (HTTP ${response.code})", response.code)
                    }
                    val bodyText = response.body?.string().orEmpty()
                    extractText(bodyText) ?: ""
                }
            }
        }

    private fun extractText(payload: String): String? = runCatching {
        val root = json.parseToJsonElement(payload).jsonObject
        val candidates = root["candidates"]?.jsonArray ?: return null
        val first = candidates.firstOrNull()?.jsonObject ?: return null
        val parts = first["content"]?.jsonObject?.get("parts")?.jsonArray ?: return null
        parts.joinToString("") { it.jsonObject["text"]?.jsonPrimitive?.contentOrNull.orEmpty() }
    }.getOrNull()
}
