package com.pocketmind.hybridai.feature.imagestudio

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil.compose.AsyncImage
import com.pocketmind.hybridai.data.db.GeneratedImageDao
import com.pocketmind.hybridai.data.db.GeneratedImageEntity
import com.pocketmind.hybridai.data.network.ImageProviders
import com.pocketmind.hybridai.data.network.ProviderCatalog
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class ImageStudioViewModel @Inject constructor(
    private val images: ImageProviders,
    private val dao: GeneratedImageDao
) : ViewModel() {
    val gallery = dao.observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private val _busy = MutableStateFlow(false)
    val busy = _busy.asStateFlow()
    private val _status = MutableStateFlow<String?>(null)
    val status = _status.asStateFlow()

    fun generate(prompt: String, model: String) = viewModelScope.launch {
        if (prompt.isBlank()) return@launch
        _busy.value = true
        _status.value = "Generating via gen.pollinations.ai…"
        images.generateWithFailover(prompt, model)
            .onSuccess { (file, provider) ->
                dao.insert(
                    GeneratedImageEntity(
                        id = UUID.randomUUID().toString(),
                        prompt = prompt,
                        provider = provider,
                        model = model,
                        localPath = file.absolutePath,
                        createdAt = System.currentTimeMillis()
                    )
                )
                _status.value = "Saved via $provider"
            }
            .onFailure { _status.value = it.message ?: "Free providers unavailable right now" }
        _busy.value = false
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImageStudioScreen(vm: ImageStudioViewModel = hiltViewModel()) {
    var prompt by remember { mutableStateOf("") }
    var model by remember { mutableStateOf(ProviderCatalog.IMAGE_MODELS.first()) }
    var expanded by remember { mutableStateOf(false) }
    val gallery by vm.gallery.collectAsState()
    val busy by vm.busy.collectAsState()
    val status by vm.status.collectAsState()

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Image Studio", style = MaterialTheme.typography.headlineMedium)
        Text(
            "Free path uses live Pollinations gateway with Hugging Face failover — not legacy-only URLs.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text("Prompt") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 3
        )
        ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
            OutlinedTextField(
                value = model,
                onValueChange = {},
                readOnly = true,
                label = { Text("Model") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
                modifier = Modifier.menuAnchor(MenuAnchorType.PrimaryNotEditable).fillMaxWidth()
            )
            ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                ProviderCatalog.IMAGE_MODELS.forEach {
                    DropdownMenuItem(text = { Text(it) }, onClick = { model = it; expanded = false })
                }
            }
        }
        PmPrimaryButton(
            text = if (busy) "Working…" else "Generate (free)",
            accentGreen = true,
            enabled = !busy,
            onClick = { vm.generate(prompt, model) },
            modifier = Modifier.fillMaxWidth()
        )
        status?.let { Text(it, color = PmGreen, style = MaterialTheme.typography.bodySmall) }
        LazyVerticalGrid(
            columns = GridCells.Adaptive(140.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.weight(1f)
        ) {
            items(gallery) { img ->
                AsyncImage(
                    model = img.localPath,
                    contentDescription = img.prompt,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(1f)
                )
            }
        }
    }
}
