/** Invoke only with an explicitly reviewed plan and the successful Release commit. */
export async function importedColorsBrowserBatch(page, job) {
  return page.evaluate(async job => {
    const changes = ['structureColors', 'swingArmColors', 'upholsteryColors', 'finishingPalette'];
    const stable = value => JSON.stringify(value, function (_key, item) {
      return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
    });
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const compact = async product => {
      const { photoDataUrl, ...fields } = product;
      return { ...fields, photoDataUrlSha256: await hash(photoDataUrl || '') };
    };
    const results = [];
    let pendingId = null;
    const fetchJson = async (path, options = {}) => {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, headers: { 'X-Tenant-Id': job.tenantId, ...options.headers } });
      if (!response.ok || response.redirected) throw Error(`HTTP ${response.status}: ${path}`);
      return { response, value: await response.json() };
    };
    try {
      if (location.origin !== 'https://erp.avilaops.com' || !/^[a-f0-9]{40}$/.test(job.expectedCommit) || !job.entries?.length || job.entries.length > 8) throw Error('Origem, versão ou lote inválido');
      const health = await fetchJson('/api/health');
      if (health.value.commit !== job.expectedCommit) throw Error('A versão publicada não corresponde ao plano');
      const me = await fetchJson('/api/erp/me');
      if (me.value.tenant?.id !== job.tenantId) throw Error('A sessão está em outra empresa');
      const ledgerKey = `avila:maintenance:imported-colors:${job.expectedCommit}`;
      const ledger = JSON.parse(sessionStorage.getItem(ledgerKey) || '{}');
      for (const entry of job.entries) {
        if (!/^[a-f0-9-]{36}$/.test(entry.id) || Object.keys(entry.after).sort().join(',') !== [...changes].sort().join(',')) throw Error('Item fora do plano permitido');
        const read = await fetchJson(`/api/erp/products/${entry.id}`);
        const current = read.value.data;
        if (read.value.tenantId !== job.tenantId || current.id !== entry.id || current.sku !== entry.sku || current.categoryId !== job.categoryId) throw Error('Identidade ou categoria divergente');
        const etag = read.response.headers.get('etag');
        if (etag !== `"${current.revision}"`) throw Error('Revisão ausente ou divergente');
        const prior = ledger[entry.id];
        if (prior) {
          const saved = await compact(current);
          const expected = { ...prior.before, ...entry.after, revision: prior.before.revision + 1 };
          if (stable(saved) !== stable(expected)) throw Error(`Resultado anterior incerto ou produto alterado: ${entry.sku}`);
          ledger[entry.id] = { ...prior, state: 'verified', saved };
          sessionStorage.setItem(ledgerKey, JSON.stringify(ledger));
          results.push({ id: entry.id, sku: entry.sku, state: 'verified', reused: true, before: prior.before, saved });
          continue;
        }
        if (current.revision !== entry.before.revision) throw Error(`Produto editado desde o plano: ${entry.sku}`);
        const before = await compact(current);
        if (!job.apply) { results.push({ id: entry.id, sku: entry.sku, state: 'preview', etag, before, after: entry.after }); continue; }
        ledger[entry.id] = { state: 'pending', before, target: entry.after, etag };
        sessionStorage.setItem(ledgerKey, JSON.stringify(ledger));
        pendingId = entry.id;
        await fetchJson(`/api/erp/products/${entry.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag },
          body: JSON.stringify({ sku: current.sku, name: current.name, unit: current.unit, basePrice: current.basePrice, ncm: current.ncm ?? null, cest: current.cest ?? null, status: current.status, ...entry.after }),
        });
        const readback = await fetchJson(`/api/erp/products/${entry.id}`);
        if (readback.value.tenantId !== job.tenantId) throw Error('Readback de outra empresa');
        const saved = await compact(readback.value.data);
        if (stable(saved) !== stable({ ...before, ...entry.after, revision: before.revision + 1 })) throw Error(`Readback divergente: ${entry.sku}`);
        ledger[entry.id] = { ...ledger[entry.id], state: 'verified', saved };
        sessionStorage.setItem(ledgerKey, JSON.stringify(ledger));
        pendingId = null;
        results.push({ id: entry.id, sku: entry.sku, state: 'verified', before, saved });
      }
      return { ok: true, apply: !!job.apply, results };
    } catch (error) {
      // Stop on uncertainty • a subsequent run must first reconcile the recorded readback.
      return { ok: false, error: String(error), pendingId, results };
    }
  }, job);
}
