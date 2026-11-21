import SwiftUI

struct HomeView: View {
    @ObservedObject var session: Session
    let profile: AccessProfile

    var body: some View {
        let canReadOrders = profile.can("sales.orders.read")
        TabView {
            section("Pendências", icon: "tray") {
                if canReadOrders { OrderListView(api: session, status: "draft", searchable: false, emptyText: "Nenhum pedido em rascunho aguardando ação.") }
                else { Notice(text: "Você não tem permissão para consultar pedidos nesta empresa.") }
            }
            section("Pedidos", icon: "doc.text") {
                if canReadOrders { OrderListView(api: session, status: "", searchable: true, emptyText: "Nenhum pedido encontrado.") }
                else { Notice(text: "Você não tem permissão para consultar pedidos nesta empresa.") }
            }
            section("Cliente", icon: "person.badge.plus") {
                CustomerView(api: session, enabled: profile.can("catalog.parties.manage") && profile.can("catalog.parties.read"))
            }
        }
        .tint(ErpColor.primary)
    }

    private func section<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            content()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: String.self) { OrderDetailView(api: session, id: $0) }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(profile.tenant.displayName).font(ErpFont.small.weight(.semibold)).lineLimit(1)
                            Text(profile.identity.name).font(ErpFont.small).foregroundStyle(ErpColor.mutedForeground).lineLimit(1)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) { accountMenu }
                }
        }
        .tabItem { Label(title, systemImage: icon) }
    }

    private var accountMenu: some View {
        Menu("Conta") {
            if session.biometricAvailable {
                Toggle("Desbloquear com biometria", isOn: Binding(get: { session.biometricUnlock }, set: { session.setBiometricUnlock($0) }))
            }
            Button("Trocar empresa") { session.switchCompany() }
            Button("Sair", role: .destructive) { session.signOut() }
        }
        .font(ErpFont.body)
    }
}
