import Foundation

struct PairingPayload: Decodable {
    let v: Int
    let endpoint: String
    let code: String

    static func credentialApplies(to endpoint: String, pairedEndpoint: String) -> Bool {
        !pairedEndpoint.isEmpty && endpoint == pairedEndpoint
    }

    static func parse(_ value: String) -> PairingPayload? {
        guard value.utf8.count <= 1024,
              let payload = try? JSONDecoder().decode(Self.self, from: Data(value.utf8)),
              payload.v == 1,
              payload.code.range(of: "^[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil,
              let parts = URLComponents(string: payload.endpoint), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/"
        else { return nil }
        return payload
    }
}
