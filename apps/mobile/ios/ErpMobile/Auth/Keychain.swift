import Foundation
import Security

/// O que sobrevive ao fechamento do app: tokens, empresa escolhida e preferência de biometria.
struct StoredSession: Codable, Equatable {
    var tokens: TokenSet
    var tenantId: String?
    var biometricUnlock = false
}

/// Sessão no Keychain, acessível só com o aparelho desbloqueado e sem migrar para outro aparelho.
struct Keychain {
    private let service = "com.avilaops.erp.session"
    private let account = "session"

    func read() -> StoredSession? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        guard let session = try? JSONDecoder().decode(StoredSession.self, from: data) else { clear(); return nil }
        return session
    }

    func write(_ session: StoredSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        if SecItemUpdate(base as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(base.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    func clear() { SecItemDelete(base as CFDictionary) }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
