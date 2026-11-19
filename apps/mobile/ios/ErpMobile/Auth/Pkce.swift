import CryptoKit
import Foundation

/// PKCE S256 (RFC 7636). O verificador nunca sai do aparelho; só o desafio vai para o Auth.
struct Pkce: Equatable {
    let verifier: String
    let challenge: String

    static func create() -> Pkce { try! fromVerifier(randomToken(bytes: 64)) }

    static func fromVerifier(_ verifier: String) throws -> Pkce {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard (43...128).contains(verifier.count), verifier.unicodeScalars.allSatisfy({ allowed.contains($0) && $0.isASCII }) else {
            throw AuthError("Verificador PKCE inválido")
        }
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Pkce(verifier: verifier, challenge: base64url(Data(digest)))
    }

    /// Texto aleatório url-safe com `bytes` bytes de entropia (gerador seguro do sistema).
    static func randomToken(bytes: Int = 32) -> String {
        var data = Data(count: bytes)
        let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        precondition(status == errSecSuccess, "Gerador aleatório indisponível")
        return base64url(data)
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
