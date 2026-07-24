package com.pocketmind.hybridai.engine.attachments

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import javax.inject.Inject
import javax.inject.Singleton

/** Result of trying to pull readable text out of an attachment [Uri]. */
data class AttachmentResult(
    val fileName: String,
    val mimeType: String?,
    val text: String?,
    val limitationNote: String? = null
)

private const val MAX_CHARS = 20_000

/**
 * Extracts plain text from user-attached files so it can be folded into a
 * chat prompt. Only formats that are trivially readable as text are
 * supported in v1 (plain text, generic text MIME types, and JSON). Binary document
 * formats return a clear limitation message instead of silently failing or
 * producing garbage text.
 */
@Singleton
class AttachmentTextExtractor @Inject constructor(
    @ApplicationContext private val context: Context
) {
    suspend fun extractText(uri: Uri): AttachmentResult = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val mimeType = resolver.getType(uri)
        val fileName = queryDisplayName(uri) ?: uri.lastPathSegment ?: "attachment"

        val isPlainText = mimeType != null && (
            mimeType == "text/plain" ||
                mimeType.startsWith("text/") ||
                mimeType == "application/json"
            )
        val looksLikeTextByExtension = fileName.substringAfterLast('.', "").lowercase() in
            setOf("txt", "md", "json", "csv", "log", "yaml", "yml", "xml", "kt", "java", "py", "js", "ts", "html", "css")

        if (isPlainText || looksLikeTextByExtension) {
            return@withContext runCatching {
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: return@runCatching AttachmentResult(fileName, mimeType, null, "Could not open this file.")
                var text = String(bytes, Charsets.UTF_8)
                var note: String? = null
                if (text.length > MAX_CHARS) {
                    text = text.take(MAX_CHARS)
                    note = "File truncated to the first $MAX_CHARS characters."
                }
                AttachmentResult(fileName, mimeType, text, note)
            }.getOrElse {
                AttachmentResult(fileName, mimeType, null, "Could not read this file as text: ${it.message}")
            }
        }

        if (mimeType == "application/pdf" || fileName.endsWith(".pdf", ignoreCase = true)) {
            return@withContext AttachmentResult(
                fileName, mimeType, null,
                "PDF text extraction isn't supported yet in this build. Please export the relevant section as .txt and attach that instead."
            )
        }

        val isDocx = mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
            fileName.endsWith(".docx", ignoreCase = true)
        if (isDocx) {
            return@withContext AttachmentResult(
                fileName, mimeType, null,
                "Word (.docx) text extraction isn't supported yet in this build. Please save/export as .txt and attach that instead."
            )
        }

        AttachmentResult(
            fileName, mimeType, null,
            "This file type${if (mimeType != null) " ($mimeType)" else ""} isn't supported for text extraction yet. Try a .txt, .md, .json or similar plain-text file."
        )
    }

    private fun queryDisplayName(uri: Uri): String? = runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index) else null
            } else null
        }
    }.getOrNull()
}
