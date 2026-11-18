# Fluxo fiscal • plano de implementação

**Objetivo:** concluir as melhorias aprovadas de conferência, totais, destinatário, rateio, perfis e publicação.
**Arquitetura:** componentes React menores sobre os contratos fiscais existentes; cálculos decimais inteiros; validação final mantida no modelo e na API.
**Tecnologias:** TypeScript, Next.js, Playwright. Sem execução de Rust.
**Especificação:** sequência de oito melhorias aprovada pelo usuário nesta sessão.

## Etapas
- [x] Conferir XML e estado da NF-e 4, registrar evidência sem alterar documento autorizado.
- [x] `nfe-draft-editor.tsx`: mostrar composição e total final no rodapé; destinatário resumido com edição explícita; pendências por campo e atalhos na revisão.
- [x] `nfe-amount-allocation.ts`: rateio ativo preserva totais e ajustes individuais quando produtos mudam. Testar centavos, remoção, entrada incompleta e excesso de desconto.
- [x] `nfe-extras-fields.tsx`: substituir recolhimentos restantes por grupos compactos.
- [x] `registration-settings.tsx`: lista resumida e edição de um perfil por vez, preservando alterações e validação dos perfis não visíveis.
- [x] Testes de navegador de gravação, revisão, destinatário, rateio e perfis; typecheck e inspeção visual desktop/mobile.
- [ ] Publicar pelo fluxo existente com revisão identificada e sem build Rust; verificar versão publicada.

## Revisão
- Valores inválidos ou incompletos nunca viram total válido silenciosamente.
- Ajustes individuais não podem ser sobrescritos por redistribuição.
- Alteração de empresa ou recarga limpa estado auxiliar após confirmação existente.
- Campos não visíveis continuam validados e erros levam ao editor correspondente.
- XML autorizado é a fonte para o DANFE; não preencher PDF com dados ausentes do XML.

## Decisões de execução
- Consulta em nota bloqueada mantém endereço e detalhes individuais visíveis.
- Rateio automático é um modo desta edição; ao reabrir, conserva valores gravados e exige reaplicar total para reativar. Isso evita inferir quais valores históricos foram ajustados manualmente.
- Testes usam porta 33249 e diretório `.next-fiscal-workflow`, isolados do trabalho financeiro que usa 33118.

Validação local final: 44 testes Chromium passaram; TypeScript sem erros; verificador de arquitetura sem erros. Revisão independente concluída e correções verificadas.
