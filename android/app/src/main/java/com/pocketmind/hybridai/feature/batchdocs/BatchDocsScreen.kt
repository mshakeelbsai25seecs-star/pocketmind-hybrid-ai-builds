package com.pocketmind.hybridai.feature.batchdocs

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.pocketmind.hybridai.data.db.DocSummaryDao
import com.pocketmind.hybridai.data.db.DocSummaryEntity
import com.pocketmind.hybridai.data.network.OrgCollection
import com.pocketmind.hybridai.data.network.OrgRagClient
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.repo.WorkspaceProfileRepository
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.engine.attachments.AttachmentTextExtractor
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

private const val MAX_BATCH_FILES = 20
private const val EXCERPT_CHARS = 4000

enum class DocsMode { OFFLINE, ORG_RAG, ORG_STUB, CLOUD_BATCH }

@HiltViewModel
class BatchDocsViewModel @Inject constructor(
    private val secureStore: SecureStore,
    private val orgRag: OrgRagClient,
    private val attachments: AttachmentTextExtractor,
    private val docSummaryDao: DocSummaryDao,
    private val profiles: WorkspaceProfileRepository,
    private val settings: SettingsRepository
) : ViewModel() {
    private val _mode = MutableStateFlow(DocsMode.OFFLINE)
    val mode = _mode.asStateFlow()
    private val _status = MutableStateFlow<String?>(null)
    val status = _status.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    private val _collections = MutableStateFlow<List<OrgCollection>>(emptyList())
    val collections = _collections.asStateFlow()
    private val _ragAnswer = MutableStateFlow<String?>(null)
    val ragAnswer = _ragAnswer.asStateFlow()

    val summaries = settings.activeProfileId
        .flatMapLatest { profileId -> docSummaryDao.observeForProfile(profileId) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    init {
        viewModelScope.launch {
            profiles.ensureDefaultProfile()
            refreshMode()
        }
    }

    fun refreshMode() = viewModelScope.launch {
        val orgUrl = secureStore.orgUrl
        when {
            !orgUrl.isNullOrBlank() -> {
                val hasRag = orgRag.probeRagAvailable(orgUrl, secureStore.orgToken)
                _mode.value = if (hasRag) DocsMode.ORG_RAG else DocsMode.ORG_STUB
                if (hasRag) loadCollections()
            }
            hasAnyOnlineKey() -> _mode.value = DocsMode.CLOUD_BATCH
            else -> _mode.value = DocsMode.OFFLINE
        }
    }

    private fun hasAnyOnlineKey(): Boolean =
        ApiProvider.entries.any { secureStore.hasApiKey(it) }

    fun loadCollections() = viewModelScope.launch {
        val url = secureStore.orgUrl ?: return@launch
        _busy.value = true
        orgRag.listCollections(url, secureStore.orgToken)
            .onSuccess {
                _collections.value = it
                _status.value = "${it.size} collections"
            }
            .onFailure { _status.value = it.message }
        _busy.value = false
    }

    fun queryCollection(collectionId: String, question: String) = viewModelScope.launch {
        val url = secureStore.orgUrl ?: return@launch
        if (question.isBlank()) return@launch
        _busy.value = true
        orgRag.knowledgeChat(url, secureStore.orgToken, collectionId, question)
            .onSuccess {
                _ragAnswer.value = it.answer
                _status.value = "Answer received"
            }
            .onFailure { _status.value = it.message }
        _busy.value = false
    }

    fun ingestUris(uris: List<Uri>) = viewModelScope.launch {
        if (_mode.value != DocsMode.CLOUD_BATCH) {
            _status.value = "online/org required"
            return@launch
        }
        _busy.value = true
        val profileId = settings.activeProfileId.first()
        var ok = 0
        uris.take(MAX_BATCH_FILES).forEach { uri ->
            val extracted = attachments.extractText(uri)
            val text = extracted.text ?: extracted.limitationNote ?: return@forEach
            val excerpt = text.take(EXCERPT_CHARS)
            docSummaryDao.upsert(
                DocSummaryEntity(
                    id = UUID.randomUUID().toString(),
                    fileName = extracted.fileName,
                    sourceUri = uri.toString(),
                    excerpt = excerpt,
                    charCount = excerpt.length,
                    providerKind = "cloud",
                    createdAt = System.currentTimeMillis(),
                    profileId = profileId
                )
            )
            ok++
        }
        _status.value = "Stored excerpts for $ok file(s)"
        _busy.value = false
    }
}

@Composable
fun BatchDocsScreen(onBack: () -> Unit, vm: BatchDocsViewModel = hiltViewModel()) {
    val mode by vm.mode.collectAsState()
    val status by vm.status.collectAsState()
    val busy by vm.busy.collectAsState()
    val collections by vm.collections.collectAsState()
    val ragAnswer by vm.ragAnswer.collectAsState()
    val summaries by vm.summaries.collectAsState()
    var question by remember { mutableStateOf("") }
    var selectedCollection by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNotEmpty()) vm.ingestUris(uris)
    }

    Column(Modifier.fillMaxSize()) {
        PmTopBar("Batch Docs", onBack = onBack)
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            when (mode) {
                DocsMode.OFFLINE -> {
                    Text(
                        "online/org required",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Text(
                        "Configure an Organization Server URL with Full RAG, or add a cloud API key, to batch-upload document excerpts. Local folder indexing is not available on Android.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                DocsMode.ORG_STUB -> {
                    Text(
                        "Org server configured, but Full RAG APIs were not found at /v1/knowledge/collections.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "Deploy the enterprise Full RAG gateway or point to a server that exposes knowledge endpoints.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                DocsMode.ORG_RAG -> {
                    Text("Org folder (server-side RAG)", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                    PmGhostButton(
                        text = if (busy) "Loading…" else "Refresh collections",
                        onClick = vm::loadCollections,
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth()
                    )
                    LazyColumn(
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.weight(1f, fill = false)
                    ) {
                        items(collections, key = { it.id }) { c ->
                            PmCard(onClick = { selectedCollection = c.id }) {
                                Text(c.name, style = MaterialTheme.typography.titleSmall)
                                Text(
                                    "${c.status ?: "unknown"} · ${c.fileCount ?: 0} files · ${c.chunkCount ?: 0} chunks",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                    if (selectedCollection != null) {
                        OutlinedTextField(
                            value = question,
                            onValueChange = { question = it },
                            label = { Text("Question about collection") },
                            modifier = Modifier.fillMaxWidth()
                        )
                        PmPrimaryButton(
                            text = "Ask org RAG",
                            accentGreen = true,
                            enabled = !busy && question.isNotBlank(),
                            onClick = { vm.queryCollection(selectedCollection!!, question) },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                    ragAnswer?.let {
                        PmCard {
                            Text("Answer", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                            Text(it, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                DocsMode.CLOUD_BATCH -> {
                    Text("Batch upload (cloud excerpts)", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                    Text(
                        "Pick up to $MAX_BATCH_FILES text files. Excerpts (top $EXCERPT_CHARS chars) are stored locally — no on-device HNSW index.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    PmPrimaryButton(
                        text = "Pick files",
                        accentGreen = true,
                        enabled = !busy,
                        onClick = { picker.launch(arrayOf("text/*", "application/json")) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    if (summaries.isNotEmpty()) {
                        Text("Stored excerpts (${summaries.size})", style = MaterialTheme.typography.titleSmall)
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(summaries, key = { it.id }) { s ->
                                PmCard {
                                    Text(s.fileName, style = MaterialTheme.typography.titleSmall)
                                    Text(
                                        "${s.charCount} chars · ${s.providerKind}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                    Text(
                                        s.excerpt.take(200) + if (s.excerpt.length > 200) "…" else "",
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                            }
                        }
                    }
                }
            }
            status?.let { Text(it, color = PmGreen, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
