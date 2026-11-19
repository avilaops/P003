package com.avilaops.erp.core

import com.avilaops.erp.api.ErpOperation
import com.avilaops.erp.api.generated.ErpOperations
import java.net.URI
import java.util.UUID

/** Erro devolvido pela API em `application/problem+json`, com o título já pronto para a tela. */
class ApiException(val status: Int, val code: String?, override val message: String) : Exception(message) {
    val sessionExpired get() = status == 401
}

/** Resposta com a revisão do `ETag`, usada no `If-Match` da próxima escrita. */
data class Revised<T>(val value: T, val revision: Long)

/**
 * Cliente da API do ERP. Fala só com a API (nunca com o banco), usando as operações geradas
 * do contrato OpenAPI, o mesmo Bearer do Auth e a mesma empresa (`X-Tenant-Id`) do ERP web.
 */
class ErpApi(
    baseUrl: String,
    private val transport: HttpTransport,
    private val accessToken: () -> String,
) {
    private val base = URI(baseUrl.trim()).also {
        require(it.scheme == "https" || it.host in setOf("localhost", "10.0.2.2")) { "A API precisa de HTTPS" }
        require(it.userInfo == null && it.rawQuery == null && it.fragment == null) { "Endereço da API inválido" }
    }.toString().trimEnd('/')

    fun companies(): CompanyDirectory = call(ErpOperations.getApiV1Companies, tenant = null)

    fun selectCompany(tenant: String) {
        call<Unit>(ErpOperations.postApiV1CompanySelection, tenant, expect = setOf(204))
    }

    fun me(tenant: String): AccessProfile = call(ErpOperations.getApiV1Me, tenant)

    fun orders(tenant: String, query: String = "", status: String = "", offset: Int = 0, limit: Int = 25): OrderPage = call(
        ErpOperations.getApiV1Orders, tenant,
        query = mapOf("q" to query.trim(), "status" to status, "offset" to offset.takeIf { it > 0 }?.toString(), "limit" to limit.toString()),
    )

    fun order(tenant: String, id: String): Revised<OrderDetail> = revised(ErpOperations.getApiV1OrdersId, tenant, mapOf("id" to id))

    fun pricing(tenant: String, id: String): Revised<OrderPricing> = revised(ErpOperations.getApiV1OrdersIdPricing, tenant, mapOf("id" to id))

    /** A mesma [idempotencyKey] deve ser reenviada ao repetir a mesma decisão após falha de rede. */
    fun approvePricing(tenant: String, id: String, revision: Long, reason: String, idempotencyKey: UUID): PricingApproval = call(
        ErpOperations.postApiV1OrdersIdPricingApprove, tenant, mapOf("id" to id),
        body = ErpJson.encodeToString(ApprovalReason.serializer(), ApprovalReason(reason.trim())),
        headers = mapOf("If-Match" to "\"$revision\"", "Idempotency-Key" to idempotencyKey.toString()),
    )

    fun createCustomer(tenant: String, input: QuickCustomerInput, idempotencyKey: UUID): Party = call<PartyEnvelope>(
        ErpOperations.postApiV1Parties, tenant,
        body = ErpJson.encodeToString(QuickCustomerInput.serializer(), input),
        headers = mapOf("Idempotency-Key" to idempotencyKey.toString()),
        expect = setOf(201),
    ).data

    @kotlinx.serialization.Serializable
    private data class ApprovalReason(val reason: String)

    private inline fun <reified T> revised(operation: ErpOperation, tenant: String, path: Map<String, String>): Revised<T> {
        val response = send(operation, tenant, path, emptyMap(), null, emptyMap(), setOf(200))
        val revision = response.header("ETag")?.trim('"', ' ', 'W', '/')?.toLongOrNull() ?: throw ApiException(502, null, "Resposta sem revisão")
        return Revised(decode(response.body), revision)
    }

    private inline fun <reified T> call(
        operation: ErpOperation,
        tenant: String?,
        path: Map<String, String> = emptyMap(),
        query: Map<String, String?> = emptyMap(),
        body: String? = null,
        headers: Map<String, String> = emptyMap(),
        expect: Set<Int> = setOf(200),
    ): T {
        val response = send(operation, tenant, path, query, body, headers, expect)
        @Suppress("UNCHECKED_CAST")
        return if (T::class == Unit::class) Unit as T else decode(response.body)
    }

    private inline fun <reified T> decode(body: String): T =
        runCatching { ErpJson.decodeFromString<T>(body) }.getOrElse { throw ApiException(502, null, "Resposta da API em formato inesperado") }

    private fun send(
        operation: ErpOperation,
        tenant: String?,
        path: Map<String, String>,
        query: Map<String, String?>,
        body: String?,
        extra: Map<String, String>,
        expect: Set<Int>,
    ): HttpResponse {
        require(!operation.requiresTenant || tenant != null) { "${operation.id} exige empresa selecionada" }
        val headers = buildMap {
            put("Accept", "application/json")
            put("Authorization", "Bearer ${accessToken()}")
            if (operation.requiresTenant) put("X-Tenant-Id", tenant!!)
            put("X-Request-Id", UUID.randomUUID().toString())
            if (body != null) put("Content-Type", "application/json")
            putAll(extra)
        }
        val response = try {
            transport.send(HttpRequest(operation.method, base + operation.resolve(path, query), headers, body))
        } catch (error: java.io.IOException) {
            throw ApiException(0, "network", "Sem conexão com o ERP. Tente novamente")
        }
        if (response.status in expect) return response
        val problem = runCatching { ErpJson.decodeFromString<Problem>(response.body) }.getOrNull()
        val title = problem?.title?.takeIf { it.isNotBlank() } ?: when (response.status) {
            401 -> "Sessão expirada. Entre novamente"
            403 -> "Você não tem permissão para esta ação nesta empresa"
            404 -> "Registro não encontrado nesta empresa"
            else -> "Não foi possível concluir. Tente novamente"
        }
        throw ApiException(response.status, problem?.code, title)
    }
}
