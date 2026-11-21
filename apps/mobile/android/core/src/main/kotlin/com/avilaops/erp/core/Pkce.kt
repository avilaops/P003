package com.avilaops.erp.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** PKCE S256 (RFC 7636). O verificador nunca sai do aparelho; só o desafio vai para o Auth. */
data class Pkce(val verifier: String, val challenge: String) {
    companion object {
        private val encoder = Base64.getUrlEncoder().withoutPadding()

        fun create(random: SecureRandom = SecureRandom()): Pkce = fromVerifier(randomToken(random, 64))

        fun fromVerifier(verifier: String): Pkce {
            require(verifier.length in 43..128 && verifier.all { it.isLetterOrDigit() || it in "-._~" }) { "Verificador PKCE inválido" }
            val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
            return Pkce(verifier, encoder.encodeToString(digest))
        }

        /** Texto aleatório url-safe com [bytes] bytes de entropia. */
        fun randomToken(random: SecureRandom = SecureRandom(), bytes: Int = 32): String =
            ByteArray(bytes).also(random::nextBytes).let(encoder::encodeToString)
    }
}
