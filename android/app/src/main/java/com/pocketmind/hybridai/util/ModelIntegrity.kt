package com.pocketmind.hybridai.util

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

data class IntegrityResult(
    val path: String,
    val sha256: String,
    val sizeBytes: Long,
    val matchedExpected: Boolean?
)

object ModelIntegrity {

    suspend fun sha256File(path: String): IntegrityResult = withContext(Dispatchers.IO) {
        val file = File(path)
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(256 * 1024)
        var total = 0L
        file.inputStream().use { input ->
            while (true) {
                val n = input.read(buffer)
                if (n <= 0) break
                digest.update(buffer, 0, n)
                total += n
            }
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        IntegrityResult(path, hex, total, null)
    }

    suspend fun verify(path: String, expectedSha256: String?): IntegrityResult = withContext(Dispatchers.IO) {
        val result = sha256File(path)
        val matched = expectedSha256?.let { result.sha256.equals(it, ignoreCase = true) }
        result.copy(matchedExpected = matched)
    }
}
