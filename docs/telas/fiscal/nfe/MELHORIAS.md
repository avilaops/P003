# Melhorias: Notas fiscais de saída (NF-e)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/fiscal/notas-saida` • **Código:** `apps/web/src/features/fiscal/outgoing-nfes.tsx` • **Capturas:** mobile 20.

## O que está errado hoje

- No celular, a página fica **mais larga que a tela**: o navegador reduz o zoom e todo o texto fica minúsculo (captura mobile 20). O cabeçalho também muda (aparece "Menu ERP" + campo "Buscar no ERP"), diferente das outras telas no celular.
- Três botões no topo com pesos parecidos: "Ambiente: Produção" (parece botão, é estado), "Importar XML", "Preparar nota".
- Filtros todos abertos (busca, Situação, Ambiente, De, Até) antes da lista; "Limpar filtros" e "Atualizar lista" juntos.
- "0 nota(s)" e "Nenhuma nota fiscal cadastrada nesta empresa."; texto de rodapé "Rascunhos ainda não estão autorizados. O período considera a data de preparação para rascunhos e de emissão para os demais documentos."
- Termo "Preparar nota" em vez de "Nova NF-e".

## O que fazer

1. Corrigir o transbordo horizontal no celular (procurar larguras fixas, `min-width` de tabela e grids sem `minmax(0, 1fr)` em `outgoing-nfes.tsx`) e usar o shell padrão.
2. Cabeçalho: título "NF-e de saída", selo de ambiente (Produção/Homologação) ao lado do título, primário "Nova NF-e", "Importar XML" em "Mais ações".
3. Filtros: busca + Situação visíveis; período e ambiente em "Mais filtros".
4. Colunas: Número/série, Emissão, Destinatário (nome + CNPJ mascarado), Pedido de origem (link), Valor, Situação (Rascunho, Autorizada, Rejeitada com motivo, Cancelada), ações (DANFE, XML, Cancelar, Carta de correção).
5. Rejeitadas destacadas no topo com o motivo da SEFAZ em linguagem clara e ação "Corrigir".
6. Estado vazio: "Nenhuma NF-e emitida." + "Nova NF-e" + "Emitir a partir de um pedido".

## Critérios de aceite

- Sem transbordo em 390 px; texto em tamanho normal.
- Ambiente exibido como selo, não como botão.
