import Foundation
import XCTest
@testable import Blazar

final class ApplicationWriteTests: XCTestCase {
    func testSharedWriteReviewAndExplicitConfirmationUsePairedCredential() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ApprovalFixture.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = RouterClient(base: try XCTUnwrap(URL(string: "https://router.example")),
                                  token: "paired-fixture", session: session)
        let proposals = try await client.applicationWriteProposals()
        let summary = try XCTUnwrap(proposals.first)
        XCTAssertEqual(summary.workspace, "project")
        let review = try await client.applicationWriteProposal(summary.id)
        XCTAssertEqual(review.account, "Fixture")
        XCTAssertEqual(review.inputPreview, "{\"title\":\"Approved\"}")
        XCTAssertTrue(review.canConfirm)
        try await client.confirmApplicationWrite(summary.id)
    }
}

private final class ApprovalFixture: URLProtocol {
    private static let id = "df444855-bbd7-4614-bbef-7ef26e17a3ae"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, url.scheme == "https", url.host == "router.example",
              request.value(forHTTPHeaderField: "Authorization") == "Bearer paired-fixture" else {
            client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired))
            return
        }
        let path = "/v1/app-write-proposals"
        let row: [String: Any] = ["id": Self.id, "capability": "action.document.update", "workspace": "project",
                                  "status": "pending", "expires": 4_102_444_800_000.0]
        let body: [String: Any]
        switch (request.httpMethod, url.path) {
        case ("GET", path):
            body = ["proposals": [row]]
        case ("GET", path + "/" + Self.id):
            body = row.merging(["app": "mcp", "account": "Fixture", "inputPreview": "{\"title\":\"Approved\"}"],
                               uniquingKeysWith: { _, latest in latest })
        case ("POST", path + "/" + Self.id + "/confirm"):
            body = ["status": "succeeded"]
        default:
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        do {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                                        headerFields: ["Content-Type": "application/json"]))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
