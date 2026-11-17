# Melhorias: Empresas e Plano

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

---

## Tela 1: Suas empresas (seleção de empresa)

**Rota:** `/empresas` • **Código:** `apps/web/src/features/company/company-onboarding.tsx` • **Capturas:** web 04, mobile 03.

### O que está errado hoje

- Card estreito centralizado no desktop com muito espaço vazio.
- Não indica qual empresa está ativa agora.
- Empresas sem nome fantasia mostram só a razão social em caixa alta (Empresa de exemplo); as outras mostram nome fantasia + razão social • os cartões ficam com alturas e hierarquias diferentes.
- Não mostra CNPJ nem situação (ativa/suspensa) de forma visível, o que dificulta distinguir empresas parecidas.
- "Cadastrar nova empresa" é um link fraco no rodapé do card.
- Aviso "Administração da plataforma: todas as empresas do ERP. O acesso à empresa selecionada será registrado." em negrito ocupando o topo.

### O que fazer

1. Cada empresa em uma linha: nome (fantasia ou razão), razão social e CNPJ mascarado em texto secundário, selo "Ativa agora" na empresa atual, selo de situação quando não ativa.
2. Busca por nome/CNPJ quando houver mais de 6 empresas (administrador da plataforma).
3. Aviso de administrador em linha discreta com ícone, não em negrito.
4. "Cadastrar nova empresa" como botão secundário no topo à direita.
5. Ao selecionar, mostrar "Acessando Empresa de exemplo…" no próprio item e voltar à tela de onde o usuário veio (`returnTo`, já existe).
6. Largura máx. 720 px, alinhada ao conteúdo das outras páginas.

### Critérios de aceite

- Empresa ativa identificada; CNPJ visível e mascarado; troca de empresa em 1 clique.

---

## Tela 2: Plano e limites (Alteração de plano)

**Rota:** `/preferencias/plano` (e `/preferencias/empresa/conta/plano`) • **Código:** procurar o componente de plano em `apps/web/src/features/` (a página `/preferencias/plano` não importa feature direto; seguir o redirecionamento) • **Capturas:** web 14, mobile 13.

### O que está errado hoje

- O título da página é **"Alterar dados da empresa"**, mas o conteúdo é "Alteração de plano".
- Esta página usa um cabeçalho diferente (botão "Menu" no topo, sem a barra lateral) • shell inconsistente com o resto do ERP.
- Aviso "A conexão de assinaturas com o Mercado Pago ainda não foi configurada neste ambiente. A contratação e as alterações de cobrança estão indisponíveis." e, mesmo assim, todos os botões "Escolher plano →" aparecem ativos.
- Não mostra qual é o plano atual nem o consumo (dados, usuários, importações).
- Vários planos com "Franquia de importações a definir".
- No celular, um seletor "Alteração de plano" duplica o título logo abaixo do cabeçalho.
- O menu lateral interno (Minha conta, Pagamento, Gerenciamento, Preferências da conta) repete a navegação de Preferências.

### O que fazer

1. Título "Plano e limites"; breadcrumb "Preferências / Plano e limites"; shell padrão.
2. **Bloco "Seu plano"** no topo: nome do plano atual, valor, renovação, e barras de consumo (dados usados / limite, usuários / limite, importações no mês / franquia).
3. Comparativo de planos abaixo, com o atual marcado e botões coerentes: se a cobrança não está configurada, botões desabilitados com o motivo uma vez ("Contratação disponível após configurar a cobrança") ou "Falar com vendas".
4. Substituir "a definir" por "Sob consulta" ou omitir a linha.
5. Remover o seletor duplicado no celular; usar a navegação de Preferências.

### Mobile

- Planos em lista vertical; o atual primeiro.

### Critérios de aceite

- Título correto; plano atual e consumo visíveis; nenhum botão ativo que leve a uma ação indisponível.
