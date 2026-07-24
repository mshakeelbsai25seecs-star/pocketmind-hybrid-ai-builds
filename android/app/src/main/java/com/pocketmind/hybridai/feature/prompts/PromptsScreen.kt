package com.pocketmind.hybridai.feature.prompts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.pocketmind.hybridai.data.db.PromptDao
import com.pocketmind.hybridai.data.db.PromptEntity
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class PromptsViewModel @Inject constructor(
    private val dao: PromptDao
) : ViewModel() {
    val prompts = dao.observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun seedIfEmpty() = viewModelScope.launch {
        if (dao.count() > 0) return@launch
        val now = System.currentTimeMillis()
        listOf(
            Triple("Study", "Explain simply", "Explain the following like I'm learning it for the first time."),
            Triple("Coding", "Review code", "Review this code for bugs, clarity, and safer alternatives."),
            Triple("Business", "Executive brief", "Summarize into an executive brief with risks and next actions."),
            Triple("Writing", "Tighten prose", "Rewrite for clarity and punch without changing meaning.")
        ).forEach { (cat, title, body) ->
            dao.upsert(PromptEntity(UUID.randomUUID().toString(), title, cat, body, true, now))
        }
    }

    fun upsert(id: String?, title: String, category: String, content: String) = viewModelScope.launch {
        val entity = PromptEntity(
            id = id ?: UUID.randomUUID().toString(),
            title = title.trim(),
            category = category.trim().ifBlank { "Custom" },
            content = content.trim(),
            isBuiltIn = false,
            createdAt = System.currentTimeMillis()
        )
        if (entity.title.isBlank() || entity.content.isBlank()) return@launch
        dao.upsert(entity)
    }

    fun delete(id: String) = viewModelScope.launch { dao.deleteById(id) }
}

private data class PromptDraft(
    val id: String? = null,
    val title: String = "",
    val category: String = "Custom",
    val content: String = ""
)

@Composable
fun PromptsScreen(onBack: () -> Unit, vm: PromptsViewModel = hiltViewModel()) {
    val prompts by vm.prompts.collectAsState()
    var draft by remember { mutableStateOf<PromptDraft?>(null) }
    LaunchedEffect(Unit) { vm.seedIfEmpty() }

    Column(Modifier.fillMaxSize()) {
        PmTopBar("Prompts", onBack = onBack)
        LazyColumn(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            item {
                PmPrimaryButton(
                    text = "New prompt",
                    accentGreen = true,
                    onClick = { draft = PromptDraft() },
                    modifier = Modifier.fillMaxWidth()
                )
            }
            items(prompts, key = { it.id }) { p ->
                PmCard {
                    Text(p.category, color = PmGreen, style = MaterialTheme.typography.labelMedium)
                    Text(p.title, style = MaterialTheme.typography.titleMedium)
                    Text(p.content, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.padding(top = 8.dp)
                    ) {
                        PmGhostButton(
                            text = "Edit",
                            onClick = {
                                draft = PromptDraft(p.id, p.title, p.category, p.content)
                            }
                        )
                        if (!p.isBuiltIn) {
                            PmGhostButton(text = "Delete", onClick = { vm.delete(p.id) })
                        }
                    }
                }
            }
        }
    }

    draft?.let { current ->
        AlertDialog(
            onDismissRequest = { draft = null },
            title = { Text(if (current.id == null) "New prompt" else "Edit prompt") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = current.title,
                        onValueChange = { draft = current.copy(title = it) },
                        label = { Text("Title") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = current.category,
                        onValueChange = { draft = current.copy(category = it) },
                        label = { Text("Category") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = current.content,
                        onValueChange = { draft = current.copy(content = it) },
                        label = { Text("Prompt") },
                        minLines = 4,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.upsert(current.id, current.title, current.category, current.content)
                    draft = null
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { draft = null }) { Text("Cancel") }
            }
        )
    }
}
