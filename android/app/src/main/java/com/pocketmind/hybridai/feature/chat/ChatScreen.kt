package com.pocketmind.hybridai.feature.chat

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.pocketmind.hybridai.util.ChatExport
import com.pocketmind.hybridai.util.ChatExportFormat
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.db.MessageEntity
import com.pocketmind.hybridai.data.network.ChatTurn
import com.pocketmind.hybridai.data.network.GeminiClient
import com.pocketmind.hybridai.data.network.OpenAiCompatibleClient
import com.pocketmind.hybridai.data.network.ProviderCatalog
import com.pocketmind.hybridai.data.repo.ChatRepository
import com.pocketmind.hybridai.data.repo.ChatRole
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.engine.attachments.AttachmentTextExtractor
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.ui.components.ContextBudgetBar
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.components.simpleMarkdown
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.ContextBudgetInput
import com.pocketmind.hybridai.util.computeContextBudget
import com.pocketmind.hybridai.util.contextLimitForModelKind
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ChatViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val chats: ChatRepository,
    private val openAi: OpenAiCompatibleClient,
    private val gemini: GeminiClient,
    private val secureStore: SecureStore,
    private val settings: SettingsRepository,
    private val localEngine: LocalLlamaEngine,
    private val attachments: AttachmentTextExtractor
) : ViewModel() {
    val conversationId: String = checkNotNull(savedStateHandle["conversationId"])

    val conversation = chats.observeConversation(conversationId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
    val messages = chats.observeMessages(conversationId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val keepLastN = settings.keepLastN
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), com.pocketmind.hybridai.util.DEFAULT_KEEP_LAST_N)

    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    private val _error = MutableStateFlow<String?>(null)
    val error = _error.asStateFlow()
    private val _pendingAttachment = MutableStateFlow<String?>(null)
    val pendingAttachment = _pendingAttachment.asStateFlow()

    private var streamJob: Job? = null

    fun setKeepLastN(n: Int) = viewModelScope.launch {
        settings.setKeepLastN(n)
    }

    fun stop() {
        streamJob?.cancel()
        localEngine.stop()
        _busy.value = false
    }

    fun attach(uri: Uri) = viewModelScope.launch {
        val extracted = attachments.extractText(uri)
        val body = extracted.text
            ?: extracted.limitationNote
            ?: "Could not read attachment."
        _pendingAttachment.value = "File: ${extracted.fileName}\n$body"
    }

    fun clearAttachment() {
        _pendingAttachment.value = null
    }

    fun send(userText: String) {
        if (userText.isBlank() && _pendingAttachment.value.isNullOrBlank()) return
        val conv = conversation.value ?: return
        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            _busy.value = true
            _error.value = null
            val attachment = _pendingAttachment.value
            _pendingAttachment.value = null
            val fullUser = buildString {
                append(userText.trim())
                if (!attachment.isNullOrBlank()) {
                    if (isNotEmpty()) append("\n\n")
                    append("--- attached ---\n")
                    append(attachment.take(12_000))
                }
            }
            chats.addMessage(
                conversationId,
                ChatRole.USER,
                fullUser,
                attachmentsSummary = if (attachment != null) "1 attachment" else null
            )
            if (conv.title == "New chat" && userText.isNotBlank()) {
                chats.renameConversation(conversationId, userText.take(48))
            }
            val assistant = chats.addMessage(
                conversationId,
                ChatRole.ASSISTANT,
                "",
                isStreaming = true
            )
            val history = chats.getMessagesOnce(conversationId)
                .filter { it.id != assistant.id }
                .takeLast(keepLastN.value)
                .map { ChatTurn(it.role, it.content) }
            val turns = buildList {
                conv.systemPrompt?.takeIf { it.isNotBlank() }?.let {
                    add(ChatTurn(ChatRole.SYSTEM, it))
                }
                addAll(history)
            }
            val temperature = settings.temperature.first()
            val maxTokens = settings.maxTokens.first()
            try {
                val flow = when (conv.modelKind.lowercase()) {
                    "local" -> {
                        val models = localEngine.listImportedModels().first()
                        val model = models.find { it.id == conv.modelId } ?: models.firstOrNull()
                            ?: error(localEngine.runtimeUnavailableMessage())
                        if (!localEngine.isRuntimeAvailable()) error(localEngine.runtimeUnavailableMessage())
                        val prompt = turns.joinToString("\n\n") { "${it.role}: ${it.content}" }
                        localEngine.generate(model, prompt, maxTokens)
                    }
                    "org" -> {
                        val base = openAi.normalizeBaseUrl(secureStore.orgUrl.orEmpty())
                        if (base.isBlank()) error("Set Organization Server URL in Org Server.")
                        val modelId = if (conv.modelId == "org-default") {
                            openAi.listModels(base, secureStore.orgToken).getOrNull()?.firstOrNull()?.id
                                ?: error("No models on org server. Test connection first.")
                        } else conv.modelId
                        openAi.streamChatCompletions(base, secureStore.orgToken, modelId, turns, temperature, maxTokens)
                    }
                    "premium", "free" -> {
                        val provider = when {
                            conv.modelId.startsWith("gemini") || conv.modelLabel.contains("Gemini", true) -> "gemini"
                            conv.modelKind == "premium" && conv.modelLabel.contains("DeepSeek", true) -> "deepseek"
                            conv.modelKind == "premium" && conv.modelLabel.contains("Mistral", true) -> "mistral"
                            conv.modelKind == "premium" && conv.modelLabel.contains("Together", true) -> "together"
                            conv.modelKind == "premium" || conv.modelLabel.contains("OpenRouter", true) -> "openrouter"
                            else -> "groq"
                        }
                        if (provider == "gemini") {
                            val key = secureStore.getApiKey(ApiProvider.GEMINI)
                                ?: error("Add a Gemini API key in Models.")
                            gemini.streamGenerate(key, conv.modelId, turns, temperature)
                        } else {
                            val apiProvider = when (provider) {
                                "deepseek" -> ApiProvider.DEEPSEEK
                                "mistral" -> ApiProvider.MISTRAL
                                "together" -> ApiProvider.TOGETHER
                                "openrouter" -> ApiProvider.OPENROUTER
                                else -> ApiProvider.GROQ
                            }
                            val key = secureStore.getApiKey(apiProvider)
                                ?: error("Add a ${apiProvider.displayName} API key in Models.")
                            val base = ProviderCatalog.baseUrlFor(provider)!!
                            openAi.streamChatCompletions(base, key, conv.modelId, turns, temperature, maxTokens)
                        }
                    }
                    else -> error("Unknown model kind: ${conv.modelKind}")
                }
                var acc = ""
                flow.collect { delta ->
                    acc += delta
                    chats.updateMessageContent(assistant, acc, isStreaming = true)
                }
                chats.updateMessageContent(assistant, acc.ifBlank { "(empty response)" }, isStreaming = false)
            } catch (t: Throwable) {
                if (t is kotlinx.coroutines.CancellationException) {
                    chats.updateMessageContent(assistant, "(stopped)", isStreaming = false)
                } else {
                    val friendly = com.pocketmind.hybridai.util.UserFacingError.map(t)
                    _error.value = friendly
                    chats.updateMessageContent(
                        assistant,
                        friendly,
                        isStreaming = false,
                        isError = true
                    )
                }
            } finally {
                _busy.value = false
            }
        }
    }
}

