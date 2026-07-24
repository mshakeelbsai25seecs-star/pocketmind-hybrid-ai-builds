package com.pocketmind.hybridai.util

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

data class OrphanItem(
    val path: String,
    val fileName: String,
    val sizeBytes: Long,
    val kind: String,
    val safeToDelete: Boolean
)

object OrphanCleaner {

    /** Lists `.part` / `.partial` leftovers under the models directory. */
    suspend fun scanPartialDownloads(
        modelsDir: File,
        activeModelPath: String? = null
    ): List<OrphanItem> = withContext(Dispatchers.IO) {
        if (!modelsDir.isDirectory) return@withContext emptyList()
        val activeCanon = activeModelPath?.let { File(it).absolutePath.lowercase() }
        modelsDir.walkTopDown()
            .filter { it.isFile }
            .mapNotNull { file ->
                val name = file.name.lowercase()
                if (!name.endsWith(".part") && !name.endsWith(".partial")) return@mapNotNull null
                val safe = activeCanon?.let { file.absolutePath.lowercase() != it } ?: true
                OrphanItem(
                    path = file.absolutePath,
                    fileName = file.name,
                    sizeBytes = file.length(),
                    kind = "partial_download",
                    safeToDelete = safe
                )
            }
            .toList()
    }

    suspend fun deletePaths(paths: List<String>): Int = withContext(Dispatchers.IO) {
        paths.count { path ->
            val file = File(path)
            file.isFile && file.delete()
        }
    }
}
