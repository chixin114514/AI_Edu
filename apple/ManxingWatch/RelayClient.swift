import Foundation

struct PairReply: Decodable {
    let token: String
    let expires_at: Double
}
struct RelayFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}
// Never follow a redirect with a device bearer token or health data.
final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
final class RelayClient {
    private let origin: URL
    private let session: URLSession
    init(address: String) throws {
        guard let parts = URLComponents(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let url = parts.url else {
            throw RelayFailure(status: 0, message: "请输入网页显示的HTTPS地址，不要带路径或账号密码。")
        }
        origin = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 12
        // Default system TLS trust evaluation; no certificate bypass.
        session = URLSession(configuration: configuration, delegate: NoRedirect(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    func post(_ path: String, body: [String: Any], token: String? = nil) async throws -> Data {
        var request = URLRequest(url: origin.appendingPathComponent("api/watch/" + path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RelayFailure(status: 0, message: "服务器响应无效")
        }
        guard (200..<300).contains(http.statusCode) else {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw RelayFailure(status: http.statusCode, message: json?["error"] as? String ?? "连接失败，请检查HTTPS地址与证书。")
        }
        return data
    }
}
