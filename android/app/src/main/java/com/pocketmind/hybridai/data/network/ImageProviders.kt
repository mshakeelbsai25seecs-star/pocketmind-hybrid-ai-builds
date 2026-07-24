package com.pocketmind.hybridai.data.network

import android.content.Context
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import java.net.URLEncoder
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Free/low-cost image generation. Pollinations (https://gen.pollinations.ai)
 * requires no account for its free tier, so it's the primary path; Hugging
 * Face Inference is used as an automatic failover when a token is configured
 * and Pollinations is unreachable or rate-limited.
 */
@Singleton
class ImageProviders @Inject constructor(
    @ApplicationContext private val context: Context,
    private val http: OkHttpClient,
    private val secureStore: SecureStore
) {
    private val imagesDir: File by lazy { File(context.filesDir, "images").apply { mkdirs() } }

    suspend fun generateViaPollinations(
        prompt: String,
        model: String,
        width: Int = 1024,
        height: Int = 1024,
        seed: Long? = null
    ): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val encoded = URLEncoder.encode(prompt, "UTF-8").replace("+", "%20")
            val url = buildString {
                append(ProviderCatalog.POLLINATIONS_IMAGE_BASE)
                append(encoded)
                append("?model=").append(model)
                append("&width=").append(width)
                append("&height=").append(height)
                append("&nologo=true")
                if (seed != null) append("&seed=").append(seed)
            }
            val key = secureStore.getApiKey(ApiProvider.POLLINATIONS)
            val request = Request.Builder()
                .url(url)
                .apply { if (!key.isNullOrBlank()) addHeader("Authorization", "Bearer $key") }
                .get()
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ProviderRequestException("Pollinations image request failed (HTTP ${response.code})", response.code)
                }
                val bytes = response.body?.bytes()
                if (bytes == null || bytes.isEmpty()) throw ProviderRequestException("Pollinations returned an empty image")
                saveBytes(bytes, "pollinations")
            }
        }
    }

    suspend fun generateViaHuggingFace(
        prompt: String,
        model: String = ProviderCatalog.HF_FALLBACK_IMAGE_MODEL
    ): Result<File> = withContext(Dispatchers.IO) {
        runCatching {
            val token = secureStore.getApiKey(ApiProvider.HF)
                ?: throw ProviderRequestException("No Hugging Face token configured")
            val bodyJson = buildJsonObject { put("inputs", prompt) }.toString()
            val request = Request.Builder()
                .url("${ProviderCatalog.HF_INFERENCE_BASE}$model")
                .addHeader("Authorization", "Bearer $token")
                .post(bodyJson.toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    val err = runCatching { response.body?.string() }.getOrNull().orEmpty()
                    throw ProviderRequestException("Hugging Face image request failed (HTTP ${response.code}): ${err.take(200)}", response.code)
                }
                val bytes = response.body?.bytes()
                if (bytes == null || bytes.isEmpty()) throw ProviderRequestException("Hugging Face returned an empty image")
                saveBytes(bytes, "huggingface")
            }
        }
    }

    /**
     * Tries Pollinations first; automatically falls back to Hugging Face
     * Inference (if a token is set) when Pollinations fails. Returns the
     * saved file plus the provider id that actually produced it.
     */
    suspend fun generateWithFailover(prompt: String, model: String): Result<Pair<File, String>> {
        val primary = generateViaPollinations(prompt, model)
        if (primary.isSuccess) {
            return primary.map { file -> file to "pollinations" }
        }
        val hasHfToken = !secureStore.getApiKey(ApiProvider.HF).isNullOrBlank()
        if (hasHfToken) {
            val fallback = generateViaHuggingFace(prompt)
            if (fallback.isSuccess) {
                return fallback.map { file -> file to "huggingface" }
            }
            return Result.failure(fallback.exceptionOrNull() ?: primary.exceptionOrNull() ?: ProviderRequestException("Image generation failed"))
        }
        return Result.failure(primary.exceptionOrNull() ?: ProviderRequestException("Image generation failed"))
    }

    private fun saveBytes(bytes: ByteArray, prefix: String): File {
        val file = File(imagesDir, "${prefix}_${System.currentTimeMillis()}.png")
        FileOutputStream(file).use { it.write(bytes) }
        return file
    }

    fun imagesDirectorySizeBytes(): Long = imagesDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    fun clearAllImages() {
        imagesDir.listFiles()?.forEach { it.delete() }
    }
}
