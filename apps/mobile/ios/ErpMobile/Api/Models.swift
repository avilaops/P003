import Foundation

// Modelos mínimos de resposta: só os campos que as telas da v1 mostram.
// O contrato OpenAPI do api-ts ainda não publica schemas de resposta (aguardando #284);
// quando publicar, o gerador passa a emitir estes tipos e este arquivo encolhe.

/// Valores decimais chegam como texto ("1234.50") ou número; o app mostra, não calcula.
struct DecimalText: Decodable, Equatable {
    let value: String
    init(_ value: String) { self.value = value }
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) { value = text }
        else { value = "\(try container.decode(Decimal.self))" }
    }
}

struct Problem: Decodable { let status: Int?; let code: String?; let title: String? }

struct Identity: Decodable, Equatable { let subject: String; let email: String; let name: String }

struct Tenant: Decodable, Equatable {
    let id: String
    let legalName: String
    let tradeName: String?
    var displayName: String { tradeName.flatMap { $0.isEmpty ? nil : $0 } ?? legalName }
}

struct AccessProfile: Decodable, Equatable {
    let identity: Identity
    let tenant: Tenant
    let roles: [String]
    let permissions: [String]
    func can(_ permission: String) -> Bool { permissions.contains(permission) }
}

struct CompanySummary: Decodable, Equatable, Identifiable {
    let id: String
    let legalName: String
    let tradeName: String?
    let status: String
    var displayName: String { tradeName.flatMap { $0.isEmpty ? nil : $0 } ?? legalName }
}

struct CompanyDirectory: Decodable { let data: [CompanySummary]; let platformAdministrator: Bool }

struct OrderSummary: Decodable, Equatable, Identifiable {
    let id: String
    let number: String
    let customerName: String?
    let customerTaxId: String?
    let dueDate: String?
    let amount: DecimalText
    let status: String
    let revision: Int
}

struct OrderPage: Decodable { let data: [OrderSummary]; let total: Int; let offset: Int; let limit: Int }

struct OrderItem: Decodable, Equatable {
    let sku: String?
    let name: String
    let unit: String?
    let quantity: DecimalText
    let unitPrice: DecimalText
    let amount: DecimalText
}

struct OrderDetail: Decodable { let data: OrderSummary; let items: [OrderItem] }

struct PricingState: Decodable { let needsApproval: Bool; let approved: Bool }

struct OrderPricing: Decodable {
    let canApprove: Bool
    let data: PricingState?
    var awaitingApproval: Bool { data.map { $0.needsApproval && !$0.approved } ?? false }
}

struct PricingApproval: Decodable { let id: String; let revision: Int; let approved: Bool }

/// Corpo de `POST /api/v1/parties` no cadastro rápido: só cliente, ativo, sem endereço.
struct QuickCustomerInput: Encodable, Equatable {
    enum PersonType: String, Encodable { case fisica, juridica }
    var personType: PersonType
    var legalName: String
    var tradeName: String?
    var taxId: String
    var email: String?
    var phone: String?
    var isCustomer = true
    var isSupplier = false
    var status = "active"

    // Campos nulos são omitidos, como no app Android e no web.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(personType, forKey: .personType)
        try container.encode(legalName, forKey: .legalName)
        try container.encodeIfPresent(tradeName, forKey: .tradeName)
        try container.encode(taxId, forKey: .taxId)
        try container.encodeIfPresent(email, forKey: .email)
        try container.encodeIfPresent(phone, forKey: .phone)
        try container.encode(isCustomer, forKey: .isCustomer)
        try container.encode(isSupplier, forKey: .isSupplier)
        try container.encode(status, forKey: .status)
    }

    private enum CodingKeys: String, CodingKey { case personType, legalName, tradeName, taxId, email, phone, isCustomer, isSupplier, status }
}

struct Party: Decodable { let id: String; let legalName: String; let revision: Int }
struct PartyEnvelope: Decodable { let data: Party }

/// Resposta com a revisão do `ETag`, usada no `If-Match` da próxima escrita.
struct Revised<Value> { let value: Value; let revision: Int }

extension String {
    var blankToNil: String? { let trimmed = trimmingCharacters(in: .whitespacesAndNewlines); return trimmed.isEmpty ? nil : trimmed }
}
