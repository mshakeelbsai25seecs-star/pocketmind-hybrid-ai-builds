package com.pocketmind.hybridai.util

import android.content.Context
import android.content.Intent
import com.pocketmind.hybridai.data.db.ConversationEntity
import com.pocketmind.hybridai.data.db.MessageEntity
import org.json.JSONArray
import org.json.JSONObject

enum class ChatExportFormat { MARKDOWN, JSON, TXT }

object ChatExport {
    fun render(
        conversation: ConversationEntity,
        messages: List<MessageEntity>,
        format: ChatExportFormat
    ): String = when (format) {
        ChatExportFormat.MARKDOWN -> buildString {
            appendLine("# ${conversation.title}")
            appendLine()
            appendLine("_Model: ${conversation.modelLabel} (${conversation.modelKind})_")
            appendLine()
            messages.forEach { msg ->
                appendLine("## ${msg.role}")
                appendLine()
                appendLine(msg.content)
                appendLine()
            }
        }
        ChatExportFormat.TXT -> buildString {
            appendLine(conversation.title)
            appendLine("Model: ${conversation.modelLabel} (${conversation.modelKind})")
            appendLine("---")
            messages.forEach { msg ->
                appendLine(msg.role.uppercase())
                appendLine(msg.content)
                appendLine()
            }
        }
        ChatExportFormat.JSON -> {
            val root = JSONObject()
            root.put("id", conversation.id)
            root.put("title", conversation.title)
            root.put("modelId", conversation.modelId)
            root.put("modelLabel", conversation.modelLabel)
            root.put("modelKind", conversation.modelKind)
            val arr = JSONArray()
            messages.forEach { msg ->
                arr.put(
                    JSONObject()
                        .put("id", msg.id)
                        .put("role", msg.role)
                        .put("content", msg.content)
                        .put("createdAt", msg.createdAt)
                )
            }
            root.put("messages", arr)
            root.toString(2)
        }
    }

    fun share(context: Context, title: String, body: String, mime: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TEXT, body)
        }
        context.startActivity(Intent.createChooser(send, "Export chat"))
    }

    fun mime(format: ChatExportFormat): String = when (format) {
        ChatExportFormat.MARKDOWN -> "text/markdown"
        ChatExportFormat.JSON -> "application/json"
        ChatExportFormat.TXT -> "text/plain"
    }

    fun extension(format: ChatExportFormat): String = when (format) {
        ChatExportFormat.MARKDOWN -> "md"
        ChatExportFormat.JSON -> "json"
        ChatExportFormat.TXT -> "txt"
    }
}
