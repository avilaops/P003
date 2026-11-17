# API integral em TypeScript

A migração deve substituir todo o código Rust próprio do ERP por TypeScript, preservando os contratos HTTP/MCP, autorização atual, isolamento por empresa/RLS, valores monetários exatos, concorrência, revisão otimista e idempotência. O catálogo histórico deve manter seus identificadores. PostgreSQL próprio permanece; não usar Supabase. Não introduzir caminhos de sucesso simulados ou pontes para Rust como conclusão.

O trabalho compreende plataforma/acesso/onboarding, financeiro, estoque/compras/logística/produção, PDV/equipe/comissões, fiscal, contratos manuais existentes, documentos/arquivos/SMTP, auditoria, MCP/OpenAPI e rotinas operacionais, além dos módulos já convertidos. Migrar apenas comportamento existente de contratos nesta etapa, sem ampliar automações de preparação contratual. Preservar integrações fiscais externas e configurações reais.

Antes da retirada de Rust, substituir o migrador SQLx mantendo exatamente o histórico/checksums de arquivos já aplicados e o bloqueio de migração compartilhado. Manter implantação antiga enquanto houver funcionalidade nativa sem substituta validada. Ao final, retirar apps/api, Cargo/toolchain/imagem nativa e jobs Rust, atualizar rede/health/dispatcher e comprovar a aplicação TypeScript em produção. Remover worktrees somente quando concluídos e sem trabalho alheio pendente. Retenção de duas releases: ativa e rollback.

Implementar por subprojetos revisáveis, sem reexecutar toda a matriz de CI a cada edição local. Evidências de cobertura devem distinguir rota registrada, comportamento validado e publicação comprovada. Operações reais de emissão, pagamento, e-mail e assinatura não devem ser usadas como testes.
