import SwiftUI

struct ApplicationWrites: View {
    let client: RouterClient
    @State private var proposals: [ApplicationWriteSummary]?
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundStyle(.red)
                Button("Retry") { Task { await reload() } }
            } else if let proposals {
                if proposals.isEmpty { Text("No shared write proposals.") }
                ForEach(proposals) { proposal in
                    NavigationLink {
                        ApplicationWriteReview(client: client, id: proposal.id)
                    } label: {
                        VStack(alignment: .leading) {
                            Text(proposal.capability)
                            Text(proposal.workspace + " · " + proposal.status.replacingOccurrences(of: "_", with: " "))
                                .font(.caption)
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Application writes")
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            proposals = try await client.applicationWriteProposals()
            error = nil
        } catch is CancellationError {
        } catch {
            proposals = nil
            self.error = error.localizedDescription
        }
    }
}

private struct ApplicationWriteReview: View {
    let client: RouterClient
    let id: UUID
    @State private var proposal: ApplicationWriteDetail?
    @State private var error: String?
    @State private var sending = false
    @State private var confirming = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if let proposal {
                Section("Destination") {
                    Text(proposal.app + " · " + proposal.account)
                    Text(proposal.workspace).font(.caption)
                    Text(proposal.capability)
                }
                Section("Write input") {
                    Text(proposal.inputPreview).font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
                Section("Status") {
                    Text(proposal.status.replacingOccurrences(of: "_", with: " "))
                    if proposal.canConfirm {
                        Button("Confirm write", role: .destructive) { confirming = true }
                            .disabled(sending)
                    }
                }
            }
            Button("Refresh status") { Task { await reload() } }.disabled(sending)
        }
        .navigationTitle("Review write")
        .task { await reload() }
        .confirmationDialog("Write to this application?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Confirm write", role: .destructive) {
                guard proposal?.canConfirm == true, !sending else { return }
                sending = true
                Task { await confirm() }
            }
        }
    }

    private func reload() async {
        do {
            proposal = try await client.applicationWriteProposal(id)
            error = nil
        } catch is CancellationError {
        } catch {
            proposal = nil
            self.error = error.localizedDescription
        }
    }

    private func confirm() async {
        defer { sending = false }
        do {
            try await client.confirmApplicationWrite(id)
            await reload()
        } catch {
            let message = error.localizedDescription
            await reload()
            self.error = message
        }
    }
}
