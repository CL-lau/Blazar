#if os(iOS)
import SwiftUI
import VisionKit

struct PairingScanner: UIViewControllerRepresentable {
    let received: (String) -> Void
    let failed: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(received: received, failed: failed) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false,
            isGuidanceEnabled: true, isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() }
        catch { Task { @MainActor in failed() } }
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        private let received: (String) -> Void
        private let failed: () -> Void
        private var completed = false

        init(received: @escaping (String) -> Void, failed: @escaping () -> Void) {
            self.received = received
            self.failed = failed
        }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
                         allItems: [RecognizedItem]) {
            guard !completed else { return }
            for item in addedItems {
                if case let .barcode(code) = item, let value = code.payloadStringValue {
                    completed = true
                    scanner.stopScanning()
                    received(value)
                    return
                }
            }
        }

        func dataScanner(_ scanner: DataScannerViewController,
                         becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            failed()
        }
    }
}
#endif
