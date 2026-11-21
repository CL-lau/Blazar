import Foundation
import Security

enum Credentials {
    private struct Pairing: Codable {
        let endpoint: String
        let token: String
    }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.blazar.app.router", kSecAttrAccount as String: "token"]
    }

    static func read(for endpoint: String) -> String {
        var lookup = query
        lookup[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return "" }
        if let pairing = try? JSONDecoder().decode(Pairing.self, from: data) {
            return PairingPayload.credentialApplies(to: endpoint, pairedEndpoint: pairing.endpoint) ? pairing.token : ""
        }
        // Older versions stored the token alone and saved the endpoint in preferences.
        return endpoint.isEmpty ? "" : String(decoding: data, as: UTF8.self)
    }

    static func save(_ token: String, for endpoint: String) throws {
        let data = try JSONEncoder().encode(Pairing(endpoint: endpoint, token: token))
        var entry = query
        entry[kSecValueData as String] = data
        entry[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(entry as CFDictionary, nil)
        let status = added == errSecDuplicateItem
            ? SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            : added
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }
}
