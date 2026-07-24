package com.pocketmind.hybridai.engine.download

import android.content.Context
import com.pocketmind.hybridai.data.db.ModelRecordDao
import com.pocketmind.hybridai.data.db.ModelRecordEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

data class DownloadProgress(
    val fileName: String,
    val downloaded: Long,
    val total: Long?,
    val bytesPerSec: Double,
    val etaSec: Double?,
    val resumed: Boolean,
    val status: String
)

/** Curated GGUF download siblings for the quantization picker (not live re-quantize). */
data class QuantSibling(
    val family: String,
    val quant: String,
    val label: String,
    val url: String,
    val fileName: String
)

object GgufDownloadCatalog {
    val SIBLINGS: List<QuantSibling> = listOf(
        QuantSibling(
            "Qwen2.5-1.5B-Instruct", "Q4_K_M", "Qwen2.5 1.5B Q4_K_M",
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf?download=true",
            "qwen2.5-1.5b-instruct-q4_k_m.gguf"
        ),
        QuantSibling(
            "Qwen2.5-1.5B-Instruct", "Q5_K_M", "Qwen2.5 1.5B Q5_K_M",
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q5_k_m.gguf?download=true",
            "qwen2.5-1.5b-instruct-q5_k_m.gguf"
        ),
        QuantSibling(
            "Qwen2.5-1.5B-Instruct", "Q8_0", "Qwen2.5 1.5B Q8_0",
            "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q8_0.gguf?download=true",
            "qwen2.5-1.5b-instruct-q8_0.gguf"
        ),
        QuantSibling(
            "TinyLlama-1.1B-Chat", "Q4_K_M", "TinyLlama 1.1B Q4_K_M",
            "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf?download=true",
            "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
        ),
        QuantSibling(
            "TinyLlama-1.1B-Chat", "Q5_K_M", "TinyLlama 1.1B Q5_K_M",
            "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q5_K_M.gguf?download=true",
            "tinyllama-1.1b-chat-v1.0.Q5_K_M.gguf"
        ),
        QuantSibling(
            "TinyLlama-1.1B-Chat", "Q8_0", "TinyLlama 1.1B Q8_0",
            "https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q8_0.gguf?download=true",
            "tinyllama-1.1b-chat-v1.0.Q8_0.gguf"
        )
    )

    fun families(): List<String> = SIBLINGS.map { it.family }.distinct()
    fun forFamily(family: String): List<QuantSibling> = SIBLINGS.filter { it.family == family }
}

/**
 * HTTP Range resumable GGUF downloader. Writes to `filesDir/models` via a
 * `.partial` file, then renames on success. Emits MB/s via a rolling window.
 */
@Singleton
class ModelDownloadManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val modelRecordDao: ModelRecordDao,
    private val okHttp: OkHttpClient
) {
    private val modelsDir: File by lazy { File(context.filesDir, "models").apply { mkdirs() } }
    private val client: OkHttpClient = okHttp.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private val _progress = MutableStateFlow<DownloadProgress?>(null)
    val progress: Flow<DownloadProgress?> = _progress.asStateFlow()

    @Volatile
    private var cancelRequested = false

    fun cancel() {
        cancelRequested = true
    }

    suspend fun download(sibling: QuantSibling): Result<File> = withContext(Dispatchers.IO) {
        cancelRequested = false
        val finalFile = File(modelsDir, sibling.fileName)
        if (finalFile.exists() && finalFile.length() > 0) {
            ensureRecord(sibling, finalFile)
            _progress.value = DownloadProgress(
                sibling.fileName, finalFile.length(), finalFile.length(),
                0.0, 0.0, resumed = false, status = "already_present"
            )
            return@withContext Result.success(finalFile)
        }

        val partial = File(modelsDir, "${sibling.fileName}.partial")
        val existing = if (partial.exists()) partial.length() else 0L
        val resumed = existing > 0

        val requestBuilder = Request.Builder().url(sibling.url).header("User-Agent", "PocketMindHybridAI/1.0.2")
        if (resumed) requestBuilder.header("Range", "bytes=$existing-")

        try {
            client.newCall(requestBuilder.build()).execute().use { response ->
                if (!response.isSuccessful && response.code != 206) {
                    return@withContext Result.failure(
                        IllegalStateException("Download failed HTTP ${response.code}")
                    )
                }
                val body = response.body ?: return@withContext Result.failure(
                    IllegalStateException("Empty response body")
                )
                val contentLength = body.contentLength().takeIf { it >= 0 }
                val total = when {
                    response.code == 206 && contentLength != null -> existing + contentLength
                    contentLength != null && response.code == 200 -> contentLength
                    else -> null
                }
                if (response.code == 200 && existing > 0) {
                    // Server ignored Range — restart clean.
                    partial.delete()
                }
                val startOffset = if (response.code == 206) existing else 0L

                RandomAccessFile(partial, "rw").use { raf ->
                    if (response.code == 206) raf.seek(startOffset) else raf.setLength(0)
                    val buffer = ByteArray(64 * 1024)
                    var downloaded = startOffset
                    var windowBytes = 0L
                    var windowStart = System.nanoTime()
                    var speed = 0.0
                    body.byteStream().use { input ->
                        while (true) {
                            if (cancelRequested) {
                                _progress.value = DownloadProgress(
                                    sibling.fileName, downloaded, total, speed, null, resumed, "cancelled"
                                )
                                return@withContext Result.failure(IllegalStateException("Download cancelled"))
                            }
                            val read = input.read(buffer)
                            if (read < 0) break
                            raf.write(buffer, 0, read)
                            downloaded += read
                            windowBytes += read
                            val elapsedNs = System.nanoTime() - windowStart
                            if (elapsedNs >= 500_000_000L) {
                                speed = windowBytes.toDouble() / (elapsedNs / 1_000_000_000.0)
                                windowBytes = 0
                                windowStart = System.nanoTime()
                            }
                            val eta = if (total != null && speed > 1) {
                                (total - downloaded) / speed
                            } else null
                            _progress.value = DownloadProgress(
                                sibling.fileName, downloaded, total, speed, eta, resumed, "downloading"
                            )
                        }
                    }
                }

                if (!partial.renameTo(finalFile)) {
                    partial.copyTo(finalFile, overwrite = true)
                    partial.delete()
                }
                ensureRecord(sibling, finalFile)
                _progress.value = DownloadProgress(
                    sibling.fileName, finalFile.length(), finalFile.length(),
                    0.0, 0.0, resumed, "complete"
                )
                Result.success(finalFile)
            }
        } catch (t: Throwable) {
            _progress.value = DownloadProgress(
                sibling.fileName, existing, null, 0.0, null, resumed, "error"
            )
            Result.failure(t)
        }
    }

    private suspend fun ensureRecord(sibling: QuantSibling, file: File) {
        val existing = modelRecordDao.getByKindOnce("local").find { it.filePath == file.absolutePath }
        if (existing != null) return
        modelRecordDao.upsert(
            ModelRecordEntity(
                id = UUID.randomUUID().toString(),
                providerId = "local",
                modelId = sibling.fileName,
                label = "${sibling.label} [${sibling.quant}]",
                kind = "local",
                filePath = file.absolutePath,
                sizeBytes = file.length(),
                lastCheckedAt = System.currentTimeMillis()
            )
        )
    }
}
