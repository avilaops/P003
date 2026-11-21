import SwiftUI

/// Cadastro rápido de cliente. A validação de CPF/CNPJ, e-mail e parâmetros da empresa é da API;
/// o app só exige os campos obrigatórios. Endereço, contatos e fiscal ficam no ERP web.
struct CustomerView: View {
    let api: ApiRunner
    let enabled: Bool

    @State private var personType = QuickCustomerInput.PersonType.juridica
    @State private var legalName = ""
    @State private var tradeName = ""
    @State private var taxId = ""
    @State private var email = ""
    @State private var phone = ""
    @State private var message: (text: String, error: Bool)?
    @State private var saving = false
    // Uma chave por conteúdo: repetir o mesmo cadastro após falha de rede não duplica o cliente;
    // qualquer mudança nos dados gera chave nova (a API recusa a mesma chave com outro corpo).
    @State private var attempt: (input: QuickCustomerInput, key: UUID)?

    var body: some View {
        if !enabled {
            Notice(text: "Você não tem permissão para cadastrar clientes nesta empresa.").padding()
        } else {
            Form {
                Picker("Tipo", selection: $personType) {
                    Text("Pessoa jurídica").tag(QuickCustomerInput.PersonType.juridica)
                    Text("Pessoa física").tag(QuickCustomerInput.PersonType.fisica)
                }
                .pickerStyle(.segmented)
                TextField(personType == .juridica ? "CNPJ" : "CPF", text: $taxId).keyboardType(.asciiCapable)
                TextField(personType == .juridica ? "Razão social" : "Nome", text: $legalName)
                if personType == .juridica { TextField("Nome fantasia (opcional)", text: $tradeName) }
                TextField("E-mail (opcional)", text: $email).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                TextField("Telefone (opcional)", text: $phone).keyboardType(.phonePad)
                if let message { Notice(text: message.text, error: message.error) }
                Button(saving ? "Salvando…" : "Salvar cliente") { Task { await save() } }
                    .disabled(saving || legalName.blankToNil == nil || taxId.blankToNil == nil)
            }
            .font(ErpFont.body)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let input = QuickCustomerInput(personType: personType, legalName: legalName.trimmingCharacters(in: .whitespaces),
                                       tradeName: personType == .juridica ? tradeName.blankToNil : nil,
                                       taxId: taxId.trimmingCharacters(in: .whitespaces), email: email.blankToNil, phone: phone.blankToNil)
        let key = attempt?.input == input ? attempt!.key : UUID()
        attempt = (input, key)
        do {
            let party = try await api.call { try await $0.createCustomer($1, input: input, idempotencyKey: key) }
            legalName = ""; tradeName = ""; taxId = ""; email = ""; phone = ""
            message = ("Cliente \(party.legalName) cadastrado.", false)
            attempt = nil
        } catch {
            message = (error.localizedDescription, true)
        }
    }
}
