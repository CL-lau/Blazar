import Foundation
import Security

struct RouterSnapshot: Decodable {
    struct DesktopTarget: Decodable {
        struct Controls: Decodable {
            let buttons: [String]
            let visual: Bool
        }
        let workspace: String
        let alias: String
        let deviceId: String?
        let deviceName: String?
        let accessibility: String?
        let screenRecording: String?
        let controls: Controls?
    }
    struct Task: Decodable, Identifiable {
        let id: String
        let goal: String
        let status: String
        let version: Int
        let result: String?
        let usesAppMemory: Bool?
        let personalMemoryUnavailable: Bool?
        let waitingForPreviousRun: Bool?
        let desktopReconciliationRequired: Bool?
    }
    struct Approval: Decodable, Identifiable {
        let id: String
        let taskId: String
        let version: Int
        let summary: String
    }
    struct Attachment: Decodable, Identifiable {
        let taskId: String
        let position: Int
        let name: String
        let size: Int
        var id: Int { position }
    }
    struct Artifact: Decodable, Identifiable {
        let id: String
        let taskId: String
        let name: String
        let mime: String?
        let expires: Int?
    }
    struct Progress: Decodable {
        let taskId: String
        let message: String
    }
    struct WorkflowStepLink: Decodable {
        let workflowId: String
        let stepKey: String
        let taskId: String
        let predecessorId: String?
    }
    struct Criterion: Decodable {
        let taskId: String
        let criterion: String
    }
    let criteria: [Criterion]?
    let cursor: Int
    let workflowSteps: [WorkflowStepLink]?
    let progress: [Progress]?
    let tasks: [Task]
    let approvals: [Approval]
    let artifacts: [Artifact]
    let attachments: [Attachment]?
    let desktopTargets: [DesktopTarget]?
}

struct TimelinePage: Decodable {
    struct Entry: Decodable, Identifiable {
        struct Details: Decodable {
            let message: String?
            let text: String?
            let summary: String?
            let decision: String?
            let name: String?
            let status: String?
            let waitingReason: String?
            let runId: String?
            let result: String?
            var description: String? { waitingReason == "worker_question" ? result : message ?? text ?? summary ?? decision ?? name ?? status }
        }
        let seq: Int
        let type: String
        let data: Details
        var id: Int { seq }
        var title: String { data.waitingReason == "worker_question" ? "Worker asked a question" : type.replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "_", with: " ").capitalized }
    }
    let events: [Entry]
    let before: Int?
}

struct TaskTextAttachment {
    let name: String
    let text: String

    static func read(_ urls: [URL]) throws -> [Self] {
        let sizeError = RouterError(error: "Choose up to four text files, at most 8 KiB each and 16 KiB total.")
        guard urls.count <= 4 else { throw sizeError }
        var total = 0
        return try urls.map { url in
            let granted = url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var data = Data()
            while let chunk = try handle.read(upToCount: 8_193 - data.count), !chunk.isEmpty {
                data.append(chunk)
                guard data.count <= 8_192 else { throw sizeError }
            }
            total += data.count
            guard total <= 16_384 else { throw sizeError }
            guard let text = String(data: data, encoding: .utf8),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw RouterError(error: "Each attachment must contain non-empty UTF-8 text.")
            }
            return Self(name: url.lastPathComponent, text: text)
        }
    }
}

struct ApplicationWriteSummary: Decodable, Identifiable {
    let id: UUID
    let capability: String
    let workspace: String
    let status: String
    let expires: Double
}

struct ApplicationWriteDetail: Decodable {
    let id: UUID
    let capability: String
    let workspace: String
    let app: String
    let account: String
    let inputPreview: String
    let status: String
    let expires: Double

    var canConfirm: Bool {
        status == "pending" && expires > Date().timeIntervalSince1970 * 1_000
    }
}

struct RouterClient: Equatable {
    let base: URL
    let token: String

