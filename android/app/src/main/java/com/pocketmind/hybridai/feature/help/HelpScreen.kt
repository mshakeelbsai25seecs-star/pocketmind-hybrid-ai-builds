package com.pocketmind.hybridai.feature.help

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pocketmind.hybridai.ui.components.PmCard
import com.pocketmind.hybridai.ui.components.PmTopBar
import com.pocketmind.hybridai.ui.theme.PmGreen

@Composable
fun HelpScreen(onBack: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        PmTopBar("Help", onBack = onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            HelpBlock(
                "Privacy",
                "Local GGUF stays on device. Online and Org Server send prompts to the endpoint you configure. API keys are encrypted on-device and excluded from backups by default."
            )
            HelpBlock(
                "Free chat keys",
                "Groq: https://console.groq.com/keys\nGemini: https://aistudio.google.com/app/apikey\nOpenRouter: https://openrouter.ai/keys"
            )
            HelpBlock(
                "Free images",
                "Primary: https://gen.pollinations.ai (optional key from enter.pollinations.ai)\nFailover: Hugging Face token at https://huggingface.co/settings/tokens\nWe do not rely solely on the legacy image.pollinations.ai path."
            )
            HelpBlock(
                "Local GGUF",
                "Import a .gguf in Models. Place a real llama-cli / llama-server binary under the app filesDir/bin to enable on-device generation. Vulkan is used when the device reports it; otherwise CPU."
            )
        }
    }
}

@Composable
private fun HelpBlock(title: String, body: String) {
    PmCard {
        Text(title, color = PmGreen, style = MaterialTheme.typography.titleSmall)
        Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
