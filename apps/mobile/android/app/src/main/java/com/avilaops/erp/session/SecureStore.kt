package com.avilaops.erp.session

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.avilaops.erp.core.ErpJson
import com.avilaops.erp.core.TokenSet
import kotlinx.serialization.Serializable
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** O que sobrevive ao fechamento do app: tokens, empresa escolhida e preferência de biometria. */
@Serializable
data class StoredSession(val tokens: TokenSet, val tenantId: String? = null, val biometricUnlock: Boolean = false)

/**
 * Sessão cifrada com AES-256-GCM. A chave é gerada e guardada no Android Keystore
 * (não exportável); o arquivo de preferências guarda apenas o texto cifrado.
 */
class SecureStore(context: Context) {
    private val preferences = context.getSharedPreferences("erp-session", Context.MODE_PRIVATE)

    fun read(): StoredSession? {
        val stored = preferences.getString(KEY, null) ?: return null
        return runCatching {
            val bytes = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_SIZE))
            val plain = cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE)
            ErpJson.decodeFromString<StoredSession>(plain.toString(Charsets.UTF_8))
        }.getOrElse {
            clear() // Chave invalidada (ex.: bloqueio de tela removido) ou dado corrompido: novo login.
            null
        }
    }

    fun write(session: StoredSession) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.iv + cipher.doFinal(ErpJson.encodeToString(StoredSession.serializer(), session).toByteArray(Charsets.UTF_8))
        preferences.edit().putString(KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply()
    }

    fun clear() {
        preferences.edit().remove(KEY).apply()
    }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER).apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
        }.generateKey()
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "erp-session"
        const val KEY = "session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
    }
}
