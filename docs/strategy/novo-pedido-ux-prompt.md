# Prompt: redesenho da tela Novo Pedido (web e mobile)

## Contexto

Tela: `erp.avilaops.com/vendas/pedidos/novo` (Vendas > Pedidos de venda > Novo pedido).

Arquivos principais em `apps/web/src/features/sales/`:

- `commercial-simulator.tsx` — lista de equipamentos; `SelectedProduct` renderiza cada linha e o bloco de acabamentos.
- `commercial-order-layout.tsx`, `commercial-order.css` — grade da página.
- `commercial-navigation-model.ts`, `order-mobile-navigation.tsx` — abas de seção (Equipamentos, Cliente, Entrega, Desconto, Pagamento, Revisão).
- `order-customer-form.tsx`, `order-negotiation*.tsx`, `commercial-checkout*.tsx`, `order-weight-summary.tsx`, `order-progress.ts` — cliente, desconto, pagamento, revisão e pendências.
- Testes de UI: `apps/web/tests/commercial-checkout-ui.spec.ts`.

Leia esses arquivos e o padrão visual do restante do ERP antes de propor qualquer mudança. Não troque de biblioteca de componentes nem crie dependências novas sem necessidade comprovada.

Referência estratégica: `docs/strategy/analise-saas-comercial-padrao-totvs.pdf` (16/11/2026). Leia antes de começar. Este redesenho atende principalmente:

- Seção 5 — motor comercial contextual (desconto máximo, entrada mínima, motivo do limite, aprovação).
- Seção 6 — mobilidade: experiência responsiva para vendedores e gestores.
- Seção 7.1 — profundidade transacional: recuperação de erros.
- Seção 8 — diretrizes de experiência.
- Seção 9.1 — itens 3 (cálculo contextual), 4 (eliminar telas duplicadas) e 6 (painel de pendências e aprovações).
- Seção 10 — indicador "tempo até aprovação".

Quando uma decisão de UI entrar em conflito com essas diretrizes, siga o documento e registre o motivo.

## Problema

Com 14 equipamentos a página passa de 6 telas de rolagem. Cada linha ocupa de 2 a 4 vezes a altura necessária porque mostra, para todo item:

1. Linha principal (SKU, nome, quantidade, valor unitário, desconto, total, remover).
2. Uma caixa de erro "Produto não encontrado" com o botão "Recarregar acabamentos".
3. Um `<details>` "Acabamentos" com 4 seletores (Estrutura, Braços, Tipo de anilheiro, Estofado) e o link da paleta.

Problemas observados nas capturas:

- **Erro em massa**: quase todos os itens mostram "Produto não encontrado". `SelectedProduct` faz um `GET /api/erp/products/{id}` por linha (N requisições). Investigue a causa antes de mexer no visual: 404 por tenant, limite de requisições, ID errado vindo da tabela publicada, ou corrida de `tenantId`. Corrija a causa. Se fizer sentido, troque as N chamadas por uma única busca em lote dos acabamentos dos itens do pedido.
- **Erro mal posicionado**: a caixa de erro aparece acima do bloco "Acabamentos", desconectada dele, e o bloco aberto continua mostrando seletores vazios ("Estrutura", "Braços" sem campo). Item sem dados de acabamento deve mostrar um estado único e compacto.
- **Colunas vazias**: "Desconto" e "Total c/ IPI" mostram "—" em todas as linhas até a simulação rodar. Isso gasta largura e não informa nada.
- **Rolagem para chegar ao resto**: Cliente, Entrega, Desconto, Pagamento e Revisão ficam abaixo de toda a lista. O resumo ("Revisão do pedido", "14 pendências") só aparece no fim, então o vendedor não vê total nem pendências enquanto monta o pedido.
- **Pendências longas**: a lista "Cliente · 12 pendências" repete 12 frases do tipo "Confira X: preenchimento obrigatório dentro do limite de N caracteres". Com cliente ainda não selecionado, uma pendência basta: "Selecione ou cadastre o cliente".
- **Abas fixas sem estado**: a barra Equipamentos / Cliente / Entrega / Desconto / Pagamento / Revisão não mostra em que seção o usuário está nem quais seções têm pendência.
- **Limite comercial escondido**: o card Desconto mostra apenas "Desconto sem aprovação: até 20%" e deixa a "Alçada comercial" recolhida. O vendedor não vê o desconto máximo deste pedido, a entrada mínima, o motivo do limite nem quem precisa aprovar.
- **Trabalho perdido**: montar 14 itens com cores leva minutos; recarregar a página ou perder a sessão descarta tudo.
- **Componente duplicado**: Simulador e Novo pedido usam o mesmo `SelectedProduct` com comportamentos diferentes (`orderMode`).
- **Hierarquia fraca**: textos de ajuda longos ("Base para o primeiro prazo: 17/11/2026 (hoje na geração)...", "Salvar cria um pedido em rascunho com número...") competem com os campos.

