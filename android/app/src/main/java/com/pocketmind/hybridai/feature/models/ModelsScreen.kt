package com.pocketmind.hybridai.feature.models

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.network.ModelKind
import com.pocketmind.hybridai.data.network.ProviderCatalog
import com.pocketmind.hybridai.data.network.ProviderHealthRepository
import com.pocketmind.hybridai.data.network.ProviderStatus
import com.pocketmind.hybridai.data.network.SeedModel
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.engine.download.DownloadProgress
import com.pocketmind.hybridai.engine.download.GgufDownloadCatalog
import com.pocketmind.hybridai.engine.download.ModelDownloadManager
import com.pocketmind.hybridai.engine.download.QuantSibling
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.engine.llama.LocalModelInfo
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmStatusChip
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.UserFacingError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ModelsViewModel @Inject constructor(
    private val health: ProviderHealthRepository,
    private val secureStore: SecureStore,
    private val localEngine: LocalLlamaEngine,
    private val settings: SettingsRepository,
    private val downloader: ModelDownloadManager
) : ViewModel() {
    val localModels = localEngine.listImportedModels()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val downloadProgress = downloader.progress
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)

    private val _statuses = MutableStateFlow<List<ProviderStatus>>(emptyList())
    val statuses = _statuses.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    private val _message = MutableStateFlow<String?>(null)
    val message = _message.asStateFlow()

    fun refresh() = viewModelScope.launch {
        _busy.value = true
        _message.value = null
        runCatching { health.probeAll() }
            .onSuccess { _statuses.value = it }
            .onFailure { _message.value = UserFacingError.map(it) }
        _busy.value = false
    }

    fun saveKey(provider: ApiProvider, value: String) {
        secureStore.setApiKey(provider, value.ifBlank { null })
    }

    fun keyFor(provider: ApiProvider) = secureStore.getApiKey(provider).orEmpty()

    fun importGguf(uri: Uri, name: String) = viewModelScope.launch {
        _busy.value = true
        localEngine.importModel(uri, name)
            .onSuccess { _message.value = "Imported ${it.fileName}" }
            .onFailure { _message.value = UserFacingError.map(it) }
        _busy.value = false
    }

    fun setDefault(seed: SeedModel) = viewModelScope.launch {
        settings.setDefaultModel(seed.modelId, seed.label, seed.kind.name.lowercase())
        _message.value = "Default: ${seed.label}"
    }

    fun setDefaultLocal(model: LocalModelInfo) = viewModelScope.launch {
        settings.setDefaultModel(model.id, model.fileName, "local")
        _message.value = "Default local: ${model.fileName}"
    }

    fun downloadSibling(sibling: QuantSibling) = viewModelScope.launch {
        _busy.value = true
        _message.value = "Downloading ${sibling.label}…"
        downloader.download(sibling)
            .onSuccess { _message.value = "Ready: ${it.name}" }
            .onFailure { _message.value = UserFacingError.map(it) }
        _busy.value = false
    }

    fun cancelDownload() = downloader.cancel()
}

@Composable
fun ModelsScreen(vm: ModelsViewModel = hiltViewModel()) {
    var tab by remember { mutableIntStateOf(0) }
    val tabs = listOf("Local", "Download", "Free", "Premium", "Keys")
    val local by vm.localModels.collectAsState()
    val statuses by vm.statuses.collectAsState()
    val busy by vm.busy.collectAsState()
    val message by vm.message.collectAsState()
    val progress by vm.downloadProgress.collectAsState()
    val scope = rememberCoroutineScope()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val name = uri.lastPathSegment?.substringAfterLast(':') ?: "model.gguf"
            scope.launch { vm.importGguf(uri, name) }
        }
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Models", style = MaterialTheme.typography.headlineMedium)
            PmGhostButton(text = if (busy) "…" else "Refresh", onClick = vm::refresh, enabled = !busy)
        }
        message?.let {
            Text(it, color = PmGreen, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 4.dp))
        }
        progress?.let { p ->
            if (p.status == "downloading" || p.status == "cancelled") {
                DownloadSpeedBar(p, onCancel = vm::cancelDownload)
            }
        }
        ScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
            tabs.forEachIndexed { i, label ->
                Tab(selected = tab == i, onClick = { tab = i }, text = { Text(label) })
            }
        }
        when (tab) {
            0 -> LocalModelsPane(local, onImport = { picker.launch(arrayOf("*/*")) }, onSelect = vm::setDefaultLocal)
            1 -> QuantDownloadPane(local, busy, onDownload = vm::downloadSibling, onSelectLocal = vm::setDefaultLocal)
            2 -> ModelSeedList(ProviderCatalog.FREE_SEED_MODELS, statuses, onSelect = vm::setDefault)
            3 -> ModelSeedList(ProviderCatalog.PREMIUM_SEED_MODELS, statuses, onSelect = vm::setDefault)
            4 -> KeysPane(vm)
        }
    }
}

