package com.pocketmind.hybridai.feature.backup

import android.content.Intent
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.db.ConversationEntity
import com.pocketmind.hybridai.data.db.MessageEntity
import com.pocketmind.hybridai.data.repo.ChatRepository
import com.pocketmind.hybridai.data.repo.ConversationExport
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.BackupCrypto
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import javax.inject.Inject

@Serializable
data class BackupDto(
    val conversations: List<ConversationEntity>,
    val messages: List<MessageEntity>
)

@HiltViewModel
class BackupViewModel @Inject constructor(
    private val chats: ChatRepository,
    private val json: Json
) : ViewModel() {
    private val _status = MutableStateFlow<String?>(null)
    val status = _status.asStateFlow()
    private val _exportPayload = MutableStateFlow<String?>(null)
    val exportPayload = _exportPayload.asStateFlow()
    private val _encryptedExport = MutableStateFlow<ByteArray?>(null)
    val encryptedExport = _encryptedExport.asStateFlow()

    private suspend fun buildJson(): String = withContext(Dispatchers.IO) {
        val all = chats.exportAll()
        json.encodeToString(
            BackupDto(
                conversations = all.map { it.conversation },
                messages = all.flatMap { it.messages }
            )
        )
    }

    fun prepareExport() = viewModelScope.launch {
        _exportPayload.value = buildJson()
        _status.value = "Export ready"
    }

    fun prepareEncryptedExport(passphrase: String) = viewModelScope.launch {
        runCatching {
            val plain = buildJson()
            val encrypted = BackupCrypto.encryptBackupText(plain, passphrase)
            _encryptedExport.value = encrypted
            _status.value = "Encrypted export ready"
        }.onFailure { _status.value = it.message }
    }

    fun consumeExport(): String? {
        val v = _exportPayload.value
        _exportPayload.value = null
        return v
    }

    fun consumeEncryptedExport(): ByteArray? {
        val v = _encryptedExport.value
        _encryptedExport.value = null
        return v
    }

    fun importJson(raw: String) = viewModelScope.launch {
        runCatching {
            val count = importPlaintext(raw)
            _status.value = "Imported $count chats"
        }.onFailure { _status.value = it.message }
    }

    fun importEncrypted(blob: ByteArray, passphrase: String) = viewModelScope.launch {
        runCatching {
            val decoded = runCatching { android.util.Base64.decode(blob, android.util.Base64.DEFAULT) }
                .getOrDefault(blob)
            val plain = BackupCrypto.decryptBackupText(decoded, passphrase)
            val count = importPlaintext(plain)
            _status.value = "Imported $count chats from encrypted backup"
        }.onFailure { _status.value = it.message }
    }

    private suspend fun importPlaintext(raw: String): Int {
        val dto = json.decodeFromString<BackupDto>(raw)
        val byConv = dto.messages.groupBy { it.conversationId }
        chats.importAll(
            dto.conversations.map { conv ->
                ConversationExport(conv, byConv[conv.id].orEmpty())
            }
        )
        return dto.conversations.size
    }
}

@Composable
fun BackupScreen(onBack: () -> Unit, vm: BackupViewModel = hiltViewModel()) {
    val status by vm.status.collectAsState()
    val exportPayload by vm.exportPayload.collectAsState()
    val encryptedExport by vm.encryptedExport.collectAsState()
    val context = LocalContext.current
    var showEncryptDialog by remember { mutableStateOf(false) }
    var showDecryptDialog by remember { mutableStateOf(false) }
    var passphrase by remember { mutableStateOf("") }
    var pendingEncrypted by remember { mutableStateOf<ByteArray?>(null) }

    val plainImporter = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val text = context.contentResolver.openInputStream(uri)?.bufferedReader()?.readText().orEmpty()
        vm.importJson(text)
    }

    val encryptedImporter = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val bytes = context.contentResolver.openInputStream(uri)?.readBytes() ?: return@rememberLauncherForActivityResult
        pendingEncrypted = bytes
        passphrase = ""
        showDecryptDialog = true
    }

    androidx.compose.runtime.LaunchedEffect(exportPayload) {
        val payload = exportPayload ?: return@LaunchedEffect
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(Intent.EXTRA_TEXT, payload)
        }
        context.startActivity(Intent.createChooser(send, "Export chats"))
        vm.consumeExport()
    }

    androidx.compose.runtime.LaunchedEffect(encryptedExport) {
        val blob = encryptedExport ?: return@LaunchedEffect
        val b64 = Base64.encodeToString(blob, Base64.NO_WRAP)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_TEXT, b64)
        }
        context.startActivity(Intent.createChooser(send, "Export encrypted backup"))
        vm.consumeEncryptedExport()
    }

    if (showEncryptDialog) {
        AlertDialog(
            onDismissRequest = { showEncryptDialog = false },
            title = { Text("Encrypt backup") },
            text = {
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("Passphrase (min 8 chars)") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showEncryptDialog = false
                    vm.prepareEncryptedExport(passphrase)
                    passphrase = ""
                }) { Text("Export") }
            },
            dismissButton = {
                TextButton(onClick = { showEncryptDialog = false }) { Text("Cancel") }
            }
        )
    }

    if (showDecryptDialog) {
        AlertDialog(
            onDismissRequest = { showDecryptDialog = false },
            title = { Text("Decrypt backup") },
            text = {
                OutlinedTextField(
                    value = passphrase,
                    onValueChange = { passphrase = it },
                    label = { Text("Passphrase") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    val blob = pendingEncrypted
                    if (blob != null) vm.importEncrypted(blob, passphrase)
                    showDecryptDialog = false
                    passphrase = ""
                    pendingEncrypted = null
                }) { Text("Import") }
            },
            dismissButton = {
                TextButton(onClick = { showDecryptDialog = false }) { Text("Cancel") }
            }
        )
    }

    Column(Modifier.fillMaxSize()) {
        PmTopBar("Backup", onBack = onBack)
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "Exports conversations only — API keys and GGUF weights stay out by default.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            PmPrimaryButton(
                text = "Quick export JSON",
                accentGreen = true,
                modifier = Modifier.fillMaxWidth(),
                onClick = vm::prepareExport
            )
            PmGhostButton(
                text = "Import JSON (unencrypted)",
                onClick = { plainImporter.launch("application/json") },
                modifier = Modifier.fillMaxWidth()
            )
            PmPrimaryButton(
                text = "Encrypted export (PMBK1)",
                accentGreen = false,
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    passphrase = ""
                    showEncryptDialog = true
                }
            )
            PmGhostButton(
                text = "Import encrypted backup",
                onClick = { encryptedImporter.launch("*/*") },
                modifier = Modifier.fillMaxWidth()
            )
            status?.let { Text(it, color = PmGreen) }
        }
    }
}
