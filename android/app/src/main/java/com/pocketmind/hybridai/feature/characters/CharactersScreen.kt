package com.pocketmind.hybridai.feature.characters

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketmind.hybridai.data.db.CharacterDao
import com.pocketmind.hybridai.data.db.CharacterEntity
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID
import javax.inject.Inject

@HiltViewModel
class CharactersViewModel @Inject constructor(
    private val dao: CharacterDao
) : ViewModel() {
    val characters = dao.observeAll().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    fun seedIfEmpty() = viewModelScope.launch {
        if (dao.count() > 0) return@launch
        val now = System.currentTimeMillis()
        dao.upsert(
            CharacterEntity(
                UUID.randomUUID().toString(),
                "PocketMind Assistant",
                "PM",
                "Default helpful assistant",
                "You are PocketMind Hybrid AI. Be concise, accurate, and practical.",
                true,
                now
            )
        )
        dao.upsert(
            CharacterEntity(
                UUID.randomUUID().toString(),
                "SOC Analyst",
                "SOC",
                "Security drafting aide",
                "You are a senior SOC analyst aide. Draft for human review only; never claim live containment.",
                true,
                now
            )
        )
    }
}

@Composable
fun CharactersScreen(onBack: () -> Unit, vm: CharactersViewModel = hiltViewModel()) {
    val characters by vm.characters.collectAsState()
    LaunchedEffect(Unit) { vm.seedIfEmpty() }
    Column(Modifier.fillMaxSize()) {
        PmTopBar("Characters", onBack = onBack)
        LazyColumn(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(characters) { c ->
                PmCard {
                    Text(c.name, style = MaterialTheme.typography.titleMedium, color = PmGreen)
                    Text(c.description, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
