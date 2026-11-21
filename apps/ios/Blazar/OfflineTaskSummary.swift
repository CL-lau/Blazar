import CryptoKit
import Foundation

struct OfflineTaskSummary: Codable {
    struct Task: Codable, Identifiable {
        let id: String
        let goal: String
        let status: String
    }

    let synchronizedAt: Date
    let tasks: [Task]
    private let scope: String

    init(snapshot: RouterSnapshot, client: RouterClient) {
        synchronizedAt = Date()
        scope = Self.scope(for: client)
        tasks = snapshot.tasks.filter { $0.usesAppMemory != true }.map {
            Task(id: $0.id, goal: $0.goal, status: $0.status)
        }
    }

    static func read(for client: RouterClient) -> Self? {
        guard let file = location, let data = try? Data(contentsOf: file),
              let summary = try? JSONDecoder().decode(Self.self, from: data),
              summary.scope == scope(for: client) else { return nil }
        return summary
    }

    func save() {
        guard let file = Self.location else { return }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(self)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: file, options: .atomic)
            #endif
        } catch {
            // The cache is optional. The live snapshot is still available.
        }
    }

    static func clear() {
        if let file = location { try? FileManager.default.removeItem(at: file) }
    }

    private static var location: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("com.blazar.app", isDirectory: true)
            .appendingPathComponent("offline-tasks-v1.json")
    }

    private static func scope(for client: RouterClient) -> String {
        SHA256.hash(data: Data((client.base.absoluteString + "\n" + client.token).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}
