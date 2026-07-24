package com.pocketmind.hybridai.feature.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.secure.ApiProvider
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmStatusChip
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

data class HomeUiState(
    val hasOrg: Boolean = false,
    val hasFreeKey: Boolean = false,
    val vulkan: Boolean = false,
    val localModels: Int = 0,
    val binaryReady: Boolean = false
)

@HiltViewModel
class HomeViewModel @Inject constructor(
    secureStore: SecureStore,
    localEngine: LocalLlamaEngine
) : ViewModel() {
    val state: StateFlow<HomeUiState> = localEngine.listImportedModels()
        .map { models ->
            val caps = localEngine.capabilities()
            HomeUiState(
                hasOrg = !secureStore.orgUrl.isNullOrBlank(),
                hasFreeKey = secureStore.hasApiKey(ApiProvider.GROQ) ||
                    secureStore.hasApiKey(ApiProvider.GEMINI) ||
                    secureStore.hasApiKey(ApiProvider.OPENROUTER),
                vulkan = caps.hasVulkan,
                localModels = models.size,
                binaryReady = localEngine.isRuntimeAvailable()
            )
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), HomeUiState())
}

@Composable
fun HomeScreen(
    onOpenChats: () -> Unit,
    onOpenOrg: () -> Unit,
    onOpenModels: () -> Unit,
    onOpenImages: () -> Unit,
    vm: HomeViewModel = hiltViewModel()
) {
    val state by vm.state.collectAsState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text("PocketMind", style = MaterialTheme.typography.labelMedium, color = PmGreen)
        Text(
            "Hybrid AI",
            style = MaterialTheme.typography.displayMedium,
            color = MaterialTheme.colorScheme.onBackground
        )
        Text(
            "Offline chat, org server, and live free/premium models — conductor-clean, on your phone.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PmStatusChip(label = if (state.hasOrg) "org · ready" else "org · unset", ok = state.hasOrg)
            PmStatusChip(label = if (state.hasFreeKey) "online · keyed" else "online · no key", ok = state.hasFreeKey)
            PmStatusChip(
                label = if (state.vulkan) "vulkan" else "cpu",
                ok = state.vulkan
            )
        }

        PmPrimaryButton(
            text = "New chat",
            onClick = onOpenChats,
            modifier = Modifier.fillMaxWidth(),
            accentGreen = true
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            PmGhostButton(text = "Models", onClick = onOpenModels, modifier = Modifier.weight(1f))
            PmGhostButton(text = "Org Server", onClick = onOpenOrg, modifier = Modifier.weight(1f))
        }
        PmGhostButton(
            text = "Image Studio",
            onClick = onOpenImages,
            modifier = Modifier.fillMaxWidth()
        )

        PmCard {
            Text("Local engine", style = MaterialTheme.typography.titleSmall, color = PmGreen)
            Spacer(Modifier.height(8.dp))
            Text(
                if (state.binaryReady) {
                    "${state.localModels} GGUF imported · native binary present"
                } else {
                    "${state.localModels} GGUF imported · add llama-cli to filesDir/bin for on-device generate"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
