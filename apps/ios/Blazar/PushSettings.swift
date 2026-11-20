#if os(iOS)
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class PushRegistration: NSObject, UIApplicationDelegate, ObservableObject {
    @Published private(set) var deviceToken: String?
    @Published private(set) var registrationError: String?

    func refreshToken() {
        registrationError = nil
        UIApplication.shared.registerForRemoteNotifications()
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        deviceToken = token.map { String(format: "%02x", $0) }.joined()
        registrationError = nil
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        registrationError = "This iPhone could not register for Apple notifications."
    }
}

struct PushSettings: View {
    let client: RouterClient
    @EnvironmentObject private var registration: PushRegistration
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("notifications.optedIn") private var optedIn = false
    @State private var busy = false
    @State private var confirmed = false
    @State private var error: String?

    private struct SyncKey: Equatable {
        let client: RouterClient
        let active: Bool
        let optedIn: Bool
        let deviceToken: String?
    }

    var body: some View {
        Section("Task notifications") {
            if optedIn {
                if confirmed {
                    Text("Notifications are enabled.")
                }
                Button("Turn off task notifications") {
                    Task { await turnOff() }
                }
                .disabled(busy)
            } else {
                Button("Enable task notifications") {
                    Task { await turnOn() }
                }
                .disabled(busy)
            }
            if let error = error ?? (optedIn ? registration.registrationError : nil) {
                Text(error).foregroundStyle(.red)
            }
        }
        .task(id: scenePhase) {
            if scenePhase == .active && optedIn { registration.refreshToken() }
        }
        .task(id: SyncKey(client: client, active: scenePhase == .active, optedIn: optedIn,
                          deviceToken: registration.deviceToken)) {
            guard scenePhase == .active && optedIn else { return }
            await synchronize()
        }
    }

    private func turnOn() async {
        error = nil
        busy = true
        defer { busy = false }
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert])
            guard granted else {
                error = "Allow notifications for Blazar in iPhone Settings."
                return
            }
            optedIn = true
            registration.refreshToken()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func turnOff() async {
        error = nil
        busy = true
        defer { busy = false }
        do {
            try await client.configurePush(deviceToken: nil)
            optedIn = false
            confirmed = false
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func synchronize() async {
        busy = true
        defer { busy = false }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard !Task.isCancelled else { return }
        let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
        do {
            if !allowed {
                try await client.configurePush(deviceToken: nil)
                guard !Task.isCancelled else { return }
                optedIn = false
                confirmed = false
            } else if let token = registration.deviceToken {
                try await client.configurePush(deviceToken: token)
                guard !Task.isCancelled else { return }
                confirmed = true
            }
            error = nil
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}
#endif
