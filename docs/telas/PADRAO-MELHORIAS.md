# Padrão comum de melhorias de tela

[Todas as telas](../README.md) • [Índice de melhorias](MELHORIAS-INDICE.md)

Este arquivo vale para **todos** os prompts `MELHORIAS.md` das pastas de tela. Cada prompt de tela lista só o que é específico dela; as regras abaixo se aplicam sempre, sem precisar repetir.

As referências de captura identificam evidências mantidas localmente. Nomes, contatos, documentos e valores de clientes foram anonimizados nesta versão.

## Contexto para quem for executar

- Produto: ERP SaaS da Ávila Ops, posicionado como **ERP vertical para vendas técnicas e equipamentos**.
- Referência estratégica obrigatória: `docs/strategy/analise-saas-comercial-padrao-totvs.pdf` (16/11/2026), principalmente a seção 8 (diretrizes de experiência) e a seção 9.1 (roteiro de 0 a 90 dias).
- Código web: `apps/web` (Next.js). Telas em `apps/web/src/app/<rota>/page.tsx`, componentes em `apps/web/src/features/`. Shell e menu em `apps/web/src/components/shell/` (`navigation-catalog.ts`, `menu-navigation.tsx`, `app-shell.tsx`, `header-tools.tsx`).
- Capturas de referência: `docs/telas/erp-web.pdf` (62 telas, desktop, tema escuro), `docs/telas/erp-mobile.pdf` (23 telas, celular, tema escuro) e `reports/screens/mobile/` (159 telas, celular 390 px, tema claro, página inteira). Para recapturar: `node apps/web/scripts/capture-screens.mjs --device mobile --company ludus`.
- Antes de mudar uma tela, leia o `README.md` da pasta dela (regras de negócio e limites) e o componente indicado no prompt. Não troque bibliotecas, não mude regras de negócio e não crie dependências sem necessidade comprovada.

## Problemas transversais vistos nas capturas

1. **Funções indisponíveis à vista.** O menu mostra itens marcados "Indisponível" (Eventos, Notificações, Aplicativos, Novidades, Loja virtual, Anúncios, Conferência de estoque, Sugestões de compra, Caixa, Ficha financeira, Remessas e retornos, Faturamento agrupado, Guias tributárias…). Ao clicar, todos abrem a mesma página "Funcionalidade indisponível" com oito atalhos que não têm relação com a tela pedida (Produtos, Clientes, Pedidos de venda…).
2. **Três padrões de lista diferentes** em telas equivalentes (cadastros): título, posição do botão de criar, nome do botão de busca ("Buscar" / "Pesquisar"), presença de "Limpar", contador e paginação mudam de tela para tela.
3. **Texto técnico exposto ao usuário:** "Consulta e edição", "Cadastro conectado • consulta exige acesso à empresa", "Documento sem máscara", "Situação no ERP", códigos `LEGACY-2`, "Empresa - true", "Emissão de (UTC)", NSU `000000000000000`, "o cursor foi preservado", "ledger financeiro", "Erro interno".
4. **Documentos e telefones sem máscara** (CPF/CNPJ `00000000000000`) em algumas telas e com máscara em outras.
5. **Página de conteúdo estreito centralizado** com grande área vazia no desktop (listas de cadastro, assistente, empresas).
6. **Voltar inconsistente:** "← Visão geral", "Voltar à visão geral", "← Início", "‹ Preferências", ou nenhum.
7. **Estados vazios genéricos:** "Nenhum cadastro encontrado. Revise os filtros ou adicione um registro." aparece igual com e sem filtro, sem explicar para que serve o cadastro nem oferecer a ação certa.
8. **Telas de visão geral sem números:** Compras, Financeiro e Fiscal mostram só cartões de navegação, sem pendências, totais ou próxima ação.
9. **Rotas diferentes que mostram a mesma tela** (Estoque visão geral = Saldos = Lançamentos; Pedidos de compra = Recebimentos quando vazio; Notas de entrada em Compras = Monitor fiscal).
10. **Mobile:** e-mails quebram no meio da palavra; algumas telas fiscais ficam mais largas que o celular (o navegador reduz o zoom e o texto fica minúsculo); cartões de hub grandes demais (quatro por tela).

## Regras que todo prompt de tela deve cumprir

### Navegação e shell

- Item indisponível **não aparece no menu** para quem não pode usá-lo (documento, seção 8: "ocultar opções ainda indisponíveis"). Se a rota for acessada direto, mostrar uma página indisponível **específica**: o que a função fará, por que ainda não está ativa (falta configuração, plano, permissão ou desenvolvimento), quem pode ativar e um único atalho relacionado (ex.: Conferência de estoque → Saldos). Nunca a grade genérica de oito atalhos.
- Um único padrão de cabeçalho de página: breadcrumb `Módulo / Tela` clicável, título (h1), descrição de uma linha, ação principal à direita (botão primário), ações secundárias em botões neutros ou menu "Mais ações".
- O mesmo shell em todas as telas (algumas telas, como Plano e as fiscais no celular, usam um cabeçalho diferente).
- Empresa ativa sempre visível no cabeçalho, inclusive no celular (truncar com `title`/tooltip com o nome completo).
- Cada rota do menu mostra um conteúdo próprio. Se duas rotas precisam do mesmo dado, mudam o título, os filtros padrão e as ações.

