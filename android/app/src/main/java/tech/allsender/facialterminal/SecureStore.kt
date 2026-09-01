package tech.allsender.facialterminal

import android.content.Context
import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Small Keystore-backed store for terminal secrets and encrypted local payloads. */
class SecureStore(context: Context) {
    private val preferences = context.getSharedPreferences("allsender_facial_secure", Context.MODE_PRIVATE)
    private val alias = "allsender-facial-terminal-aes-v1"

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(android.security.keystore.KeyGenParameterSpec.Builder(
            alias,
            android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or
                android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }

    fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
        val ciphertext = Base64.encodeToString(
            cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8)),
            Base64.NO_WRAP,
        )
        return "$iv:$ciphertext"
    }

    fun decrypt(value: String): String? {
        return try {
            val parts = value.split(":", limit = 2)
            if (parts.size != 2) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(),
                GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun putSecret(name: String, value: String) {
        preferences.edit().putString(name, encrypt(value)).apply()
    }

    fun getSecret(name: String): String? = preferences.getString(name, null)?.let(::decrypt)

    fun removeSecret(name: String) {
        preferences.edit().remove(name).apply()
    }

    fun clearTerminalSecrets() {
        preferences.edit().clear().apply()
    }
}
