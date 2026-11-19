package com.avilaops.erp.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

@Serializable
data class OidcMetadata(
    val issuer: String,
    @SerialName("authorization_endpoint") val authorizationEndpoint: String,
    @SerialName("token_endpoint") val tokenEndpoint: String,
    @SerialName("code_challenge_methods_supported") val codeChallengeMethods: List<String> = emptyList(),
    @SerialName("scopes_supported") val scopesSupported: List<String> = emptyList(),
)

@Serializable
data class TokenSet(val accessToken: String, val refreshToken: String?, val expiresAtEpochSeconds: Long) {
    fun expiresWithin(nowEpochSeconds: Long, marginSeconds: Long = 60) = nowEpochSeconds + marginSeconds >= expiresAtEpochSeconds
}

/** Pedido de login em andamento: guardado só na memória do processo até o retorno do navegador. */
data class AuthorizationRequest(val url: String, val state: String, val pkce: Pkce)

class AuthException(message: String) : Exception(message)

/**
 * Cliente OIDC público (sem segredo) com PKCE S256, no mesmo Auth do ERP web.
 * As mesmas validações do BFF web: issuer exato, S256 obrigatório e endpoints na origem do issuer.
 */
class OidcClient(
    issuer: String,
    private val clientId: String,
    private val redirectUri: String,
    private val transport: HttpTransport,
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val issuer = URI(issuer).let { "${it.scheme}://${it.authority}" }

    fun discover(): OidcMetadata {
        val response = transport.send(HttpRequest("GET", "$issuer/.well-known/openid-configuration", mapOf("Accept" to "application/json")))
        if (response.status != 200) throw AuthException("Serviço de autenticação indisponível")
        val metadata = runCatching { ErpJson.decodeFromString<OidcMetadata>(response.body) }.getOrElse { throw AuthException("Contrato do Auth incompatível") }
        if (metadata.issuer.trimEnd('/') != issuer || "S256" !in metadata.codeChallengeMethods) throw AuthException("Contrato do Auth incompatível")
        for (endpoint in listOf(metadata.authorizationEndpoint, metadata.tokenEndpoint)) {
            val parsed = URI(endpoint)
            if (parsed.scheme != "https" && !issuer.startsWith("http://localhost")) throw AuthException("Endpoint do Auth inválido")
            if ("${parsed.scheme}://${parsed.authority}" != issuer || parsed.userInfo != null || parsed.fragment != null) throw AuthException("Endpoint do Auth inválido")
        }
        return metadata
    }

    fun authorizationRequest(metadata: OidcMetadata, pkce: Pkce = Pkce.create(), state: String = Pkce.randomToken()): AuthorizationRequest {
        val scopes = buildList {
            addAll(listOf("openid", "profile", "email"))
            if ("offline_access" in metadata.scopesSupported) add("offline_access")
        }
        val query = form(
            "response_type" to "code",
            "client_id" to clientId,
            "redirect_uri" to redirectUri,
            "scope" to scopes.joinToString(" "),
            "state" to state,
            "code_challenge" to pkce.challenge,
            "code_challenge_method" to "S256",
        )
        val separator = if ('?' in metadata.authorizationEndpoint) "&" else "?"
        return AuthorizationRequest("${metadata.authorizationEndpoint}$separator$query", state, pkce)
    }

    /** Valida o retorno do navegador e devolve o código de autorização. */
    fun authorizationCode(callback: String, pending: AuthorizationRequest): String {
        val uri = URI(callback)
        if (!callback.startsWith(redirectUri)) throw AuthException("Retorno de login inesperado")
        val params = parseQuery(uri.rawQuery)
        if (params["state"] != pending.state) throw AuthException("Retorno de login inválido. Entre novamente")
        params["error"]?.let { throw AuthException(if (it == "access_denied") "Login cancelado" else "O Auth recusou o login") }
        return params["code"]?.takeIf { it.isNotBlank() } ?: throw AuthException("Retorno de login sem código")
    }

    fun exchangeCode(metadata: OidcMetadata, code: String, pending: AuthorizationRequest): TokenSet = token(
        metadata,
        form("grant_type" to "authorization_code", "code" to code, "redirect_uri" to redirectUri, "client_id" to clientId, "code_verifier" to pending.pkce.verifier),
        previousRefresh = null,
    )

    fun refresh(metadata: OidcMetadata, refreshToken: String): TokenSet = token(
        metadata,
        form("grant_type" to "refresh_token", "refresh_token" to refreshToken, "client_id" to clientId),
        previousRefresh = refreshToken,
    )

    private fun token(metadata: OidcMetadata, body: String, previousRefresh: String?): TokenSet {
        val response = transport.send(
            HttpRequest("POST", metadata.tokenEndpoint, mapOf("Content-Type" to "application/x-www-form-urlencoded", "Accept" to "application/json"), body),
        )
        if (response.status == 400 || response.status == 401) throw AuthException("Sessão expirada. Entre novamente")
        if (response.status != 200) throw AuthException("Serviço de autenticação indisponível")
        val token = runCatching { ErpJson.decodeFromString<TokenResponse>(response.body) }.getOrElse { throw AuthException("Resposta do Auth inválida") }
        if (!token.tokenType.equals("bearer", ignoreCase = true) || token.accessToken.isBlank() || token.expiresIn <= 0) throw AuthException("Resposta do Auth inválida")
        return TokenSet(token.accessToken, token.refreshToken ?: previousRefresh, clock() + token.expiresIn)
    }

    @Serializable
    private data class TokenResponse(
        @SerialName("access_token") val accessToken: String,
        @SerialName("token_type") val tokenType: String,
        @SerialName("expires_in") val expiresIn: Long,
        @SerialName("refresh_token") val refreshToken: String? = null,
    )

    companion object {
        fun form(vararg pairs: Pair<String, String>) =
            pairs.joinToString("&") { (key, value) -> "${encode(key)}=${encode(value)}" }

        fun encode(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        fun parseQuery(raw: String?): Map<String, String> = raw.orEmpty().split('&').filter { it.isNotEmpty() }.associate {
            val parts = it.split('=', limit = 2)
            URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
        }
    }
}
