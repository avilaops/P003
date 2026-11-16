# Cores importadas • imagens e lista compacta

## Pedido
Cadastrar as opções dos catálogos DHZ nos importados e apresentar imagem original ao lado do nome em lista sobreposta com rolagem interna. A autorização anterior para concluir implantação continua válida; sem nova rodada de aprovação de design.

## Fonte e escopo
Fonte: pasta Drive03Produtos e preços e planilhaProdutosPremium; relação salva em artifacts/imported-colors/source-rows.json. São94produtos com vínculo:54HammerForcePro,21SForce,15ambos e4CableMotion. Para os15com duasfontes usarPro como referência explícita, preservando a relação com ambas na evidência. O usuário escolheu explicitamente liberar as cores dos dois catálogos nos4CableMotion: registrar referência dhz-combined, mostrar as duas fontes, sem afirmar que o catálogoCableMotion declara essa paleta. Deduplicar Graphite Black/Matte Graphite Black como alias de pintura já documentado, sem traduzir tecidos.

Paletas por componente vêm de catalog-finish-palettes.ts e rasters originais/proveniência versionados. Incluir padrão e especiais de cada componente, sem converter tecidos genéricos em texturas. Não cadastrar cor de anilheiro; manter opções de tipo existentes. Preservar arquivamento, fotos, fichas, impostos, preços, custos, estoque e pedidos históricos.

## Interface
Substituir select nativo mais cartões duplicados por controle único acessível, imagem46px ao lado do nome, lista em portal/sobreposição com altura máxima e scroll interno, seleção por mouse/toque/teclado, Escape/fora fecha e foco retorna. Preservar seleção histórica fora do cadastro e sem seleção opcional. Leitura de catálogo também usa lista compacta para não expandir a página. Nenhuma foto aproximada quando não houver referência; usar imagem só com paleta explícita.

## Compatibilidade comercial
Atualizar acabamentos incrementa a revisão geral do produto. Adicionar revisão de compatibilidade de preço inicializada com products.revision, preservando exatamente o estado das publicações existentes. Trigger mantém essa revisão em alterações somente de acabamentos e a incrementa em outras alterações. Consultas de publicação, disponibilidade, simulação e conversão usam a revisão de preço, sem editar snapshots publicados. Os42importados já bloqueados continuam bloqueados; não republicar tabelas nem recalcular preços para esta carga.

## Aplicação dos dados
Preparar diff concreto porID/SKU, backup atual e ETAG. Executar apenas depois da compatibilidade publicada. Releitura individual imediatamente antes do PUT com If-Match, atualização dos três conjuntos e finishingPalette, manter campos obrigatórios/protegidos e omitir fotos. Readback completo e comparar campos protegidos. Conferir conjuntos disponíveis da tabela e valores antes/depois. Resultado incerto não é repetido cegamente.

## Aceite
Testes demonstram imagem real por componente, lista sem mover os campos seguintes, scroll próprio, teclado/fora/Escape, histórico/desabilitado, mobile320/393 e desktop. Testes SQL demonstram edição de cores não invalidando tabela válida, edição relevante invalidando, bloqueio anterior preservado e snapshots imutáveis. Revisão final, CI/Release completos e conferência autenticada em produção antes de concluir.
