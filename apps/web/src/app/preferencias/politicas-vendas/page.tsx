import { PolicySettings } from "@/features/sales/policy-settings"
import { ReturnPolicy } from "@/features/fiscal/return-policy"
export const metadata = {title:"Políticas de vendas"}
export default function Page(){ return <><PolicySettings/><ReturnPolicy/></> }
