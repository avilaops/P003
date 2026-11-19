import SwiftUI

/// Lista de pedidos. Em Pendências, mostra os rascunhos (fonte provisória até o painel D01, #293);
/// em Pedidos, permite buscar por cliente, CPF/CNPJ ou número.
struct OrderListView: View {
    let api: ApiRunner
    let status: String
    let searchable: Bool
    let emptyText: String

    @State private var query = ""
    @State private var submitted = ""
    @State private var page: OrderPage?
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        List {
            if let error { Notice(text: error, error: true) }
            if !loading, error == nil, page?.data.isEmpty == true { Notice(text: emptyText) }
            ForEach(page?.data ?? []) { order in
                NavigationLink(value: order.id) {
                    ListRow(title: "PV-\(order.number) • \(order.customerName ?? "Sem cliente")",
                            subtitle: "\(Format.orderStatus[order.status] ?? order.status) • vence \(Format.date(order.dueDate))",
                            trailing: Format.money(order.amount))
                }
            }
            if let page, page.total > page.data.count { Notice(text: "Mostrando \(page.data.count) de \(page.total). Refine a busca.") }
        }
        .listStyle(.plain)
        .overlay { if loading && page == nil { ProgressView() } }
        .modifier(SearchModifier(enabled: searchable, query: $query) { submitted = query.trimmingCharacters(in: .whitespaces) })
        .refreshable { await load() }
        .task(id: submitted) { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do { page = try await api.call { try await $0.orders($1, query: submitted, status: status) } }
        catch { self.error = error.localizedDescription }
        loading = false
    }
}

private struct SearchModifier: ViewModifier {
    let enabled: Bool
    @Binding var query: String
    let onSubmit: () -> Void
    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $query, prompt: "Cliente, CPF/CNPJ ou número").onSubmit(of: .search, onSubmit)
        } else { content }
    }
}

/// Detalhe do pedido com a aprovação de exceção de preço (alçada atual do ERP).
struct OrderDetailView: View {
    let api: ApiRunner
    let id: String

    @State private var detail: Revised<OrderDetail>?
    @State private var pricing: Revised<OrderPricing>?
    @State private var error: String?
    @State private var notice: String?
    @State private var approving = false
    @State private var reason = ""
    // Mesma chave em toda tentativa desta decisão: repetir após falha de rede não aprova duas vezes.
    @State private var approvalKey = UUID()

    var body: some View {
        List {
            if let error { Notice(text: error, error: true) }
            if let notice { Notice(text: notice) }
            if let order = detail?.value.data {
                VStack(alignment: .leading, spacing: 4) {
                    Text("PV-\(order.number)").font(ErpFont.title)
                    Text(order.customerName ?? "Sem cliente").font(ErpFont.body)
                    Text("\(Format.orderStatus[order.status] ?? order.status) • vence \(Format.date(order.dueDate)) • \(Format.money(order.amount))")
                        .font(ErpFont.small).foregroundStyle(ErpColor.mutedForeground)
                }
                if let price = pricing?.value, price.awaitingApproval {
                    Notice(text: "Preço fora da política: aguarda aprovação.", error: true)
                    if price.canApprove {
                        Button("Aprovar preço") { approving = true }.font(ErpFont.body.weight(.medium))
                    } else {
                        Notice(text: "A aprovação exige alçada de gestão e outra pessoa que não o solicitante.")
                    }
                }
                Section("Itens") {
                    ForEach(Array((detail?.value.items ?? []).enumerated()), id: \.offset) { _, item in
                        ListRow(title: item.name, subtitle: [item.sku, "\(item.quantity.value) \(item.unit ?? "") × \(Format.money(item.unitPrice))"].compactMap { $0 }.joined(separator: " • "),
                                trailing: Format.money(item.amount))
                    }
                }
            } else if error == nil {
                ProgressView()
            }
        }
        .listStyle(.plain)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .alert("Aprovar preço", isPresented: $approving) {
            TextField("Motivo", text: $reason)
            Button("Cancelar", role: .cancel) {}
            Button("Aprovar") { Task { await approve() } }.disabled(!(3...2000).contains(reason.trimmingCharacters(in: .whitespacesAndNewlines).count))
        }
    }

    private func load() async {
        error = nil
        do {
            detail = try await api.call { try await $0.order($1, id: id) }
            pricing = try await api.call { try await $0.pricing($1, id: id) }
        } catch { self.error = error.localizedDescription }
    }

    private func approve() async {
        guard let revision = detail?.revision else { return }
        do {
            _ = try await api.call { try await $0.approvePricing($1, id: id, revision: revision, reason: reason, idempotencyKey: approvalKey) }
            notice = "Preço aprovado."
            reason = ""
            approvalKey = UUID()
            await load()
        } catch let failure as ApiError {
            error = failure.message
            if failure.status == 412 { approvalKey = UUID(); await load() }
        } catch { self.error = error.localizedDescription }
    }
}
