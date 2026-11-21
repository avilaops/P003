import Foundation

struct HttpRequest: Equatable {
    var method: String
    var url: URL
    var headers: [String: String] = [:]
    var body: Data?
}

struct HttpResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

/// Transporte HTTP sem estado. Os testes usam uma implementação falsa; o app usa `URLSessionTransport`.
protocol HttpTransport: Sendable {
    func send(_ request: HttpRequest) async throws -> HttpResponse
}

/// Sessão efêmera: sem cache em disco e sem cookies, como o BFF exige para respostas `no-store`.
final class URLSessionTransport: NSObject, HttpTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func send(_ request: HttpRequest) async throws -> HttpResponse {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        request.headers.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields { headers["\(key)"] = "\(value)" }
        return HttpResponse(status: http.statusCode, headers: headers, body: data)
    }

    // Redirecionamentos não são seguidos (mesma regra do BFF web).
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }
}
