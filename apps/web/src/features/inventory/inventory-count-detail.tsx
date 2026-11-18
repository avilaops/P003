"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useResource } from "@/hooks/use-operation"
import { decimalPattern, normalizeDecimal } from "@/lib/decimal-input"
import { commercialQuantity } from "@/features/sales/order-presentation"
import { countEndpoint, countLabels, countPath, type CountDetail, type CountLine } from "./count-model"
import { useCountCommand } from "./use-count-command"
import { textLink } from "./stock-model"

export function InventoryCountDetail({ id, tenant }: { id: string; tenant: string }) {
  const url = countEndpoint + "/" + id
  const resource = useResource<CountDetail>(url)
  const detail = resource.value?.tenantId === tenant && resource.value.count.id === id ? resource.value : null
  return (
    <div className="workspace-page-frame">
      <PageHeader title={detail?.count.reference || "Conferência de estoque"} back={{ href: countPath, label: "Inventários" }} />
      {!detail ? (
        resource.loading ? (
          <p role="status">Carregando inventário…</p>
        ) : (
          <div role="alert" className="space-y-2">
            <p>{resource.error || "Inventário indisponível na empresa ativa."}</p>
            <Button onClick={resource.reload}>Tentar novamente</Button>
            <Link className={textLink} href="/estoque/saldos">
              Consultar saldos
            </Link>
          </div>
        )
      ) : (
        <CountSession key={tenant + id} detail={detail} reload={resource.reload} loading={resource.loading} />
      )}
    </div>
  )
}