## Objetivo

O vendedor monta um pedido de 1 a 30+ itens, vê total, desconto e pendências o tempo todo, e salva sem precisar rolar a página inteira. Funciona igualmente bem em desktop (≥1280 px), tablet (768 px) e celular (375 px).

## Requisitos

### 1. Lista de equipamentos compacta

- Cada item ocupa **uma linha** por padrão (desktop) ou **um cartão de até 2 linhas** (mobile): SKU + nome, quantidade com −/+, valor unitário, total da linha, remover.
- Acabamentos viram um **resumo em chips** na própria linha (ex.: amostra de cor + "Piano Black · Matte Graphite · Saddle Brown · Não se aplica"). Sem escolha, mostrar um chip "Escolher acabamentos" e, se forem obrigatórios para salvar, um indicador de pendência no item.
- A edição de acabamentos abre em **painel lateral (drawer) no desktop** e **bottom sheet no mobile**, um item por vez, com "Anterior / Próximo item" para percorrer todos sem fechar o painel. Inclua "Aplicar estas cores a todos os itens compatíveis" (só para opções disponíveis em cada produto; avise quais itens não aceitaram).
- Erro de carregamento do produto: um único aviso compacto dentro da linha ("Acabamentos indisponíveis · Tentar de novo"), sem renderizar seletores vazios. Se vários itens falharem pela mesma causa, mostrar **um** aviso no topo da lista com "Tentar de novo para todos".
- Colunas "Desconto" e "Total c/ IPI" só aparecem quando há simulação válida. Antes disso, a linha mostra apenas o valor de tabela.
- Lista longa: a partir de ~8 itens, cabeçalho da tabela fixo (`position: sticky`), busca/filtro dentro do pedido e opção de recolher a lista mostrando só o resumo ("14 itens · 829 kg · R$ X de tabela").
- Busca de equipamento continua no topo, com adição por teclado (Enter adiciona o primeiro resultado; se o item já existe, soma a quantidade em vez de duplicar a linha).

### 2. Resumo sempre visível

- **Desktop**: coluna direita fixa (`sticky`) com Total de tabela, Desconto, Valor sem IPI, IPI, Total do pedido, Entrada, Saldo, peso bruto, contagem de pendências e o botão "Salvar pedido". A coluna principal rola; o resumo não.
- **Mobile**: barra inferior fixa com Total do pedido, número de pendências e "Salvar pedido". Tocar na barra abre o resumo completo em bottom sheet. Respeitar `env(safe-area-inset-bottom)`.
- O resumo mostra "—" só para valores realmente desconhecidos e diz em uma linha curta o que falta para calcular.

### 3. Navegação por seções

- A barra de seções fica fixa abaixo do cabeçalho, destaca a seção visível (scroll-spy com `IntersectionObserver`) e mostra um contador de pendências por seção (ex.: "Cliente · 1").
- Clicar numa seção ou numa pendência rola até o campo e coloca o foco nele.
- Mobile: a barra vira rolagem horizontal ou um seletor compacto ("Seção 2 de 6 · Cliente") que não ocupa mais de 48 px de altura. Avalie também o modo passo a passo (uma seção por vez com Voltar / Continuar); escolha o que for mais simples dado o código existente e justifique.
- Seções concluídas podem ser recolhidas mostrando um resumo de uma linha (ex.: "Cliente: Academia X · CNPJ 00.000.000/0001-00 · SP").

### 4. Pendências úteis

