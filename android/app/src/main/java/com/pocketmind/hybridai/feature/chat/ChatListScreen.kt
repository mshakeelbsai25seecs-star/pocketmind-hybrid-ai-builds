package com.pocketmind.hybridai.feature.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.db.ConversationEntity
import com.pocketmind.hybridai.data.repo.ChatRepository
import com.pocketmind.hybridai.data.repo.SettingsRepository
import com.pocketmind.hybridai.data.repo.WorkspaceProfileRepository
import com.pocketmind.hybridai.data.secure.SecureStore
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmEmptyState
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

@HiltViewModel
class ChatListViewModel @Inject constructor(
    private val chats: ChatRepository,
    private val secureStore: SecureStore,
    private val settings: SettingsRepository,
    private val profiles: WorkspaceProfileRepository
) : ViewModel() {
    val conversations = chats.observeConversationsForActiveProfile()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    val activeProfileId = settings.activeProfileId
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), "default")
    val profileList = profiles.observeProfiles()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun delete(id: String) = viewModelScope.launch { chats.deleteConversation(id) }

    suspend fun createDefaultChat(): String {
        var modelId = "llama-3.1-8b-instant"
        var modelLabel = "Llama 3.1 8B Instant"
        var modelKind = "free"
        if (!secureStore.orgUrl.isNullOrBlank()) {
            modelId = "org-default"
            modelLabel = "Organization Server"
            modelKind = "org"
        }
        val conv = chats.createConversation(
            title = "New chat",
            modelId = modelId,
            modelLabel = modelLabel,
            modelKind = modelKind
        )
        return conv.id
    }
}

@Composable
fun ChatListScreen(
    onOpenChat: (String) -> Unit,
    onNewChat: (String) -> Unit,
    vm: ChatListViewModel = hiltViewModel()
) {
    val items by vm.conversations.collectAsState()
    val activeProfile by vm.activeProfileId.collectAsState()
    val profileList by vm.profileList.collectAsState()
    val scope = rememberCoroutineScope()
    val activeName = profileList.find { it.id == activeProfile }?.name ?: activeProfile

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Chats", style = MaterialTheme.typography.headlineMedium)
                Text(
                    "Profile: $activeName",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = {
                scope.launch {
                    val id = vm.createDefaultChat()
                    onNewChat(id)
                }
            }) {
                Icon(Icons.Default.Add, contentDescription = "New chat", tint = PmGreen)
            }
        }

        if (items.isEmpty()) {
            PmEmptyState(
                title = "No conversations",
                body = "Start a chat with Org Server, a free online model, or an imported GGUF.",
                action = {
                    PmPrimaryButton(
                        text = "Start chatting",
                        accentGreen = true,
                        onClick = {
                            scope.launch {
                                val id = vm.createDefaultChat()
                                onNewChat(id)
                            }
                        }
                    )
                }
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(items, key = { it.id }) { conv ->
                    ConversationRow(
                        conv = conv,
                        onOpen = { onOpenChat(conv.id) },
                        onDelete = { vm.delete(conv.id) }
                    )
                }
            }
        }
    }
}

@Composable
private fun ConversationRow(
    conv: ConversationEntity,
    onOpen: () -> Unit,
    onDelete: () -> Unit
) {
    PmCard(onClick = onOpen) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(conv.title, style = MaterialTheme.typography.titleMedium)
                Text(
                    "${conv.modelLabel} · ${conv.modelKind} · ${DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(conv.updatedAt))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Default.Delete, contentDescription = "Delete")
            }
        }
    }
}
