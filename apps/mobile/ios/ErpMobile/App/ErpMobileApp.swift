import SwiftUI

@main
struct ErpMobileApp: App {
    @StateObject private var session = Session()

    var body: some Scene {
        WindowGroup {
            Group {
                switch session.state {
                case .unconfigured: UnconfiguredView()
                case .loading: ProgressView()
                case .signedOut(let message): LoginView(message: message, onLogin: session.login)
                case .locked: LockedView(onUnlock: session.unlock, onSignOut: { session.signOut() })
                case .choosingCompany(let companies, let message):
                    CompanyView(companies: companies, message: message, onChoose: session.choose, onSignOut: { session.signOut() })
                case .ready(let profile): HomeView(session: session, profile: profile)
                }
            }
            .foregroundStyle(ErpColor.foreground)
            .onAppear { if session.state == .locked { session.unlock() } }
        }
    }
}
