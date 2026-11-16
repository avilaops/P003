import { expect, test } from "@playwright/test"
import { commercialRecordAction } from "../src/features/sales/commercial-status"
test("rascunhos só continuam para quem pode editar", () => {
  expect(commercialRecordAction("pedidos", "pedido", "draft", true)).toEqual({ href: "/vendas/pedidos/pedido/editar", label: "Continuar" })
  expect(commercialRecordAction("propostas", "proposta", "draft", false)).toEqual({ href: "/vendas/propostas/proposta", label: "Abrir" })
  expect(commercialRecordAction("pedidos", "pedido", "confirmed", true)).toEqual({ href: "/vendas/pedidos/pedido", label: "Abrir" })
})
