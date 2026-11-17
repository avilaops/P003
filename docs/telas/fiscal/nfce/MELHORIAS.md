# Melhorias: NFC-e (Rascunhos de NFC-e)

[Padrão comum](../../PADRAO-MELHORIAS.md) • [Guia da tela](README.md)

**Rota:** `/fiscal/nfce` • **Código:** `apps/web/src/features/fiscal/fiscal-screen.tsx` • **Capturas:** mobile 21.

## O que está errado hoje

- Transbordo horizontal no celular (texto reduzido) e cabeçalho diferente, como em NF-e.
- Aviso âmbar longo: "Rascunho não é nota autorizada. Não possui número fiscal, chave de acesso, XML ou DANFE. A emissão usa o ambiente escolhido na configuração fiscal. Homologação é um ambiente de testes, sem valor fiscal."
- Acordeão "Preparação para emissão: pendências atuais" recolhido • se há pendência que impede emitir, ela deveria estar visível.
- Título "Rascunhos de NFC-e" enquanto o menu chama "NFC-e"; "Voltar ao fiscal" como link.
- "Buscar nos rascunhos carregados" (texto técnico) e "Atualizar lista".
- Para a empresa de exemplo (venda de equipamentos a empresas), NFC-e é rara; avaliar ocultar por configuração.

## O que fazer

1. Corrigir largura no celular e usar shell padrão.
2. Título "NFC-e"; abas "Rascunhos | Emitidas".
3. Pendências que impedem emitir sempre visíveis no topo (lista curta com links de correção); sem pendências, nada.
4. Aviso sobre rascunho em uma linha ("Rascunho ainda não é nota fiscal.") com "Saiba mais".
5. Busca: placeholder "Destinatário, CPF/CNPJ ou identificação"; remover "carregados".
6. Permitir ocultar NFC-e do menu nas preferências fiscais quando a empresa não usa.

## Critérios de aceite

- Sem transbordo em 390 px; pendências visíveis sem abrir acordeão.
