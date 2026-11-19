import Foundation

struct AuthError: Error, LocalizedError, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct OidcMetadata: Decodable, Equatable {
    let issuer: String
    let authorizationEndpoint: String
    let tokenEndpoint: String
    let codeChallengeMethodsSupported: [String]?
    let scopesSupported: [String]?

    enum CodingKeys: String, CodingKey {
        case issuer
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case codeChallengeMethodsSupported = "code_challenge_methods_supported"
        case scopesSupported = "scopes_supported"
    }
}

struct TokenSet: Codable, Equatable {
    let accessToken: String
    let refreshToken: String?
    let expiresAt: Date
    func expires(within margin: TimeInterval = 60, now: Date = Date()) -> Bool { now.addingTimeInterval(margin) >= expiresAt }
}

/// Pedido de login em andamento: guardado só na memória do processo até o retorno do navegador.
struct AuthorizationRequest: Equatable { let url: URL; let state: String; let pkce: Pkce }

/// Cliente OIDC público (sem segredo) com PKCE S256, no mesmo Auth do ERP web.
/// As mesmas validações do BFF web: issuer exato, S256 obrigatório e endpoints na origem do issuer.
struct OidcClient: Sendable {
    let issuer: String
    let clientId: String
    let redirectUri: String
    let transport: HttpTransport
    let now: @Sendable () -> Date

    init(issuer: String, clientId: String, redirectUri: String, transport: HttpTransport, now: @escaping @Sendable () -> Date = { Date() }) {
        self.issuer = URL(string: issuer).map(Self.origin) ?? issuer
        self.clientId = clientId
        self.redirectUri = redirectUri
        self.transport = transport
        self.now = now
    }

    static func origin(_ url: URL) -> String { "\(url.scheme ?? "")://\(url.host ?? "")\(url.port.map { ":\($0)" } ?? "")" }

    func discover() async throws -> OidcMetadata {
        guard let url = URL(string: "\(issuer)/.well-known/openid-configuration") else { throw AuthError("Auth não configurado") }
        let response = try await transport.send(HttpRequest(method: "GET", url: url, headers: ["Accept": "application/json"]))
        guard response.status == 200 else { throw AuthError("Serviço de autenticação indisponível") }
        guard let metadata = try? JSONDecoder().decode(OidcMetadata.self, from: response.body),
              metadata.issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
              metadata.codeChallengeMethodsSupported?.contains("S256") == true else { throw AuthError("Contrato do Auth incompatível") }
        for endpoint in [metadata.authorizationEndpoint, metadata.tokenEndpoint] {
            guard let parsed = URL(string: endpoint), parsed.scheme == "https", Self.origin(parsed) == issuer,
                  parsed.user == nil, parsed.fragment == nil else { throw AuthError("Endpoint do Auth inválido") }
        }
        return metadata
    }

    func authorizationRequest(_ metadata: OidcMetadata, pkce: Pkce = .create(), state: String = Pkce.randomToken()) throws -> AuthorizationRequest {
        var scopes = ["openid", "profile", "email"]
        if metadata.scopesSupported?.contains("offline_access") == true { scopes.append("offline_access") }
        guard var components = URLComponents(string: metadata.authorizationEndpoint) else { throw AuthError("Endpoint do Auth inválido") }
        components.percentEncodedQueryItems = (components.percentEncodedQueryItems ?? []) + [
            ("response_type", "code"), ("client_id", clientId), ("redirect_uri", redirectUri), ("scope", scopes.joined(separator: " ")),
            ("state", state), ("code_challenge", pkce.challenge), ("code_challenge_method", "S256"),
        ].map { URLQueryItem(name: $0.0, value: ErpOperation.encode($0.1)) }
        guard let url = components.url else { throw AuthError("Endpoint do Auth inválido") }
        return AuthorizationRequest(url: url, state: state, pkce: pkce)
    }

    /// Valida o retorno do navegador e devolve o código de autorização.
    func authorizationCode(callback: URL, pending: AuthorizationRequest) throws -> String {
        guard callback.absoluteString.hasPrefix(redirectUri) else { throw AuthError("Retorno de login inesperado") }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("state") == pending.state else { throw AuthError("Retorno de login inválido. Entre novamente") }
        if let error = value("error") { throw AuthError(error == "access_denied" ? "Login cancelado" : "O Auth recusou o login") }
        guard let code = value("code"), !code.isEmpty else { throw AuthError("Retorno de login sem código") }
        return code
    }

    func exchange(_ metadata: OidcMetadata, code: String, pending: AuthorizationRequest) async throws -> TokenSet {
        try await token(metadata, form: [("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirectUri),
                                         ("client_id", clientId), ("code_verifier", pending.pkce.verifier)], previousRefresh: nil)
    }

    func refresh(_ metadata: OidcMetadata, refreshToken: String) async throws -> TokenSet {
        try await token(metadata, form: [("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("client_id", clientId)], previousRefresh: refreshToken)
    }

    static func form(_ pairs: [(String, String)]) -> String { pairs.map { "\(ErpOperation.encode($0.0))=\(ErpOperation.encode($0.1))" }.joined(separator: "&") }

    private struct TokenResponse: Decodable {
        let access_token: String
        let token_type: String
        let expires_in: Double
        let refresh_token: String?
    }

    private func token(_ metadata: OidcMetadata, form pairs: [(String, String)], previousRefresh: String?) async throws -> TokenSet {
        guard let url = URL(string: metadata.tokenEndpoint) else { throw AuthError("Endpoint do Auth inválido") }
        let response = try await transport.send(HttpRequest(method: "POST", url: url, headers: [
            "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
        ], body: Data(Self.form(pairs).utf8)))
        if response.status == 400 || response.status == 401 { throw AuthError("Sessão expirada. Entre novamente") }
        guard response.status == 200 else { throw AuthError("Serviço de autenticação indisponível") }
        guard let token = try? JSONDecoder().decode(TokenResponse.self, from: response.body),
              token.token_type.lowercased() == "bearer", !token.access_token.isEmpty, token.expires_in > 0 else { throw AuthError("Resposta do Auth inválida") }
        return TokenSet(accessToken: token.access_token, refreshToken: token.refresh_token ?? previousRefresh, expiresAt: now().addingTimeInterval(token.expires_in))
    }
}