- Agrupar por causa, não por campo. Cliente não selecionado = uma pendência. Só listar campos individuais depois que um cliente existir e faltar algo nele.
- Texto curto e acionável: "Informe o CNPJ", não "Confira X: preenchimento obrigatório dentro do limite de N caracteres". O limite de caracteres vai para a validação do próprio campo.
- Ordem das pendências = ordem das seções na página.

### 5. Condição comercial contextual (documento, seção 5)

- O card Desconto e o resumo mostram, em linguagem direta e sempre visível (não recolhido):
  - **Desconto máximo para este pedido** (em % e em R$), já calculado para produto, tabela de origem, UF de destino, contribuinte/não contribuinte, PF/PJ, comissão, margem e perfil/alçada do usuário logado.
  - **Entrada mínima** em R$ e %.
  - **Motivo do limite** em uma frase (ex.: "Margem líquida mínima da linha importada", "Destino SP não contribuinte").
  - **Aprovação necessária acima desse valor**: quem aprova (perfil) e o que acontece ao salvar ("O pedido vai para aprovação do gestor comercial").
- Use os dados que a simulação já devolve. Não crie regra nova no front; se a API não expõe motivo ou aprovador, liste o que falta e proponha o campo no contrato da API em PR separado.
- O controle de desconto (campo + slider) mostra visualmente a faixa livre, a faixa que exige aprovação e o teto; ultrapassar o teto é bloqueado com a mensagem do motivo.
- O cálculo exibido precisa ser reprodutível: mostrar a versão da tabela/política usada (ex.: "Política v12 · tabela importada de 10/11/2026").

### 6. Aprovação e pendências de alçada

- Pedido acima da alçada mostra no resumo um estado "Aguardando aprovação" com aprovador, data de envio e próxima ação, em vez de só bloquear o salvar.
- A tela de detalhe do pedido permite ao gestor aprovar ou recusar (com motivo) também no celular, com o mesmo resumo fixo e a mesma barra inferior.
- Registrar data/hora de entrada e saída da fila de aprovação, usuário e motivo, para alimentar o indicador "tempo até aprovação" (documento, seção 10). Verifique se a auditoria existente já guarda isso antes de criar algo.

### 7. Rascunho e recuperação de erros (documento, seção 7.1)

- Guardar o pedido em montagem localmente (itens, quantidades, acabamentos, cliente, condições) a cada alteração, por empresa ativa e usuário. Ao voltar à tela, oferecer "Continuar pedido em andamento (14 itens, há 12 min)" ou "Descartar".
- Nunca restaurar rascunho de outra empresa; limpar após salvar com sucesso.
- Erros de rede ou de simulação mostram o que foi preservado e uma ação de repetir, sem apagar dados digitados.
- Avalie se o rascunho deve ir para o servidor (pedido em rascunho já existe após "Salvar"); se sim, proponha, mas comece pelo local por ser mais simples.

### 8. Um componente para Simulador e Pedido (documento, seção 9.1, item 4)

- A linha compacta, o painel de acabamentos e o resumo valem para `/vendas/simulador` e para o novo pedido. Remova bifurcações por `orderMode` que só existem por diferença visual; mantenha apenas as diferenças de regra (quantidade com −/+, colunas de preço, pendências de pedido).

### 9. Formulários de Cliente, Entrega, Desconto e Pagamento

- Cliente: busca como ação principal; "Cadastrar cliente" abre o formulário inline ou em drawer, preenchendo endereço pelo CNPJ/CEP quando a API permitir (verifique o que já existe antes de criar).
- Textos de ajuda: no máximo uma linha visível; o restante em tooltip ou "Saiba mais".
- Botões desabilitados ("Gerar parcelas", "Adicionar parcela") explicam o motivo uma única vez, perto do botão, não repetido abaixo de cada um.
- Campos numéricos com `inputMode` correto, máscaras de CNPJ/CEP/moeda já usadas no projeto, alvo de toque ≥ 44 px no mobile.

### 10. Responsividade

