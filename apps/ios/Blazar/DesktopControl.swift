import SwiftUI

enum DesktopOperation: String, CaseIterable, Identifiable {
    case windows = "List windows"
    case inspect = "Inspect"
    case click = "Click button"

    var id: Self { self }

    func command(alias rawAlias: String, window rawWindow: String, button rawButton: String) -> String? {
        let alias = rawAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        let window = rawWindow.trimmingCharacters(in: .whitespacesAndNewlines)
        let button = rawButton.trimmingCharacters(in: .whitespacesAndNewlines)
        guard alias.wholeMatch(of: #/[a-z0-9_-]{1,32}/#) != nil else { return nil }
        if self == .windows { return "/observe \(alias) --windows" }
        guard window.isEmpty || window.wholeMatch(of: #/w-[0-9]{1,20}/#) != nil else { return nil }
        let target = window.isEmpty ? alias : "\(alias) --window \(window)"
        if self == .inspect { return "/observe \(target)" }
        guard (1...120).contains(button.utf16.count),
              button.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil else { return nil }
        return "/click \(target) \(button)"
    }
}

struct DesktopControl: View {
    let client: RouterClient
    @Binding var workspace: String
    @Binding var sending: Bool
    let reload: () async -> Void
    let showError: (Error) -> Void

    @State private var operation: DesktopOperation = .windows
    @State private var alias = ""
    @State private var window = ""
    @State private var button = ""
    @State private var requestKey = UUID()

    private var command: String? {
        operation.command(alias: alias, window: window, button: button)
    }

    var body: some View {
        Section("Desktop control") {
            TextField("Workspace", text: $workspace)
            Picker("Operation", selection: $operation) {
                ForEach(DesktopOperation.allCases) { Text($0.rawValue).tag($0) }
            }
            TextField("Configured app alias", text: $alias)
                .autocorrectionDisabled()
            if operation != .windows {
                TextField("Window ID (optional)", text: $window)
                    .autocorrectionDisabled()
            }
            if operation == .click {
                TextField("Configured button label", text: $button)
                Text("Blazar will ask for approval before clicking.")
                    .font(.caption)
            }
            Button(operation.rawValue) {
                guard let command else { return }
                let targetWorkspace = workspace
                let key = requestKey
                sending = true
                Task {
                    defer { sending = false }
                    do {
                        try await client.submit(workspace: targetWorkspace, goal: command, key: key)
                        requestKey = UUID()
                        await reload()
                    } catch {
                        showError(error)
                    }
                }
            }
            .disabled(command == nil || workspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .disabled(sending)
        .onChange(of: command) { _, _ in requestKey = UUID() }
        .onChange(of: workspace) { _, _ in requestKey = UUID() }
    }
}
