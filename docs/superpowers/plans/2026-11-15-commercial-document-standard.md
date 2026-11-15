# Padrão de documentos comerciais • Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Padronizar pedidos e propostas com a organização do contrato Ludus.

**Architecture:** Preservar o renderer vetorial Rust e a impressão HTML. Componentes reutilizáveis de documento no frontend definem a estrutura de seções e campos; o renderer e o HTML de e-mail seguem a mesma especificação visual.

**Tech Stack:** Rust/pdf-writer, React, CSS de impressão, Playwright, PyMuPDF.

**Spec:** docs/superpowers/specs/2026-11-15-commercial-document-standard.md

## Global Constraints

• A4, fundo branco, tinta #202020, secundária #626262, divisórias #d6d6d6 e preenchimento #f4f4f4.
• Separador textual •. Preservar operadores e sintaxe de código.
• Preservar valores, permissões, revisão, snapshots e regras de envio existentes.
• Validar somente com fixtures, sem e-mail real ou alterações em pedidos.

## Review Focus

• Nomes/endereço extensos devem quebrar linha dentro do quadro.
• Cabeçalhos e divisórias não devem tocar o texto ou o logo.
• Seções longas devem continuar na próxima página sem título órfão.
• Impressão em viewport móvel deve restaurar todas as colunas.
• Texto não confiável no HTML de e-mail deve continuar escapado.

## Tarefas

- [x] Adicionar e executar teste visual estrutural do renderer de pedidos; atualizar cabeçalho, quadros, faixas e rodapé; rodar harness e inspeção independente.
- [x] Criar componentes CommercialDocument/DocumentSection e CSS comum; aplicar à proposta; testar identificação, responsividade e impressão em navegador.
- [x] Alinhar o HTML anexado à proposta ao padrão visual mantendo escaping e conteúdo; validar testes pertinentes.
- [x] Gerar amostras conferíveis, revisar diff e registrar verificações/limitações.

## Execução

O usuário pediu execução imediata após escolher o contrato como referência; seguir sem nova rodada de aprovação. Trabalho no checkout atual inicialmente limpo. Sem commit, publicação ou remoção de modelos nesta alteração.

## Evidências

• Renderer: 7 testes passam, incluindo nomes extensos, logo, Unicode, paginação e título junto da primeira linha da tabela. A revisão encontrou o título órfão; o teste novo reproduziu a falha com 26 linhas de identificação antes da correção.
• Propostas: 8 testes finais de documentos passam, incluindo logo/isolamento por empresa, 320/390/768/1280px, impressão, proposta curta e longa. A execução ampla passou 27 de 28 testes; o teste de logo excedeu a espera durante a compilação Rust e passou na reexecução. A expectativa tipográfica foi atualizada de 18px para a escala editorial de 13px.
• PDF: inspeção independente confirma A4, limites e identidade/paginação repetida; proposta curta em 1 página, longa com 24 itens em 5 páginas. Amostras de pedidos e propostas com os registros consultados foram geradas somente em artifacts/.
• Código: cargo check, TypeScript, ESLint, regra de arquitetura e teste isolado da função real de anexo HTML passam. A compilação da suíte completa da API foi interrompida por custo excessivo no Windows; não é evidência de execução integral dessa suíte.
• Documentação: o verificador global acusa mapa de rotas divergente e links em transcrição de sessão e documentos antigos, fora dos arquivos criados aqui. A rota/superfície da aplicação não mudou; o verificador de arquitetura passa.
• Publicação: nenhuma alteração publicada, nenhum e-mail enviado e nenhum pedido alterado.
