import type { BrowserContext, Page } from "@playwright/test"
import { tenant } from "./frontend-fixture"

/** An unpublished second source is explicit • all unrelated API failures stay visible. */
export async function installEmptyNationalTable(target: BrowserContext | Page, authority = "seller", fixtureTenant = tenant) {
  await target.route(/\/api\/erp\/commercial\/tables\/national(?:\?.*)?$/, route => {
    if (route.request().method() !== "GET") return route.fallback()
    return route.fulfill({ json: { tenantId: fixtureTenant, line: "national", authority, canManage: false, canCreateOrder: true, paymentMethods: [], data: null } })
  })
}
