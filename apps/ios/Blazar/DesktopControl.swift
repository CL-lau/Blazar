import SwiftUI

enum DesktopOperation: String, CaseIterable, Identifiable {
    case windows = "List windows"
    case inspect = "Inspect"
    case visual = "View window image"
    case click = "Click button"

    var id: Self { self }

    func command(alias rawAlias: String, window rawWindow: String, button rawButton: String,
                 identity: String? = nil) -> String? {
        let alias = rawAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        let window = rawWindow.trimmingCharacters(in: .whitespacesAndNewlines)
        let button = rawButton.trimmingCharacters(in: .whitespacesAndNewlines)
        guard alias.wholeMatch(of: #/[a-z0-9_-]{1,32}/#) != nil else { return nil }
        if self == .windows { return "/observe \(alias) --windows-json" }
        guard window.isEmpty || window.wholeMatch(of: #/w-[0-9]{1,20}/#) != nil else { return nil }
        var target = window.isEmpty ? alias : "\(alias) --window \(window)"
        if let identity {
            guard !window.isEmpty, identity.wholeMatch(of: #/[a-f0-9]{64}/#) != nil else { return nil }
            target += " --instance \(identity)"
        }
        if self == .inspect { return "/observe \(target)" }
        if self == .visual { return identity == nil ? nil : "/observe \(target) --visual" }
        guard (1...120).contains(button.utf16.count),
              button.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil else { return nil }
        return "/click \(target) \(button)"
    }
}

struct DesktopControl: View {
    private struct Target: Equatable {
        let workspace: String
        let device: String?
        let alias: String
    }

    private struct Inventory {
        let taskId: String
        let target: Target
    }

    private struct Window: Decodable, Identifiable {
        let id: String
        let title: String
        let accessible: Bool
        let identity: String?

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
    @State private var targetGeneration = UUID()
    @State private var inventory: Inventory?

    private var target: Target {
        Target(workspace: workspace.trimmingCharacters(in: .whitespacesAndNewlines),
               device: targetDevice, alias: alias)
    }

    private var inventoryTask: RouterSnapshot.Task? {
        guard let inventory, inventory.target == target else { return nil }
        return tasks.first { $0.id == inventory.taskId }
    }

    private var windows: [Window]? {
        guard inventoryTask?.status == "succeeded", let result = inventoryTask?.result else { return nil }
        return try? JSONDecoder().decode([Window].self, from: Data(result.utf8))
    }

    private var command: String? {
        if operation != .windows, !window.isEmpty, let inventory, inventory.target != target { return nil }
        if operation == .visual && appControls?.visual == false { return nil }
        if operation == .click, let appControls, !appControls.buttons.contains(button) { return nil }
        let identity = windows?.first { $0.id == window }?.identity
        return operation.command(alias: alias, window: window, button: button, identity: identity)
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

    private var selectedComputer: RouterSnapshot.DesktopTarget? {
        computers.first { $0.deviceId == targetDevice }
    }

    private var appControls: RouterSnapshot.DesktopTarget.Controls? {
        available.first { $0.deviceId == targetDevice && $0.alias == alias }?.controls
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
            if operation != .windows, let windows, windows.contains(where: { operation == .visual ? $0.identity != nil : $0.accessible }) {
                Picker("Window", selection: $window) {
                    Text(operation == .visual ? "Choose a window" : "Active window").tag("")
                    ForEach(windows.filter { operation == .visual ? $0.identity != nil : $0.accessible }) { item in Text(item.label).tag(item.id) }
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
                        operation = item.accessible ? .inspect : .visual
                        window = item.id
                    }
                    .disabled(!item.accessible && item.identity == nil)
                }
            } else if operation == .windows, let inventoryTask {
                Text(inventoryTask.status == "failed" ? (inventoryTask.result ?? "Window list unavailable.") : inventoryTask.status)
                    .font(.caption)
            }
            if operation == .click {
                if let appControls {
                    if appControls.buttons.isEmpty {
                        Text("No buttons are configured for this application.").font(.caption)
                    } else {
                        Picker("Button", selection: $button) {
                            Text("Choose a button").tag("")
                            ForEach(appControls.buttons, id: \.self) { Text($0).tag($0) }
                        }
                    }
                } else {
                    TextField("Configured button label", text: $button)
                }
                Text("Blazar will ask for approval before clicking.")
                    .font(.caption)
            }
            if operation == .visual && appControls?.visual == false {
                Text("Window images are disabled for this application.").font(.caption)
            } else if operation == .visual && selectedComputer?.screenRecording == "denied" {
                Text("Screen Recording is disabled on the selected computer.").font(.caption)
            } else if (operation == .inspect || operation == .click) && selectedComputer?.accessibility == "denied" {
                Text("Accessibility is disabled on the selected computer.").font(.caption)
            }
            Button(operation.rawValue) {
                guard let command else { return }
                let submittedTarget = target
                let submittedGeneration = targetGeneration
                let key = requestKey
                let listing = operation == .windows
                sending = true
                Task {
                    defer { sending = false }
                    do {
                        let task = try await client.submit(workspace: submittedTarget.workspace, goal: command, key: key,
                                                           desktopDevice: submittedTarget.device)
                        guard submittedGeneration == targetGeneration else { return }
                        if listing {
                            inventory = Inventory(taskId: task.id, target: submittedTarget)
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
        .onChange(of: target) { previous, updated in
            targetGeneration = UUID()
            requestKey = UUID()
            inventory = nil
            window = ""
            if previous.alias != updated.alias || previous.device != updated.device {
                button = ""
            }
        }
        .onChange(of: appControls?.buttons) { _, next in
            if let next, !next.contains(button) { button = "" }
        }
        .onChange(of: aliases) { _, next in
            if !next.isEmpty && !next.contains(alias) { alias = "" }
        }
    }
}