@Composable
private fun DownloadSpeedBar(p: DownloadProgress, onCancel: () -> Unit) {
    val pct = if (p.total != null && p.total > 0) (p.downloaded.toFloat() / p.total.toFloat()).coerceIn(0f, 1f) else 0f
    val mbps = p.bytesPerSec / (1024.0 * 1024.0)
    Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            "${p.fileName} · ${"%.2f".format(mbps)} MB/s" +
                (p.etaSec?.let { " · ETA ${it.toInt()}s" } ?: "") +
                if (p.resumed) " · resumed" else "",
            style = MaterialTheme.typography.labelMedium,
            color = PmGreen
        )
        LinearProgressIndicator(
            progress = { pct },
            modifier = Modifier.fillMaxWidth().height(6.dp)
        )
        PmGhostButton(text = "Cancel download", onClick = onCancel)
    }
}

@Composable
private fun LocalModelsPane(
    local: List<LocalModelInfo>,
    onImport: () -> Unit,
    onSelect: (LocalModelInfo) -> Unit
) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
        item {
            PmPrimaryButton(
                text = "Import GGUF",
                accentGreen = true,
                onClick = onImport,
                modifier = Modifier.fillMaxWidth()
            )
        }
        item {
            Text(
                "Tap a file to set it as the active local model. Sibling quants of the same family can be switched from Download.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (local.isEmpty()) {
            item { Text("No local models yet.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        items(local) { m ->
            PmCard(onClick = { onSelect(m) }) {
                Text(m.fileName, style = MaterialTheme.typography.titleMedium)
                Text("${m.sizeBytes / (1024 * 1024)} MB", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun QuantDownloadPane(
    local: List<LocalModelInfo>,
    busy: Boolean,
    onDownload: (QuantSibling) -> Unit,
    onSelectLocal: (LocalModelInfo) -> Unit
) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
        item {
            Text(
                "Quantization switch picks among available GGUF files (Q4 / Q5 / Q8). It does not re-encode a single file.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        GgufDownloadCatalog.families().forEach { family ->
            item {
                Text(family, style = MaterialTheme.typography.titleSmall, color = PmGreen, modifier = Modifier.padding(top = 8.dp))
            }
            items(GgufDownloadCatalog.forFamily(family)) { sibling ->
                val imported = local.find { it.fileName.equals(sibling.fileName, ignoreCase = true) }
                PmCard {
                    Text(sibling.label, style = MaterialTheme.typography.titleMedium)
                    Text(sibling.quant, style = MaterialTheme.typography.labelMedium, color = PmGreen)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                        if (imported != null) {
                            PmPrimaryButton(
                                text = "Use this quant",
                                accentGreen = true,
                                onClick = { onSelectLocal(imported) },
                                enabled = !busy
                            )
                        } else {
                            PmPrimaryButton(
                                text = "Download ${sibling.quant}",
                                accentGreen = true,
                                onClick = { onDownload(sibling) },
                                enabled = !busy
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModelSeedList(
    seeds: List<SeedModel>,
    statuses: List<ProviderStatus>,
    onSelect: (SeedModel) -> Unit
) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 12.dp)) {
        items(seeds) { seed ->
            val status = statuses.find { it.providerId == seed.providerId }
            val liveOk = status?.models?.any { it.id == seed.modelId || it.id.endsWith("/${seed.modelId}") } == true
            val unknown = statuses.isEmpty()
            PmCard(onClick = { onSelect(seed) }) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(seed.label, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    PmStatusChip(
                        label = when {
                            unknown -> "seed"
                            liveOk || status?.isOnline == true -> "live"
                            else -> "check"
                        },
                        ok = liveOk || (unknown && seed.kind == ModelKind.FREE)
                    )
                }
                Text("${seed.providerLabel} · ${seed.modelId}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                seed.notes?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun KeysPane(vm: ModelsViewModel) {
    val providers = listOf(
        ApiProvider.GROQ, ApiProvider.GEMINI, ApiProvider.OPENROUTER,
        ApiProvider.DEEPSEEK, ApiProvider.MISTRAL, ApiProvider.TOGETHER,
        ApiProvider.HF, ApiProvider.POLLINATIONS
    )
    LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 12.dp)) {
        items(providers) { p ->
            var value by remember(p) { mutableStateOf(vm.keyFor(p)) }
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                label = { Text(p.displayName) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )
            PmGhostButton(text = "Save ${p.displayName}", onClick = { vm.saveKey(p, value) })
        }
    }
}
