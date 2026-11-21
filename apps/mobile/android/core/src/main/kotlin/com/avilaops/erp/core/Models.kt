package com.avilaops.erp.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.jsonPrimitive

// Modelos mínimos de resposta: só os campos que as telas da v1 mostram.
// O contrato OpenAPI do api-ts ainda não publica schemas de resposta (aguardando #284);
// quando publicar, o gerador passa a emitir estes tipos e este arquivo encolhe.

val ErpJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }

/** Valores decimais chegam como texto ("1234.50") ou número; o app mostra, não calcula. */
object DecimalText : KSerializer<String> {
    override val descriptor = PrimitiveSerialDescriptor("DecimalText", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder): String =
        (decoder as? JsonDecoder)?.decodeJsonElement()?.jsonPrimitive?.content ?: decoder.decodeString()
    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)
}

@Serializable
data class Problem(val status: Int = 0, val code: String? = null, val title: String? = null, val detail: String? = null)

@Serializable
data class Identity(val subject: String, val email: String, val name: String)

@Serializable
data class Tenant(val id: String, val legalName: String, val tradeName: String? = null) {
    val displayName get() = tradeName?.takeIf { it.isNotBlank() } ?: legalName
}

@Serializable
data class AccessProfile(val identity: Identity, val tenant: Tenant, val roles: List<String> = emptyList(), val permissions: List<String> = emptyList()) {
    fun can(permission: String) = permission in permissions
}

@Serializable
data class CompanySummary(val id: String, val legalName: String, val tradeName: String? = null, val status: String) {
    val displayName get() = tradeName?.takeIf { it.isNotBlank() } ?: legalName
}

@Serializable
data class CompanyDirectory(val data: List<CompanySummary>, val platformAdministrator: Boolean)

@Serializable
data class OrderSummary(
    val id: String,
    val number: String,
    val customerName: String? = null,
    val customerTaxId: String? = null,
    val dueDate: String? = null,
    @Serializable(with = DecimalText::class) val amount: String = "0",
    val status: String,
    val revision: Long,
    val updatedAt: String? = null,
)

@Serializable
data class OrderPage(val data: List<OrderSummary>, val total: Int, val offset: Int, val limit: Int, val canEdit: Boolean = false)

@Serializable
data class OrderItem(
    val sku: String? = null,
    val name: String,
    val unit: String? = null,
    @Serializable(with = DecimalText::class) val quantity: String = "0",
    @Serializable(with = DecimalText::class) val unitPrice: String = "0",
    @Serializable(with = DecimalText::class) val amount: String = "0",
)

@Serializable
data class OrderDetail(val data: OrderSummary, val items: List<OrderItem> = emptyList(), val canEdit: Boolean = false)

@Serializable
data class PricingState(val needsApproval: Boolean, val approved: Boolean)

@Serializable
data class OrderPricing(val canApprove: Boolean, val data: PricingState? = null) {
    val awaitingApproval get() = data?.needsApproval == true && !data.approved
}

@Serializable
data class PricingApproval(val id: String, val revision: Long, val approved: Boolean)

/** Corpo de `POST /api/v1/parties` no cadastro rápido: só cliente, ativo, sem endereço. */
@Serializable
data class QuickCustomerInput(
    val personType: String,
    val legalName: String,
    val tradeName: String? = null,
    val taxId: String,
    val email: String? = null,
    val phone: String? = null,
    val isCustomer: Boolean = true,
    val isSupplier: Boolean = false,
    val status: String = "active",
) {
    init {
        require(personType == "fisica" || personType == "juridica")
    }
}

@Serializable
data class Party(val id: String, val legalName: String, val taxId: String? = null, val revision: Long)

@Serializable
data class PartyEnvelope(val data: Party)

/** Normaliza o retorno de texto usado no cadastro: vazio vira nulo, como o web envia. */
fun String.blankToNull(): String? = trim().takeIf { it.isNotEmpty() }

