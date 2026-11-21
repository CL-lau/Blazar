import Foundation

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
    }
    struct Approval: Decodable, Identifiable {
        let id: String
        let taskId: String
        let version: Int
        let summary: String
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
            var description: String? { message ?? text ?? summary ?? decision ?? name ?? status }
        }
        let seq: Int
        let type: String
        let data: Details
        var id: Int { seq }
        var title: String { type.replacingOccurrences(of: ".", with: " ").replacingOccurrences(of: "_", with: " ").capitalized }
    }
    let events: [Entry]
    let before: Int?
}

struct RouterClient: Equatable {
    let base: URL
    let token: String

    static func pair(base: URL, code: String, name: String) async throws -> RouterClient {
        struct Registration: Decodable { let token: String }
        let pending = RouterClient(base: base, token: "")
        let bytes = try await pending.request("v1/pairings/redeem", body: ["code": code, "name": name])
        return RouterClient(base: base, token: try JSONDecoder().decode(Registration.self, from: bytes).token)
    }

    func configurePush(deviceToken: String?) async throws {
        let value: Any = deviceToken.map { $0 as Any } ?? NSNull()
        _ = try await request("v1/mobile/push", body: ["deviceToken": value])
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
        if http.statusCode == 409 { return }
        guard http.statusCode == 200, http.mimeType == "text/event-stream" else {
            throw RouterError(error: "The Router event stream is unavailable.")
        }
        for try await line in bytes.lines {
            if line.hasPrefix("id: "), let id = Int(line.dropFirst(4)), id > cursor { return }
        }
    }

    @discardableResult
    func submit(workspace: String, goal: String, key: UUID, desktopDevice: String? = nil) async throws -> RouterSnapshot.Task {
        var body = ["workspace": workspace, "text": goal]
        if let desktopDevice { body["desktopDevice"] = desktopDevice }
        let response = try await request("v1/events", body: body, key: key)
        return try JSONDecoder().decode(RouterSnapshot.Task.self, from: response)
    }

    struct WorkflowStep: Codable, Identifiable {
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
    }

    func ask(workspace: String, text: String, key: UUID, usePersonalMemory: Bool = false) async throws -> ConversationReply {
        try JSONDecoder().decode(ConversationReply.self, from: await request(
            "v1/conversation", body: ["workspace": workspace, "text": text, "usePersonalMemory": usePersonalMemory], key: key
        ))
    }

    func createWorkflow(workspace: String, steps: [WorkflowStep], key: UUID) async throws {
        let encoded = try JSONEncoder().encode(steps)
        let body = ["workspace": workspace, "steps": try JSONSerialization.jsonObject(with: encoded)]
        _ = try await request("v1/workflows", body: body, key: key)
    }

    func command(task: RouterSnapshot.Task, action: String, text: String? = nil, approval: String? = nil) async throws {
        var body: [String: Any] = ["action": action, "expectedVersion": task.version]
        body["text"] = text
        body["approvalId"] = approval
        _ = try await request("v1/tasks/\(task.id)/commands", body: body, key: UUID())
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
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            let error = try? JSONDecoder().decode(RouterError.self, from: data)
            throw error ?? RouterError(error: "The Router request failed.")
        }
        return data
    }
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
