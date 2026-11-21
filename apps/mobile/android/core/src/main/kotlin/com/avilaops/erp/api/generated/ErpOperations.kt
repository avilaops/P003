// Gerado por apps/mobile/contract/generate.mjs a partir de apps/api-ts/openapi.json. Não edite.
package com.avilaops.erp.api.generated

import com.avilaops.erp.api.ErpOperation

object ErpOperations {
    /** Fora do contrato TypeScript: aguardando porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust. */
    val getApiV1Companies = ErpOperation(
        id = "getApiV1Companies",
        method = "GET",
        path = "/api/v1/companies",
        pathParameters = listOf(),
        queryParameters = listOf(),
        requiresTenant = false,
        pendingOn = "porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust",
    )

    val getApiV1Me = ErpOperation(
        id = "getApiV1Me",
        method = "GET",
        path = "/api/v1/me",
        pathParameters = listOf(),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    val getApiV1Orders = ErpOperation(
        id = "getApiV1Orders",
        method = "GET",
        path = "/api/v1/orders",
        pathParameters = listOf(),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    val getApiV1OrdersId = ErpOperation(
        id = "getApiV1OrdersId",
        method = "GET",
        path = "/api/v1/orders/{id}",
        pathParameters = listOf("id"),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    val getApiV1OrdersIdPricing = ErpOperation(
        id = "getApiV1OrdersIdPricing",
        method = "GET",
        path = "/api/v1/orders/{id}/pricing",
        pathParameters = listOf("id"),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    /** Fora do contrato TypeScript: aguardando porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust. */
    val postApiV1CompanySelection = ErpOperation(
        id = "postApiV1CompanySelection",
        method = "POST",
        path = "/api/v1/company-selection",
        pathParameters = listOf(),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = "porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust",
    )

    val postApiV1OrdersIdPricingApprove = ErpOperation(
        id = "postApiV1OrdersIdPricingApprove",
        method = "POST",
        path = "/api/v1/orders/{id}/pricing/approve",
        pathParameters = listOf("id"),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    val postApiV1Parties = ErpOperation(
        id = "postApiV1Parties",
        method = "POST",
        path = "/api/v1/parties",
        pathParameters = listOf(),
        queryParameters = listOf(),
        requiresTenant = true,
        pendingOn = null,
    )

    val all: List<ErpOperation> = listOf(getApiV1Companies, getApiV1Me, getApiV1Orders, getApiV1OrdersId, getApiV1OrdersIdPricing, postApiV1CompanySelection, postApiV1OrdersIdPricingApprove, postApiV1Parties)
}
