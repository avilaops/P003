package com.avilaops.erp.core

import com.avilaops.erp.api.generated.ErpOperations
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private class FakeTransport(private val reply: (HttpRequest) -> HttpResponse) : HttpTransport {
    val requests = mutableListOf<HttpRequest>()
    override fun send(request: HttpRequest) = reply(request).also { requests += request }
}

private fun json(status: Int, body: String, headers: Map<String, String> = emptyMap()) = HttpResponse(status, headers, body)

class PkceTest {
    @Test
    fun `desafio S256 confere com o vetor da RFC 7636`() {
        val pkce = Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", pkce.challenge)
    }

    @Test
    fun `verificador aleatório tem tamanho e alfabeto válidos`() {
        val pkce = Pkce.create()
        assertTrue(pkce.verifier.length in 43..128)
        assertFailsWith<IllegalArgumentException> { Pkce.fromVerifier("curto") }
    }
}

class OidcClientTest {
    private val metadata = """{"issuer":"https://auth.example.com","authorization_endpoint":"https://auth.example.com/authorize","token_endpoint":"https://auth.example.com/token","code_challenge_methods_supported":["S256"],"scopes_supported":["openid","offline_access"]}"""

    private fun client(transport: HttpTransport) = OidcClient("https://auth.example.com", "erp-mobile", "com.avilaops.erp:/oauth2redirect", transport) { 1_000 }

    @Test
    fun `login usa PKCE S256, estado e o cliente público`() {
        val oidc = client(FakeTransport { json(200, metadata) })
        val request = oidc.authorizationRequest(oidc.discover(), Pkce.fromVerifier("a".repeat(43)), "estado")
        val query = OidcClient.parseQuery(request.url.substringAfter('?'))
        assertEquals("code", query["response_type"])
        assertEquals("erp-mobile", query["client_id"])
        assertEquals("S256", query["code_challenge_method"])
        assertEquals("openid profile email offline_access", query["scope"])
        assertEquals("estado", query["state"])
    }

    @Test
    fun `recusa Auth sem S256 ou com endpoint de outra origem`() {
        assertFailsWith<AuthException> { client(FakeTransport { json(200, metadata.replace("\"S256\"", "\"plain\"")) }).discover() }
        assertFailsWith<AuthException> { client(FakeTransport { json(200, metadata.replace("https://auth.example.com/token", "https://evil.example.com/token")) }).discover() }
    }

    @Test
    fun `retorno exige o mesmo estado e troca o código com o verificador`() {
        val transport = FakeTransport { if (it.method == "GET") json(200, metadata) else json(200, """{"access_token":"at","token_type":"Bearer","expires_in":300,"refresh_token":"rt"}""") }
        val oidc = client(transport)
        val discovered = oidc.discover()
        val pending = oidc.authorizationRequest(discovered, Pkce.fromVerifier("v".repeat(43)), "s1")
        assertFailsWith<AuthException> { oidc.authorizationCode("com.avilaops.erp:/oauth2redirect?code=c&state=outro", pending) }
        assertFailsWith<AuthException> { oidc.authorizationCode("com.avilaops.erp:/oauth2redirect?error=access_denied&state=s1", pending) }
        val code = oidc.authorizationCode("com.avilaops.erp:/oauth2redirect?code=abc&state=s1", pending)
        val tokens = oidc.exchangeCode(discovered, code, pending)
        assertEquals(TokenSet("at", "rt", 1_300), tokens)
        val form = OidcClient.parseQuery(transport.requests.last().body)
        assertEquals("v".repeat(43), form["code_verifier"])
        assertNull(form["client_secret"])
    }

    @Test
    fun `renovação preserva o refresh token quando o Auth não envia outro`() {
        val oidc = client(FakeTransport { json(200, """{"access_token":"novo","token_type":"bearer","expires_in":60}""") })
        val discovered = ErpJson.decodeFromString<OidcMetadata>(metadata)
        assertEquals(TokenSet("novo", "rt", 1_060), oidc.refresh(discovered, "rt"))
        assertFailsWith<AuthException> { client(FakeTransport { json(400, "{}") }).refresh(discovered, "rt") }
    }
}

