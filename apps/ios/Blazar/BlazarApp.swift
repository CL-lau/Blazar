import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import AVFoundation
import UIKit
import VisionKit
#endif

@main
struct BlazarApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(PushRegistration.self) private var push
    #endif

    var body: some Scene {
        WindowGroup {
            #if os(iOS)
            TaskScreen().environmentObject(push)
            #else
            TaskScreen()
            #endif
        }
    }
}

private struct TaskScreen: View {
    private struct ProposedWorkflow {
        let workspace: String
        let steps: [RouterClient.WorkflowStep]
        let key = UUID()
    }
    private struct ProposedFollowUp {
        let taskId: String
        let version: Int
        let instruction: String
        let key = UUID()
    }

    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("router.endpoint") private var savedEndpoint = ""
    @State private var endpoint = ""
    @State private var token = Credentials.read()
    @State private var snapshot: RouterSnapshot?
    @State private var offlineSummary: OfflineTaskSummary?
    @State private var snapshotRequest = UUID()
    @State private var error: String?
    @State private var workspace = ""
    @State private var goal = ""
    @State private var attachments: [TaskTextAttachment] = []
    @State private var choosingAttachments = false
    @State private var requestKey = UUID()
    @State private var sending = false
    @State private var answer: String?
    @State private var usePersonalMemory = false
    @State private var plan: ProposedWorkflow?
    @State private var followUp: ProposedFollowUp?
    @State private var pairingCode = ""
    @State private var pairing = false
    #if os(iOS)
    @State private var showingScanner = false
    #endif

    private var routerURL: URL? {
        guard let url = URL(string: endpoint), url.scheme == "https",
              url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil else { return nil }
        return url
    }

