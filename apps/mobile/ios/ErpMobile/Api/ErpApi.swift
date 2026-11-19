import Foundation

/// Erro devolvido pela API em `application/problem+json`, com o título já pronto para a tela.
struct ApiError: Error, LocalizedError, Equatable {
    let status: Int
    let code: String?
    let message: String
    var errorDescription: String? { message }
    var sessionExpired: Bool { status == 401 }
}

/// Cliente da API do ERP. Fala só com a API (nunca com o banco), usando as operações geradas
/// do contrato OpenAPI, o mesmo Bearer do Auth e a mesma empresa (`X-Tenant-Id`) do ERP web.
struct ErpApi: Sendable {
    let base: URL
    let transport: HttpTransport
    let accessToken: @Sendable () async throws -> String

    init(baseUrl: String, transport: HttpTransport, accessToken: @escaping @Sendable () async throws -> String) throws {
        guard let url = URL(string: baseUrl.trimmingCharacters(in: .whitespaces)), let host = url.host,
              url.scheme == "https" || host == "localhost", url.user == nil, url.query == nil, url.fragment == nil else {
            throw ApiError(status: 0, code: "config", message: "Endereço da API inválido; é preciso HTTPS")
        }
        var text = url.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        base = URL(string: text)!
        self.transport = transport
        self.accessToken = accessToken
    }

    func companies() async throws -> CompanyDirectory { try await call(ErpOperations.getApiV1Companies, tenant: nil) }

    func selectCompany(_ tenant: String) async throws {
        _ = try await send(ErpOperations.postApiV1CompanySelection, tenant: tenant, expect: [204])
    }

    func me(_ tenant: String) async throws -> AccessProfile { try await call(ErpOperations.getApiV1Me, tenant: tenant) }

    func orders(_ tenant: String, query: String = "", status: String = "", offset: Int = 0, limit: Int = 25) async throws -> OrderPage {
        try await call(ErpOperations.getApiV1Orders, tenant: tenant, query: [
            ("q", query.trimmingCharacters(in: .whitespaces)), ("status", status), ("offset", offset > 0 ? "\(offset)" : nil), ("limit", "\(limit)"),
        ])
    }

    func order(_ tenant: String, id: String) async throws -> Revised<OrderDetail> { try await revised(ErpOperations.getApiV1OrdersId, tenant: tenant, id: id) }

    func pricing(_ tenant: String, id: String) async throws -> Revised<OrderPricing> { try await revised(ErpOperations.getApiV1OrdersIdPricing, tenant: tenant, id: id) }

    /// A mesma `idempotencyKey` deve ser reenviada ao repetir a mesma decisão após falha de rede.
    func approvePricing(_ tenant: String, id: String, revision: Int, reason: String, idempotencyKey: UUID) async throws -> PricingApproval {
        let body = try JSONEncoder().encode(["reason": reason.trimmingCharacters(in: .whitespacesAndNewlines)])
        return try await call(ErpOperations.postApiV1OrdersIdPricingApprove, tenant: tenant, path: ["id": id], body: body,
                              headers: ["If-Match": "\"\(revision)\"", "Idempotency-Key": idempotencyKey.uuidString.lowercased()])
    }

    func createCustomer(_ tenant: String, input: QuickCustomerInput, idempotencyKey: UUID) async throws -> Party {
        let envelope: PartyEnvelope = try await call(ErpOperations.postApiV1Parties, tenant: tenant, body: try JSONEncoder().encode(input),
                                                     headers: ["Idempotency-Key": idempotencyKey.uuidString.lowercased()], expect: [201])
        return envelope.data
    }

    private func revised<T: Decodable>(_ operation: ErpOperation, tenant: String, id: String) async throws -> Revised<T> {
        let response = try await send(operation, tenant: tenant, path: ["id": id])
        let tag = response.header("ETag")?.trimmingCharacters(in: CharacterSet(charactersIn: "\"W/ "))
        guard let revision = tag.flatMap(Int.init) else { throw ApiError(status: 502, code: nil, message: "Resposta sem revisão") }
        return Revised(value: try decode(response.body), revision: revision)
    }

    private func call<T: Decodable>(_ operation: ErpOperation, tenant: String?, path: [String: String] = [:], query: [(String, String?)] = [],
                                    body: Data? = nil, headers: [String: String] = [:], expect: Set<Int> = [200]) async throws -> T {
        try decode(try await send(operation, tenant: tenant, path: path, query: query, body: body, headers: headers, expect: expect).body)
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ApiError(status: 502, code: nil, message: "Resposta da API em formato inesperado") }
    }

    func send(_ operation: ErpOperation, tenant: String?, path: [String: String] = [:], query: [(String, String?)] = [],
              body: Data? = nil, headers extra: [String: String] = [:], expect: Set<Int> = [200]) async throws -> HttpResponse {
        precondition(!operation.requiresTenant || tenant != nil, "\(operation.id) exige empresa selecionada")
        var headers = ["Accept": "application/json", "Authorization": "Bearer \(try await accessToken())", "X-Request-Id": UUID().uuidString.lowercased()]
        if operation.requiresTenant, let tenant { headers["X-Tenant-Id"] = tenant }
        if body != nil { headers["Content-Type"] = "application/json" }
        headers.merge(extra) { $1 }
        guard let url = URL(string: base.absoluteString + operation.resolve(path: path, query: query)) else {
            throw ApiError(status: 0, code: "config", message: "Endereço inválido")
        }
        let response: HttpResponse
        do { response = try await transport.send(HttpRequest(method: operation.method, url: url, headers: headers, body: body)) }
        catch let error as ApiError { throw error }
        catch { throw ApiError(status: 0, code: "network", message: "Sem conexão com o ERP. Tente novamente") }
        if expect.contains(response.status) { return response }
        let problem = try? JSONDecoder().decode(Problem.self, from: response.body)
        let fallback: String
        switch response.status {
        case 401: fallback = "Sessão expirada. Entre novamente"
        case 403: fallback = "Você não tem permissão para esta ação nesta empresa"
        case 404: fallback = "Registro não encontrado nesta empresa"
        default: fallback = "Não foi possível concluir. Tente novamente"
        }
        throw ApiError(status: response.status, code: problem?.code, message: problem?.title.flatMap { $0.isEmpty ? nil : $0 } ?? fallback)
    }
}
