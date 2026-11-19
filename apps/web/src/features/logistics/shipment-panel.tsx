"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { erpFetch } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";

type Status = "to_separate" | "separated" | "checked" | "shipped" | "delivered";
type Shipment = {
  id: string; status: Status; revision: number; carrierName: string | null; vehiclePlate: string | null; driverName: string | null;
  trackingCode: string | null; deliveredAt: string | null;
  packages: { id: string; packageNumber: number; weightGrams: number }[];
  manifest: { number: string; packageCount: number; totalWeightGrams: number; shippedAt: string } | null;
};

const labels: Record<Status, string> = { to_separate: "A separar", separated: "Separado", checked: "Conferido", shipped: "Expedido", delivered: "Entregue" };
const order: Status[] = ["to_separate", "separated", "checked", "shipped", "delivered"];

export function ShipmentPanel({ orderId }: { orderId: string }) {
  const [shipment, setShipment] = useState<Shipment | null>(null);
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    const controller = new AbortController();
    (async () => {
      const list = await erpFetch(`/api/erp/logistics/shipments?orderId=${orderId}`, { signal: controller.signal });
      const listed = await list.json();
      if (!list.ok) throw new Error(listed.title || "Expedição indisponível");
      setTenantId(listed.tenantId);
      const first = listed.data?.[0];
      if (!first) { setShipment(null); return; }
      const detail = await erpFetch(`/api/erp/logistics/shipments/${first.id}`, { signal: controller.signal });
      const value = await detail.json();
      if (!detail.ok) throw new Error(value.title || "Expedição indisponível");
      setShipment(value.data);
    })().then(() => setError("")).catch((cause) => { if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Expedição indisponível")); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [orderId]);
  useEffect(() => load(), [load]);

  async function send(path: string, headers: Record<string, string>, body: object) {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const response = await erpFetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Tenant-Id": tenantId, "Idempotency-Key": crypto.randomUUID(), ...headers }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.title || "Não foi possível atualizar a expedição");
      setShipment(value.data);
    } catch (cause) { setError(apiErrorMessage(cause, "Não foi possível atualizar a expedição")); } finally { setSaving(false); }
  }

  const next = shipment ? order[order.indexOf(shipment.status) + 1] : undefined;
  function advance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shipment || !next) return;
    const form = new FormData(event.currentTarget), pick = (name: string) => String(form.get(name) || "").trim() || undefined;
    const extra = next === "shipped" ? { carrierName: pick("carrierName"), vehiclePlate: pick("vehiclePlate"), driverName: pick("driverName"), trackingCode: pick("trackingCode") } : {};
    void send(`/api/erp/logistics/shipments/${shipment.id}/status`, { "If-Match": `"${shipment.revision}"` }, { status: next, ...extra });
  }

  return <section className="mt-6 rounded-lg border border-border bg-card p-4 text-sm" aria-label="Expedição e romaneio">
    <h2 className="text-base font-semibold">Expedição e romaneio</h2>
    {loading ? <p className="mt-3" role="status">Carregando expedição…</p> : !shipment ? <div className="mt-3 flex items-center gap-3">
      <p className="text-muted-foreground">Este pedido ainda não entrou na expedição.</p>
      <Button size="sm" disabled={saving || !tenantId} onClick={() => void send("/api/erp/logistics/shipments", {}, { orderId })}>Iniciar expedição</Button>
    </div> : <>
      <ol className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="Etapas">{order.map((status) => <li key={status} className={`rounded border px-2 py-1 ${status === shipment.status ? "border-primary bg-primary/10 font-medium" : "border-border text-muted-foreground"}`}>{labels[status]}</li>)}</ol>
      <dl className="mt-3 grid gap-2 sm:grid-cols-4">
        <div><dt className="text-xs text-muted-foreground">Romaneio</dt><dd>{shipment.manifest?.number ?? "—"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Volumes</dt><dd>{shipment.packages.length} • {(shipment.packages.reduce((sum, item) => sum + Number(item.weightGrams), 0) / 1000).toLocaleString("pt-BR")} kg</dd></div>
        <div><dt className="text-xs text-muted-foreground">Transportadora</dt><dd>{shipment.carrierName ?? "—"}{shipment.vehiclePlate ? ` • ${shipment.vehiclePlate}` : ""}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Entrega</dt><dd>{shipment.deliveredAt ? new Date(shipment.deliveredAt).toLocaleString("pt-BR") : "—"}</dd></div>
      </dl>
      {next && <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={advance}>
        {next === "shipped" && <>
          <Input name="carrierName" required minLength={2} maxLength={120} placeholder="Transportadora" aria-label="Transportadora" className="h-8 w-44 text-sm" />
          <Input name="vehiclePlate" minLength={4} maxLength={12} placeholder="Placa" aria-label="Placa do veículo" className="h-8 w-24 text-sm" />
          <Input name="driverName" minLength={2} maxLength={120} placeholder="Motorista" aria-label="Motorista" className="h-8 w-40 text-sm" />
          <Input name="trackingCode" minLength={4} maxLength={60} placeholder="Rastreio" aria-label="Código de rastreio" className="h-8 w-32 text-sm" />
        </>}
        <Button size="sm" type="submit" disabled={saving}>Marcar como {labels[next].toLowerCase()}</Button>
      </form>}
    </>}
    {error && <p className="mt-3 text-destructive" role="alert">{error}</p>}
  </section>;
}