    static func pair(base: URL, code: String, name: String) async throws -> RouterClient {
        struct PairingRequest: Decodable { let id: String }
        struct PairingStatus: Decodable { let state: String }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RouterError(error: "Could not generate a device credential.")
        }
        let token = Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let pending = RouterClient(base: base, token: token)
        let deadline = ContinuousClock.now + .seconds(300)
        let data = try await pending.pairingRequest("v1/pairings/redeem",
            body: ["code": code, "name": name, "token": token], deadline: deadline)
        let pairing = try JSONDecoder().decode(PairingRequest.self, from: data)
        repeat {
            let data = try await pending.pairingRequest("v1/pairings/status",
                query: [.init(name: "id", value: pairing.id)], deadline: deadline)
            let status = try JSONDecoder().decode(PairingStatus.self, from: data)
            switch status.state {
            case "approved": return pending
            case "denied": throw RouterError(error: "The desktop denied this pairing.")
            case "pending": try await Task.sleep(for: .seconds(2))
            default: throw RouterError(error: "The Router returned an invalid pairing state.")
            }
        } while ContinuousClock.now < deadline
        throw RouterError(error: "This pairing request expired.")
    }

    private func pairingRequest(_ path: String, body: [String: Any]? = nil, query: [URLQueryItem] = [],
                                deadline: ContinuousClock.Instant) async throws -> Data {
        let transient: Set<URLError.Code> = [.notConnectedToInternet, .networkConnectionLost, .timedOut,
                                             .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]
        while ContinuousClock.now < deadline {
            try Task.checkCancellation()
            do {
                return try await request(path, body: body, query: query)
            } catch let error as URLError where transient.contains(error.code) {
                try await Task.sleep(for: .seconds(2))
            }
        }
        throw RouterError(error: "This pairing request expired.")
    }

    func configurePush(deviceToken: String?) async throws {
        let value: Any = deviceToken.map { $0 as Any } ?? NSNull()
        _ = try await request("v1/mobile/push", body: ["deviceToken": value])
    }

    func applicationWriteProposals() async throws -> [ApplicationWriteSummary] {
        struct Proposals: Decodable { let proposals: [ApplicationWriteSummary] }
        return try JSONDecoder().decode(Proposals.self, from: await request("v1/app-write-proposals")).proposals
    }

    func applicationWriteProposal(_ id: UUID) async throws -> ApplicationWriteDetail {
        try JSONDecoder().decode(ApplicationWriteDetail.self,
                                 from: await request("v1/app-write-proposals/" + id.uuidString.lowercased()))
    }

    func confirmApplicationWrite(_ id: UUID) async throws {
        _ = try await request("v1/app-write-proposals/" + id.uuidString.lowercased() + "/confirm", body: [:])
    }

    func snapshot() async throws -> RouterSnapshot {
        try JSONDecoder().decode(RouterSnapshot.self, from: await request("v1/state"))
    }

    func waitForChange(after cursor: Int) async throws {
        let endpoint = base.appendingPathComponent("v1/stream").appending(queryItems: [
            URLQueryItem(name: "once", value: "1")
        ])
        var request = URLRequest(url: endpoint, timeoutInterval: 35)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue(String(cursor), forHTTPHeaderField: "Last-Event-ID")
        let (bytes, response) = try await URLSession.shared.bytes(for: request, delegate: RejectRedirects())
        guard let http = response as? HTTPURLResponse else {
            throw RouterError(error: "The Router event stream is unavailable.")
        }
        if http.statusCode == 401 || http.statusCode == 403 { throw RouterAccessDenied() }
        if http.statusCode == 409 { return }
        guard http.statusCode == 200, http.mimeType == "text/event-stream" else {
            throw RouterError(error: "The Router event stream is unavailable.")
        }
        for try await line in bytes.lines {
            if line.hasPrefix("id: "), let id = Int(line.dropFirst(4)), id > cursor { return }
        }
    }

    @discardableResult
    func submit(workspace: String, goal: String, key: UUID, desktopDevice: String? = nil,
                attachments: [TaskTextAttachment] = []) async throws -> RouterSnapshot.Task {
        var body: [String: Any] = ["workspace": workspace, "text": goal]
        if !attachments.isEmpty { body["attachments"] = attachments.map { ["name": $0.name, "text": $0.text] } }
        if let desktopDevice { body["desktopDevice"] = desktopDevice }
        let response = try await request("v1/events", body: body, key: key)
        return try JSONDecoder().decode(RouterSnapshot.Task.self, from: response)
    }

    struct WorkflowStep: Codable, Identifiable {
        struct Action: Codable {
            struct WindowSource: Codable {
                let step: String
                let title: String
            }
            let mode: String?
            let windowFrom: WindowSource?
            let kind: String
            let alias: String
            let deviceId: String
            let windowId: String?
            let windowIdentity: String?
            let button: String?
            let expectedText: String?
            let waitSeconds: Int?
        }
        var action: Action? = nil
        var workerProtocols: [String]? = nil
        var workerCapability: String? = nil
        var inputArtifacts: [String: String]? = nil
        var outputArtifact: String? = nil
        var runLimitSeconds: Int? = nil
        let key: String
        let goal: String
        let needs: [String]
        let acceptanceCriteria: [String]?
        let requireReview: Bool?
        var id: String { key }
    }

    struct ConversationReply: Decodable {
        let kind: String
        let text: String?
        let steps: [WorkflowStep]?
        let taskId: String?
        let instruction: String?
        let expectedVersion: Int?
        let proposalKey: String?
    }

    func ask(workspace: String, text: String, key: UUID, usePersonalMemory: Bool = false) async throws -> ConversationReply {
        try JSONDecoder().decode(ConversationReply.self, from: await request(
            "v1/conversation", body: ["workspace": workspace, "text": text, "usePersonalMemory": usePersonalMemory], key: key
        ))
    }

    func createWorkflow(workspace: String, steps: [WorkflowStep], key: UUID, proposalKey: String? = nil) async throws {
        let encoded = try JSONEncoder().encode(steps)
        var body: [String: Any] = ["workspace": workspace, "steps": try JSONSerialization.jsonObject(with: encoded)]
        body["proposalKey"] = proposalKey
        _ = try await request("v1/workflows", body: body, key: key)
    }

    func command(task: RouterSnapshot.Task, action: String, text: String? = nil, approval: String? = nil,
                 key: UUID) async throws {
        var body: [String: Any] = ["action": action, "expectedVersion": task.version]
        body["text"] = text
        body["approvalId"] = approval
        _ = try await request("v1/tasks/\(task.id)/commands", body: body, key: key)
    }

    func sendFollowUp(taskId: String, version: Int, text: String, key: UUID) async throws {
        _ = try await request("v1/tasks/\(taskId)/commands",
                              body: ["action": "append", "expectedVersion": version, "text": text], key: key)
    }

    func timeline(taskId: String, before: Int? = nil) async throws -> TimelinePage {
        let query = before.map { [URLQueryItem(name: "before", value: String($0))] } ?? []
        return try JSONDecoder().decode(TimelinePage.self, from: await request("v1/tasks/\(taskId)/timeline", query: query))
    }

    func artifact(_ artifact: RouterSnapshot.Artifact) async throws -> String {
        String(decoding: try await artifactData(artifact), as: UTF8.self)
    }

    func artifactData(_ artifact: RouterSnapshot.Artifact) async throws -> Data {
        try await request("v1/artifacts/\(artifact.id)")
    }

    func attachment(_ attachment: RouterSnapshot.Attachment) async throws -> String {
        struct Content: Decodable { let text: String }
        let data = try await request("v1/tasks/\(attachment.taskId)/attachments/\(attachment.position)")
        return try JSONDecoder().decode(Content.self, from: data).text
    }

    func compareArtifacts(_ current: RouterSnapshot.Artifact, base: RouterSnapshot.Artifact) async throws -> String {
        struct Comparison: Decodable { let text: String }
        let query = [URLQueryItem(name: "base", value: base.id)]
        return try JSONDecoder().decode(Comparison.self, from: await request(
            "v1/artifacts/\(current.id)/diff", query: query
        )).text
    }

    private func request(_ path: String, body: [String: Any]? = nil, key: UUID? = nil,
                         query: [URLQueryItem] = []) async throws -> Data {
        let endpoint = base.appendingPathComponent(path)
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw RouterError(error: "Invalid Router address.") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(key?.uuidString, forHTTPHeaderField: "Idempotency-Key")
        }
        let (data, response) = try await URLSession.shared.data(for: request, delegate: RejectRedirects())
        if path == "v1/state", let status = (response as? HTTPURLResponse)?.statusCode, status == 401 || status == 403 {
            throw RouterAccessDenied()
        }
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            let error = try? JSONDecoder().decode(RouterError.self, from: data)
            throw error ?? RouterError(error: "The Router request failed.")
        }
        return data
    }
}

struct RouterAccessDenied: LocalizedError {
    var errorDescription: String? { "The Router no longer authorizes this phone. Pair it again from the desktop." }
}

private struct RouterError: Decodable, LocalizedError {
    let error: String
    var errorDescription: String? { error }
}


private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
