// Captures full-page screenshots of every static ERP route, in desktop or phone size.
//
// Usage (from apps/web):
//   node scripts/capture-screens.mjs --device mobile
//   node scripts/capture-screens.mjs --device desktop --only vendas
//   node scripts/capture-screens.mjs --device mobile --base http://localhost:3000
//   node scripts/capture-screens.mjs --list          (only print the routes)
//
// The first run opens a visible browser on the login page: sign in there yourself.
// The session is kept in a local profile folder, so later runs skip the login.
//   node scripts/capture-screens.mjs --device mobile --company ludus   (selects the active company first)
// Apart from the optional company selection, the script only navigates and screenshots;
// it never types or submits anything.

import { chromium, devices } from "@playwright/test"
import { mkdirSync, readdirSync, statSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, "..")
const repoRoot = resolve(webRoot, "../..")

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const deviceName = option("device", "mobile")
if (!["mobile", "desktop"].includes(deviceName)) throw new Error("--device must be mobile or desktop")
const base = option("base", "https://erp.avilaops.com").replace(/\/$/, "")
// Accepts "vendas" or "/vendas" (Git Bash rewrites a leading slash into a Windows path).
const onlyRaw = option("only", "")
const company = option("company", "")
const only = onlyRaw ? `/${onlyRaw.replace(/\\/g, "/").replace(/^.*?\/Git\//i, "").replace(/^\/+/, "")}` : ""
const output = resolve(option("out", join(repoRoot, "reports", "screens", deviceName)))
const profile = resolve(option("profile", join(process.env.LOCALAPPDATA || homedir(), "avilaops-erp-capture-profile")))
const loginTimeoutMs = 5 * 60 * 1000

const excluded = new Set(["/entrar", "/cadastro/empresa"])

function discoverRoutes(directory, prefix = "") {
  const routes = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (!statSync(full).isDirectory()) {
      if (entry === "page.tsx" || entry === "page.ts") routes.push(prefix || "/")
      continue
    }
    if (entry === "api" || entry.startsWith("[") || entry.startsWith("_") || entry.startsWith("@")) continue
    const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`
    routes.push(...discoverRoutes(full, prefix + segment))
  }
  return routes
}

const routes = [...new Set(discoverRoutes(join(webRoot, "src", "app")))]
  .filter(route => !excluded.has(route) && (!only || route.startsWith(only)))
  .sort()

if (process.argv.includes("--list")) {
  console.log(routes.join("\n"))
  console.log(`\n${routes.length} routes`)
  process.exit(0)
}

// iPhone 13 profile (390x844, touch, mobile user agent) run in Chromium, the browser already installed.
const { defaultBrowserType: _webkit, ...iphone } = devices["iPhone 13"]
const context = deviceName === "mobile" ? iphone : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }

mkdirSync(output, { recursive: true })
const browser = await chromium.launchPersistentContext(profile, { headless: false, ...context })
const page = browser.pages()[0] || await browser.newPage()

// Signed in = on the ERP origin and outside /entrar. Login may happen on another (SSO) domain.
const baseOrigin = new URL(base).origin
const signedIn = url => { const parsed = new URL(url); return parsed.origin === baseOrigin && !parsed.pathname.startsWith("/entrar") }
const onLogin = () => !signedIn(page.url())

// A redirect to the sign-in domain aborts this navigation; that is expected.
await page.goto(`${base}/dashboard`, { waitUntil: "domcontentloaded" }).catch(() => {})
await page.waitForLoadState("domcontentloaded").catch(() => {})
await page.waitForTimeout(2_000)
if (onLogin()) {
  console.log("Sign in in the open browser window. Waiting up to 5 minutes…")
  await page.waitForURL(url => signedIn(url.href), { timeout: loginTimeoutMs })
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
}
// Selects the active company by name on /empresas (case-insensitive substring), e.g. --company ludus.
if (company) {
  await page.goto(`${base}/empresas`, { waitUntil: "domcontentloaded" })
  const card = page.getByRole("button", { name: new RegExp(company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first()
  await card.waitFor({ timeout: 30_000 })
  console.log(`Selecting company: ${(await card.innerText()).split("\n")[0]}`)
  await Promise.all([page.waitForURL(url => url.pathname !== "/empresas", { timeout: 30_000 }), card.click()])
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
}
console.log("Signed in. Capturing…")

const failures = []
let index = 0
for (const route of routes) {
  index += 1
  const file = join(output, `${route === "/" ? "home" : route.slice(1).replaceAll("/", "__")}.png`)
  try {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 })
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {})
    if (onLogin()) throw new Error("session expired: sign in again and rerun")
    await page.screenshot({ path: file, fullPage: true })
    console.log(`[${index}/${routes.length}] ${route}`)
  } catch (error) {
    failures.push({ route, message: error instanceof Error ? error.message.split("\n")[0] : String(error) })
    console.log(`[${index}/${routes.length}] ${route} FAILED: ${failures.at(-1).message}`)
    if (onLogin()) break
  }
}

await browser.close()
console.log(`\n${routes.length - failures.length} of ${routes.length} screens saved to ${output}`)
if (failures.length) {
  console.log("Failed:")
  for (const failure of failures) console.log(`  ${failure.route}: ${failure.message}`)
  process.exitCode = 1
}
