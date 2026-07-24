package com.pocketmind.hybridai.feature.diagnostics

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.BuildConfig
import com.pocketmind.hybridai.data.network.ChatTurn
import com.pocketmind.hybridai.data.network.OpenAiCompatibleClient
import com.pocketmind.hybridai.data.network.ProviderCatalog
import com.pocketmind.hybridai.data.network.ProviderHealthRepository
import com.pocketmind.hybridai.data.network.ProviderStatus
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.engine.llama.DeviceCapabilities
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmStatusChip
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.UserFacingError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class DiagnosticsViewModel @Inject constructor(
    private val localEngine: LocalLlamaEngine,
    private val health: ProviderHealthRepository,
    private val secureStore: SecureStore,
    private val openAi: OpenAiCompatibleClient
) : ViewModel() {
    private val _caps = MutableStateFlow<DeviceCapabilities?>(null)
    val caps = _caps.asStateFlow()
    private val _providers = MutableStateFlow<List<ProviderStatus>>(emptyList())
    val providers = _providers.asStateFlow()
    private val _runtime = MutableStateFlow(false)
    val runtime = _runtime.asStateFlow()
    private val _bench = MutableStateFlow<String?>(null)
    val bench = _bench.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    fun refresh() = viewModelScope.launch {
        _caps.value = localEngine.capabilities()
        _runtime.value = localEngine.isRuntimeAvailable()
        _providers.value = runCatching { health.probeAll() }.getOrElse { emptyList() }
    }

    fun stopLocal() = localEngine.stop()

    fun runTokPerSecTest() = viewModelScope.launch {
        _busy.value = true
        _bench.value = "Running…"
        try {
            val prompt = "Count from 1 to 20 in words, then stop."
            val maxTokens = 64
            val start = System.nanoTime()
            var chars = 0
            val label: String
            val models = localEngine.listImportedModels().first()
            if (localEngine.isRuntimeAvailable() && models.isNotEmpty()) {
                label = "local (${models.first().fileName})"
                localEngine.generate(models.first(), prompt, maxTokens).collect { chars += it.length }
            } else if (!secureStore.orgUrl.isNullOrBlank()) {
                label = "org server"
                val base = openAi.normalizeBaseUrl(secureStore.orgUrl.orEmpty())
                val modelId = openAi.listModels(base, secureStore.orgToken).getOrNull()?.firstOrNull()?.id
                    ?: error("No org models available")
                openAi.streamChatCompletions(
                    base, secureStore.orgToken, modelId,
                    listOf(ChatTurn("user", prompt)), 0.2f, maxTokens
                ).collect { chars += it.length }
            } else {
                val key = secureStore.getApiKey(ApiProvider.GROQ)
                    ?: error("Need a local binary + GGUF, Org Server, or Groq key for the tok/s test.")
                label = "online (Groq)"
                openAi.streamChatCompletions(
                    ProviderCatalog.GROQ_BASE, key, "llama-3.1-8b-instant",
                    listOf(ChatTurn("user", prompt)), 0.2f, maxTokens
                ).collect { chars += it.length }
            }
            val secs = (System.nanoTime() - start) / 1_000_000_000.0
            val approxTokens = (chars / 4.0).coerceAtLeast(1.0)
            val tps = if (secs > 0) approxTokens / secs else 0.0
            _bench.value = String.format(
                "≈ %.1f tok/s over %.1fs (%d chars ≈ %.0f tokens) via %s",
                tps, secs, chars, approxTokens, label
            )
        } catch (t: Throwable) {
            _bench.value = UserFacingError.map(t)
        } finally {
            _busy.value = false
        }
    }

    fun shareText(): String = buildString {
        appendLine("PocketMind Hybrid AI ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        appendLine("org=${secureStore.orgUrl}")
        caps.value?.let {
            appendLine("vulkan=${it.hasVulkan} ram=${it.totalRamMb}MB abi=${it.cpuAbi}")
        }
        appendLine("localRuntime=${runtime.value}")
        bench.value?.let { appendLine("bench=$it") }
        providers.value.forEach {
            appendLine("${it.providerId}: online=${it.isOnline} models=${it.models.size} ${it.message.orEmpty()}")
        }
    }
}

@Composable
fun DiagnosticsScreen(onBack: () -> Unit, vm: DiagnosticsViewModel = hiltViewModel()) {
    val caps by vm.caps.collectAsState()
    val providers by vm.providers.collectAsState()
    val runtime by vm.runtime.collectAsState()
    val bench by vm.bench.collectAsState()
    val busy by vm.busy.collectAsState()
    val context = LocalContext.current

    LaunchedEffect(Unit) { vm.refresh() }

    Column(Modifier.fillMaxSize()) {
        PmTopBar(title = "Diagnostics", onBack = onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            PmPrimaryButton(
                text = "Refresh probes",
                onClick = vm::refresh,
                accentGreen = true,
                modifier = Modifier.fillMaxWidth()
            )
            PmGhostButton("Stop local engine", onClick = vm::stopLocal, modifier = Modifier.fillMaxWidth())
            PmPrimaryButton(
                text = if (busy) "Benchmark running…" else "Run tok/s test",
                onClick = vm::runTokPerSecTest,
                enabled = !busy,
                accentGreen = true,
                modifier = Modifier.fillMaxWidth()
            )
            bench?.let {
                PmCard {
                    Text("Token speed", style = MaterialTheme.typography.titleSmall, color = PmGreen)
                    Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp))
                }
            }
            PmGhostButton(
                text = "Share report",
                onClick = {
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(android.content.Intent.EXTRA_TEXT, vm.shareText())
                    }
                    context.startActivity(android.content.Intent.createChooser(send, "Share diagnostics"))
                },
                modifier = Modifier.fillMaxWidth()
            )
            PmCard {
                Text("Device", style = MaterialTheme.typography.titleSmall, color = PmGreen)
                caps?.let {
                    Text("Vulkan: ${it.hasVulkan}")
                    Text("RAM: ${it.availableRamMb}/${it.totalRamMb} MB")
                    Text("ABI: ${it.cpuAbi}")
                    PmStatusChip(if (runtime) "local binary ready" else "local binary missing", runtime)
                }
            }
            providers.forEach { p ->
                PmCard {
                    Text(p.displayName, style = MaterialTheme.typography.titleSmall)
                    PmStatusChip(if (p.isOnline) "online" else "offline", p.isOnline)
                    Text(p.message ?: "${p.models.size} models · key=${p.hasApiKey}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
