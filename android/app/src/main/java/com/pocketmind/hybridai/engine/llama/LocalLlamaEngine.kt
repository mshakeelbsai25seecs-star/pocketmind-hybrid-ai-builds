package com.pocketmind.hybridai.engine.llama

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import com.pocketmind.hybridai.data.db.ModelRecordDao
import com.pocketmind.hybridai.data.db.ModelRecordEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/** Snapshot of what this device can realistically run on-device. */
data class DeviceCapabilities(
    val hasVulkan: Boolean,
    val totalRamMb: Long,
    val availableRamMb: Long,
    val isLowRamDevice: Boolean,
    val cpuAbi: String,
    val recommendSafeCpuOnly: Boolean
)

/** A GGUF file the user has imported into app-private storage. */
data class LocalModelInfo(
    val id: String,
    val fileName: String,
    val filePath: String,
    val sizeBytes: Long,
    val importedAt: Long
)

/**
 * On-device inference engine contract. v1 ships an honest, non-simulated
 * implementation: it can import/manage GGUF files and report device
 * capability, but only actually *generates* text if a real `llama-cli` /
 * `llama-server` binary has been installed into `filesDir/bin`. There is
 * intentionally no fake/mock model that pretends to produce AI output.
 */
interface LocalLlamaEngine {
    fun capabilities(): DeviceCapabilities
    fun listImportedModels(): Flow<List<LocalModelInfo>>
    suspend fun importModel(uri: Uri, displayName: String): Result<LocalModelInfo>
    suspend fun deleteModel(modelId: String): Result<Unit>
    fun isRuntimeAvailable(): Boolean
    fun runtimeUnavailableMessage(): String
    fun generate(model: LocalModelInfo, prompt: String, maxTokens: Int): Flow<String>
    fun stop()
}

@Singleton
class LocalProcessLlamaEngine @Inject constructor(
    @ApplicationContext private val context: Context,
    private val modelRecordDao: ModelRecordDao
) : LocalLlamaEngine {

    private val modelsDir: File by lazy { File(context.filesDir, "models").apply { mkdirs() } }
    private val binDir: File by lazy { File(context.filesDir, "bin").apply { mkdirs() } }

    @Volatile
    private var runningProcess: Process? = null

    override fun capabilities(): DeviceCapabilities {
        val pm = context.packageManager
        val hasVulkan = pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_LEVEL) ||
            pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_VERSION) ||
            pm.hasSystemFeature(PackageManager.FEATURE_VULKAN_HARDWARE_COMPUTE)

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memoryInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memoryInfo)
        val totalRamMb = memoryInfo.totalMem / (1024 * 1024)
        val availRamMb = memoryInfo.availMem / (1024 * 1024)
        val isLowRam = activityManager.isLowRamDevice

        return DeviceCapabilities(
            hasVulkan = hasVulkan,
            totalRamMb = totalRamMb,
            availableRamMb = availRamMb,
            isLowRamDevice = isLowRam,
            cpuAbi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            recommendSafeCpuOnly = isLowRam || totalRamMb < 3072
        )
    }

    override fun listImportedModels(): Flow<List<LocalModelInfo>> =
        modelRecordDao.observeByKind("local").map { records ->
            records.mapNotNull { record ->
                val path = record.filePath ?: return@mapNotNull null
                val file = File(path)
                if (!file.exists()) return@mapNotNull null
                LocalModelInfo(
                    id = record.id,
                    fileName = file.name,
                    filePath = path,
                    sizeBytes = record.sizeBytes ?: file.length(),
                    importedAt = record.lastCheckedAt
                )
            }
        }

    override suspend fun importModel(uri: Uri, displayName: String): Result<LocalModelInfo> = withContext(Dispatchers.IO) {
        runCatching {
            val safeName = displayName.ifBlank { "model_${System.currentTimeMillis()}" }
                .replace(Regex("[^A-Za-z0-9._-]"), "_")
            val targetName = if (safeName.endsWith(".gguf", ignoreCase = true)) safeName else "$safeName.gguf"
            val targetFile = File(modelsDir, targetName)

            context.contentResolver.openInputStream(uri)?.use { input ->
                targetFile.outputStream().use { output -> input.copyTo(output) }
            } ?: throw IllegalStateException("Could not open the selected file")

            if (targetFile.length() == 0L) {
                targetFile.delete()
                throw IllegalStateException("The imported file is empty")
            }

            val now = System.currentTimeMillis()
            val id = UUID.randomUUID().toString()
            modelRecordDao.upsert(
                ModelRecordEntity(
                    id = id,
                    providerId = "local",
                    modelId = targetName,
                    label = displayName.ifBlank { targetName },
                    kind = "local",
                    isAvailable = true,
                    filePath = targetFile.absolutePath,
                    sizeBytes = targetFile.length(),
                    lastCheckedAt = now
                )
            )
            LocalModelInfo(id, targetName, targetFile.absolutePath, targetFile.length(), now)
        }
    }

    override suspend fun deleteModel(modelId: String): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val record = modelRecordDao.getById(modelId)
            record?.filePath?.let { File(it).delete() }
            modelRecordDao.deleteById(modelId)
            Unit
        }
    }

    override fun isRuntimeAvailable(): Boolean {
        val candidates = listOf("llama-server", "llama-cli", "main")
        return candidates.any { name ->
            val file = File(binDir, name)
            file.exists() && (file.canExecute() || file.setExecutable(true))
        }
    }

    override fun runtimeUnavailableMessage(): String =
        "On-device inference isn't installed on this build yet, so I can't generate a real reply locally. " +
            "Your imported GGUF files are safe and listed below \u2014 once a native llama.cpp runtime pack " +
            "(llama-cli / llama-server) is added to the app's bin folder, on-device chat will start working " +
            "with them automatically. Until then, use Org Server or an Online Free/Premium model to chat."

    override fun generate(model: LocalModelInfo, prompt: String, maxTokens: Int): Flow<String> = callbackFlow {
        if (!isRuntimeAvailable()) {
            trySend(runtimeUnavailableMessage())
            close()
            return@callbackFlow
        }

        val binaryFile = listOf("llama-server", "llama-cli", "main")
            .map { File(binDir, it) }
            .firstOrNull { it.exists() }

        if (binaryFile == null) {
            trySend(runtimeUnavailableMessage())
            close()
            return@callbackFlow
        }

        try {
            val process = ProcessBuilder(
                binaryFile.absolutePath,
                "-m", model.filePath,
                "-p", prompt,
                "-n", maxTokens.toString(),
                "--no-display-prompt"
            ).redirectErrorStream(true).start()
            runningProcess = process

            BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    trySend(line + "\n")
                }
            }
            process.waitFor()
            close()
        } catch (e: Exception) {
            close(e)
        } finally {
            runningProcess = null
        }
    }.flowOn(Dispatchers.IO)

    override fun stop() {
        runningProcess?.destroy()
        runningProcess = null
    }
}
