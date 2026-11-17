# Melhorias: CT-e recebidos

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/fiscal/ctes` • **Código:** `apps/web/src/features/fiscal/cte-distribution-screen.tsx` • **Capturas:** mobile 23.

## O que está errado hoje

- Mensagem em vermelho **"Sem permissão atual para consultar CT-e. Atualize os arquivos."** para um usuário administrador da plataforma com perfil Diretoria • verificar se é permissão faltando no papel, erro de API tratado como permissão, ou texto errado. "Atualize os arquivos" não faz sentido junto de "sem permissão".
- Subtítulo "Confirme o acesso para visualizar os documentos." sem dizer como.
- Bloco "Homologação, sem valor fiscal" com dois parágrafos técnicos ("Atualizar esta lista não consulta a SEFAZ. A captura em produção ainda não está disponível… Confiança do certificado e situação fiscal atual não são comprovadas aqui…").
- Transbordo horizontal no celular; cabeçalho diferente.

## O que fazer

1. **Diagnóstico:** chamar `GET /api/v1/fiscal/cte-distribution/documents` com o mesmo usuário e conferir status e corpo. Se for 403, mostrar "Seu perfil não tem a permissão 'Consultar CT-e'. Peça a um administrador." com link para Preferências → Papéis (para quem pode editar). Se for outro erro, tratar como erro, não como permissão.
2. Ambiente de testes como selo no cabeçalho; os parágrafos técnicos vão para "Saiba mais".
3. Lista: Emissão, Transportadora, Tomador, Valor do frete, Notas vinculadas, Vínculo com pedido/compra (a API tem `commercial-links`), ações (XML, Inspecionar, Vincular).
4. Corrigir largura no celular e usar shell padrão.

## Critérios de aceite

- Mensagem de permissão só quando a API responde 403, com o nome da permissão e quem resolve.
- Sem transbordo em 390 px.
