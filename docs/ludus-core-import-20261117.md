# Ludus Core • carga técnica de 17/11/2026

Foram cadastradas as fichas técnicas dos 66 equipamentos nacionais, sem seleção de cores, conforme orientação do responsável. A carga contém medidas em milímetros, peso, grupo muscular, categoria e 26 baterias explicitamente informadas nas fontes. A ausência de bateria nos demais equipamentos não foi substituída por um valor presumido.

## Fontes verificadas

- [Planilha original • fotos, medidas e preços](https://docs.google.com/spreadsheets/d/1S--qUG8amnAVEsTz7MJ5cSmKK-qG2w5_/edit) • CSV SHA-256 `32b71a6817374a8229c83f294ed48b153b604c4b3e775879edc86203550ef6da`.
- [Ludus Core • catálogo por grupo corporal](https://drive.google.com/file/d/16v8UsmppZ7wegFcHQuF1tlO_DlPOhGaj/view) • página correspondente registrada na ficha de cada produto.
- A planilha local original corresponde aos mesmos 66 SKUs, medidas, pesos, baterias e valores da cópia no Drive. As medidas seguem a ordem profundidade, largura e altura utilizada pelo ERP.

O manifesto técnico está em `scripts/maintenance/fixtures/ludus-core-technical-20261117.json`. Custos e credenciais não integram esse arquivo.

## Execução e verificação

O planejador recusa SKUs duplicados, produtos ausentes, fichas já cadastradas, revisão diferente de zero, medidas inválidas, bateria ausente quando aplicável e qualquer paleta nacional. Foram executados os sete testes de manutenção do projeto, incluindo preservação dos dados protegidos.

A ferramenta conectada de gravação do catálogo ainda não suportava a revisão e todos os campos técnicos necessários. A execução utilizou a infraestrutura existente do servidor e o papel restrito da aplicação, com autorização da identidade verificada, contexto RLS da empresa e transação serializada. Cada ficha recebeu auditoria e evento de catálogo. Um ensaio completo foi revertido antes da aplicação definitiva.

O plano anterior à carga e as evidências ficam no diretório privado de manutenção do servidor, fora da aplicação pública. A conferência comparou a impressão digital de cada uma das 160 linhas de produtos antes e depois: nenhum campo dessas linhas mudou. As 66 fichas foram criadas na revisão 1, mantendo a fotografia existente com o vínculo de mídia principal nulo. As 66 respostas autenticadas da API foram conferidas individualmente contra o manifesto; todas mantiveram foto e nenhuma ganhou cores.

## Tabela nacional

Os custos que faltavam de `LD-WH065` e `LD-WH066` foram cadastrados a partir da coluna de nota cheia, com o mesmo tratamento já registrado para a linha. Nenhum outro custo foi alterado. A prévia foi comparada com os 64 itens da versão anterior antes da publicação.

A versão nacional 5, identificador `01a1ea4e-8277-775d-a4d1-f9a56202027c`, passou a conter 66 itens. Nos itens anteriores, 42 preços foram preservados exatamente e 22 tiveram acréscimo de R$ 0,01 pelo arredondamento do cálculo vigente. A versão anterior permanece no histórico. O cadastro base dos produtos não foi reprecificado pela carga.

## Recuperação

A versão anterior da tabela e os arquivos privados de manutenção permitem comparar o estado anterior. Uma eventual reversão das fichas deve conferir empresa, SKU, revisão 1 e fontes da carga antes de qualquer alteração. Fichas posteriormente editadas não devem ser sobrescritas. A reversão da tabela deve usar o fluxo de publicação versionada e suas verificações de revisão e digest, preservando documentos já emitidos.

A publicação desta tabela e o cadastro técnico são independentes da implantação do novo editor de propostas. Esta evidência não comprova implantação de código nem conclusão da preparação automática de contratos.
