import XCTest
@testable import ErpMobile

private final class FakeTransport: HttpTransport, @unchecked Sendable {
    var requests: [HttpRequest] = []
    let reply: (HttpRequest) -> HttpResponse
    init(_ reply: @escaping (HttpRequest) -> HttpResponse) { self.reply = reply }
    func send(_ request: HttpRequest) async throws -> HttpResponse { requests.append(request); return reply(request) }
}

private func json(_ status: Int, _ body: String, headers: [String: String] = [:]) -> HttpResponse {
    HttpResponse(status: status, headers: headers, body: Data(body.utf8))
}

private func query(_ text: String) -> [String: String] {
    Dictionary(uniqueKeysWithValues: text.split(separator: "&").map {
        let parts = $0.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
        return (parts[0], parts.count > 1 ? parts[1] : "")
    })
}

final class PkceTests: XCTestCase {
    func testChallengeMatchesRfc7636Vector() throws {
        XCTAssertEqual(try Pkce.fromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertThrowsError(try Pkce.fromVerifier("curto"))
        XCTAssertTrue((43...128).contains(Pkce.create().verifier.count))
    }
}

final class OidcClientTests: XCTestCase {
    let metadata = #"{"issuer":"https://auth.example.com","authorization_endpoint":"https://auth.example.com/authorize","token_endpoint":"https://auth.example.com/token","code_challenge_methods_supported":["S256"],"scopes_supported":["openid","offline_access"]}"#

    func client(_ transport: HttpTransport) -> OidcClient {
        OidcClient(issuer: "https://auth.example.com", clientId: "erp-mobile", redirectUri: "com.avilaops.erp:/oauth2redirect", transport: transport) { Date(timeIntervalSince1970: 1_000) }
    }

    func testLoginUsesPkceStateAndPublicClient() async throws {
        let oidc = client(FakeTransport { _ in json(200, self.metadata) })
        let request = try oidc.authorizationRequest(try await oidc.discover(), pkce: try Pkce.fromVerifier(String(repeating: "a", count: 43)), state: "estado")
        let items = query(request.url.query!)
        XCTAssertEqual(items["response_type"], "code")
        XCTAssertEqual(items["client_id"], "erp-mobile")
        XCTAssertEqual(items["code_challenge_method"], "S256")
        XCTAssertEqual(items["scope"], "openid profile email offline_access")
        XCTAssertEqual(items["state"], "estado")
    }

    func testRejectsAuthWithoutS256OrForeignEndpoint() async {
        for body in [metadata.replacingOccurrences(of: "\"S256\"", with: "\"plain\""), metadata.replacingOccurrences(of: "https://auth.example.com/token", with: "https://evil.example.com/token")] {
            do { _ = try await client(FakeTransport { _ in json(200, body) }).discover(); XCTFail("Auth incompatível aceito") } catch {}
        }
    }

