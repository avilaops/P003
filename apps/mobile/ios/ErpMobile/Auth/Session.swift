import AuthenticationServices
import Foundation
import LocalAuthentication
import UIKit

struct AppConfig {
    let apiBaseUrl: String
    let issuer: String
    let clientId: String
    let redirectUri = "com.avilaops.erp:/oauth2redirect"
    let callbackScheme = "com.avilaops.erp"

    static let current: AppConfig = {
        let info = Bundle.main.infoDictionary ?? [:]
        return AppConfig(apiBaseUrl: info["ERPApiBaseURL"] as? String ?? "", issuer: info["ERPAuthIssuer"] as? String ?? "",
                         clientId: info["ERPAuthClientID"] as? String ?? "")
    }()
}

enum SessionState: Equatable {
    case unconfigured
    case loading
    case signedOut(String?)
    case locked
    case choosingCompany([CompanySummary], String?)
    case ready(AccessProfile)
}

/// Executa chamadas da API com o token válido e a empresa ativa.
@MainActor
protocol ApiRunner: AnyObject {
    func call<T>(_ block: (ErpApi, String) async throws -> T) async throws -> T
}

/// Sessão do app: login OIDC + PKCE, renovação do token, empresa ativa e bloqueio por biometria.
@MainActor
final class Session: NSObject, ObservableObject, ApiRunner {
    @Published private(set) var state: SessionState = .loading
    @Published private(set) var biometricUnlock = false

    private let config = AppConfig.current
    private let keychain = Keychain()
    private let transport = URLSessionTransport()
    private lazy var oidc = OidcClient(issuer: config.issuer, clientId: config.clientId, redirectUri: config.redirectUri, transport: transport)
    private var api: ErpApi?
    private var metadata: OidcMetadata?
    private var stored: StoredSession?
    private var refreshing: Task<TokenSet, Error>?
    private var authSession: ASWebAuthenticationSession?

    override init() {
        super.init()
        api = try? ErpApi(baseUrl: config.apiBaseUrl, transport: transport) { [weak self] in
            guard let self else { throw ApiError(status: 401, code: "missing_token", message: "Entre novamente") }
            return try await self.validAccessToken()
        }
        guard api != nil else { state = .unconfigured; return }
        stored = keychain.read()
        biometricUnlock = stored?.biometricUnlock ?? false
        if stored == nil { state = .signedOut(nil) }
        else if biometricUnlock { state = .locked }
        else { Task { await resume() } }
    }

    // MARK: Login

    /// Login no navegador do sistema (ASWebAuthenticationSession): a senha nunca passa pelo app.
    func login() {
        Task {
            do {
                let discovered = try await discoveredMetadata()
                let request = try oidc.authorizationRequest(discovered)
                let callback = try await browser(request.url)
                state = .loading
                let code = try oidc.authorizationCode(callback: callback, pending: request)
                let tokens = try await oidc.exchange(discovered, code: code, pending: request)
                save(StoredSession(tokens: tokens, tenantId: stored?.tenantId, biometricUnlock: biometricUnlock))
                await resume()
            } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                state = .signedOut(nil)
            } catch {
                state = .signedOut(Self.message(error, fallback: "Sem conexão com o Auth. Tente novamente"))
            }
        }
    }

    func unlock() {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Desbloquear a sessão do ERP") { success, _ in
            Task { @MainActor in if success { self.state = .loading; await self.resume() } }
        }
    }

    var biometricAvailable: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) }

    func setBiometricUnlock(_ enabled: Bool) {
        guard var current = stored else { return }
        current.biometricUnlock = enabled
        save(current)
    }

    func choose(_ company: CompanySummary) {
        state = .loading
        Task {
            do {
                try await authorized { try await $0.selectCompany(company.id) }
                if var current = stored { current.tenantId = company.id; save(current) }
                await resume()
            } catch { handle(error) }
        }
    }

    func switchCompany() {
        if var current = stored { current.tenantId = nil; save(current) }
        state = .loading
        Task { await resume() }
    }

    func signOut(_ message: String? = nil) {
        stored = nil
        keychain.clear()
        state = .signedOut(message)
    }

    func call<T>(_ block: (ErpApi, String) async throws -> T) async throws -> T {
        guard let tenant = stored?.tenantId else { throw ApiError(status: 403, code: "tenant", message: "Escolha uma empresa") }
        do { return try await authorized { try await block($0, tenant) } }
        catch let error as ApiError where error.sessionExpired { signOut(error.message); throw error }
    }

    // MARK: Interno

    private func resume() async {
        do {
            if let tenant = stored?.tenantId {
                state = .ready(try await authorized { try await $0.me(tenant) })
                return
            }
            let active = try await authorized { try await $0.companies() }.data.filter { $0.status == "active" }
            switch active.count {
            case 1: choose(active[0])
            case 0: state = .choosingCompany([], "Nenhuma empresa ativa para este usuário. Cadastre a empresa no ERP web")
            default: state = .choosingCompany(active, nil)
            }
        } catch { handle(error) }
    }

    private func handle(_ error: Error) {
        let message = Self.message(error, fallback: "Não foi possível concluir. Tente novamente")
        if let api = error as? ApiError, api.sessionExpired { return signOut(message) }
        if let api = error as? ApiError, api.status == 403, var current = stored, current.tenantId != nil {
            current.tenantId = nil
            save(current)
            state = .choosingCompany([], message)
            Task { await resume() }
            return
        }
        if case .choosingCompany(let companies, _) = state { state = .choosingCompany(companies, message) } else { state = .signedOut(message) }
    }

    private func authorized<T>(_ block: (ErpApi) async throws -> T) async throws -> T {
        guard let api else { throw ApiError(status: 0, code: "unconfigured", message: "API não configurada") }
        return try await block(api)
    }

    /// Renova o token antes de expirar; chamadas simultâneas aguardam a mesma renovação.
    private func validAccessToken() async throws -> String {
        guard let current = stored else { throw ApiError(status: 401, code: "missing_token", message: "Entre novamente") }
        if !current.tokens.expires() { return current.tokens.accessToken }
        guard let refresh = current.tokens.refreshToken else { throw ApiError(status: 401, code: "expired", message: "Sessão expirada. Entre novamente") }
        let task = refreshing ?? Task { [oidc] in
            let discovered = try await self.discoveredMetadata()
            return try await oidc.refresh(discovered, refreshToken: refresh)
        }
        refreshing = task
        defer { refreshing = nil }
        do {
            let renewed = try await task.value
            if var latest = stored { latest.tokens = renewed; save(latest) }
            return renewed.accessToken
        } catch let error as AuthError {
            throw ApiError(status: 401, code: "expired", message: error.message)
        } catch {
            throw ApiError(status: 0, code: "network", message: "Sem conexão com o Auth. Tente novamente")
        }
    }

    private func discoveredMetadata() async throws -> OidcMetadata {
        if let metadata { return metadata }
        let discovered = try await oidc.discover()
        metadata = discovered
        return discovered
    }

    private func browser(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: config.callbackScheme) { callback, error in
                if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: error ?? AuthError("Login cancelado")) }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            authSession = session
            session.start()
        }
    }

    private func save(_ next: StoredSession) {
        stored = next
        biometricUnlock = next.biometricUnlock
        keychain.write(next)
    }

    private static func message(_ error: Error, fallback: String) -> String {
        (error as? LocalizedError)?.errorDescription ?? fallback
    }
}

extension Session: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
