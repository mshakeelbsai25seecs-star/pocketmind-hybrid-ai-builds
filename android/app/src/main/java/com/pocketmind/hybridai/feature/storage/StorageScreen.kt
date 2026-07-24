package com.pocketmind.hybridai.feature.storage

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.db.GeneratedImageDao
import com.pocketmind.hybridai.data.db.ModelRecordDao
import com.pocketmind.hybridai.data.network.ImageProviders
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.IntegrityResult
import com.pocketmind.hybridai.util.ModelIntegrity
import com.pocketmind.hybridai.util.OrphanCleaner
import com.pocketmind.hybridai.util.OrphanItem
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

@HiltViewModel
class StorageViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val localEngine: LocalLlamaEngine,
    private val images: ImageProviders,
    private val imageDao: GeneratedImageDao,
    private val modelRecordDao: ModelRecordDao
) : ViewModel() {
    val localModels = localEngine.listImportedModels()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private val _imageBytes = MutableStateFlow(0L)
    val imageBytes = _imageBytes.asStateFlow()
    private val _verifyResults = MutableStateFlow<List<IntegrityResult>>(emptyList())
    val verifyResults = _verifyResults.asStateFlow()
    private val _verifyBusy = MutableStateFlow(false)
    val verifyBusy = _verifyBusy.asStateFlow()
    private val _orphans = MutableStateFlow<List<OrphanItem>>(emptyList())
    val orphans = _orphans.asStateFlow()

    private val modelsDir get() = File(context.filesDir, "models")

    fun refresh() {
        _imageBytes.value = images.imagesDirectorySizeBytes()
        scanOrphans()
    }

    fun clearImages() = viewModelScope.launch {
        images.clearAllImages()
        imageDao.deleteAll()
        refresh()
    }

    fun scanOrphans() = viewModelScope.launch {
        _orphans.value = OrphanCleaner.scanPartialDownloads(modelsDir)
    }

    fun verifyLocalModels() = viewModelScope.launch {
        _verifyBusy.value = true
        val models = localModels.first()
        val results = models.map { model ->
            val record = modelRecordDao.getById(model.id)
            val result = ModelIntegrity.verify(model.filePath, record?.sha256)
            val updated = (record ?: com.pocketmind.hybridai.data.db.ModelRecordEntity(
                id = model.id,
                providerId = "local",
                modelId = model.fileName,
                label = model.fileName,
                kind = "local",
                filePath = model.filePath,
                sizeBytes = model.sizeBytes,
                lastCheckedAt = System.currentTimeMillis()
            )).copy(sha256 = result.sha256, lastCheckedAt = System.currentTimeMillis())
            modelRecordDao.upsert(updated)
            result.copy(matchedExpected = record?.sha256?.let { result.sha256.equals(it, ignoreCase = true) })
        }
        _verifyResults.value = results
        _verifyBusy.value = false
    }

    fun deleteOrphans(paths: List<String>) = viewModelScope.launch {
        OrphanCleaner.deletePaths(paths)
        scanOrphans()
    }
}

@Composable
fun StorageScreen(onBack: () -> Unit, vm: StorageViewModel = hiltViewModel()) {
    val models by vm.localModels.collectAsState()
    val imageBytes by vm.imageBytes.collectAsState()
    val verifyResults by vm.verifyResults.collectAsState()
    val verifyBusy by vm.verifyBusy.collectAsState()
    val orphans by vm.orphans.collectAsState()
    var confirmDelete by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.refresh() }
    val modelBytes = models.sumOf { it.sizeBytes }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete partial downloads?") },
            text = {
                Text("Remove ${orphans.size} .part/.partial file(s) from the models folder? Active GGUF files are not touched.")
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.deleteOrphans(orphans.filter { it.safeToDelete }.map { it.path })
                    confirmDelete = false
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancel") }
            }
        )
    }

    Column(Modifier.fillMaxSize()) {
        PmTopBar("Storage", onBack = onBack)
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            PmCard {
                Text("Local models", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                Text("${models.size} files · ${modelBytes / (1024 * 1024)} MB")
                PmGhostButton(
                    text = if (verifyBusy) "Verifying SHA-256…" else "Verify model SHA-256",
                    enabled = !verifyBusy && models.isNotEmpty(),
                    onClick = vm::verifyLocalModels,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                )
                verifyResults.forEach { r ->
                    Text(
                        "${File(r.path).name}: ${r.sha256.take(16)}…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            PmCard {
                Text("Partial downloads", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                Text(
                    if (orphans.isEmpty()) "No .part/.partial files found"
                    else "${orphans.size} leftover partial file(s) · ${orphans.sumOf { it.sizeBytes } / (1024 * 1024)} MB",
                    style = MaterialTheme.typography.bodySmall
                )
                if (orphans.isNotEmpty()) {
                    orphans.forEach { o ->
                        Text(o.fileName, style = MaterialTheme.typography.bodySmall)
                    }
                    PmGhostButton(
                        text = "Delete partial files",
                        onClick = { confirmDelete = true },
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp)
                    )
                }
            }
            PmCard {
                Text("Generated images", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                Text("${imageBytes / (1024 * 1024)} MB cache")
            }
            PmGhostButton(
                text = "Clear image cache",
                onClick = vm::clearImages,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}
