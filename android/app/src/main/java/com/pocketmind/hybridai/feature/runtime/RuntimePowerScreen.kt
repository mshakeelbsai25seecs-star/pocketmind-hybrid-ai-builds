package com.pocketmind.hybridai.feature.runtime

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.engine.llama.LocalLlamaEngine
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject

@HiltViewModel
class RuntimePowerViewModel @Inject constructor(
    val settings: SettingsRepository,
    private val localEngine: LocalLlamaEngine
) : ViewModel() {
    val caps = localEngine.capabilities()
    fun stopEngine() = localEngine.stop()
}

@Composable
fun RuntimePowerScreen(
    onBack: () -> Unit,
    vm: RuntimePowerViewModel = hiltViewModel()
) {
    val safeCpu by vm.settings.safeCpuOnly.collectAsState()
    val sleepBg by vm.settings.sleepOnBackground.collectAsState()
    val caps = vm.caps

    Column(modifier = Modifier.fillMaxSize()) {
        PmTopBar(title = "Runtime / Power", onBack = onBack)
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "Android can prefer CPU-only inference and stop the local engine when the app is backgrounded. Live GPU-layer pressure tuning is a desktop capability.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            PmCard {
                Text("Device", style = MaterialTheme.typography.titleSmall, color = PmGreen)
                Text(
                    "RAM ${caps.availableRamMb}/${caps.totalRamMb} MB · ABI ${caps.cpuAbi} · " +
                        if (caps.hasVulkan) "Vulkan present" else "no Vulkan",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
            PmCard {
                androidx.compose.foundation.layout.Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
                        Text("Safe CPU only", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "Prefer CPU paths when the local binary supports Vulkan. Recommended on low-RAM devices.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(checked = safeCpu, onCheckedChange = { vm.settings.setSafeCpuOnly(it) })
                }
            }
            PmCard {
                androidx.compose.foundation.layout.Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(modifier = Modifier.weight(1f).padding(end = 12.dp)) {
                        Text("Sleep when backgrounded", style = MaterialTheme.typography.titleMedium)
                        Text(
                            "Stop the local llama process when the app goes to the background (ON_STOP).",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(checked = sleepBg, onCheckedChange = { vm.settings.setSleepOnBackground(it) })
                }
            }
            PmCard(onClick = { vm.stopEngine() }) {
                Text("Stop local engine now", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Unload any running on-device generate process immediately.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
        }
    }
}
