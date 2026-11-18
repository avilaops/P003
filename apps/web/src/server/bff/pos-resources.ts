const session = /^\/pos\/sessions\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:\/(movements|close))?$/i

export function posSessionRoute(method: string, resource: string): { query: string[] } | undefined {
  if (resource === "/pos/sessions" && method === "GET")
    return { query: ["register", "status", "startDate", "endDate", "offset", "limit"] }
  if (resource === "/pos/sessions" && method === "POST") return { query: [] }
  if (resource === "/pos/sessions/current" && method === "GET") return { query: ["register"] }
  const match = session.exec(resource)
  if (match && ((match[1] && method === "POST") || (!match[1] && method === "GET"))) return { query: [] }
}