function CountSession({ detail, reload, loading }: { detail: CountDetail; reload: () => void; loading: boolean }) {
  const { count, lines, canEdit, canApprove, tenantId } = detail
  const url = countEndpoint + "/" + count.id,
    command = useCountCommand(tenantId)
  const open = count.status === "open",
    pending = command.busy || command.uncertain || loading
  const [selected, setSelected] = useState(""),
    [quantity, setQuantity] = useState(""),
    [scan, setScan] = useState(""),
    [correct, setCorrect] = useState(false)
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [cancelReason, setCancelReason] = useState("")
  const [action, setAction] = useState<"line" | "approve" | "cancel">("line")
  const scanner = useRef<HTMLInputElement>(null),
    quantityInput = useRef<HTMLInputElement>(null)
  const focusScannerAfterSave = useRef(false)
  useEffect(() => {
    if (!pending && focusScannerAfterSave.current) {
      focusScannerAfterSave.current = false
      scanner.current?.focus()
    }
  }, [pending])
  const active =
    lines.find((l) => l.productId === selected) ?? lines.find((l) => l.countedQuantity === null) ?? lines.find((l) => l.needsRecount) ?? lines[0]
  const recount = Boolean(active?.needsRecount && !correct)
  const ready = lines.length > 0 && lines.every((l) => l.countedQuantity !== null && !l.needsRecount && !l.stockChanged)
  function choose(line: CountLine) {
    setSelected(line.productId)
    setCorrect(false)
    setQuantity("")
    setError("")
    requestAnimationFrame(() => quantityInput.current?.focus())
  }
  async function save() {
    if (!active) return
    const normalized = normalizeDecimal(quantity, 6)
    if (!normalized && !command.uncertain) {
      setError("Informe uma quantidade válida com até seis casas decimais.")
      return
    }
    setAction("line")
    setError("")
    setNotice("")
    const saved = await command.send(
      url + "/lines",
      { productId: active.productId, countedQuantity: normalized, ...(recount ? { recount: true } : {}) },
      "line",
      count.revision,
    )
    if (saved) {
      const next =
        lines.find((l) => l.productId !== active.productId && l.countedQuantity === null) ??
        lines.find((l) => l.productId !== active.productId && l.needsRecount)
      focusScannerAfterSave.current = true
      setSelected(next?.productId ?? "")
      setQuantity("")
      setScan("")
      setCorrect(false)
      setNotice("Contagem registrada.")
      reload()
    }
  }
  async function finish(which: "approve" | "cancel") {
    setAction(which)
    setError("")
    setNotice("")
    const saved = await command.send(url + "/" + which, which === "approve" ? {} : { reason: cancelReason }, "session", count.revision)
    if (saved) {
      setNotice(which === "approve" ? "Inventário aprovado." : "Inventário cancelado.")
      reload()
    }
  }
  return (
    <>
      <section className="form-section space-y-2" aria-label="Resumo do inventário">
        <p>
          {countLabels[count.status]} • {count.countedLines} de {count.lineCount} produtos contados
        </p>
        <p>
          {count.warehouseName || "Estoque consolidado"} • {count.categoryName || "Todas as categorias"}
        </p>
        {count.blind && <p>Contagem cega</p>}
        {count.lockMovements && open && <p>Movimentos bloqueados para os produtos desta sessão.</p>}
        {count.recountPercent !== null && <p>Recontagem obrigatória para divergência superior a {count.recountPercent}%.</p>}
        {count.approvedBy && <p>Aprovado por {count.approvedBy}</p>}
        {count.cancelReason && <p>Motivo do cancelamento • {count.cancelReason}</p>}
      </section>
      {open && canEdit && active && (
        <section className="form-section grid max-w-2xl gap-3" aria-label="Registrar contagem">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const needle = scan.trim().toUpperCase(),
                found = lines.find((l) => l.sku.toUpperCase() === needle || l.productId.toUpperCase() === needle)
              if (found) choose(found)
              else setError("Código não encontrado no escopo desta sessão.")
            }}
          >
            <label>
              Ler código ou SKU
              <Input ref={scanner} value={scan} disabled={pending} onChange={(e) => setScan(e.target.value)} autoComplete="off" />
            </label>
            <Button type="submit" variant="outline" disabled={pending || !scan.trim()}>
              Localizar item
            </Button>
          </form>
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <p>
              <strong>{active.name}</strong> • {active.sku} • {active.unit}
            </p>
            <label>
              {recount ? "Segunda contagem" : "Quantidade contada"}
              <Input
                className="h-12 text-lg"
                ref={quantityInput}
                required
                inputMode="decimal"
                pattern={decimalPattern(6)}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                disabled={pending || active.stockChanged}
              />
            </label>
            <Button type="submit" disabled={pending || active.stockChanged}>
              {recount ? "Confirmar recontagem" : "Registrar quantidade"}
            </Button>
            {active.needsRecount && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setCorrect(!correct)
                  setQuantity("")
                }}
              >
                {correct ? "Voltar à recontagem" : "Corrigir primeira contagem"}
              </Button>
            )}
          </form>
        </section>
      )}
      {(error || command.error) && (
        <div role="alert">
          <p>{error || command.error}</p>
          {!command.uncertain && (
            <Button variant="outline" onClick={reload} disabled={loading}>
              Atualizar sessão
            </Button>
          )}
        </div>
      )}
      {command.uncertain && (
        <Button disabled={command.busy} onClick={() => (action === "line" ? void save() : void finish(action))}>
          Repetir confirmação
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="form-section space-y-2" aria-label="Produtos da sessão">
        <h2 className="font-semibold">Produtos da sessão</h2>
        <ul className="divide-y">
          {lines.map((l) => (
            <li key={l.productId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <strong>
                  {l.sku} • {l.name}
                </strong>
                {l.expectedQuantity !== null && (
                  <p>
                    Esperado • {commercialQuantity(l.expectedQuantity)} {l.unit}
                  </p>
                )}
                <p>
                  {l.stockChanged
                    ? "Estoque alterado desde a abertura"
                    : l.needsRecount
                      ? "Recontagem pendente"
                      : l.countedQuantity === null
                        ? "Pendente"
                        : "Contado • " + commercialQuantity(l.countedQuantity) + " " + l.unit}
                </p>
              </div>
              {open && canEdit && (
                <Button variant="outline" disabled={pending} onClick={() => choose(l)}>
                  Selecionar {l.sku}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {open && canApprove && (
        <Button disabled={pending || !ready} onClick={() => void finish("approve")}>
          Aprovar ajustes
        </Button>
      )}
      {open && canEdit && !canApprove && <p>A aprovação exige outra pessoa com permissão de aprovar inventários.</p>}
      {open && canEdit && (
        <details className="form-section">
          <summary>Cancelar inventário</summary>
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void finish("cancel")
            }}
          >
            <label>
              Motivo do cancelamento
              <Input
                required
                minLength={3}
                maxLength={500}
                disabled={pending}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </label>
            <Button disabled={pending} variant="outline">
              Confirmar cancelamento
            </Button>
          </form>
        </details>
      )}
      {count.status === "cancelled" && canEdit && (
        <Link href={countPath + "/novo"} className={textLink}>
          Abrir nova sessão
        </Link>
      )}
    </>
  )
}
