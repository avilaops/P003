import SwiftUI

private struct Brand: View {
    var body: some View {
        Text("ERP • Avila Ops").font(ErpFont.title)
    }
}

struct CenteredView<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(spacing: 12) { content }.padding(24).frame(maxWidth: 420)
    }
}

struct UnconfiguredView: View {
    var body: some View {
        CenteredView {
            Brand()
            Notice(text: "API não configurada neste build. Gere o build com ERP_API_BASE_URL de homologação.", error: true)
        }
    }
}

struct LoginView: View {
    let message: String?
    let onLogin: () -> Void
    var body: some View {
        CenteredView {
            Brand()
            Text("Entre com a mesma conta do ERP web.").font(ErpFont.body).foregroundStyle(ErpColor.mutedForeground)
            if let message { Notice(text: message, error: true) }
            Button(action: onLogin) { Text("Entrar").font(ErpFont.body.weight(.medium)).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(ErpColor.primary).controlSize(.regular)
        }
    }
}

struct LockedView: View {
    let onUnlock: () -> Void
    let onSignOut: () -> Void
    var body: some View {
        CenteredView {
            Brand()
            Text("Sessão bloqueada").font(ErpFont.rowTitle)
            Button(action: onUnlock) { Text("Desbloquear").font(ErpFont.body.weight(.medium)).frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent).tint(ErpColor.primary)
            Button("Sair", action: onSignOut).font(ErpFont.body)
        }
    }
}

struct CompanyView: View {
    let companies: [CompanySummary]
    let message: String?
    let onChoose: (CompanySummary) -> Void
    let onSignOut: () -> Void
    var body: some View {
        NavigationStack {
            List {
                if let message { Notice(text: message, error: true) }
                ForEach(companies) { company in
                    Button { onChoose(company) } label: {
                        ListRow(title: company.displayName, subtitle: company.legalName == company.displayName ? nil : company.legalName, trailing: nil)
                    }
                    .foregroundStyle(ErpColor.foreground)
                }
            }
            .listStyle(.plain)
            .navigationTitle("Escolha a empresa")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Sair", action: onSignOut).font(ErpFont.body) }
        }
    }
}
