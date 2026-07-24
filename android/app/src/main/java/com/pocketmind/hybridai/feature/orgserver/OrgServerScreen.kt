package com.pocketmind.hybridai.feature.orgserver

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import com.pocketmind.hybridai.data.network.OpenAiCompatibleClient
import com.pocketmind.hybridai.data.network.RemoteModel
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class OrgServerViewModel @Inject constructor(
    private val secureStore: SecureStore,
    private val openAi: OpenAiCompatibleClient,
    private val settings: SettingsRepository
) : ViewModel() {
    private val _models = MutableStateFlow<List<RemoteModel>>(emptyList())
    val models = _models.asStateFlow()
    private val _status = MutableStateFlow<String?>(null)
    val status = _status.asStateFlow()
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()

    fun loadSaved(): Triple<String, String, Boolean> = Triple(
        secureStore.orgUrl.orEmpty(),
        secureStore.orgToken.orEmpty(),
        secureStore.allowLanHttp
    )

    fun save(url: String, token: String, allowLan: Boolean) {
        secureStore.orgUrl = url.ifBlank { null }
        secureStore.orgToken = token.ifBlank { null }
        secureStore.allowLanHttp = allowLan
        _status.value = "Saved"
    }

    fun test(url: String, token: String) = viewModelScope.launch {
        _busy.value = true
        val base = openAi.normalizeBaseUrl(url)
        openAi.listModels(base, token.ifBlank { null })
            .onSuccess {
                _models.value = it
                _status.value = "OK · ${it.size} models"
                secureStore.orgUrl = base.trimEnd('/')
                if (token.isNotBlank()) secureStore.orgToken = token
            }
            .onFailure { _status.value = it.message }
        _busy.value = false
    }

    fun useModel(model: RemoteModel) = viewModelScope.launch {
        settings.setDefaultModel(model.id, model.id, "org")
        _status.value = "Default set to ${model.id}"
    }
}

@Composable
fun OrgServerScreen(onBack: () -> Unit, vm: OrgServerViewModel = hiltViewModel()) {
    val saved = remember { vm.loadSaved() }
    var url by remember { mutableStateOf(saved.first) }
    var token by remember { mutableStateOf(saved.second) }
    var allowLan by remember { mutableStateOf(saved.third) }
    val models by vm.models.collectAsState()
    val status by vm.status.collectAsState()
    val busy by vm.busy.collectAsState()

    Column(Modifier.fillMaxSize()) {
        PmTopBar(title = "Org Server", onBack = onBack)
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "OpenAI-compatible endpoint (…/v1). Same contract as desktop Organization Server.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(url, { url = it }, label = { Text("Server URL") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(token, { token = it }, label = { Text("Access token (optional)") }, modifier = Modifier.fillMaxWidth())
            RowSwitch("Allow LAN HTTP (cleartext)", allowLan) { allowLan = it }
            PmPrimaryButton(
                text = if (busy) "Testing…" else "Test connection",
                accentGreen = true,
                enabled = !busy,
                onClick = {
                    vm.save(url, token, allowLan)
                    vm.test(url, token)
                },
                modifier = Modifier.fillMaxWidth()
            )
            status?.let { Text(it, color = PmGreen, style = MaterialTheme.typography.bodySmall) }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(models) { m ->
                    PmCard(onClick = { vm.useModel(m) }) {
                        Text(m.id, style = MaterialTheme.typography.titleSmall)
                        m.ownedBy?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RowSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    androidx.compose.foundation.layout.Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(end = 8.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
