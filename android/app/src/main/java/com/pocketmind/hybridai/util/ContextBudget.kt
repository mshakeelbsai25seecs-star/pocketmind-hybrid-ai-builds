package com.pocketmind.hybridai.util

import com.pocketmind.hybridai.data.db.MessageEntity

/** Rough token estimate used for UI budget bars (chars/4). */
fun estimateTokens(text: String?): Int {
    if (text.isNullOrEmpty()) return 0
    return maxOf(0, kotlin.math.ceil(text.length / 4.0).toInt())
}

fun estimateMessagesTokens(messages: List<MessageEntity>): Int =
    messages.sumOf { estimateTokens(it.content) + 4 }

data class ContextBudgetInput(
    val systemPrompt: String? = null,
    val messages: List<MessageEntity>,
    val attachmentText: String? = null,
    val ragBundle: String? = null,
    val contextSize: Int,
    val keepLastN: Int
)

data class ContextBudgetResult(
    val contextSize: Int,
    val keepLastN: Int,
    val retainedMessages: List<MessageEntity>,
    val usedTokens: Int,
    val limitTokens: Int,
    val ratio: Float,
    val level: BudgetLevel,
    val droppedCount: Int
)

enum class BudgetLevel { OK, WARN, CRITICAL }

fun computeContextBudget(input: ContextBudgetInput): ContextBudgetResult {
    val limitTokens = maxOf(512, input.contextSize)
    val keepLastN = input.keepLastN.coerceIn(1, 200)
    val retainedMessages = input.messages.takeLast(keepLastN)
    val droppedCount = maxOf(0, input.messages.size - retainedMessages.size)
    val usedTokens =
        estimateTokens(input.systemPrompt) +
            estimateMessagesTokens(retainedMessages) +
            estimateTokens(input.attachmentText) +
            estimateTokens(input.ragBundle)
    val ratio = (usedTokens.toFloat() / limitTokens).coerceAtMost(1f)
    val level = when {
        ratio >= 0.9f -> BudgetLevel.CRITICAL
        ratio >= 0.7f -> BudgetLevel.WARN
        else -> BudgetLevel.OK
    }
    return ContextBudgetResult(
        contextSize = limitTokens,
        keepLastN = keepLastN,
        retainedMessages = retainedMessages,
        usedTokens = usedTokens,
        limitTokens = limitTokens,
        ratio = ratio,
        level = level,
        droppedCount = droppedCount
    )
}

fun contextLimitForModelKind(kind: String): Int = when (kind.lowercase()) {
    "local" -> 8192
    else -> 32768
}

fun formatBudgetLabel(b: ContextBudgetResult): String =
    "~${"%,d".format(b.usedTokens)} / ${"%,d".format(b.limitTokens)} tokens"

const val DEFAULT_KEEP_LAST_N = 6
