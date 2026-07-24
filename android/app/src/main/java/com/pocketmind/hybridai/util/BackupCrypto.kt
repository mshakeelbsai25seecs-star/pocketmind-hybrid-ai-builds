package com.pocketmind.hybridai.util

import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

private val BACKUP_MAGIC = "PMBK1".toByteArray(Charsets.US_ASCII)

/**
 * AES-256-GCM encrypted backup format compatible with desktop PocketMind (PMBK1).
 * Layout: magic(5) + salt(16) + nonce(12) + ciphertext+tag
 */
object BackupCrypto {

    fun encryptBackupBytes(plaintext: ByteArray, passphrase: String): ByteArray {
        require(passphrase.trim().length >= 8) { "Passphrase must be at least 8 characters" }
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val key = deriveKey(passphrase, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        val ciphertext = cipher.doFinal(plaintext)
        return BACKUP_MAGIC + salt + nonce + ciphertext
    }

    fun decryptBackupBytes(blob: ByteArray, passphrase: String): ByteArray {
        require(blob.size >= BACKUP_MAGIC.size + 16 + 12 + 16) { "Invalid encrypted backup file" }
        require(blob.copyOfRange(0, BACKUP_MAGIC.size).contentEquals(BACKUP_MAGIC)) {
            "Not a PocketMind encrypted backup (PMBK1)"
        }
        val salt = blob.copyOfRange(5, 21)
        val nonce = blob.copyOfRange(21, 33)
        val ciphertext = blob.copyOfRange(33, blob.size)
        val key = deriveKey(passphrase, salt)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        return cipher.doFinal(ciphertext)
    }

    fun encryptBackupText(plaintext: String, passphrase: String): ByteArray =
        encryptBackupBytes(plaintext.toByteArray(Charsets.UTF_8), passphrase)

    fun decryptBackupText(blob: ByteArray, passphrase: String): String =
        String(decryptBackupBytes(blob, passphrase), Charsets.UTF_8)

    /** Matches desktop PBKDF2-style stretch (100k rounds of SHA-256 HMAC-like block). */
    private fun deriveKey(passphrase: String, salt: ByteArray): ByteArray {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        var block = digest.digest(passphrase.toByteArray(Charsets.UTF_8) + salt)
        repeat(100_000) {
            block = digest.digest(block + passphrase.toByteArray(Charsets.UTF_8))
        }
        return block.copyOf(32)
    }
}
