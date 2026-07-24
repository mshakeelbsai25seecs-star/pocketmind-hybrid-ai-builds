package com.pocketmind.hybridai.feature.socassist

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen

@Composable
fun SocAssistScreen(onBack: () -> Unit) {
    var ioc by remember { mutableStateOf("") }
    val templates = listOf(
        "Alert triage" to "Summarize this alert, list likely causes, and propose investigation steps for analyst review.",
        "SIEM rule draft" to "Draft a FortiSIEM-style detection note (logic, fields, false-positive risks). Human approval required.",
        "Playbook outline" to "Outline a FortiSOAR-style response playbook with gates that require human confirmation before action."
    )
    Column(Modifier.fillMaxSize()) {
        PmTopBar("SOC Assist", onBack = onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "Drafting aides only — not live FortiSIEM/FortiSOAR control.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            templates.forEach { (title, body) ->
                PmCard {
                    Text(title, color = PmGreen, style = MaterialTheme.typography.titleSmall)
                    Text(body, style = MaterialTheme.typography.bodySmall)
                }
            }
            OutlinedTextField(
                value = ioc,
                onValueChange = { ioc = it },
                label = { Text("IOC helper (paste indicators)") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3
            )
            if (ioc.isNotBlank()) {
                PmCard {
                    Text("Normalized hints", color = PmGreen, style = MaterialTheme.typography.titleSmall)
                    Text(
                        ioc.lines().map { it.trim() }.filter { it.isNotEmpty() }
                            .joinToString("\n") { "• $it" },
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        }
    }
}
