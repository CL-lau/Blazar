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
        if self == .windows { return "/observe \(alias) --windows-json" }
        guard window.isEmpty || window.wholeMatch(of: #/w-[0-9]{1,20}/#) != nil else { return nil }
        let target = window.isEmpty ? alias : "\(alias) --window \(window)"
        if self == .inspect { return "/observe \(target)" }
        guard (1...120).contains(button.utf16.count),
              button.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil else { return nil }
        return "/click \(target) \(button)"
    }
}

struct DesktopControl: View {
    private struct Window: Decodable, Identifiable {
        let id: String
        let title: String
        let accessible: Bool

        var label: String { title.isEmpty ? id : "\(title) · \(id)" }
    }

    let client: RouterClient
    let targets: [RouterSnapshot.DesktopTarget]
    let tasks: [RouterSnapshot.Task]
    @Binding var workspace: String
    @Binding var sending: Bool
    let reload: () async -> Void
    let showError: (Error) -> Void

    @State private var operation: DesktopOperation = .windows
    @State private var alias = ""
    @State private var device = ""
    @State private var window = ""
    @State private var button = ""
    @State private var requestKey = UUID()
    @State private var inventoryId: String?

    private var inventoryTask: RouterSnapshot.Task? {
        tasks.first { $0.id == inventoryId }
    }

    private var windows: [Window]? {
        guard inventoryTask?.status == "succeeded", let result = inventoryTask?.result else { return nil }
        return try? JSONDecoder().decode([Window].self, from: Data(result.utf8))
    }

    private var command: String? {
        operation.command(alias: alias, window: window, button: button)
    }

    private var available: [RouterSnapshot.DesktopTarget] {
        targets.filter { $0.workspace == workspace.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    private var computers: [RouterSnapshot.DesktopTarget] {
        var seen = Set<String>()
        return available.filter { target in
            guard let id = target.deviceId else { return false }
            return seen.insert(id).inserted
        }
    }

    private var targetDevice: String? {
        if computers.count == 1 { return computers.first?.deviceId }
        return computers.contains { $0.deviceId == device } ? device : nil
    }

    private var aliases: [String] {
        available.filter { $0.deviceId == targetDevice }.map(\.alias)
    }

    var body: some View {
        Section("Desktop control") {
            TextField("Workspace", text: $workspace)
            Picker("Operation", selection: $operation) {
                ForEach(DesktopOperation.allCases) { Text($0.rawValue).tag($0) }
            }
            if computers.count > 1 {
                Picker("Computer", selection: $device) {
                    Text("Choose a computer").tag("")
                    ForEach(computers, id: \.deviceId) { target in
                        Text(target.deviceName ?? "Computer").tag(target.deviceId ?? "")
                    }
                }
            }
            if aliases.isEmpty {
                TextField("Configured app alias", text: $alias)
                    .autocorrectionDisabled()
            } else {
                Picker("Application", selection: $alias) {
                    Text("Choose an application").tag("")
                    ForEach(aliases, id: \.self) { Text($0).tag($0) }
                }
            }
            if operation != .windows, let windows, windows.contains(where: \.accessible) {
                Picker("Window", selection: $window) {
                    Text("Active window").tag("")
                    ForEach(windows.filter(\.accessible)) { item in Text(item.label).tag(item.id) }
                }
            } else if operation != .windows {
                TextField("Window ID (optional)", text: $window)
                    .autocorrectionDisabled()
            }
            if operation == .windows, let windows {
                if windows.isEmpty {
                    Text("No visible windows.")
                }
                ForEach(windows) { item in
                    Button(item.label) {
                        operation = .inspect
                        window = item.id
                    }
                    .disabled(!item.accessible)
                }
            } else if operation == .windows, let inventoryTask {
                Text(inventoryTask.status == "failed" ? (inventoryTask.result ?? "Window list unavailable.") : inventoryTask.status)
                    .font(.caption)
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
                let computer = targetDevice
                let listing = operation == .windows
                sending = true
                Task {
                    defer { sending = false }
                    do {
                        let task = try await client.submit(workspace: targetWorkspace, goal: command, key: key, desktopDevice: computer)
                        if listing {
                            inventoryId = task.id
                            window = ""
                        }
                        requestKey = UUID()
                        await reload()
                    } catch {
                        showError(error)
                    }
                }
            }
            .disabled(command == nil || (!aliases.isEmpty && !aliases.contains(alias)) ||
                      (!computers.isEmpty && targetDevice == nil) ||
                      workspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .disabled(sending)
        .onChange(of: command) { _, _ in requestKey = UUID() }
        .onChange(of: workspace) { _, _ in
            requestKey = UUID()
            inventoryId = nil
            window = ""
        }
        .onChange(of: targetDevice) { _, _ in
            requestKey = UUID()
            inventoryId = nil
            window = ""
        }
        .onChange(of: alias) { _, _ in
            inventoryId = nil
            window = ""
        }
        .onChange(of: aliases) { _, next in
            if !next.isEmpty && !next.contains(alias) { alias = "" }
        }
    }
}