### Listas

Padrão único de lista, aplicado a todos os cadastros e listas operacionais:

- Cabeçalho da página com título no plural ("Contas financeiras") e botão primário com verbo + objeto ("Nova conta financeira", nunca "Novo cadastro").
- Barra de filtros: busca com placeholder de exemplo real ("Nome ou CNPJ"), filtros em seguida, busca **ao digitar** com debounce de 300 ms (botão "Buscar" só se a API exigir), "Limpar filtros" só quando há filtro ativo.
- Contador simples ("4 pessoas"), sem "Consulta e edição".
- O nome do registro é o link para o detalhe; não repetir coluna "Editar".
- Ocultar paginação quando há uma página só.
- Arquivados fora da lista padrão (filtro "Situação: Ativos" por padrão) ou ordenados no fim.
- Preservar busca, filtros, página e rolagem ao voltar de um registro (documento, seção 8).
- Exportar CSV/XLSX nas listas operacionais (documento, seção 7.3), quando a API já permitir; senão, registrar como pendência.

### Estados

- **Vazio sem filtro:** ícone, frase do que o cadastro faz e por que importa, botão da ação principal ("Cadastrar primeira conta financeira") e, quando houver, link para importar.
- **Vazio com filtro:** "Nenhum resultado para 'X'" + "Limpar filtros".
- **Carregando:** esqueleto com a forma da lista, não só texto.
- **Erro:** mensagem em linguagem simples com a causa provável e a ação ("Não foi possível abrir o caixa porque nenhuma conta financeira está cadastrada. Cadastrar conta"). Nunca só "Erro interno". Guardar o `x-request-id` em "Detalhes técnicos" recolhido.
- **Dependência faltando:** quando a tela depende de outro cadastro (Caixas e bancos → Contas financeiras; Estoque → Depósitos; PDV → Caixa/conta), dizer isso e levar até lá.

### Dados

- CPF/CNPJ, CEP e telefone sempre com máscara na exibição; busca aceita com ou sem máscara.
- Moeda `R$ X`, datas `dd/mm/aaaa`, mês "nov/2026" (nunca `2026-11`), fuso de Brasília (não exibir "UTC").
- Nunca mostrar identificadores internos (`LEGACY-n`, UUID, NSU zerado, booleanos `true/false`).
- Status como selo com cor e texto, sempre com o mesmo vocabulário (Rascunho, Aguardando aprovação, Confirmado, Cancelado, Arquivado…).
- Prazos vencidos e itens parados destacados (selo "Vencida", "Parado há 18 dias").

### Mobile (≤ 767 px)

- Nenhuma rolagem horizontal da página. Tabelas viram lista de cartões com no máximo 3 linhas por item.
- Textos longos (e-mail, razão social) quebram em ponto seguro (`overflow-wrap: anywhere` só como último recurso; preferir truncar com reticências e mostrar completo no detalhe).
- Ação principal acessível sem rolar (cabeçalho ou barra inferior fixa).
- Alvos de toque ≥ 44 px. Filtros secundários em painel "Filtros" (bottom sheet).
- Hubs com cartões viram lista compacta (ícone, nome, uma linha de descrição).

### Acessibilidade

- Contraste AA nos dois temas (claro e escuro), foco visível, navegação completa por teclado, reflow a 200% sem perda de conteúdo (documento, seção 8).
- Título da aba do navegador = título da página.
- Regiões dinâmicas (contadores, totais) com `aria-live="polite"`.

### Linguagem

- Português claro e curto, sem jargão de implementação. Uma frase de ajuda por bloco; o resto em "Saiba mais".
- Mesmo nome para a mesma coisa em todo o produto: escolher entre "Proposta" e "Orçamento", "Recebimentos" e "Check-in de recebimentos", "Conferência de estoque" e "Inventários", "Caixa" e "Controle de caixa", e usar sempre o mesmo.

## Formato esperado de entrega para cada tela

1. Diagnóstico confirmando no código cada problema listado no prompt (alguns podem já ter mudado).
2. Proposta curta (texto ou wireframe) antes de implementar, se a tela mudar de estrutura.
3. Implementação em PR próprio por tela ou por grupo de telas iguais.
4. Testes de UI atualizados (`apps/web/tests/`) para desktop 1280 px e celular 390 px.
5. Captura antes/depois com `apps/web/scripts/capture-screens.mjs --only <rota>`.

## Critérios de aceite comuns

- Nenhum texto técnico da lista "Problemas transversais", item 3, visível.
- Nenhum item "Indisponível" no menu para o perfil testado.
- Lista segue o padrão único (mesmas posições, nomes e comportamentos).
- Sem rolagem horizontal em 390 px; usável a 200% de zoom em 1280 px.
- Estados vazio, vazio com filtro, carregando e erro implementados e testados.
