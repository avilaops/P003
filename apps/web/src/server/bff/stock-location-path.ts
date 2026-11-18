const id = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
const detail = new RegExp("^/stock/transfers/" + id + "$", "i")
const reverse = new RegExp("^/stock/transfers/" + id + "/reverse$", "i")
const rule = new RegExp("^/stock/replenishment/" + id + "$","i")

export function stockLocationPath(resource: string, method: string) {
  if (resource === "/stock/replenishment") return method === "GET"
  if (rule.test(resource)) return method === "GET" || method === "PUT"
  if (resource === "/inventory-settings") return method === "GET" || method === "PUT"
  if (resource === "/stock/locations") return method === "GET" || method === "PUT"
  if (resource === "/stock/transfers") return method === "GET" || method === "POST"
  return method === "GET" && detail.test(resource) || method === "POST" && reverse.test(resource)
}
