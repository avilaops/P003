import type { FastifyInstance } from "fastify"
import type { AppDependencies } from "../../app.js"
import { registerReceivedImport } from "./received.js"
import { registerDistribution } from "./distribution.js"
import { registerManifestations } from "./manifestations.js"
import { registerInvoicePurchases } from "./purchase.js"
import { registerFiscalPurchaseReceipt } from "./receipt.js"
import { registerEntrySettings } from "./entry-settings.js"

export function registerFiscalReceipts(app:FastifyInstance,deps:AppDependencies) {
  registerReceivedImport(app,deps)
  registerDistribution(app,deps)
  registerManifestations(app,deps)
  registerInvoicePurchases(app,deps)
  registerFiscalPurchaseReceipt(app,deps)
  registerEntrySettings(app,deps)
}
