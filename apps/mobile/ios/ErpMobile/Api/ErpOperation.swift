import Foundation

/// Operação do contrato OpenAPI do api-ts. As instâncias são geradas em `ErpOperations`.
struct ErpOperation: Equatable {
    let id: String
    let method: String
    let path: String
    let pathParameters: [String]
    let queryParameters: [String]
    let requiresTenant: Bool
    /// Preenchido quando a rota ainda não está no contrato TypeScript; descreve a dependência.
    let pendingOn: String?

    /// Monta caminho e consulta. Parâmetros de caminho são obrigatórios e codificados; consultas vazias são omitidas.
    func resolve(path values: [String: String] = [:], query: [(String, String?)] = []) -> String {
        precondition(Set(values.keys) == Set(pathParameters), "Parâmetros de caminho de \(id): esperados \(pathParameters)")
        var resolved = path
        for (name, value) in values {
            precondition(!value.isEmpty, "Parâmetro \(name) vazio")
            resolved = resolved.replacingOccurrences(of: "{\(name)}", with: Self.encode(value))
        }
        let pairs = query.compactMap { key, value in value.flatMap { $0.isEmpty ? nil : "\(Self.encode(key))=\(Self.encode($0))" } }
        return pairs.isEmpty ? resolved : resolved + "?" + pairs.joined(separator: "&")
    }

    static func encode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
