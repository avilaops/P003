# Publicação TypeScript • reaproveitamento nativo

## Resultado

Uma publicação que altera somente TypeScript pode reutilizar a imagem nativa, os dois executáveis de comparação e os contratos de uma validação completa anterior. O cache pertence às publicações confiáveis da main, usa o conteúdo de todas as entradas nativas e expira semanalmente. A primeira publicação prepara o cache; não há promessa de aceleração da execução que já começou.

## Regras

• PostgreSQL, tipos TypeScript e comparação HTTP continuam em cada publicação.
• Rust, SQL, consultas, ativos nativos, ferramenta de compilação e configuração do pipeline invalidam o cache.
• Recibo, plataforma, hashes dos arquivos e disponibilidade da imagem por digest são conferidos antes do uso. Falhas voltam ao caminho completo.
• Cache só é salvo depois de validação nativa completa, comparação HTTP e publicação da imagem. PRs e regressões não usam esse atalho.
• Contratos e evidência identificam a revisão nativa reutilizada; o digest conserva sua procedência original.
• A publicação atual continua sem cancelamento. Nenhuma redução de retenção, isolamento ou autorização.

## Entregas

1. Preservar a migração fiscal já aplicada; os privilégios novos ficam somente na migração aditiva existente.
2. Implementar e testar um recibo de cache com integridade e retorno ao caminho completo.
3. Integrar restore/save no workflow de API e uma opção explícita de reconstrução nativa.
4. Validar os testes de política e integridade; revisar, integrar e publicar quando a execução atual terminar.
5. Conferir a publicação comercial atual no navegador autenticado e registrar o que segue pendente no contrato.

## Validação proporcional

Testes pequenos de integridade (conteúdo alterado, entradas diferentes, links, digest indisponível), políticas existentes e revisão da configuração. Não repetir a suíte local completa do produto. Medir ganho somente após um cache real ser reutilizado.
