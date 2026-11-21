import Foundation
import XCTest
@testable import Blazar

final class RouterReconnectTests: XCTestCase {
    func testReconnectUsesLastSeenCursorAndReloadsAfterHistoryGap() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReconnectFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = RouterClient(base: try XCTUnwrap(URL(string: "https://router.example")),
                                  token: "paired-reconnect", session: session)
        let savedCursor = 12
        try await client.waitForChange(after: savedCursor)
        let snapshot = try await client.snapshot()
        XCTAssertEqual(snapshot.cursor, 31)
        XCTAssertEqual(snapshot.tasks.first?.status, "succeeded")
        try await client.waitForChange(after: snapshot.cursor)
    }

    func testRevokedPairingRejectsBothSnapshotAndEventStream() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ReconnectFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = RouterClient(base: try XCTUnwrap(URL(string: "https://router.example")),
                                  token: "revoked-reconnect", session: session)
        do {
            _ = try await client.snapshot()
            XCTFail("A revoked phone received a snapshot")
        } catch is RouterAccessDenied {}
        do {
            try await client.waitForChange(after: 12)
            XCTFail("A revoked phone opened the event stream")
        } catch is RouterAccessDenied {}
    }
}

private final class ReconnectFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, url.scheme == "https", url.host == "router.example",
              request.httpMethod == "GET" else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        switch (request.value(forHTTPHeaderField: "Authorization"), url.path) {
        case ("Bearer revoked-reconnect", "/v1/state"), ("Bearer revoked-reconnect", "/v1/stream"):
            send(url, status: 401, type: "application/json", body: "{}")
        case ("Bearer paired-reconnect", "/v1/state"):
            send(url, status: 200, type: "application/json", body: """
                {"cursor":31,"tasks":[{"id":"task","goal":"Review","status":"succeeded","version":1}],"approvals":[],"artifacts":[]}
                """)
        case ("Bearer paired-reconnect", "/v1/stream"):
            guard url.query == "once=1", request.value(forHTTPHeaderField: "Accept") == "text/event-stream" else {
                client?.urlProtocol(self, didFailWithError: URLError(.badURL))
                return
            }
            switch request.value(forHTTPHeaderField: "Last-Event-ID") {
            case "12": send(url, status: 409, type: "application/json", body: "{}")
            case "31": send(url, status: 200, type: "text/event-stream", body: "id: 32\ndata: {}\n\n")
            default: client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            }
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired))
        }
    }

    private func send(_ url: URL, status: Int, type: String, body: String) {
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": type]) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