@Composable
fun ChatScreen(
    conversationId: String,
    onBack: () -> Unit,
    vm: ChatViewModel = hiltViewModel()
) {
    val conv by vm.conversation.collectAsState()
    val messages by vm.messages.collectAsState()
    val keepLastN by vm.keepLastN.collectAsState()
    val busy by vm.busy.collectAsState()
    val error by vm.error.collectAsState()
    val attachment by vm.pendingAttachment.collectAsState()
    var input by remember { mutableStateOf("") }
    var exportOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.attach(uri)
    }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    val budget = remember(conv, messages, attachment, keepLastN) {
        val c = conv ?: return@remember null
        computeContextBudget(
            ContextBudgetInput(
                systemPrompt = c.systemPrompt,
                messages = messages,
                attachmentText = attachment,
                contextSize = contextLimitForModelKind(c.modelKind),
                keepLastN = keepLastN
            )
        )
    }

    fun exportAs(format: ChatExportFormat) {
        val c = conv ?: return
        val body = ChatExport.render(c, messages, format)
        ChatExport.share(context, "${c.title}.${ChatExport.extension(format)}", body, ChatExport.mime(format))
        exportOpen = false
    }

    Column(Modifier.fillMaxSize()) {
        PmTopBar(
            title = conv?.modelLabel ?: "Chat",
            onBack = onBack,
            actions = {
                IconButton(onClick = { exportOpen = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "Export")
                }
                DropdownMenu(expanded = exportOpen, onDismissRequest = { exportOpen = false }) {
                    DropdownMenuItem(text = { Text("Export Markdown") }, onClick = { exportAs(ChatExportFormat.MARKDOWN) })
                    DropdownMenuItem(text = { Text("Export JSON") }, onClick = { exportAs(ChatExportFormat.JSON) })
                    DropdownMenuItem(text = { Text("Export TXT") }, onClick = { exportAs(ChatExportFormat.TXT) })
                }
            }
        )
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(messages, key = { it.id }) { msg ->
                MessageBubble(msg)
            }
        }
        if (error != null) {
            Text(
                error!!,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 16.dp)
            )
        }
        if (budget != null) {
            ContextBudgetBar(
                budget = budget!!,
                keepLastN = keepLastN,
                onKeepLastNChange = vm::setKeepLastN
            )
        }
        if (attachment != null) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "Attachment ready (${attachment!!.length} chars)",
                    style = MaterialTheme.typography.labelMedium,
                    color = PmGreen,
                    modifier = Modifier.weight(1f)
                )
                IconButton(onClick = vm::clearAttachment) {
                    Text("×", color = MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = { picker.launch("*/*") }) {
                Icon(Icons.Default.AttachFile, contentDescription = "Attach")
            }
            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message…") },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = PmGreen,
                    cursorColor = PmGreen
                )
            )
            if (busy) {
                IconButton(onClick = vm::stop) {
                    Icon(Icons.Default.Stop, contentDescription = "Stop", tint = MaterialTheme.colorScheme.error)
                }
            } else {
                IconButton(
                    onClick = {
                        val text = input
                        input = ""
                        vm.send(text)
                    }
                ) {
                    Icon(Icons.Default.Send, contentDescription = "Send", tint = PmGreen)
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(msg: MessageEntity) {
    val isUser = msg.role == ChatRole.USER
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (isUser) Alignment.CenterEnd else Alignment.CenterStart
    ) {
        Column(
            Modifier
                .fillMaxWidth(0.92f)
                .background(
                    if (isUser) MaterialTheme.colorScheme.surfaceVariant
                    else MaterialTheme.colorScheme.surface,
                    MaterialTheme.shapes.medium
                )
                .padding(12.dp)
        ) {
            Text(
                if (isUser) "you" else "assistant",
                style = MaterialTheme.typography.labelSmall,
                color = if (msg.isError) MaterialTheme.colorScheme.error else PmGreen
            )
            Text(simpleMarkdown(msg.content.ifBlank { if (msg.isStreaming) "…" else "" }))
            if (msg.attachmentsSummary != null) {
                Text(msg.attachmentsSummary!!, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