class ErpApiTest {
    private fun api(transport: HttpTransport) = ErpApi("https://erp.example.com/", transport) { "token" }

    @Test
    fun `consulta envia Bearer, empresa e operação gerada do contrato`() {
        val transport = FakeTransport { json(200, """{"data":[{"id":"o1","number":"12","customerName":"Ana","amount":"10.50","status":"draft","revision":3}],"total":1,"offset":0,"limit":25}""") }
        val page = api(transport).orders("t1", query = "ana maria", status = "draft")
        val request = transport.requests.single()
        assertEquals("https://erp.example.com/api/v1/orders?q=ana%20maria&status=draft&limit=25", request.url)
        assertEquals("Bearer token", request.headers["Authorization"])
        assertEquals("t1", request.headers["X-Tenant-Id"])
        assertEquals("10.50", page.data.single().amount)
    }

    @Test
    fun `aprovação usa If-Match da revisão e chave idempotente`() {
        val transport = FakeTransport { json(200, """{"tenantId":"t1","id":"o1","revision":4,"approved":true}""") }
        val key = UUID.fromString("00000000-0000-4000-8000-000000000001")
        val result = api(transport).approvePricing("t1", "o1", 3, "  margem negociada ", key)
        val request = transport.requests.single()
        assertEquals("/api/v1/orders/o1/pricing/approve", request.url.removePrefix("https://erp.example.com"))
        assertEquals("\"3\"", request.headers["If-Match"])
        assertEquals(key.toString(), request.headers["Idempotency-Key"])
        assertEquals("""{"reason":"margem negociada"}""", request.body)
        assertEquals(4, result.revision)
    }

    @Test
    fun `detalhe devolve a revisão do ETag`() {
        val transport = FakeTransport { json(200, """{"data":{"id":"o1","number":"1","status":"draft","revision":7,"amount":12},"items":[]}""", mapOf("etag" to "\"7\"")) }
        val detail = api(transport).order("t1", "o1")
        assertEquals(7, detail.revision)
        assertEquals("12", detail.value.data.amount)
    }

    @Test
    fun `cadastro rápido envia apenas campos aceitos pela API`() {
        val transport = FakeTransport { json(201, """{"tenantId":"t1","canEdit":true,"data":{"id":"p1","legalName":"Ana","taxId":"52998224725","revision":1}}""") }
        api(transport).createCustomer("t1", QuickCustomerInput("fisica", "Ana", taxId = "529.982.247-25"), UUID.randomUUID())
        assertEquals(
            """{"personType":"fisica","legalName":"Ana","taxId":"529.982.247-25","isCustomer":true,"isSupplier":false,"status":"active"}""",
            transport.requests.single().body,
        )
    }

    @Test
    fun `problem json vira mensagem e 401 indica sessão expirada`() {
        val error = assertFailsWith<ApiException> {
            api(FakeTransport { json(403, """{"status":403,"code":"forbidden","title":"Acesso não autorizado para esta empresa"}""") }).me("t1")
        }
        assertEquals("Acesso não autorizado para esta empresa", error.message)
        assertFalse(error.sessionExpired)
        assertTrue(assertFailsWith<ApiException> { api(FakeTransport { json(401, "") }).me("t1") }.sessionExpired)
    }

    @Test
    fun `lista de empresas não envia X-Tenant-Id e API sem HTTPS é recusada`() {
        val transport = FakeTransport { json(200, """{"data":[],"platformAdministrator":false}""") }
        api(transport).companies()
        assertNull(transport.requests.single().headers["X-Tenant-Id"])
        assertFailsWith<IllegalArgumentException> { ErpApi("http://erp.example.com", transport) { "t" } }
    }

    @Test
    fun `todas as operações do cliente vêm do contrato ou declaram a dependência`() {
        assertTrue(ErpOperations.all.isNotEmpty())
        for (operation in ErpOperations.all) assertTrue(operation.path.startsWith("/api/v1/"), operation.id)
        assertEquals(setOf("getApiV1Companies", "postApiV1CompanySelection"), ErpOperations.all.filter { it.pendingOn != null }.map { it.id }.toSet())
    }
}
