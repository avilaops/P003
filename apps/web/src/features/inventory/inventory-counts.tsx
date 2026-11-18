"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Pagination } from "@/components/workspace/pagination"
import { useResource } from "@/hooks/use-operation"
import { countEndpoint, countLabels, countPath, type CountList } from "./count-model"
import { useCountCommand } from "./use-count-command"
import { textLink } from "./stock-model"

export function InventoryCounts({ tenant, create }: { tenant: string; create: boolean }) {
  const [offset, setOffset] = useState(0)
  const list = useResource<CountList>(countEndpoint + "?limit=25&offset=" + offset)
  const data = list.value?.tenantId === tenant ? list.value : null
  return (
    <div className="workspace-page-frame">
      <PageHeader
        title={create ? "Novo inventário" : "Conferência de estoque"}
        back={create ? { href: countPath, label: "Inventários" } : undefined}
        actions={
          data?.canEdit && !create ? (
            <Link className={textLink} href={countPath + "/novo"}>
              Criar inventário
            </Link>
          ) : null
        }
      />
      {!data ? (
        list.loading ? (
          <p role="status">Consultando sessões de inventário…</p>
        ) : (
          <div role="alert">
            {list.error || "A empresa da sessão mudou."} <Button onClick={list.reload}>Tentar novamente</Button>
          </div>
        )
      ) : create ? (
        data.canEdit ? (
          <CountForm tenant={tenant} data={data} />
        ) : (
          <p>Seu perfil permite consultar as sessões da empresa.</p>
        )
      ) : (
        <section aria-label="Sessões de inventário" className="form-section space-y-3">
          {data.data.length ? (
            <ul className="divide-y">
              {data.data.map((s) => (
                <li key={s.id} className="py-2">
                  <Link href={countPath + "/" + s.id} className={textLink}>
                    {s.reference}
                  </Link>
                  <p>
                    {countLabels[s.status]} • {s.countedLines} de {s.lineCount} produtos contados{s.warehouseName && " • " + s.warehouseName}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nenhum inventário nesta página.</p>
          )}
          <Pagination offset={offset} pageSize={25} total={data.total} maxOffset={100000} onOffsetChange={setOffset} />
        </section>
      )}
    </div>
  )
}

function CountForm({ tenant, data }: { tenant: string; data: CountList }) {
  const router = useRouter(),
    command = useCountCommand(tenant)
  return (
    <form
      className="form-section space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const form = new FormData(e.currentTarget),
          warehouseId = form.get("warehouseId"),
          categoryId = form.get("categoryId"),
          threshold = form.get("threshold")
        const result = await command.send(
          countEndpoint,
          {
            reference: form.get("reference"),
            ...(warehouseId ? { warehouseId } : {}),
            ...(categoryId ? { categoryId } : {}),
            blind: form.has("blind"),
            lockMovements: form.has("lockMovements"),
            ...(threshold ? { recountPercent: Number(threshold) } : {}),
          },
          "session",
        )
        if (result) router.push(countPath + "/" + result.id)
      }}
    >
      <fieldset disabled={command.busy || command.uncertain} className="grid max-w-2xl gap-4">
        <label>
          Referência
          <Input name="reference" required minLength={2} maxLength={120} />
        </label>
        {data.warehouses.length > 0 && (
          <label>
            Depósito
            <select required name="warehouseId" defaultValue="" className="block min-h-11 w-full rounded border px-2">
              <option value="">Selecione o depósito</option>
              {data.warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} • {w.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Categoria
          <select name="categoryId" className="block min-h-11 w-full rounded border px-2">
            <option value="">Todas as categorias</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="blind" />
          Contagem cega • ocultar o saldo esperado
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="lockMovements" />
          Bloquear movimentos dos produtos durante a conferência
        </label>
        <label>
          Recontar divergências acima de (%)
          <Input name="threshold" type="number" min={0} max={999999.9999} step={0.0001} placeholder="Opcional" />
        </label>
      </fieldset>
      {command.error && <p role="alert">{command.error}</p>}
      <Button disabled={command.busy} type="submit">
        {command.uncertain ? "Repetir confirmação" : "Abrir sessão"}
      </Button>
    </form>
  )
}
