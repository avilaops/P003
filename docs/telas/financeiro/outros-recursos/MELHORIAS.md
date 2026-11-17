# Melhorias: Recursos financeiros indisponíveis

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rotas:** `/financeiro/controle-caixa` (menu "Caixa"), `/financeiro/ficha-financeira`, `/financeiro/remessas-retornos`, `/financeiro/faturamento-agrupado`, `/financeiro/tributos`, `/financeiro/contador`, `/financeiro/conta-digital` • **Código:** `apps/web/src/features/finance/finance-capability-unavailable.tsx`, menu em `apps/web/src/components/shell/navigation-catalog.ts` • **Capturas:** web 54, 56, 57, 59, 60, 61.

## O que está errado hoje

- Sete rotas abrem a mesma página genérica "Funcionalidade indisponível" com 8 atalhos sem relação.
- Cinco delas aparecem no menu com "Indisponível" (Caixa, Ficha financeira, Remessas e retornos, Faturamento agrupado e outras), ocupando o grupo "Gestão" quase inteiro • só Comissões funciona nesse grupo.
- O item **"Caixa"** (controle de caixa) fica logo acima de **"Caixas e bancos"**, e o usuário não sabe a diferença.
- Na captura 60 (Contador), o cabeçalho mostra "Empresa ativa" com o nome quase invisível e o logotipo sem o texto "ERP" • verificar se é carregamento parcial ou problema de contraste.

## O que fazer

1. Remover do menu todos os itens indisponíveis deste grupo; o grupo "Gestão" fica com Comissões (e entra no grupo principal se ficar sozinho).
2. Página indisponível específica para cada rota (texto por função), por exemplo:
   - Remessas e retornos: "Gera arquivos CNAB para cobrança bancária e lê os retornos. Requer banco, carteira e convênio configurados." → atalho Contas a receber.
   - Tributos: "Apuração e guias de impostos." → atalho Fiscal.
   - Contador: "Acesso do escritório contábil aos documentos." → atalho Preferências → Usuários.
3. Decidir o nome do controle de caixa (ex.: "Abertura e fechamento de caixa") para não colidir com "Caixas e bancos"; unificar com o PDV se for o mesmo conceito.
4. Investigar o cabeçalho da captura 60 (contraste/carregamento do seletor de empresa).

## Critérios de aceite

- Nenhum item indisponível no menu do Financeiro.
- Cada rota indisponível tem texto próprio e um atalho relacionado.
- Cabeçalho com empresa ativa legível em todas as rotas.
