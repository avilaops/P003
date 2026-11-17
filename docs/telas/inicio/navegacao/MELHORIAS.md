# Melhorias: Hub de Cadastros e navegação

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/cadastros` (e o mesmo padrão em `/preferencias`) • **Código:** `apps/web/src/features/records/records-module.tsx`, menu em `apps/web/src/components/shell/navigation-catalog.ts` e `menu-navigation.tsx` • **Capturas:** web 15, mobile 14.

## O que está errado hoje

- Oito cartões grandes, cada um com a frase técnica **"Cadastro conectado • consulta exige acesso à empresa"** repetida.
- Faltam cartões para Grupos de produtos, Grupos de tags e Tags, que estão no menu lateral.
- Nenhum cartão mostra quantos registros existem ou se o cadastro está vazio (Contas financeiras e Categorias financeiras estão vazios e isso bloqueia o Financeiro).
- Menu lateral separa "Visão geral / Produtos / Clientes / Funcionários" de "Ferramentas" (Contas financeiras, Categorias…) sem critério claro para o usuário.
- No celular, cada cartão ocupa ~150 px de altura: quatro por tela, muita rolagem.

## O que fazer

1. **Agrupar por uso**, não por "ferramentas":
   - Comercial: Produtos, Categorias de produtos, Listas de preços, Clientes e fornecedores.
   - Equipe: Funcionários.
   - Financeiro: Contas financeiras, Categorias financeiras, Formas de pagamento.
   - Organização: Grupos de produtos, Tags (com grupos de tags dentro).
   O menu lateral segue a mesma ordem.
2. Cada item: ícone, nome, uma linha do que é, **contagem** ("160 produtos", "0 contas") e alerta quando vazio e necessário ("Necessário para Caixas e bancos").
3. Remover "Cadastro conectado • consulta exige acesso à empresa".
4. "Configuração inicial" no topo quando houver cadastros obrigatórios vazios: checklist (Conta financeira, Categorias financeiras) com links • atende o "checklist de implantação" do documento, seção 7.5.

## Mobile

- Lista compacta (altura ~56 px por item), grupos com título.

## Critérios de aceite

- Todos os cadastros do menu aparecem no hub, com contagem.
- Nenhuma frase técnica.
- No cenário de exemplo, o checklist mostra Contas financeiras e Categorias financeiras como pendentes.
