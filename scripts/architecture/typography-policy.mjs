const approvedSizes = new Set([10, 12, 13, 14, 16, 18, 20, 28, 30, 32]);
const approvedTokens = /var\(--workspace-font-(title|section|body|auxiliary)\)/;

/** Keep authenticated screens on the shared scale; document typography is data. */
export function validateTypography(files) {
  const errors = [];
  for (const [name, source] of files) {
    if (!name.startsWith("apps/web/src/") || name.startsWith("apps/web/src/app/entrar/")) continue;
    // A4 document typography follows the contract reference, independently of UI controls.
    if (name === "apps/web/src/components/documents/commercial-document.css") continue;
    for (const [index, line] of source.split("\n").entries()) {
      // Public PageTitle fallback; internal headings override it in .erp-content.
      if (name.endsWith("app/workspace-ui.css") && line.startsWith(".workspace-page-title {")) continue;
      for (const match of line.matchAll(/font-size:\s*([^;}]+)/g)) {
        const size = match[1].trim();
        // User-selected order reference • only this heading has the larger display size.
        if (name === "apps/web/src/features/sales/order-proposal-actions.css" && line.startsWith(".erp-content .order-proposal-heading h1 {") && size === "32px") continue;
        if (approvedTokens.test(size)) continue;
        if (/^clamp\((24|28)px,\s*2\.4vw,\s*32px\)$/.test(size)) continue;
        if (/^\d+px$/.test(size) && approvedSizes.has(Number.parseFloat(size))) continue;
        errors.push(`Tipografia fora da escala compartilhada: ${name}:${index + 1}: ${size}`);
      }
      for (const match of line.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g)) {
        const size = Number(match[1]) * (match[2] === "px" ? 1 : 16);
        if (!approvedSizes.has(size)) errors.push(`Tamanho de texto avulso: ${name}:${index + 1}: ${match[0]}`);
      }
      for (const match of line.matchAll(/font:\s*(\d+(?:\.\d+)?)(px|rem)/g)) {
        const size = Number(match[1]) * (match[2] === "px" ? 1 : 16);
        if (!approvedSizes.has(size)) errors.push(`Atalho font fora da escala: ${name}:${index + 1}: ${match[0]}`);
      }
      if (/\btext-[5-9]xl\b/.test(line)) errors.push(`Classe sem escala interna: ${name}:${index + 1}`);
    }
  }
  const shared = files.get("apps/web/src/app/workspace-ui.css");
  if (shared) for (const [token, value] of [["title", "clamp(28px, 2.4vw, 32px)"], ["section", "18px"], ["body", "14px"], ["auxiliary", "12px"]]) {
    if (!shared.includes(`--workspace-font-${token}: ${value};`)) errors.push(`Token obrigatório de tipografia: ${token} = ${value}`);
  }
  if (shared) for (const [token, value] of [["xs", "var(--workspace-font-auxiliary)"], ["sm", "var(--workspace-font-body)"], ["base", "var(--workspace-font-body)"], ["lg", "var(--workspace-font-section)"], ["xl", "20px"], ["2xl", "var(--workspace-font-title)"], ["3xl", "var(--workspace-font-title)"], ["4xl", "var(--workspace-font-title)"]]) {
    if (!shared.includes(`--text-${token}: ${value};`)) errors.push(`Escala interna obrigatória: text-${token} -> ${value}`);
  }
  return errors;
}
