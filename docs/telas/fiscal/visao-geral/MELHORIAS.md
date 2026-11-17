# Melhorias: Fiscal • visão geral

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/fiscal` • **Código:** `apps/web/src/features/fiscal/fiscal-screen.tsx` • **Capturas:** web 62.

## O que está errado hoje

- Oito cartões de navegação iguais, **sem estado**: não diz se a empresa está pronta para emitir (certificado, ambiente, série, CSC), quantas notas estão pendentes ou rejeitadas, nem quantas notas recebidas aguardam manifestação.
- "Guias tributárias • Capacidade ainda indisponível" aparece como cartão normal.
- Nomes confusos entre menu e cartões: menu "NF-e" × cartão "Notas fiscais de saída"; "Monitor fiscal e XML recebidos" × "Notas recebidas e importação de XML"; "DANFE de XML autorizado".
- Faixa de texto genérica no topo ("Importe XMLs recebidos, consulte documentos armazenados e prepare documentos fiscais. A transmissão depende da configuração fiscal, do ambiente autorizado e da prontidão do emitente.").

## O que fazer

1. **Bloco "Prontidão fiscal"** no topo (a API tem `fiscal/readiness`): certificado (válido até / vencendo / ausente), ambiente (Produção / Homologação), série e numeração, CSC da NFC-e • cada item com status e link para corrigir. Substitui a faixa de texto.
2. Indicadores: notas de saída em rascunho, rejeitadas, autorizadas no mês; notas recebidas aguardando manifestação; CT-e recebidos.
3. Agrupar navegação em **Saída** (NF-e, NFC-e, NFS-e) e **Entrada** (Notas recebidas, CT-e, NFS-e recebidas) e **Ferramentas** (DANFE de XML, Configurações). Um nome por documento, igual no menu e nos cartões.
4. Remover "Guias tributárias" enquanto indisponível.

## Critérios de aceite

- A primeira coisa visível responde "posso emitir nota hoje?".
- Nomes idênticos no menu e na tela.
