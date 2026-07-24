package com.pocketmind.hybridai.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.BuildConfig
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.repo.ThemeMode
import com.pocketmind.hybridai.data.repo.WorkspaceProfileRepository
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    val settings: SettingsRepository,
    private val profiles: WorkspaceProfileRepository
) : ViewModel() {
    val profileList = profiles.observeProfiles()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val activeProfileId = settings.activeProfileId
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), "default")

    fun setTheme(mode: ThemeMode) = settings.setThemeMode(mode)
    fun setSafeCpu(v: Boolean) = settings.setSafeCpuOnly(v)
    fun setBiometric(v: Boolean) = settings.setBiometricEnabled(v)
    fun setTemp(v: Float) = viewModelScope.launch { settings.setTemperature(v) }
    fun setMaxTokens(v: Int) = viewModelScope.launch { settings.setMaxTokens(v) }
    fun switchProfile(id: String) = viewModelScope.launch { profiles.setActiveProfile(id) }
    fun createProfile(name: String) = viewModelScope.launch {
        val created = profiles.createProfile(name)
        profiles.setActiveProfile(created.id)
    }
}

@Composable
fun SettingsScreen(onBack: () -> Unit, vm: SettingsViewModel = hiltViewModel()) {
    val theme by vm.settings.themeMode.collectAsState()
    val safeCpu by vm.settings.safeCpuOnly.collectAsState()
    val biometric by vm.settings.biometricEnabled.collectAsState()
    val temp by vm.settings.temperature.collectAsState(initial = 0.7f)
    val maxTokens by vm.settings.maxTokens.collectAsState(initial = 1024)
    val profileList by vm.profileList.collectAsState()
    val activeProfileId by vm.activeProfileId.collectAsState()
    var newProfileName by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize()) {
        PmTopBar("Settings", onBack = onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            PmCard {
                Text("Workspace profile", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                profileList.forEach { profile ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            profile.name + if (profile.isDefault) " (default)" else "",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        PmGhostButton(
                            text = if (profile.id == activeProfileId) "Active" else "Use",
                            enabled = profile.id != activeProfileId,
                            onClick = { vm.switchProfile(profile.id) }
                        )
                    }
                }
                OutlinedTextField(
                    value = newProfileName,
                    onValueChange = { newProfileName = it },
                    label = { Text("New profile name") },
                    modifier = Modifier.fillMaxWidth()
                )
                PmPrimaryButton(
                    text = "Create profile",
                    accentGreen = true,
                    enabled = newProfileName.isNotBlank(),
                    onClick = {
                        vm.createProfile(newProfileName)
                        newProfileName = ""
                    },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            PmCard {
                Text("Theme", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PmGhostButton("Dark", onClick = { vm.setTheme(ThemeMode.DARK) })
                    PmGhostButton("Light", onClick = { vm.setTheme(ThemeMode.LIGHT) })
                    PmGhostButton("System", onClick = { vm.setTheme(ThemeMode.SYSTEM) })
                }
                Text("Current: $theme", style = MaterialTheme.typography.bodySmall)
            }
            PmCard {
                Text("Temperature: ${"%.2f".format(temp)}", style = MaterialTheme.typography.titleSmall)
                Slider(value = temp, onValueChange = { scope.launch { vm.setTemp(it) } }, valueRange = 0f..1.5f)
                Text("Max tokens: $maxTokens", style = MaterialTheme.typography.titleSmall)
                Slider(
                    value = maxTokens.toFloat(),
                    onValueChange = { scope.launch { vm.setMaxTokens(it.toInt()) } },
                    valueRange = 128f..4096f
                )
            }
            SettingSwitch("Safe CPU only", safeCpu, vm::setSafeCpu)
            SettingSwitch("Biometric lock", biometric, vm::setBiometric)
            PmCard {
                Text("About", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                Text("PocketMind Hybrid AI ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
                Text("com.pocketmind.hybridai")
            }
        }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    PmCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Switch(checked = checked, onCheckedChange = onChange)
        }
    }
}
