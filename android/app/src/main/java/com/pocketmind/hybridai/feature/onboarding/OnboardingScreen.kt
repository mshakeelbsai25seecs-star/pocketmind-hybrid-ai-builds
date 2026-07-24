package com.pocketmind.hybridai.feature.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pocketmind.hybridai.ui.components.PmGhostButton
import com.pocketmind.hybridai.ui.components.PmPrimaryButton
import com.pocketmind.hybridai.ui.theme.PmGreen

private data class Page(val kicker: String, val title: String, val body: String)

@Composable
fun OnboardingScreen(onDone: () -> Unit) {
    val pages = listOf(
        Page("01", "Private by default", "Chat on-device with GGUF, or point at your company Organization Server over LAN/VPN."),
        Page("02", "Live free & premium", "Groq, Gemini, and OpenRouter free models are probed live — no dead Pollinations-only image path."),
        Page("03", "Conductor-clean UI", "Monospace, black canvas, green status. Built for focus on any phone or tablet width.")
    )
    var index by remember { mutableIntStateOf(0) }
    val page = pages[index]

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        Column {
            Text(page.kicker, style = MaterialTheme.typography.labelLarge, color = PmGreen)
            Spacer(Modifier.height(12.dp))
            Text(page.title, style = MaterialTheme.typography.displayMedium)
            Spacer(Modifier.height(12.dp))
            Text(page.body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (index < pages.lastIndex) {
                PmPrimaryButton(
                    text = "Continue",
                    onClick = { index++ },
                    modifier = Modifier.fillMaxWidth(),
                    accentGreen = true
                )
                PmGhostButton(text = "Skip", onClick = onDone, modifier = Modifier.fillMaxWidth())
            } else {
                PmPrimaryButton(
                    text = "Enter PocketMind",
                    onClick = onDone,
                    modifier = Modifier.fillMaxWidth(),
                    accentGreen = true
                )
            }
        }
    }
}