    private var client: RouterClient? {
        guard !token.isEmpty, let base = routerURL else { return nil }
        return RouterClient(base: base, token: token)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Router") {
                    TextField("HTTPS address", text: $endpoint)
                    SecureField("Pairing code", text: $pairingCode)
                    #if os(iOS)
                    Button("Scan pairing QR") {
                        Task {
                            guard DataScannerViewController.isSupported,
                                  await AVCaptureDevice.requestAccess(for: .video),
                                  DataScannerViewController.isAvailable else {
                                error = "The camera is unavailable. Enter the pairing code manually."
                                return
                            }
                            showingScanner = true
                        }
                    }
                    .disabled(pairing)
                    #endif
                    Button("Pair iPhone") {
                        guard let base = routerURL else {
                            error = "Enter a trusted HTTPS Router address."
                            return
                        }
                        let code = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
                        pairing = true
                        Task {
                            defer { pairing = false }
                            do {
                                let paired = try await RouterClient.pair(base: base, code: code, name: "iPhone")
                                guard base == routerURL else { return }
                                try Credentials.save(paired.token)
                                savedEndpoint = base.absoluteString
                                token = paired.token
                                pairingCode = ""
                                await reload()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(pairing || pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if pairing { Text("Approve this request in Linked phones on your desktop.") }
                }
                #if os(iOS)
                if let client {
                    PushSettings(client: client)
                }
                #endif
                if let client, let snapshot {
                    Section("New task") {
                        TextField("Workspace", text: $workspace)
                            .onChange(of: workspace) { _, _ in requestKey = UUID() }
                        TextField("What should Blazar do?", text: $goal, axis: .vertical)
                            .onChange(of: goal) { _, _ in requestKey = UUID() }
                        Button("Attach text files") { choosingAttachments = true }
                            .disabled(sending)
                        ForEach(attachments.indices, id: \.self) { index in
                            HStack {
                                Text(attachments[index].name)
                                Spacer()
                                Button("Remove") {
                                    attachments.remove(at: index)
                                    requestKey = UUID()
                                }
                                .accessibilityLabel("Remove \(attachments[index].name)")
                                .buttonStyle(.borderless)
                                .disabled(sending)
                            }
                        }
                        Button("Create task") {
                            Task {
                                sending = true
                                defer { sending = false }
                                do {
                                    try await client.submit(workspace: workspace, goal: goal, key: requestKey, attachments: attachments)
                                    goal = ""
                                    attachments = []
                                    requestKey = UUID()
                                    await reload()
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(sending || workspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        Toggle("Use personal memory when asking", isOn: $usePersonalMemory)
                            .onChange(of: usePersonalMemory) { _, _ in requestKey = UUID() }
                        Button("Ask Blazar") {
                            Task {
                                sending = true
                                defer { sending = false }
                                do {
                                    let submittedWorkspace = workspace
                                    let reply = try await client.ask(workspace: submittedWorkspace, text: goal, key: requestKey,
                                                                     usePersonalMemory: usePersonalMemory)
                                    answer = reply.text
                                    if reply.kind == "append_task", let taskId = reply.taskId,
                                       let version = reply.expectedVersion, let instruction = reply.instruction {
                                        followUp = ProposedFollowUp(taskId: taskId, version: version, instruction: instruction)
                                    } else {
                                        followUp = nil
                                    }
                                    if reply.kind == "propose_workflow", let steps = reply.steps, !steps.isEmpty {
                                        plan = ProposedWorkflow(workspace: submittedWorkspace, steps: steps)
                                    } else {
                                        plan = nil
                                    }
                                    goal = ""
                                    await reload()
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                        .disabled(sending || !attachments.isEmpty || workspace.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                  || goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if let answer { Text(answer).textSelection(.enabled) }

                    }
                    DesktopControl(client: client, targets: snapshot.desktopTargets ?? [], tasks: snapshot.tasks,
                                   workspace: $workspace, sending: $sending, reload: reload,
                                   showError: { self.error = $0.localizedDescription })
                    if let followUp {
                        Section("Proposed follow-up") {
                            Text(snapshot.tasks.first { $0.id == followUp.taskId }?.goal ?? followUp.taskId)
                            Text(followUp.instruction)
                            Button("Send instruction") {
                                sending = true
                                Task {
                                    defer { sending = false }
                                    do {
                                        try await client.sendFollowUp(taskId: followUp.taskId, version: followUp.version,
                                                                      text: followUp.instruction, key: followUp.key)
                                        self.followUp = nil
                                        answer = nil
                                        await reload()
                                    } catch { self.error = error.localizedDescription }
                                }
                            }
                            Button("Discard") { self.followUp = nil; answer = nil }
                        }
                        .disabled(sending)
                    }
                    if let plan {
                        Section("Proposed workflow") {
                            Text(plan.workspace)
                            ForEach(plan.steps) { step in
                                VStack(alignment: .leading) {
                                    Text(step.goal)
                                    ForEach(step.acceptanceCriteria ?? [], id: \.self) { criterion in
                                        Text(criterion).font(.caption)
                                    }
                                    if step.requireReview == true {
                                        Text("Requires your acceptance").font(.caption)
                                    }
                                    if !step.needs.isEmpty {
                                        Text("After " + step.needs.joined(separator: ", ")).font(.caption)
                                    }
                                }
                            }
                            Button("Create workflow") {
                                sending = true
                                Task {
                                    defer { sending = false }
                                    do {
                                        try await client.createWorkflow(workspace: plan.workspace, steps: plan.steps, key: plan.key)
                                        self.plan = nil
                                        answer = nil
                                        await reload()
                                    } catch { self.error = error.localizedDescription }
                                }
                            }
                            .disabled(sending)
                            Button("Discard plan", role: .destructive) {
                                self.plan = nil
                                answer = nil
                            }
                            .disabled(sending)
                        }
                    }
                    Section("Tasks") {
                        ForEach(snapshot.tasks) { task in
                            NavigationLink {
                                TaskDetails(client: client, task: task,
                                            dependencies: (snapshot.workflowSteps ?? [])
                                                .filter { $0.taskId == task.id }
                                                .compactMap { link in snapshot.tasks.first { $0.id == link.predecessorId } },
                                            criteria: (snapshot.criteria ?? []).filter { $0.taskId == task.id }.map(\.criterion),
                                            progress: snapshot.progress?.first { $0.taskId == task.id }?.message,
                                            approvals: snapshot.approvals.filter { $0.taskId == task.id },
                                            artifacts: snapshot.artifacts.filter { $0.taskId == task.id },
                                            reload: reload)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(task.goal).lineLimit(2)
                                    Text(task.status.replacingOccurrences(of: "_", with: " ")).font(.caption)
                                }
                            }
                        }
                    }
                }
                if snapshot == nil, client != nil, let offlineSummary {
                    Section("Last synced tasks") {
                        Text(offlineSummary.synchronizedAt.formatted()).font(.caption)
                        ForEach(offlineSummary.tasks) { task in
                            VStack(alignment: .leading) {
                                Text(task.goal).lineLimit(2)
                                Text(task.status.replacingOccurrences(of: "_", with: " ")).font(.caption)
                            }
                        }
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            #if os(iOS)
            .sheet(isPresented: $showingScanner) {
                NavigationStack {
                    PairingScanner { value in
                        showingScanner = false
                        guard let payload = PairingPayload.parse(value) else {
                            error = "This QR code is not a valid Blazar pairing code."
                            return
                        }
                        endpoint = payload.endpoint
                        pairingCode = payload.code
                        error = nil
                    } failed: {
                        showingScanner = false
                        error = "The camera is unavailable. Enter the pairing code manually."
                    }
                    .navigationTitle("Scan pairing QR")
                    .toolbar { Button("Cancel") { showingScanner = false } }
                }
            }
            #endif
            .fileImporter(isPresented: $choosingAttachments, allowedContentTypes: [.plainText, .commaSeparatedText, .json],
                          allowsMultipleSelection: true) { result in
                do {
                    let urls = try result.get()
                    if !urls.isEmpty {
                        attachments = try TaskTextAttachment.read(urls)
                        requestKey = UUID()
                    }
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .navigationTitle("Blazar")
            .refreshable { await reload() }
            .task {
                if endpoint.isEmpty {
                    endpoint = savedEndpoint
                }
            }
            .task(id: scenePhase == .active ? client : nil) {
                guard scenePhase == .active, let client else { return }
                offlineSummary = OfflineTaskSummary.read(for: client)
                await synchronize(using: client)
            }
            .onChange(of: endpoint) { previous, updated in
                if previous.isEmpty && updated == savedEndpoint { return }
                token = ""
                snapshot = nil
                offlineSummary = nil
                attachments = []
                requestKey = UUID()
                OfflineTaskSummary.clear()
                answer = nil
                plan = nil
            }

        }
    }

    private func synchronize(using client: RouterClient) async {
        while !Task.isCancelled && self.client == client {
            await reload()
            guard !Task.isCancelled, self.client == client else { return }
            if error == nil, let cursor = snapshot?.cursor {
                do {
                    try await client.waitForChange(after: cursor)
                    continue
                } catch {
                    guard !Task.isCancelled, self.client == client else { return }
                    self.error = error.localizedDescription
                }
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func reload() async {
        guard let client else { return }
        let request = UUID()
        snapshotRequest = request
        do {
            let state = try await client.snapshot()
            guard !Task.isCancelled, self.client == client, snapshotRequest == request else { return }
            snapshot = state
            let summary = OfflineTaskSummary(snapshot: state, client: client)
            summary.save()
            offlineSummary = summary
            error = nil
        } catch {
            guard !Task.isCancelled, self.client == client, snapshotRequest == request else { return }
            snapshot = nil
            if error is RouterAccessDenied {
                OfflineTaskSummary.clear()
                offlineSummary = nil
            }
            self.error = error.localizedDescription
        }
    }
}

private struct TaskDetails: View {
    let client: RouterClient
    let task: RouterSnapshot.Task
    let dependencies: [RouterSnapshot.Task]
    let criteria: [String]
    let progress: String?
    let approvals: [RouterSnapshot.Approval]
    let artifacts: [RouterSnapshot.Artifact]
    let reload: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var instruction = ""
    @State private var error: String?
    @State private var preview: String?
    @State private var previewArtifacts: [String] = []
    @State private var imagePreview: Data?
    @State private var imageExpiry: Int?
    @State private var working = false
    @State private var confirmingRetry = false
    @State private var loadingActivity = false
    @State private var activity: [TimelinePage.Entry] = []
    @State private var before: Int?

    var body: some View {
        Form {
            Section("Task") {
                Text(task.goal)
                Text(task.status.replacingOccurrences(of: "_", with: " "))
                if let progress { Text(progress).foregroundStyle(.secondary) }
                if let result = task.result { Text(result).textSelection(.enabled) }
            }
            if !criteria.isEmpty {
                Section("Acceptance criteria") {
                    ForEach(criteria, id: \.self) { Text($0) }
                }
            }
            if !dependencies.isEmpty {
                Section("Dependencies") {
                    ForEach(dependencies) { dependency in
                        VStack(alignment: .leading) {
                            Text(dependency.goal)
                            Text(dependency.status.replacingOccurrences(of: "_", with: " ")).font(.caption)
                        }
                    }
                }
            }
            ForEach(approvals) { approval in
                Section("Approval") {
                    Text(approval.summary)
                    Button("Approve") { send("approve", approval: approval.id) }
                    Button("Deny", role: .destructive) { send("deny", approval: approval.id) }
                }
            }
            if !artifacts.isEmpty {
                Section("Artifacts") {
                    ForEach(artifacts) { artifact in
                        Button(artifact.name) {
                            Task {
                                do {
                                    if artifact.mime == "image/png" {
                                        preview = nil
                                        imagePreview = try await client.artifactData(artifact)
                                        imageExpiry = artifact.expires
                                    } else {
                                        imagePreview = nil
                                        preview = try await client.artifact(artifact)
                                    }
                                    previewArtifacts = [artifact.id]
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                        if let latest = artifacts.first, latest.id != artifact.id, latest.mime == nil, artifact.mime == nil {
                            Button("Compare with latest") {
                                Task {
                                    do {
                                        preview = try await client.compareArtifacts(latest, base: artifact)
                                        previewArtifacts = [latest.id, artifact.id]
                                    }
                                    catch { self.error = error.localizedDescription }
                                }
                            }
                        }
                    }
                    if let preview, previewArtifacts.allSatisfy({ id in artifacts.contains { $0.id == id } }) {
                        Text(preview).textSelection(.enabled)
                    }
                    #if os(iOS)
                    if let imagePreview, let image = UIImage(data: imagePreview) {
                        Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Captured window")
                    }
                    #endif
                }
                .task(id: imageExpiry) {
                    guard let imageExpiry else { return }
                    let seconds = max(0, Double(imageExpiry) / 1000 - Date().timeIntervalSince1970)
                    try? await Task.sleep(for: .seconds(seconds))
                    if !Task.isCancelled { imagePreview = nil }
                }
            }
            if ["queued", "running", "waiting_user", "waiting_dependency", "waiting_device"].contains(task.status) {
                Button("Pause task") { send("pause") }
            }
            if task.status == "paused" {
                Button("Resume task") { send("resume") }
            }
            if task.status == "failed" || (task.status == "waiting_user" && approvals.isEmpty) {
                Button("Retry task") { confirmingRetry = true }
                    .confirmationDialog("Retry this task as a new run?", isPresented: $confirmingRetry) {
                        Button("Retry task") { send("retry") }
                    } message: {
                        Text("Review any effects of the previous run first.")
                    }
            }
            if task.status == "waiting_review" {
                Section("Review result") {
                    Button("Accept result") { send("accept_result") }
                    Button("Reject result", role: .destructive) { send("reject_result") }
                }
            }
            if ["paused", "pausing", "waiting_review"].contains(task.status) {
                Button("Cancel task", role: .destructive) { send("cancel") }
            }
            if !["cancelled", "cancelling", "paused", "pausing"].contains(task.status) {
                Section("Follow-up") {
                    TextField("Additional instruction", text: $instruction, axis: .vertical)
                    Button("Send") { send("append", text: instruction) }
                        .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if ["queued", "running", "waiting_user", "waiting_dependency", "waiting_device"].contains(task.status) {
                        Button("Cancel task", role: .destructive) { send("cancel") }
                    }
                }
            }
            Section("Activity") {
                ForEach(activity) { entry in
                    VStack(alignment: .leading) {
                        Text(entry.title)
                        if let text = entry.data.description { Text(text).font(.caption) }
                    }
                }
                if let before {
                    Button("Load older activity") { Task { await loadActivity(before: before) } }
                        .disabled(loadingActivity)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .disabled(working)
        .navigationTitle("Task")
        .task { await loadActivity() }
        .refreshable { await loadActivity() }
    }

    private func loadActivity(before cursor: Int? = nil) async {
        guard !loadingActivity else { return }
        loadingActivity = true
        defer { loadingActivity = false }
        do {
            let page = try await client.timeline(taskId: task.id, before: cursor)
            activity = cursor == nil ? page.events : activity + page.events
            before = page.before
        } catch { self.error = error.localizedDescription }
    }

    private func send(_ action: String, text: String? = nil, approval: String? = nil) {
        Task {
            working = true
            defer { working = false }
            do {
                try await client.command(task: task, action: action, text: text, approval: approval)
                await reload()
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }
}
