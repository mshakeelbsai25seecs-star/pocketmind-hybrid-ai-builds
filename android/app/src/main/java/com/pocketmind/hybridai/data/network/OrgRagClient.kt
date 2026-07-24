package com.pocketmind.hybridai.data.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

data class OrgCollection(
    val id: String,
    val name: String,
    val status: String?,
    val fileCount: Int?,
    val chunkCount: Int?
)

data class OrgKnowledgeChatResult(
    val answer: String,
    val citations: List<String> = emptyList()
)

/**
 * Thin client for the Full Server RAG gateway (`enterprise-server/full-rag`).
 * Endpoints: GET /v1/knowledge/collections, POST /v1/knowledge/chat
 */
@Singleton
class OrgRagClient @Inject constructor(
    private val http: OkHttpClient,
    private val json: Json,
    private val openAi: OpenAiCompatibleClient
) {
    private val ioDispatcher = Dispatchers.IO

    suspend fun probeRagAvailable(baseUrl: String, token: String?): Boolean = withContext(ioDispatcher) {
        runCatching {
            val url = ragUrl(baseUrl, "knowledge/collections")
            val request = Request.Builder()
                .url(url)
                .apply { if (!token.isNullOrBlank()) addHeader("Authorization", "Bearer $token") }
                .get()
                .build()
            http.newCall(request).execute().use { it.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun listCollections(baseUrl: String, token: String?): Result<List<OrgCollection>> =
        withContext(ioDispatcher) {
            runCatching {
                val url = ragUrl(baseUrl, "knowledge/collections")
                val request = Request.Builder()
                    .url(url)
                    .apply { if (!token.isNullOrBlank()) addHeader("Authorization", "Bearer $token") }
                    .get()
                    .build()
                http.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw ProviderRequestException(
                            "Collections request failed (HTTP ${response.code})",
                            response.code
                        )
                    }
                    val body = response.body?.string().orEmpty()
                    val arr = json.parseToJsonElement(body)
                    if (arr !is JsonArray) return@runCatching emptyList()
                    arr.mapNotNull { el ->
                        val obj = el as? JsonObject ?: return@mapNotNull null
                        OrgCollection(
                            id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                            name = obj["name"]?.jsonPrimitive?.contentOrNull ?: obj["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                            status = obj["status"]?.jsonPrimitive?.contentOrNull,
                            fileCount = obj["file_count"]?.jsonPrimitive?.intOrNull,
                            chunkCount = obj["chunk_count"]?.jsonPrimitive?.intOrNull
                        )
                    }
                }
            }
        }

    suspend fun knowledgeChat(
        baseUrl: String,
        token: String?,
        collectionId: String,
        message: String
    ): Result<OrgKnowledgeChatResult> = withContext(ioDispatcher) {
        runCatching {
            val url = ragUrl(baseUrl, "knowledge/chat")
            val payload = buildJsonObject {
                put("message", message)
                put("collection_id", collectionId)
            }
            val request = Request.Builder()
                .url(url)
                .apply { if (!token.isNullOrBlank()) addHeader("Authorization", "Bearer $token") }
                .post(payload.toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ProviderRequestException(
                        "Knowledge chat failed (HTTP ${response.code})",
                        response.code
                    )
                }
                val body = response.body?.string().orEmpty()
                val obj = json.parseToJsonElement(body).jsonObject
                val answer = obj["answer"]?.jsonPrimitive?.contentOrNull
                    ?: obj["message"]?.jsonPrimitive?.contentOrNull
                    ?: obj["content"]?.jsonPrimitive?.contentOrNull
                    ?: body
                val citations = obj["citations"]?.jsonArray?.mapNotNull {
                    it.jsonPrimitive.contentOrNull
                }.orEmpty()
                OrgKnowledgeChatResult(answer, citations)
            }
        }
    }

    private fun ragUrl(rawBase: String, path: String): String {
        val base = openAi.normalizeBaseUrl(rawBase)
        return base.trimEnd('/') + "/" + path.trimStart('/')
    }
}
