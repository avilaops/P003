// Gerado por apps/mobile/contract/generate.mjs a partir de apps/api-ts/openapi.json. Não edite.

enum ErpOperations {
    /// Fora do contrato TypeScript: aguardando porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust.
    static let getApiV1Companies = ErpOperation(
        id: "getApiV1Companies",
        method: "GET",
        path: "/api/v1/companies",
        pathParameters: [],
        queryParameters: [],
        requiresTenant: false,
        pendingOn: "porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust"
    )

    static let getApiV1Me = ErpOperation(
        id: "getApiV1Me",
        method: "GET",
        path: "/api/v1/me",
        pathParameters: [],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    static let getApiV1Orders = ErpOperation(
        id: "getApiV1Orders",
        method: "GET",
        path: "/api/v1/orders",
        pathParameters: [],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    static let getApiV1OrdersId = ErpOperation(
        id: "getApiV1OrdersId",
        method: "GET",
        path: "/api/v1/orders/{id}",
        pathParameters: ["id"],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    static let getApiV1OrdersIdPricing = ErpOperation(
        id: "getApiV1OrdersIdPricing",
        method: "GET",
        path: "/api/v1/orders/{id}/pricing",
        pathParameters: ["id"],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    /// Fora do contrato TypeScript: aguardando porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust.
    static let postApiV1CompanySelection = ErpOperation(
        id: "postApiV1CompanySelection",
        method: "POST",
        path: "/api/v1/company-selection",
        pathParameters: [],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: "porte para a API TypeScript (#283/#285); hoje a rota só existe no Rust"
    )

    static let postApiV1OrdersIdPricingApprove = ErpOperation(
        id: "postApiV1OrdersIdPricingApprove",
        method: "POST",
        path: "/api/v1/orders/{id}/pricing/approve",
        pathParameters: ["id"],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    static let postApiV1Parties = ErpOperation(
        id: "postApiV1Parties",
        method: "POST",
        path: "/api/v1/parties",
        pathParameters: [],
        queryParameters: [],
        requiresTenant: true,
        pendingOn: nil
    )

    static let all: [ErpOperation] = [getApiV1Companies, getApiV1Me, getApiV1Orders, getApiV1OrdersId, getApiV1OrdersIdPricing, postApiV1CompanySelection, postApiV1OrdersIdPricingApprove, postApiV1Parties]
}
