package com.pocketmind.hybridai.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pocketmind.hybridai.ui.theme.PmGreen
import com.pocketmind.hybridai.util.BudgetLevel
import com.pocketmind.hybridai.util.ContextBudgetResult
import com.pocketmind.hybridai.util.formatBudgetLabel

@Composable
fun ContextBudgetBar(
    budget: ContextBudgetResult,
    keepLastN: Int,
    onKeepLastNChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    showSlider: Boolean = true
) {
    val barColor = when (budget.level) {
        BudgetLevel.CRITICAL -> MaterialTheme.colorScheme.error
        BudgetLevel.WARN -> androidx.compose.ui.graphics.Color(0xFFF59E0B)
        BudgetLevel.OK -> PmGreen
    }
    val labelColor = when (budget.level) {
        BudgetLevel.CRITICAL -> MaterialTheme.colorScheme.error
        BudgetLevel.WARN -> androidx.compose.ui.graphics.Color(0xFFD97706)
        BudgetLevel.OK -> MaterialTheme.colorScheme.onSurfaceVariant
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.medium)
            .padding(12.dp)
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                "CONTEXT",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f)
            )
            Text(
                buildString {
                    append(formatBudgetLabel(budget))
                    if (budget.droppedCount > 0) append(" · dropped ${budget.droppedCount} older")
                },
                style = MaterialTheme.typography.labelSmall,
                color = labelColor
            )
        }
        androidx.compose.foundation.layout.Box(
            Modifier
                .fillMaxWidth()
                .padding(top = 8.dp)
                .height(8.dp)
                .background(MaterialTheme.colorScheme.surface, MaterialTheme.shapes.small)
        ) {
            androidx.compose.foundation.layout.Box(
                Modifier
                    .fillMaxWidth(budget.ratio.coerceIn(0f, 1f))
                    .height(8.dp)
                    .background(barColor, MaterialTheme.shapes.small)
            )
        }
        if (budget.level == BudgetLevel.CRITICAL) {
            Text(
                "Context is nearly full. Trim history or lower Memory window before sending.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 6.dp)
            )
        }
        if (showSlider) {
            Row(
                Modifier.fillMaxWidth().padding(top = 8.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
            ) {
                Text(
                    "Keep last $keepLastN msgs",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Slider(
                    value = keepLastN.toFloat(),
                    onValueChange = { onKeepLastNChange(it.toInt()) },
                    valueRange = 2f..40f,
                    modifier = Modifier.weight(1f).padding(start = 8.dp)
                )
            }
        }
    }
}