    func testCallbackRequiresStateAndExchangesWithVerifier() async throws {
        let transport = FakeTransport { $0.method == "GET" ? json(200, self.metadata) : json(200, #"{"access_token":"at","token_type":"Bearer","expires_in":300,"refresh_token":"rt"}"#) }
        let oidc = client(transport)
        let discovered = try await oidc.discover()
        let pending = try oidc.authorizationRequest(discovered, pkce: try Pkce.fromVerifier(String(repeating: "v", count: 43)), state: "s1")
        XCTAssertThrowsError(try oidc.authorizationCode(callback: URL(string: "com.avilaops.erp:/oauth2redirect?code=c&state=outro")!, pending: pending))
        XCTAssertThrowsError(try oidc.authorizationCode(callback: URL(string: "com.avilaops.erp:/oauth2redirect?error=access_denied&state=s1")!, pending: pending))
        let code = try oidc.authorizationCode(callback: URL(string: "com.avilaops.erp:/oauth2redirect?code=abc&state=s1")!, pending: pending)
        let tokens = try await oidc.exchange(discovered, code: code, pending: pending)
        XCTAssertEqual(tokens, TokenSet(accessToken: "at", refreshToken: "rt", expiresAt: Date(timeIntervalSince1970: 1_300)))
        let form = query(String(data: transport.requests.last!.body!, encoding: .utf8)!)
        XCTAssertEqual(form["code_verifier"], String(repeating: "v", count: 43))
        XCTAssertNil(form["client_secret"])
    }
}

final class ErpApiTests: XCTestCase {
    func api(_ transport: HttpTransport) throws -> ErpApi { try ErpApi(baseUrl: "https://erp.example.com/", transport: transport) { "token" } }

    func testListSendsBearerTenantAndGeneratedOperation() async throws {
        let transport = FakeTransport { _ in json(200, #"{"data":[{"id":"o1","number":"12","customerName":"Ana","amount":"10.50","status":"draft","revision":3}],"total":1,"offset":0,"limit":25}"#) }
        let page = try await api(transport).orders("t1", query: "ana maria", status: "draft")
        let request = transport.requests[0]
        XCTAssertEqual(request.url.absoluteString, "https://erp.example.com/api/v1/orders?q=ana%20maria&status=draft&limit=25")
        XCTAssertEqual(request.headers["Authorization"], "Bearer token")
        XCTAssertEqual(request.headers["X-Tenant-Id"], "t1")
        XCTAssertEqual(page.data[0].amount.value, "10.50")
    }

    func testApprovalUsesIfMatchAndIdempotencyKey() async throws {
        let transport = FakeTransport { _ in json(200, #"{"tenantId":"t1","id":"o1","revision":4,"approved":true}"#) }
        let key = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let result = try await api(transport).approvePricing("t1", id: "o1", revision: 3, reason: "  margem negociada ", idempotencyKey: key)
        let request = transport.requests[0]
        XCTAssertEqual(request.url.path, "/api/v1/orders/o1/pricing/approve")
        XCTAssertEqual(request.headers["If-Match"], "\"3\"")
        XCTAssertEqual(request.headers["Idempotency-Key"], key.uuidString.lowercased())
        XCTAssertEqual(String(data: request.body!, encoding: .utf8), #"{"reason":"margem negociada"}"#)
        XCTAssertEqual(result.revision, 4)
    }

    func testDetailReadsRevisionFromEtagAndNumericAmount() async throws {
        let transport = FakeTransport { _ in json(200, #"{"data":{"id":"o1","number":"1","status":"draft","revision":7,"amount":12},"items":[]}"#, headers: ["Etag": "\"7\""]) }
        let detail = try await api(transport).order("t1", id: "o1")
        XCTAssertEqual(detail.revision, 7)
        XCTAssertEqual(detail.value.data.amount.value, "12")
    }

    func testQuickCustomerSendsOnlyAcceptedFields() async throws {
        let transport = FakeTransport { _ in json(201, #"{"data":{"id":"p1","legalName":"Ana","revision":1}}"#) }
        _ = try await api(transport).createCustomer("t1", input: QuickCustomerInput(personType: .fisica, legalName: "Ana", taxId: "529.982.247-25"), idempotencyKey: UUID())
        let body = try JSONSerialization.jsonObject(with: transport.requests[0].body!) as! [String: Any]
        XCTAssertEqual(Set(body.keys), ["personType", "legalName", "taxId", "isCustomer", "isSupplier", "status"])
        XCTAssertEqual(body["personType"] as? String, "fisica")
    }

    func testProblemJsonBecomesMessageAndCompaniesHaveNoTenant() async throws {
        do {
            _ = try await api(FakeTransport { _ in json(403, #"{"status":403,"code":"forbidden","title":"Acesso não autorizado para esta empresa"}"#) }).me("t1")
            XCTFail("403 aceito")
        } catch let error as ApiError {
            XCTAssertEqual(error.message, "Acesso não autorizado para esta empresa")
            XCTAssertFalse(error.sessionExpired)
        }
        let transport = FakeTransport { _ in json(200, #"{"data":[],"platformAdministrator":false}"#) }
        _ = try await api(transport).companies()
        XCTAssertNil(transport.requests[0].headers["X-Tenant-Id"])
        XCTAssertThrowsError(try ErpApi(baseUrl: "http://erp.example.com", transport: transport) { "t" })
    }

    func testEveryOperationComesFromContractOrDeclaresDependency() {
        XCTAssertTrue(ErpOperations.all.allSatisfy { $0.path.hasPrefix("/api/v1/") })
        XCTAssertEqual(Set(ErpOperations.all.filter { $0.pendingOn != nil }.map(\.id)), ["getApiV1Companies", "postApiV1CompanySelection"])
    }
}
