import { redirect } from "next/navigation"

export const metadata = { title: "Nota fiscal de entrada" }

export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{origem?:string}>}) {
  const [{id},{origem}] = await Promise.all([params,searchParams])
  redirect(`/fiscal/monitor/${encodeURIComponent(id)}?origem=${origem==="vendas" ? "vendas" : "compras"}`)
}
