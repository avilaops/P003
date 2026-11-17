# Melhorias: Clientes e fornecedores

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/cadastros/clientes-fornecedores` • **Código:** `apps/web/src/features/parties/party-access.tsx` e `party-workspace.tsx` • **Capturas:** web 17, mobile 16.

## O que está errado hoje

- Título "Pessoas cadastradas" difere do nome no menu ("Clientes e fornecedores").
- CPF/CNPJ **sem máscara** (`00000000000000`, `00000000000`); telefone sem máscara (`0000000000`) • na lista de Funcionários o telefone aparece mascarado.
- Placeholder da busca é uma instrução técnica: **"Documento sem máscara"**.
- Botão "Buscar" fica entre a busca e os filtros; ordem visual confusa.
- Rótulo "Situação no ERP" (técnico); "4 pessoa(s) • Consulta e edição".
- "Nova pessoa" é link pequeno no canto.
- Dados de teste visíveis (`teste@example.test`) sem nenhum sinal de cadastro incompleto.
- Sem coluna de cidade/UF, que é o que o vendedor usa para distinguir clientes.
- No celular, e-mails quebram no meio ("vendas@example.t / est").

## O que fazer

1. Título "Clientes e fornecedores"; botão primário "Novo cadastro de cliente ou fornecedor" (ou "Novo cliente/fornecedor").
2. Busca ao digitar aceitando nome, CPF/CNPJ **com ou sem máscara**; placeholder "Nome, CPF ou CNPJ".
3. Filtros: Relacionamento (Cliente / Fornecedor / Ambos), Situação (padrão Ativos), UF.
4. Colunas: Nome (razão social, nome fantasia em secundário), CPF/CNPJ mascarado, Tipo (selo), Cidade/UF, Contato (e-mail + telefone mascarado).
5. Indicar cadastro incompleto para emitir NF (sem IE, sem endereço, e-mail inválido) com ícone e tooltip.
6. Ação rápida por linha: "Novo pedido para este cliente".

## Mobile

- Cartão: nome (2 linhas no máx.), CPF/CNPJ mascarado, selo de tipo, cidade/UF. E-mail e telefone truncados com reticências (completo no detalhe), com ações de tocar para ligar / enviar e-mail.

## Critérios de aceite

- Nenhum documento ou telefone sem máscara.
- Buscar "00.000.000/0000-00" e "00000000000000" encontra o mesmo cliente.
- Nenhum e-mail quebrado no meio no celular.