- Breakpoints: 375, 768, 1024, 1280, 1440. Nada de rolagem horizontal da página em nenhum deles.
- Reflow a 200% de zoom (WCAG 1.4.10, documento seção 8): em 1280 px com zoom 200% a página se comporta como a versão de 640 px; elementos fixos encolhem ou deixam de ser fixos para não ocupar mais de 30% da altura.
- A empresa ativa continua identificável em qualquer posição de rolagem e no mobile (cabeçalho fixo ou nome abreviado na barra de seções).
- Tabela de itens vira lista de cartões abaixo de 768 px.
- Drawer de acabamentos vira bottom sheet abaixo de 768 px, com altura máxima de 90 vh e rolagem interna.
- Nenhum elemento fixo (cabeçalho, barra de seções, barra inferior) pode cobrir o campo com foco; use `scroll-margin-top` / `scroll-padding`.

### 11. Acessibilidade

- Drawer e bottom sheet com foco preso, `Esc` fecha, foco volta para o botão que abriu.
- Cores de acabamento sempre com nome em texto, não só a amostra.
- Contadores de pendência e total anunciados com `aria-live="polite"` sem repetir a cada tecla.
- Contraste AA, navegação completa por teclado, labels existentes preservados (os testes dependem deles).

### 12. Desempenho

- Sem N requisições por item: carregar acabamentos em lote ou sob demanda ao abrir o painel do item.
- Listas acima de ~50 itens: avaliar virtualização apenas se a medição mostrar necessidade.
- Recalcular a simulação com debounce; não bloquear a digitação.

## Fora do escopo

- Regras de preço, desconto, alçada, IPI ou política de entrada. Só a apresentação muda; campos de API que faltarem para exibir motivo/aprovador vão em PR separado e explícito.
- API pública, exceto o endpoint de leitura em lote de acabamentos e os campos acima, se necessários.
- Continuidade proposta → pedido → contrato → nota → entrega (documento, seção 4), relatórios, financeiro e operação SaaS: fazem parte do roteiro, não deste redesenho.

## Entregáveis

1. Diagnóstico da causa de "Produto não encontrado", com a correção. **Feito**: a API em TypeScript validava IDs com `z.string().uuid()` (Zod 4, RFC estrito) e recusava IDs importados; trocado por `z.guid()` em `apps/api-ts`. Falta deploy e conferir na tela.
2. Proposta de layout para desktop e mobile (descrição ou wireframe) antes de implementar, listando os componentes que mudam e a qual seção do documento estratégico cada mudança atende.
3. Implementação em PRs pequenos, nesta ordem: (a) carregamento em lote dos acabamentos; (b) linha compacta + drawer/bottom sheet de acabamentos, compartilhados com o Simulador; (c) resumo fixo e barra inferior mobile; (d) condição comercial contextual e estado de aprovação; (e) navegação por seções com scroll-spy e pendências agrupadas; (f) rascunho local e recuperação de erros; (g) ajustes de texto, formulários, reflow 200%.
4. Testes: atualizar `commercial-checkout-ui.spec.ts` e cobrir 1, 14 e 40 itens em 375 px e 1280 px; zoom 200%; teste de teclado para o drawer; teste de que pendências levam ao campo certo; restauração e descarte de rascunho, inclusive troca de empresa; desconto acima da alçada mostrando aprovador e motivo.
5. Capturas antes/depois nos dois tamanhos.

## Critérios de aceite

- Pedido com 14 itens: lista inteira cabe em até 2 telas no desktop (1280×800) e até 4 no celular (375×812), com acabamentos escolhidos.
- Total do pedido e número de pendências visíveis em qualquer posição de rolagem, nos dois tamanhos.
- Escolher acabamentos dos 14 itens sem fechar o painel.
- Nenhuma caixa "Produto não encontrado" para produtos que existem no catálogo do tenant ativo.
- Cliente não selecionado gera 1 pendência, não 12.
- Com itens e destino informados, a tela mostra sem expandir nada: desconto máximo deste pedido, entrada mínima, motivo do limite e quem aprova acima dele.
- Recarregar a página no meio da montagem oferece continuar o pedido com itens, quantidades e acabamentos preservados.
- Simulador e Novo pedido usam a mesma linha de item e o mesmo painel de acabamentos.
- Página usável a 200% de zoom em 1280 px, com a empresa ativa visível.
- Testes existentes e novos passando; typecheck e lint sem erros.
