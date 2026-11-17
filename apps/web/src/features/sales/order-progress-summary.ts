type CustomerProgressIssue = { field: string; message: string }
type CustomerProgressState = { selected: boolean; creating: boolean; values?: Readonly<Record<string, string>> }

const requiredLabels: Readonly<Record<string, string>> = {
  "nome completo": "o nome completo",
  "razão social": "a razão social",
  "nome do responsável": "o nome do responsável",
  celular: "o celular",
  "e-mail": "o e-mail",
  "inscrição estadual ou ISENTO": "a inscrição estadual",
  CEP: "o CEP",
  endereço: "o endereço",
  número: "o número",
  bairro: "o bairro",
  cidade: "a cidade",
  UF: "a UF",
}

const optionalLabels: Readonly<Record<string, string>> = {
  tradeName: "o nome fantasia",
  stateRegistration: "a inscrição estadual",
  complement: "o complemento",
}

export function groupOrderCustomerProgress(issues: readonly CustomerProgressIssue[], { selected, creating, values }: CustomerProgressState): CustomerProgressIssue[] {
  if (!selected && !creating) return [{ field: "selection", message: "Selecione ou cadastre o cliente" }]

  return issues.map(({ field, message }) => {
    const missing = values?.[field]?.trim() === ""
    const required = /^Confira (.+): preenchimento obrigatório/.exec(message)
    if (required) {
      const label = requiredLabels[required[1]] ?? required[1]
      if (missing && field === "state") return { field, message: "Selecione a UF." }
      if (missing && field === "stateRegistration") return { field, message: "Informe a inscrição estadual ou indique isenção." }
      return { field, message: `${missing ? "Informe" : "Confira"} ${label}.` }
    }
    if (field === "taxId" && missing) return { field, message: `Informe o ${message.includes("CPF") ? "CPF" : "CNPJ"}.` }
    if (field === "city" && message.startsWith("O código IBGE")) return { field, message: "Confira a cidade e a UF do código IBGE." }
    if (Object.hasOwn(optionalLabels, field) && message.startsWith("O campo contém caracteres inválidos")) {
      return { field, message: `Confira ${optionalLabels[field]}.` }
    }
    return { field, message }
  })
}
