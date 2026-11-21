import Foundation
import XCTest
@testable import Blazar

final class ClientTests: XCTestCase {
    func testStoredPairingSurvivesStalePreferencesAndReadsLegacyTokens() throws {
        let token = String(repeating: "A", count: 43)
        let pairing = Credentials.Pairing(endpoint: "https://new.example", token: token)
        let legacyEndpoint = "https://old.example"
        XCTAssertEqual(Credentials.decode(try JSONEncoder().encode(pairing), legacyEndpoint: legacyEndpoint), pairing)
        XCTAssertEqual(Credentials.decode(Data(token.utf8), legacyEndpoint: legacyEndpoint)?.endpoint, legacyEndpoint)
        XCTAssertNil(Credentials.decode(Data(token.utf8), legacyEndpoint: ""))
        XCTAssertNil(Credentials.decode(Data("{truncated".utf8), legacyEndpoint: legacyEndpoint))
    }

    func testPairingCredentialMatchesOnlyTheSavedEndpoint() {
        let paired = "https://router.example:8443"
        XCTAssertTrue(PairingPayload.credentialApplies(to: paired, pairedEndpoint: paired))
        XCTAssertFalse(PairingPayload.credentialApplies(to: "https://router.example", pairedEndpoint: paired))
        XCTAssertFalse(PairingPayload.credentialApplies(to: "https://other.example:8443", pairedEndpoint: paired))
        XCTAssertFalse(PairingPayload.credentialApplies(to: "", pairedEndpoint: ""))
    }

    func testPairingAcceptsOnlySupportedSecureOrigins() throws {
        let code = String(repeating: "A", count: 32)
        func payload(_ endpoint: String, _ version: Int = 1) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: ["endpoint": endpoint, "code": code, "v": version])
            return String(decoding: data, as: UTF8.self)
        }
        XCTAssertEqual(PairingPayload.parse(try payload("https://router.example"))?.code, code)
        for endpoint in ["http://router.example", "https://user@router.example", "https://router.example/other",
                         "https://router.example/?redirect=1", "https://router.example/#fragment"] {
            XCTAssertNil(PairingPayload.parse(try payload(endpoint)))
        }
        XCTAssertNil(PairingPayload.parse(try payload("https://router.example", 2)))
    }

    func testOfflineSummaryOmitsProtectedTasksAndResults() throws {
        let snapshot = try JSONDecoder().decode(RouterSnapshot.self, from: Data("""
        {"cursor":3,"tasks":[
          {"id":"ordinary","goal":"Draft notes","status":"succeeded","version":1,"result":"Private result"},
          {"id":"protected","goal":"Restricted goal","status":"running","version":1,"usesAppMemory":true}
        ],"approvals":[],"artifacts":[]}
        """.utf8))
        let client = RouterClient(base: try XCTUnwrap(URL(string: "https://router.example")), token: "fixture-credential")
        let json = try JSONEncoder().encode(OfflineTaskSummary(snapshot: snapshot, client: client))
        let summary = try JSONDecoder().decode(OfflineTaskSummary.self, from: json)
        XCTAssertEqual(summary.tasks.map(\.id), ["ordinary"])
        let contents = String(decoding: json, as: UTF8.self)
        for value in ["Restricted goal", "Private result", "fixture-credential"] {
            XCTAssertFalse(contents.contains(value))
        }
    }

    func testAttachmentReaderRejectsOversizeAndInvalidUTF8() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let notes = directory.appendingPathComponent("notes.txt")
        let large = directory.appendingPathComponent("large.txt")
        let invalid = directory.appendingPathComponent("invalid.txt")
        try Data("Review notes".utf8).write(to: notes)
        try Data(repeating: 97, count: 8_193).write(to: large)
        try Data([0xff]).write(to: invalid)
        let attachment = try XCTUnwrap(TaskTextAttachment.read([notes]).first)
        XCTAssertEqual(attachment.name, "notes.txt")
        XCTAssertEqual(attachment.text, "Review notes")
        XCTAssertThrowsError(try TaskTextAttachment.read([large]))
        XCTAssertThrowsError(try TaskTextAttachment.read([invalid]))
    }
}
