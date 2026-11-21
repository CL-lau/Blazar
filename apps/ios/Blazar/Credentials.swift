import Foundation
import Security

enum Credentials {
    struct Pairing: Codable, Equatable {
        let endpoint: String
        let token: String
    }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.blazar.app.router", kSecAttrAccount as String: "token"]
    }

    static func read(legacyEndpoint: String) -> Pairing? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return decode(data, legacyEndpoint: legacyEndpoint)
    }

    static func decode(_ data: Data, legacyEndpoint: String) -> Pairing? {
        if let pairing = try? JSONDecoder().decode(Pairing.self, from: data) { return pairing }
        // Older versions stored the token alone and saved the endpoint in preferences.
        guard !legacyEndpoint.isEmpty, let token = String(data: data, encoding: .utf8),
              token.wholeMatch(of: #/[A-Za-z0-9_-]{43}/#) != nil else { return nil }
        return Pairing(endpoint: legacyEndpoint, token: token)
    }

    static func save(_ pairing: Pairing) throws {
        let data = try JSONEncoder().encode(pairing)
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
