import { expect, test } from "@playwright/test"
import { installFrontendFixture, tenant } from "./helpers/frontend-fixture"

test("25 pedidos • densidade na primeira dobra, acesso às ações e largura útil", async ({page,context},info)=>{
  await installFrontendFixture(context)
  const orders=Array.from({length:25},(_,i)=>({id:"22222222-2222-4222-8222-"+String(i+1).padStart(12,"0"),number:String(i+1),customerName:"Cliente de demonstração",amount:"1130.00",
    status:"draft",revision:1,pricingOrigin:false,createdAt:"2026-11-17T12:30:00Z",updatedAt:"2026-11-17T12:30:00Z"}))
  await page.route("**/api/erp/orders?**",r=>r.fulfill({json:{tenantId:tenant,canEdit:true,total:25,totalAmount:"28250.00",data:orders}}))
  const measured=[]
  for(const [width,height,baseline] of [[1366,768,3],[1920,1080,5],[390,844,2]]){
    await page.setViewportSize({width,height})
    await page.goto("/vendas/pedidos")
    const rows=page.getByRole("region",{name:"Lista de pedidos"}).locator("tbody tr")
    await expect(rows).toHaveCount(25)
    const metrics=await rows.evaluateAll(elements=>{
      const bounds=elements.map(e=>e.getBoundingClientRect())
      return {full:bounds.filter(r=>r.top>=0 && r.bottom<=innerHeight).length,firstY:Math.round(bounds[0].top),height:Math.round(bounds[0].height),pageWidth:document.documentElement.scrollWidth}
    })
    measured.push({viewport:[width,height],...metrics})
    expect(metrics.pageWidth).toBeLessThanOrEqual(width)
    expect(metrics.full).toBeGreaterThanOrEqual(baseline)
    const primary=rows.first().getByRole("link",{name:/Continuar/})
    await primary.focus()
    await expect(primary).toBeFocused()
    await expect(rows.first().getByText("Mais ações",{exact:true})).toBeVisible()
    await info.attach("pedidos-"+width,{body:await page.screenshot(),contentType:"image/png"})
  }
  await info.attach("medicoes",{body:JSON.stringify(measured),contentType:"application/json"})
})
