package com.pocketmind.hybridai.util

import java.io.FileNotFoundException
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * Maps low-level failures to short plain-English messages for chat + diagnostics.
 */
object UserFacingError {
    fun map(error: Throwable?): String {
        if (error == null) return "Something went wrong."
        val msg = (error.message ?: "").lowercase()
        val className = error.javaClass.simpleName.lowercase()

        return when {
            error is OutOfMemoryError || msg.contains("out of memory") || msg.contains("oom") ->
                "Ran out of memory. Try a smaller GGUF (Q4), enable Safe CPU only, or close other apps."

            msg.contains("vram") || msg.contains("cuda") && msg.contains("alloc") ||
                msg.contains("ggml_cuda") || msg.contains("failed to allocate") ->
                "GPU / VRAM allocation failed. Switch to Safe CPU only or choose a smaller quantization."

            error is FileNotFoundException || msg.contains("no such file") ||
                msg.contains("file not found") || msg.contains("does not exist") ->
                "A required file was not found. Check that the model path still exists under Models."

            error is UnknownHostException || error is ConnectException ||
                msg.contains("failed to connect") || msg.contains("connection refused") ->
                "Could not reach the server. Check Org Server URL / internet, then retry."

            error is SocketTimeoutException || msg.contains("timeout") || msg.contains("timed out") ->
                "The request timed out. The model or network may be overloaded — retry or lower max tokens."

            error is IOException || className.contains("http") ->
                "Network or I/O error: ${shortMessage(error)}"

            msg.contains("unauthorized") || msg.contains("401") || msg.contains("api key") ->
                "Authentication failed. Add or refresh the API key in Models → Keys."

            msg.contains("403") || msg.contains("forbidden") ->
                "Access denied by the provider. Check account quota and API key permissions."

            msg.contains("404") ->
                "Model or endpoint not found. Refresh Models and pick a live model id."

            msg.contains("429") || msg.contains("rate limit") ->
                "Rate limited by the provider. Wait a moment, then try again."

            else -> shortMessage(error)
        }
    }

    private fun shortMessage(error: Throwable): String {
        val raw = error.message?.trim().orEmpty()
        if (raw.isBlank()) return "Generation failed (${error.javaClass.simpleName})."
        return if (raw.length > 220) raw.take(217) + "…" else raw
    }
}
